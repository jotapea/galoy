import { bitcoindClient, bitcoindOutside, getUserWallet } from "test/helpers"

jest.mock("@services/realtime-price", () => require("test/mocks/realtime-price"))
jest.mock("@services/phone-provider", () => require("test/mocks/phone-provider"))

let userWallet0, userWallet1

beforeAll(async () => {
  userWallet0 = await getUserWallet(0)
  userWallet1 = await getUserWallet(1)
  // await bitcoindClient.loadWallet({ filename: "outside" })
  // await bitcoindClient.loadWallet({ filename: "hot" })
})

// afterAll(async () => {
//   await bitcoindClient.unloadWallet({ wallet_name: "outside" })
//   await bitcoindClient.unloadWallet({ wallet_name: "hot" })
// })

describe("UserWallet - getOnchainFee", () => {
  // TODO fails with Error: ["Insufficient data or no feerate found"]
  it.skip("returns a fee greater than zero for an external address", async () => {
    const address = await bitcoindOutside.getNewAddress({})
    const fee = await userWallet0.getOnchainFee({ address })
    expect(fee).toBeGreaterThan(0)
  })

  it("returns zero for an on us address", async () => {
    const address = await userWallet1.getOnChainAddress()
    const fee = await userWallet0.getOnchainFee({ address })
    expect(fee).toBe(0)
  })
})
