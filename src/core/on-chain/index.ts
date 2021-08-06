import assert from "assert"
import {
  // createChainAddress,
  // getChainBalance,
  // getChainFeeEstimate,
  // getChainTransactions,
  GetChainTransactionsResult,
  // getHeight,
  // sendToChainAddress,
} from "lightning"
import _ from "lodash"
import moment from "moment"

import { BitcoindClient, BitcoindWalletClient, VOut } from "@services/bitcoind"
// import { getActiveOnchainLnd, getLndFromPubkey } from "@services/lnd/utils"
import { baseLogger } from "@services/logger"
import { ledger } from "@services/mongodb"
import { User } from "@services/mongoose/schema"

import {
  DbError,
  DustAmountError,
  InsufficientBalanceError,
  NewAccountWithdrawalError,
  OnChainFeeEstimationError,
  RebalanceNeededError,
  SelfPaymentError,
  TransactionRestrictedError,
  ValidationInternalError,
} from "../error"
import { lockExtendOrThrow, redlock } from "../lock"
import { UserWallet } from "../user-wallet"
import {
  amountOnVout,
  btc2sat,
  LoggedError,
  // LOOK_BACK,
  myOwnAddressesOnVout,
  sat2btc,
} from "../utils"

// export const getOnChainTransactions = async ({
//   lnd,
//   incoming,
// }: {
//   lnd: AuthenticatedLnd
//   incoming: boolean
// }) => {
//   try {
//     const { current_block_height } = await getHeight({ lnd })
//     const after = Math.max(0, current_block_height - LOOK_BACK) // this is necessary for tests, otherwise after may be negative
//     const { transactions } = await getChainTransactions({ lnd, after })

//     return transactions.filter((tx) => incoming === !tx.is_outgoing)
//   } catch (err) {
//     const error = `issue fetching transaction`
//     baseLogger.error({ err, incoming }, error)
//     throw new LoggedError(error)
//   }
// }

// First approach: we have a single wallet bitcoind named "hot"
export const OnChainMixin = (superclass) =>
  class extends superclass {
    readonly config: UserWalletConfig
    readonly bitcoindClient: BitcoindClient
    readonly bitcoindWalletClient: BitcoindWalletClient // hot

    constructor(...args) {
      super(...args)
      this.config = args[0].config
      this.bitcoindClient = new BitcoindClient()
      this.bitcoindWalletClient = new BitcoindWalletClient({ walletName: "hot" })
    }

    async updatePending(lock): Promise<void> {
      await Promise.all([this.updateOnchainReceipt(lock), super.updatePending(lock)])
    }

    async getOnchainFee({
      address,
      amount,
    }: {
      address: string
      amount: number | null
    }): Promise<number> {
      const payeeUser = await User.getUserByAddress({ address })

      let fee

      // FIXME: legacy. is this still necessary?
      // const defaultAmount = 300000

      console.log(`ddddddddddddddddddd1`)
      console.log(`ddddddddddddddddddd1`)

      if (payeeUser) {
        console.log(`ddddddddddddddddddd2`)
        fee = 0
      } else {
        console.log(`ddddddddddddddddddd3`)
        if (amount && amount < this.config.dustThreshold) {
          throw new DustAmountError(undefined, { logger: this.logger })
        }
        console.log(`amount: ${amount}`)
        console.log(`ddddddddddddddddddd4`)
        try {
          // (numeric, optional) estimate fee rate in BTC/kB (only present if no errors were encountered)
          const result = await this.bitcoindClient.estimateSmartFee({
            // const { feerate } = await this.bitcoindClient.estimateSmartFee({
            conf_target: 1,
          }) // TODO conf_target
          console.log(`result: ${JSON.stringify(result)}`)
          const feerate = result.feerate
          console.log(`feerate: ${feerate}`)
          console.log(`ddddddddddddddddddd5`)
          // 1 BTC/kB = 100000 satoshis/byte
          fee = 100000 * feerate
          console.log(`fee: ${fee}`)
          console.log(`ddddddddddddddddddd6`)
        } catch (err) {
          console.log(err)
          console.log(`ddddddddddddddddddd7`)
          throw new OnChainFeeEstimationError(undefined, {
            logger: this.logger,
          })
        }

        // // FIXME there is a transition if a node get offline for which the fee could be wrong
        // // if send by a new node in the meantime. (low probability and low side effect)
        // const { lnd } = getActiveOnchainLnd()

        // const sendTo = [{ address, tokens: amount ?? defaultAmount }]
        // try {
        //   ;({ fee } = await getChainFeeEstimate({ lnd, send_to: sendTo })) // returns tokens_per_vbyte (satoshis/vbyte)
        // } catch (err) {
        //   throw new OnChainFeeEstimationError(undefined, {
        //     logger: this.logger,
        //   })
        // }
        console.log(`ddddddddddddddddddd8`)
        console.log(`this.user.withdrawFee: ${this.user.withdrawFee}`)
        fee += this.user.withdrawFee
        console.log(`fee: ${fee}`)
        console.log(`ddddddddddddddddddd9`)
      }

      return fee
    }

    async onChainPay({
      address,
      amount,
      memo,
      sendAll = false,
    }: IOnChainPayment): Promise<ISuccess> {
      let onchainLogger = this.logger.child({
        topic: "payment",
        protocol: "onchain",
        transactionType: "payment",
        address,
        amount,
        memo,
        sendAll,
      })

      if (!sendAll) {
        if (amount <= 0) {
          const error = "Amount can't be negative, and can only be zero if sendAll = true"
          throw new ValidationInternalError(error, { logger: onchainLogger })
        }

        if (amount < this.config.dustThreshold) {
          throw new DustAmountError(undefined, { logger: onchainLogger })
        }
      }
      // when sendAll the amount should be 0
      else {
        assert(amount === 0)
        /// TODO: unable to check balance.total_in_BTC vs this.dustThreshold at this point...
      }

      return await redlock(
        { path: this.user._id, logger: onchainLogger },
        async (lock) => {
          const balance = await this.getBalances(lock)
          onchainLogger = onchainLogger.child({ balance })

          // quit early if balance is not enough
          if (balance.total_in_BTC < amount) {
            throw new InsufficientBalanceError(undefined, { logger: onchainLogger })
          }

          const payeeUser = await User.getUserByAddress({ address })

          // on us onchain transaction
          if (payeeUser) {
            let amountToSendPayeeUser // fee = 0
            if (!sendAll) {
              amountToSendPayeeUser = amount
            }
            // when sendAll the amount to send payeeUser is the whole balance
            else {
              amountToSendPayeeUser = balance.total_in_BTC
            }

            const onchainLoggerOnUs = onchainLogger.child({ onUs: true })

            if (
              await this.user.limitHit({ on_us: true, amount: amountToSendPayeeUser })
            ) {
              const error = `Cannot transfer more than ${this.config.limits.onUsLimit()} sats in 24 hours`
              throw new TransactionRestrictedError(error, { logger: onchainLoggerOnUs })
            }

            if (String(payeeUser._id) === String(this.user._id)) {
              throw new SelfPaymentError(undefined, { logger: onchainLoggerOnUs })
            }

            const sats = amountToSendPayeeUser
            const metadata = {
              type: "onchain_on_us",
              pending: false,
              ...UserWallet.getCurrencyEquivalent({ sats, fee: 0 }),
              payee_addresses: [address],
              sendAll,
            }

            await lockExtendOrThrow({ lock, logger: onchainLoggerOnUs }, async () => {
              const tx = await ledger.addOnUsPayment({
                description: "",
                sats,
                metadata,
                payerUser: this.user,
                payeeUser,
                memoPayer: memo,
                shareMemoWithPayee: false,
                lastPrice: UserWallet.lastPrice,
              })
              return tx
            })

            onchainLoggerOnUs.info(
              { success: true, ...metadata },
              "onchain payment succeed",
            )

            return true
          }

          // normal onchain payment path

          onchainLogger = onchainLogger.child({ onUs: false })

          if (!this.user.oldEnoughForWithdrawal) {
            const error = `New accounts have to wait ${this.config.limits.oldEnoughForWithdrawalLimit()}h before withdrawing`
            throw new NewAccountWithdrawalError(error, { logger: onchainLogger })
          }

          /// when sendAll the amount is closer to the final one by deducting the withdrawFee
          const checksAmount = sendAll
            ? balance.total_in_BTC - this.user.withdrawFee
            : amount

          if (checksAmount < this.config.dustThreshold) {
            throw new DustAmountError(undefined, { logger: onchainLogger })
          }

          if (await this.user.limitHit({ on_us: false, amount: checksAmount })) {
            const error = `Cannot withdraw more than ${this.config.limits.withdrawalLimit()} sats in 24 hours`
            throw new TransactionRestrictedError(error, { logger: onchainLogger })
          }

          // const { lnd } = getActiveOnchainLnd()

          const onChainBalance = btc2sat(await this.bitcoindWalletClient.getBalance())
          // const { chain_balance: onChainBalance } = await getChainBalance({ lnd })

          let estimatedFee, id, amountToSend

          const sendTo = [{ address, tokens: checksAmount }]

          try {
            //// (numeric, optional) estimate fee rate in BTC/kB (only present if no errors were encountered)
            const { feerate } = await this.bitcoindClient.estimateSmartFee({
              conf_target: 1,
            }) // TODO conf_target
            // 1 BTC/kB = 100000 satoshis/byte
            // TODO?? /byte? why this is added to sats amount as is and not based on the transaction size?
            estimatedFee = 100000 * feerate

            // ;({ fee: estimatedFee } = await getChainFeeEstimate({ lnd, send_to: sendTo }))
          } catch (err) {
            const error = `Unable to estimate fee for on-chain transaction`
            onchainLogger.error({ err, sendTo, success: false }, error)
            throw new LoggedError(error)
          }

          if (!sendAll) {
            amountToSend = amount

            // case where there is not enough money available within lnd on-chain wallet
            if (onChainBalance < amountToSend + estimatedFee) {
              // TODO: add a page to initiate the rebalancing quickly
              throw new RebalanceNeededError(undefined, {
                logger: onchainLogger,
                onChainBalance,
                amount: amountToSend,
                sendAll,
                estimatedFee,
                sendTo,
                success: false,
              })
            }

            // case where the user doesn't have enough money
            if (
              balance.total_in_BTC <
              amountToSend + estimatedFee + this.user.withdrawFee
            ) {
              throw new InsufficientBalanceError(undefined, { logger: onchainLogger })
            }
          }
          // when sendAll the amount to sendToChainAddress is the whole balance minus the fees
          else {
            amountToSend = balance.total_in_BTC - estimatedFee - this.user.withdrawFee

            // case where there is not enough money available within lnd on-chain wallet
            if (onChainBalance < amountToSend) {
              // TODO: add a page to initiate the rebalancing quickly
              throw new RebalanceNeededError(undefined, {
                logger: onchainLogger,
                onChainBalance,
                amount: amountToSend,
                sendAll,
                estimatedFee,
                sendTo,
                success: false,
              })
            }

            // case where the user doesn't have enough money (fees are more than the whole balance)
            if (amountToSend < 0) {
              throw new InsufficientBalanceError(undefined, { logger: onchainLogger })
            }
          }

          return lockExtendOrThrow({ lock, logger: onchainLogger }, async () => {
            try {
              // TODO use estimatedFee to avoid checking it in the next step

              id = await this.bitcoindWalletClient.sendToAddress({
                address,
                amount: sat2btc(amountToSend),
              })
              // id = await clientPayInstance.sendToAddress(address, amountToSend)

              // ;({ id } = await sendToChainAddress({ address, lnd, tokens: amountToSend }))
            } catch (err) {
              onchainLogger.error(
                { err, address, tokens: amountToSend, success: false },
                "Impossible to sendToChainAddress",
              )
              return false
            }

            let fee
            try {
              // const outgoingOnchainTxns = await getOnChainTransactions({
              //   lnd,
              //   incoming: false,
              // })
              // const [{ fee: fee_ }] = outgoingOnchainTxns.filter((tx) => tx.id === id)
              // fee = fee_

              //////////
              console.log(`vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv62`)
              console.log(`vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv62`)
              const txn = await this.bitcoindWalletClient.getTransaction({ txid: id })
              console.log(`JSON.stringify(txn): ${JSON.stringify(txn)}`)
              console.log(`vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv62`)
              console.log(`vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv62`)
              /////////
              fee = btc2sat(-txn.fee) // fee comes in BTC and negative
            } catch (err) {
              onchainLogger.fatal({ err }, "impossible to get fee for onchain payment")
              fee = 0
            }

            fee += this.user.withdrawFee

            {
              let sats // full amount debited from account
              if (!sendAll) {
                sats = amount + fee
              }
              // when sendAll the amount debited from the account is the whole balance
              else {
                sats = balance.total_in_BTC
              }

              const metadata = {
                hash: id,
                ...UserWallet.getCurrencyEquivalent({ sats, fee }),
                sendAll,
              }

              await ledger.addOnchainPayment({
                description: memo,
                sats,
                fee: this.user.withdrawFee,
                account: this.user.accountPath,
                metadata,
              })

              onchainLogger.info(
                { success: true, ...metadata },
                "successful onchain payment",
              )
            }

            return true
          })
        },
      )
    }

    async getLastOnChainAddress(): Promise<string> {
      if (this.user.onchain.length === 0) {
        // FIXME this should not be done in a query but only in a mutation?
        await this.getOnChainAddress()
      }

      return _.last(this.user.onchain_addresses) as string
    }

    async getOnChainAddress(): Promise<string> {
      // TODO
      // another option to investigate is to have a master key / client
      // (maybe this could be saved in JWT)
      // and a way for them to derive new key
      //
      // this would avoid a communication to the server
      // every time you want to show a QR code.

      // let address

      // This would be taking the hotwallet...
      // const { lnd, pubkey } = getActiveOnchainLnd()

      // try {
      //   ;({ address } = await createChainAddress({
      //     lnd,
      //     format: "p2wpkh",
      //   }))
      // } catch (err) {
      //   const error = `error getting on chain address`
      //   this.logger.error({ err }, error)
      //   throw new LoggedError(error)
      // }

      // TODO: which try catch's are required?

      // try {
      const address = await this.bitcoindWalletClient.getNewAddress({
        address_type: "bech32", // "p2sh-segwit",
      })
      // } catch (err) {
      //   const error = `error getting on chain address`
      //   this.logger.error({ err }, error)
      //   throw new LoggedError(error)
      // }

      // This pubkey should already be known... BUT I do like that is is already abstracted into getting the address...
      const { pubkey } = await this.bitcoindWalletClient.getAddressInfo({ address })
      // And just for logic compatibility it makes sense...
      // And it seems fine to start with this check being done from the address

      try {
        this.user.onchain.push({ address, pubkey })
        await this.user.save()
      } catch (err) {
        const error = `error storing new onchain address to db`
        throw new DbError(error, {
          forwardToClient: false,
          logger: this.logger,
          level: "warn",
          err,
        })
      }

      return address
    }

    async getOnchainReceipt({
      confirmed,
    }: {
      confirmed: boolean
    }): Promise<GetChainTransactionsResult["transactions"]> {
      // aka: what transactions has this user received onchain based on the wallet itself?

      // for a single hot wallet, it is the same pubkey so no filter is required
      const userAddresses = this.user.onchain.map((item) => item.address)

      // start with
      const countOfLatest = 10000 // TODO
      const latestTransactionsReceived = await this.bitcoindWalletClient.listTransactions(
        {
          count: countOfLatest,
        },
      ) // TODO? lists unconfirmed also?

      // TODO? filter by category "receive" here

      const filteredByUserAddresses = latestTransactionsReceived.filter(
        // only return transactions for addresses that belond to the user
        (tx) => _.intersection([tx.address], userAddresses).length > 0,
      )

      // TODO: expose to the yaml
      const min_confirmation = 2

      // TODO: confirmations could be negative: "Negative confirmations means the transaction conflicted that many blocks ago."

      let toReturnPre
      if (confirmed) {
        toReturnPre = filteredByUserAddresses.filter(
          (tx) => !!tx.confirmations && tx.confirmations >= min_confirmation,
        )
      } else {
        toReturnPre = filteredByUserAddresses.filter(
          (tx) =>
            (!!tx.confirmations && tx.confirmations < min_confirmation) ||
            !tx.confirmations,
        )
      }

      // finally transform to expected format
      // ///////////
      // transactions: {
      //   /** Block Hash */
      //   block_id?: string;
      //   /** Confirmation Count */
      //   confirmation_count?: number;
      //   /** Confirmation Block Height */
      //   confirmation_height?: number;
      //   /** Created ISO 8601 Date */
      //   created_at: string;
      //   /** Transaction Label */
      //   description?: string;
      //   /** Fees Paid Tokens */
      //   fee?: number;
      //   /** Transaction Id */
      //   id: string;
      //   /** Is Confirmed */
      //   is_confirmed: boolean;
      //   /** Transaction Outbound */
      //   is_outgoing: boolean;
      //   /** Addresses */
      //   output_addresses: string[];
      //   /** Tokens Including Fee */
      //   tokens: number;
      //   /** Raw Transaction Hex */
      //   transaction?: string;
      // }[];
      // ///////////
      return toReturnPre.map((tx) => ({
        block_id: tx.blockhash,
        confirmation_count: tx.confirmations,
        confirmation_height: tx.blockheight, // right?
        created_at: tx.time,
        description: tx.category, // ok? there is also a "comment"
        fee: tx.fee,
        id: tx.txid,
        is_confirmed: tx.confirmations > 0, // ok?
        is_outgoing: tx.category === "send",
        output_addresses: [tx.address], // ?
        tokens: btc2sat(tx.amount), // This is negative for the 'send' category, and is positive for all other categories
        transaction: "", // not available...
      }))

      // Currently obtains the list of transactions by:
      // - get this.user pubkeys
      // -- for each:
      // --- get this.user onchain... which is: [{ address, pubkey }] // getOnChainAddress->DONE!
      // ...
      // Thinking of changing the algorithm to this (which considers a single hot wallet for everyone, for now):
      // - get all that have received with listreceivedbyaddress(minconf=0)
      // - with all these, get the ones for this user
      // - then filter by confirmed based on the number configured (2)

      // const pubkeys: string[] = this.user.onchain_pubkey
      // let user_matched_txs: GetChainTransactionsResult["transactions"] = []

      // for (const pubkey of pubkeys) {
      //   // TODO: optimize the data structure
      //   const addresses = this.user.onchain
      //     .filter((item) => (item.pubkey = pubkey))
      //     .map((item) => item.address)

      //   let lnd: AuthenticatedLnd

      //   try {
      //     ;({ lnd } = getLndFromPubkey({ pubkey }))
      //   } catch (err) {
      //     // FIXME pass logger
      //     baseLogger.warn({ pubkey }, "node is offline")
      //     continue
      //   }

      //   const lnd_incoming_txs = await getOnChainTransactions({ lnd, incoming: true })

      //   // for unconfirmed tx:
      //   // { block_id: undefined,
      //   //   confirmation_count: undefined,
      //   //   confirmation_height: undefined,
      //   //   created_at: '2021-03-09T12:55:09.000Z',
      //   //   description: undefined,
      //   //   fee: undefined,
      //   //   id: '60dfde7a0c5209c1a8438a5c47bb5e56249eae6d0894d140996ec0dcbbbb5f83',
      //   //   is_confirmed: false,
      //   //   is_outgoing: false,
      //   //   output_addresses: [Array],
      //   //   tokens: 100000000,
      //   //   transaction: '02000000000...' }

      //   // for confirmed tx
      //   // { block_id: '0000000000000b1fa86d936adb8dea741a9ecd5f6a58fc075a1894795007bdbc',
      //   //   confirmation_count: 712,
      //   //   confirmation_height: 1744148,
      //   //   created_at: '2020-05-14T01:47:22.000Z',
      //   //   fee: undefined,
      //   //   id: '5e3d3f679bbe703131b028056e37aee35a193f28c38d337a4aeb6600e5767feb',
      //   //   is_confirmed: true,
      //   //   is_outgoing: false,
      //   //   output_addresses: [Array],
      //   //   tokens: 10775,
      //   //   transaction: '020000000001.....' }

      //   let lnd_incoming_filtered: GetChainTransactionsResult["transactions"]

      //   // TODO: expose to the yaml
      //   const min_confirmation = 2

      //   if (confirmed) {
      //     lnd_incoming_filtered = lnd_incoming_txs.filter(
      //       (tx) => !!tx.confirmation_count && tx.confirmation_count >= min_confirmation,
      //     )
      //   } else {
      //     lnd_incoming_filtered = lnd_incoming_txs.filter(
      //       (tx) =>
      //         (!!tx.confirmation_count && tx.confirmation_count < min_confirmation) ||
      //         !tx.confirmation_count,
      //     )
      //   }

      //   user_matched_txs = [
      //     ...user_matched_txs,
      //     ...lnd_incoming_filtered.filter(
      //       // only return transactions for addresses that belond to the user
      //       (tx) => _.intersection(tx.output_addresses, addresses).length > 0,
      //     ),
      //   ]
      // }

      // return user_matched_txs
    }

    // Returns both confirmed and unconfirmed transactions
    async getTransactions() {
      const confirmed: ITransaction[] = await super.getTransactions()
      // This call should be kept it seems

      //  ({
      //   created_at: moment(item.timestamp).unix(),
      //   amount: item.credit - item.debit,
      //   sat: item.sat,
      //   usd: item.usd,
      //   description: item.memoPayer || item.memo || item.type, // TODO remove `|| item.type` once users have upgraded
      //   type: item.type,
      //   hash: item.hash,
      //   fee: item.fee,
      //   feeUsd: item.feeUsd,
      //   // destination: TODO
      //   pending: item.pending,
      //   id: item._id,
      //   currency: item.currency
      //  })

      // TODO: should have outgoing unconfirmed transaction as well.
      // they are in ledger, but not necessarily confirmed

      let unconfirmed_user: GetChainTransactionsResult["transactions"] = []

      try {
        unconfirmed_user = await this.getOnchainReceipt({ confirmed: false })
      } catch (err) {
        baseLogger.warn({ user: this.user }, "impossible to fetch transactions")
        unconfirmed_user = []
      }

      // {
      //   block_id: undefined,
      //   confirmation_count: undefined,
      //   confirmation_height: undefined,
      //   created_at: '2020-10-06T17:18:26.000Z',
      //   description: undefined,
      //   fee: undefined,
      //   id: '709dcc443014d14bf906b551d60cdb814d6f98f1caa3d40dcc49688175b2146a',
      //   is_confirmed: false,
      //   is_outgoing: false,
      //   output_addresses: [Array],
      //   tokens: 100000000,
      //   transaction: '020000000001019b5e33c844cc72b093683cec8f743f1ddbcf075077e5851cc8a598a844e684850100000000feffffff022054380c0100000016001499294eb1f4936f15472a891ba400dc09bfd0aa7b00e1f505000000001600146107c29ed16bf7712347ddb731af713e68f1a50702473044022016c03d070341b8954fe8f956ed1273bb3852d3b4ba0d798e090bb5fddde9321a022028dad050cac2e06fb20fad5b5bb6f1d2786306d90a1d8d82bf91e03a85e46fa70121024e3c0b200723dda6862327135ab70941a94d4f353c51f83921fcf4b5935eb80495000000'
      // }

      const unconfirmed_promises = unconfirmed_user.map(async ({ id, created_at }) => {
        const { sats, addresses } = await this.getSatsAndAddressPerTxid(id)
        // async ({ transaction, id, created_at }) => {
        // const { sats, addresses } = await this.getSatsAndAddressPerTx(transaction)
        return { sats, addresses, id, created_at }
      })

      type unconfirmedType = { sats; addresses; id; created_at }
      const unconfirmed: unconfirmedType[] = await Promise.all(unconfirmed_promises)

      return [
        ...unconfirmed.map(({ sats, addresses, id, created_at }) => ({
          id,
          amount: sats,
          pending: true,
          created_at: moment(created_at).unix(),
          sat: sats,
          usd: UserWallet.satsToUsd(sats),
          description: "pending",
          type: "onchain_receipt" as const,
          hash: id,
          currency: "BTC",
          fee: 0,
          feeUsd: 0,
          addresses,
        })),
        ...confirmed,
      ]
    }

    // // raw encoded transaction
    // async getSatsAndAddressPerTx(tx): Promise<{ sats: number; addresses: string[] }> {
    //   const { vout } = await this.bitcoindClient.decodeRawTransaction({ hexstring: tx })

    //   //   vout: [
    //   //   {
    //   //     value: 1,
    //   //     n: 0,
    //   //     scriptPubKey: {
    //   //       asm: '0 13584315784642a24d62c7dd1073f24c60604a10',
    //   //       hex: '001413584315784642a24d62c7dd1073f24c60604a10',
    //   //       reqSigs: 1,
    //   //       type: 'witness_v0_keyhash',
    //   //       addresses: [ 'bcrt1qzdvyx9tcgep2yntzclw3quljf3sxqjsszrwx2x' ]
    //   //     }
    //   //   },
    //   //   {
    //   //     value: 46.9999108,
    //   //     n: 1,
    //   //     scriptPubKey: {
    //   //       asm: '0 44c6e3f09c2462f9825e441a69d3f2c2325f3ab8',
    //   //       hex: '001444c6e3f09c2462f9825e441a69d3f2c2325f3ab8',
    //   //       reqSigs: 1,
    //   //       type: 'witness_v0_keyhash',
    //   //       addresses: [ 'bcrt1qgnrw8uyuy330nqj7gsdxn5ljcge97w4cu4c7m0' ]
    //   //     }
    //   //   }
    //   // ]

    //   // we have to look at the precise vout because lnd sums up the value at the transaction level, not at the vout level.
    //   // ie: if an attacker send 10 to user A at Galoy, and 10 to user B at galoy in a sinle transaction,
    //   // both would be credited 20, unless we do the below filtering.
    //   const value = amountOnVout({ vout, addresses: this.user.onchain_addresses })
    //   const sats = btc2sat(value)

    //   const addresses = myOwnAddressesOnVout({
    //     vout,
    //     addresses: this.user.onchain_addresses,
    //   })

    //   return { sats, addresses }
    // }

    async getSatsAndAddressPerTxVout(
      vout: [VOut],
    ): Promise<{ sats: number; addresses: string[] }> {
      // const { vout } = await this.bitcoindClient.decodeRawTransaction({ hexstring: tx })

      //   vout: [
      //   {
      //     value: 1,
      //     n: 0,
      //     scriptPubKey: {
      //       asm: '0 13584315784642a24d62c7dd1073f24c60604a10',
      //       hex: '001413584315784642a24d62c7dd1073f24c60604a10',
      //       reqSigs: 1,
      //       type: 'witness_v0_keyhash',
      //       addresses: [ 'bcrt1qzdvyx9tcgep2yntzclw3quljf3sxqjsszrwx2x' ]
      //     }
      //   },
      //   {
      //     value: 46.9999108,
      //     n: 1,
      //     scriptPubKey: {
      //       asm: '0 44c6e3f09c2462f9825e441a69d3f2c2325f3ab8',
      //       hex: '001444c6e3f09c2462f9825e441a69d3f2c2325f3ab8',
      //       reqSigs: 1,
      //       type: 'witness_v0_keyhash',
      //       addresses: [ 'bcrt1qgnrw8uyuy330nqj7gsdxn5ljcge97w4cu4c7m0' ]
      //     }
      //   }
      // ]

      // we have to look at the precise vout because lnd sums up the value at the transaction level, not at the vout level.
      // ie: if an attacker send 10 to user A at Galoy, and 10 to user B at galoy in a sinle transaction,
      // both would be credited 20, unless we do the below filtering.
      const value = amountOnVout({ vout, addresses: this.user.onchain_addresses })
      const sats = btc2sat(value)

      const addresses = myOwnAddressesOnVout({
        vout,
        addresses: this.user.onchain_addresses,
      })

      return await { sats, addresses } // TODO? change here or remove async?
    }

    async getSatsAndAddressPerTxid(txid): Promise<{ sats: number; addresses: string[] }> {
      const { decoded } = await this.bitcoindWalletClient.getTransaction({
        txid,
        verbose: true,
      })
      return await this.getSatsAndAddressPerTxVout(decoded.vout)
    }

    async updateOnchainReceipt(lock?) {
      const user_matched_txs = await this.getOnchainReceipt({ confirmed: true })

      const type = "onchain_receipt"

      await redlock(
        { path: this.user._id, logger: baseLogger /* FIXME */, lock },
        async () => {
          // FIXME O(n) ^ 2. bad.
          for (const matched_tx of user_matched_txs) {
            // has the transaction has not been added yet to the user account?
            //
            // note: the fact we fiter with `account_path: this.user.accountPath` could create
            // double transaction for some non customer specific wallet. ie: if the path is different
            // for the dealer. this is fixed now but something to think about.
            const query = { type, hash: matched_tx.id }
            const count = await ledger.getAccountTransactionsCount(
              this.user.accountPath,
              query,
            )

            if (!count) {
              const { sats, addresses } = await this.getSatsAndAddressPerTxid(
                matched_tx.id,
              )
              // const { sats, addresses } = await this.getSatsAndAddressPerTx(
              //   matched_tx.transaction,
              // )
              assert(matched_tx.tokens >= sats)

              const fee = Math.round(sats * this.user.depositFeeRatio)

              const metadata = {
                hash: matched_tx.id,
                ...UserWallet.getCurrencyEquivalent({ sats, fee }),
                payee_addresses: addresses,
              }

              await ledger.addOnchainReceipt({
                description: "",
                sats,
                fee,
                account: this.user.accountPath,
                metadata,
              })

              const onchainLogger = this.logger.child({
                topic: "payment",
                protocol: "onchain",
                transactionType: "receipt",
                onUs: false,
              })
              onchainLogger.info({ success: true, ...metadata })
            }
          }
        },
      )
    }
  }
