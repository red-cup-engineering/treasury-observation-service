import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { observeMoonwellClaimableRewards } from "../scripts/observe-moonwell-claimable-rewards.mjs";

const DISTRIBUTOR = "0xe9005b078701e2A0948D2EaC43010D35870Ad9d2";
const WALLET = "0xCd6FA157359E3b9F88C31B95DD63A3D73A1F34cA";
const MARKET = "0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64";
const WELL = "0xA88594D404727625A9437C3f886C7643872296AE";
const distributorIface = new Interface([
  "function getOutstandingRewardsForUser(address _user) view returns (tuple(address mToken, tuple(address emissionToken, uint256 totalAmount, uint256 supplySide, uint256 borrowSide)[] rewards)[])",
]);
const erc20Meta = new Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

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

test("observeMoonwellClaimableRewards(): composes src/rewards.mjs, no reimplementation, one nonzero row per market", async () => {
  const fetchImpl = rpcFake([
    {
      to: DISTRIBUTOR, selector: distributorIface.getFunction("getOutstandingRewardsForUser").selector,
      result: distributorIface.encodeFunctionResult("getOutstandingRewardsForUser", [[
        { mToken: MARKET, rewards: [{ emissionToken: WELL, totalAmount: 472_700_000_000_000_000_000n, supplySide: 472_700_000_000_000_000_000n, borrowSide: 0n }] },
      ]]),
    },
    { to: WELL, selector: erc20Meta.getFunction("symbol").selector, result: erc20Meta.encodeFunctionResult("symbol", ["WELL"]) },
    { to: WELL, selector: erc20Meta.getFunction("decimals").selector, result: erc20Meta.encodeFunctionResult("decimals", [18]) },
  ]);
  const report = await observeMoonwellClaimableRewards({ wallet: WALLET, distributor: DISTRIBUTOR, chainId: "base" }, { fetchImpl });
  assert.equal(report.checked, true);
  assert.equal(report.rewards.length, 1);
  assert.equal(report.rewards[0].symbol, "WELL");
  assert.equal(report.rewards[0].totalAmount, "472.7");
});
