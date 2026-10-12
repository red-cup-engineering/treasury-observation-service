import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { CHAINS } from "../src/chains.mjs";
import { observeMorphoVaultPositionReport } from "../scripts/observe-morpho-vault-position.mjs";

const VAULT = "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OWNER = "0xCd6FA157359E3b9F88C31B95DD63A3D73A1F34cA";
const vaultIface = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256 assets)",
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
]);

function fetchImpl(url, init) {
  if (url === "https://api.morpho.org/graphql") {
    return { ok: true, status: 200, json: async () => ({ data: { vaultByAddress: { state: { apy: 0.045, netApy: 0.042, netApyExcludingRewards: 0.04 } } } }) };
  }
  const { to, data } = JSON.parse(init.body).params[0];
  const encoded = {
    [`${VAULT}:${vaultIface.getFunction("balanceOf").selector}`]: vaultIface.encodeFunctionResult("balanceOf", [1_000_000n]),
    [`${VAULT}:${vaultIface.getFunction("decimals").selector}`]: vaultIface.encodeFunctionResult("decimals", [18]),
    [`${VAULT}:${vaultIface.getFunction("asset").selector}`]: vaultIface.encodeFunctionResult("asset", [ASSET]),
    [`${ASSET}:${vaultIface.getFunction("decimals").selector}`]: vaultIface.encodeFunctionResult("decimals", [6]),
    [`${VAULT}:${vaultIface.getFunction("convertToAssets").selector}`]: vaultIface.encodeFunctionResult("convertToAssets", [1_050_000n]),
  };
  const result = encoded[`${to}:${data.slice(0, 10)}`];
  return result === undefined
    ? { ok: false, status: 500, json: async () => ({}) }
    : { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
}

test("observeMorphoVaultPositionReport(): folds APY and accrued yield onto a checked, non-empty position", async () => {
  const report = await observeMorphoVaultPositionReport(
    { owner: OWNER, vault: VAULT, principalAssetsRaw: "1000000", chainId: "base" }, { fetchImpl },
  );
  assert.equal(report.checked, true);
  assert.equal(report.assets.raw, "1050000");
  assert.equal(report.apy.checked, true);
  assert.equal(report.apy.netApy, 0.042);
  assert.equal(report.accrued.checked, true);
  assert.equal(report.accrued.accruedRaw, "50000");
});

test("observeMorphoVaultPositionReport(): a non-empty position without a supplied principal refuses accrued yield rather than inventing one", async () => {
  const report = await observeMorphoVaultPositionReport({ owner: OWNER, vault: VAULT, chainId: "base" }, { fetchImpl });
  assert.equal(report.checked, true);
  assert.equal(report.accrued.checked, false);
  assert.match(report.accrued.reason, /never invented/);
});

test("observeMorphoVaultPositionReport(): CHAINS.base is used by default and its two lead RPCs both answer the fake", async () => {
  assert.ok(CHAINS.base.rpc.length >= 2);
});
