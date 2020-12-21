import { LightningBtcWallet } from "./LightningBtcWallet"
import { LightningUsdWallet } from "./LightningUsdWallet"
import { BrokerWallet } from "./BrokerWallet";

import { User } from "./mongodb"
import { login, TEST_NUMBER } from "./text";
import * as jwt from 'jsonwebtoken';
import { baseLogger, LoggedError } from "./utils";
import { getLastPrice } from "./cache";
import { regExUsername } from "./wallet";

export const WalletFactory = async ({ user, uid, logger, currency = "BTC" }: { user: any, uid: string, currency: string, logger: any }) => {
  const lastPrice = await getLastPrice()

  // TODO: remove default BTC once old tokens had been "expired"
  if (currency === "USD") {
    return new LightningUsdWallet({ lastPrice, user, uid, logger })
  } else {
    return new LightningBtcWallet({ lastPrice, user, uid, logger })
  }
}

export const WalletFromUsername = async ({ username, logger }: { username: string, logger: any }) => {
  const user = await User.findOne({ username: regExUsername({username}) })
  if (!user) {
    const error = `User not found`
    logger.warn({username}, error)
    throw new LoggedError(error)
  }

  // FIXME: there are some duplication between user and uid/currency
  const { _id, currency } = user

  return WalletFactory({ user, uid: _id, currency, logger })
}

export const getFunderWallet = async ({ logger }) => {
  const funder = await User.findOne({ username: "***REMOVED***" })
  return new LightningBtcWallet({ lastPrice: await getLastPrice(), uid: funder._id, user: funder, logger })
}

export const getBrokerWallet = async ({ logger }) => {
  const broker = await User.findOne({ role: "broker" })
  return new BrokerWallet({ lastPrice: await getLastPrice(), user: broker, uid: broker._id, logger })
}

export const getTokenFromPhoneIndex = async (index) => {
  const entry = {...TEST_NUMBER[index]}
  const raw_token = await login({ ...entry, logger: baseLogger })
  const token = jwt.verify(raw_token, process.env.JWT_SECRET);

  if (entry.username) {
    const { uid } = token
    await User.findOneAndUpdate({ _id: uid }, { username: entry.username })
  }
  return token
}

// change role to broker
// FIXME there should be an API for this
// FIXME: this "power" user should not be able to log from a phone number
export async function createBrokerUid() {
  const { uid } = await getTokenFromPhoneIndex(7)
  await User.findOneAndUpdate({ _id: uid }, { role: "broker" })
}