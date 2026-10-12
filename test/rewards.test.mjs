import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { CHAINS } from "../src/chains.mjs";
import { observeMoonwellOutstandingRewards } from "../src/rewards.mjs";

const DISTRIBUTOR = "0xe9005b078701e2A0948D2EaC43010D35870Ad9d2";
const WALLET = "0x32886F6F361C1d570255c2762967A2e41D0E9B1a";
const MARKET_A = "0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64";
const MARKET_B = "0xEdc817A28E8B93B03976FBd4a3dDBc9f7D176c22";
const WELL = "0xA88594D404727625A9437C3f886C7643872296AE";

const distributorIface = new Interface([
  "function getOutstandingRewardsForUser(address _user) view returns (tuple(address mToken, tuple(address emissionToken, uint256 totalAmount, uint256 supplySide, uint256 borrowSide)[] rewards)[])",
]);
const erc20Meta = new Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

/** Route eth_call by (to, selector), same fake shape as positions.test.mjs and tokens.test.mjs. */
function rpcFake(rows) {
  return async (url, init) => {
    const { to, data } = JSON.parse(init.body).params[0];
    for (const row of rows) {
      if (to.toLowerCase() === row.to.toLowerCase() && data.startsWith(row.selector)) {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: row.result }) };
      }
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
}

function rewardsResult(rows) {
  return distributorIface.encodeFunctionResult("getOutstandingRewardsForUser", [rows]);
}

test("observeMoonwellOutstandingRewards(): decodes nonzero rows and resolves emission-token symbol/decimals", async () => {
  const fetchImpl = rpcFake([
    {
      to: DISTRIBUTOR, selector: distributorIface.getFunction("getOutstandingRewardsForUser").selector,
      result: rewardsResult([
        { mToken: MARKET_A, rewards: [{ emissionToken: WELL, totalAmount: 12693409352868661774n, supplySide: 12693409352868661774n, borrowSide: 0n }] },
      ]),
    },
    { to: WELL, selector: erc20Meta.getFunction("symbol").selector, result: erc20Meta.encodeFunctionResult("symbol", ["WELL"]) },
    { to: WELL, selector: erc20Meta.getFunction("decimals").selector, result: erc20Meta.encodeFunctionResult("decimals", [18]) },
  ]);
  const r = await observeMoonwellOutstandingRewards(CHAINS.base, DISTRIBUTOR, WALLET, { fetchImpl });
  assert.equal(r.checked, true);
  assert.equal(r.rewards.length, 1);
  assert.equal(r.rewards[0].market, MARKET_A);
  assert.equal(r.rewards[0].emissionToken, WELL);
  assert.equal(r.rewards[0].symbol, "WELL");
  assert.equal(r.rewards[0].decimals, 18);
  assert.equal(r.rewards[0].totalAmountRaw, "12693409352868661774");
  assert.equal(r.rewards[0].totalAmount, "12.693409352868661774");
});

test("observeMoonwellOutstandingRewards(): an all-zero response reports checked with an empty rewards array, never a fabricated row", async () => {
  const fetchImpl = rpcFake([
    {
      to: DISTRIBUTOR, selector: distributorIface.getFunction("getOutstandingRewardsForUser").selector,
      result: rewardsResult([
        { mToken: MARKET_A, rewards: [{ emissionToken: WELL, totalAmount: 0n, supplySide: 0n, borrowSide: 0n }] },
        { mToken: MARKET_B, rewards: [{ emissionToken: WELL, totalAmount: 0n, supplySide: 0n, borrowSide: 0n }] },
      ]),
    },
  ]);
  const r = await observeMoonwellOutstandingRewards(CHAINS.base, DISTRIBUTOR, WALLET, { fetchImpl });
  assert.equal(r.checked, true);
  assert.deepEqual(r.rewards, []);
});

test("observeMoonwellOutstandingRewards(): an unreachable distributor is checked:false, never a zero", async () => {
  const r = await observeMoonwellOutstandingRewards(CHAINS.base, DISTRIBUTOR, WALLET, {
    fetchImpl: async () => { throw new Error("521"); },
  });
  assert.equal(r.checked, false);
  assert.equal("rewards" in r, false);
  assert.ok(r.reason);
});

test("observeMoonwellOutstandingRewards(): one emission token's symbol()/decimals() lookup is shared across markets, not repeated per row", async () => {
  let symbolCalls = 0;
  const base = rpcFake([
    {
      to: DISTRIBUTOR, selector: distributorIface.getFunction("getOutstandingRewardsForUser").selector,
      result: rewardsResult([
        { mToken: MARKET_A, rewards: [{ emissionToken: WELL, totalAmount: 1000000000000000000n, supplySide: 1000000000000000000n, borrowSide: 0n }] },
        { mToken: MARKET_B, rewards: [{ emissionToken: WELL, totalAmount: 2000000000000000000n, supplySide: 0n, borrowSide: 2000000000000000000n }] },
      ]),
    },
    { to: WELL, selector: erc20Meta.getFunction("symbol").selector, result: erc20Meta.encodeFunctionResult("symbol", ["WELL"]) },
    { to: WELL, selector: erc20Meta.getFunction("decimals").selector, result: erc20Meta.encodeFunctionResult("decimals", [18]) },
  ]);
  const fetchImpl = async (url, init) => {
    const { to, data } = JSON.parse(init.body).params[0];
    if (to.toLowerCase() === WELL.toLowerCase() && data.startsWith(erc20Meta.getFunction("symbol").selector)) symbolCalls += 1;
    return base(url, init);
  };
  const r = await observeMoonwellOutstandingRewards(CHAINS.base, DISTRIBUTOR, WALLET, { fetchImpl });
  assert.equal(r.checked, true);
  assert.equal(r.rewards.length, 2);
  assert.equal(symbolCalls, 1);
});
