import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { CHAINS } from "../src/chains.mjs";
import { deriveAccruedYield, fetchMorphoVaultApy, observeMorphoConvertToShares, observeMorphoVaultPosition } from "../src/morpho.mjs";

const VAULT = "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OWNER = "0xCd6FA157359E3b9F88C31B95DD63A3D73A1F34cA";
const vaultIface = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256 assets)",
  "function convertToShares(uint256 assets) view returns (uint256 shares)",
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
]);

/** Routes by (to, selector); optionally makes one labeled call return a different value at the
 *  second registered Base endpoint, to exercise the disagreement path. */
function rpcFake(rows, { disagreeAt } = {}) {
  return async (url, init) => {
    const { to, data } = JSON.parse(init.body).params[0];
    for (const row of rows) {
      if (to.toLowerCase() === row.to.toLowerCase() && data.startsWith(row.selector)) {
        const result = disagreeAt === row.label && url === CHAINS.base.rpc[1] ? row.altResult : row.result;
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
      }
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
}

function rows() {
  return [
    { to: VAULT, label: "balanceOf", selector: vaultIface.getFunction("balanceOf").selector, result: vaultIface.encodeFunctionResult("balanceOf", [1_000_000n]) },
    { to: VAULT, label: "decimals", selector: vaultIface.getFunction("decimals").selector, result: vaultIface.encodeFunctionResult("decimals", [18]) },
    { to: VAULT, label: "asset", selector: vaultIface.getFunction("asset").selector, result: vaultIface.encodeFunctionResult("asset", [ASSET]) },
    { to: ASSET, label: "assetDecimals", selector: vaultIface.getFunction("decimals").selector, result: vaultIface.encodeFunctionResult("decimals", [6]) },
    { to: VAULT, label: "convertToAssets", selector: vaultIface.getFunction("convertToAssets").selector, result: vaultIface.encodeFunctionResult("convertToAssets", [1_050_000n]), altResult: vaultIface.encodeFunctionResult("convertToAssets", [1_050_000n]) },
  ];
}

test("observeMorphoVaultPosition(): two independent Base endpoints agreeing yields a checked, non-empty position", async () => {
  const fetchImpl = rpcFake(rows());
  const position = await observeMorphoVaultPosition(CHAINS.base, VAULT, OWNER, { fetchImpl });
  assert.equal(position.checked, true);
  assert.equal(position.empty, false);
  assert.equal(position.shares.raw, "1000000");
  assert.equal(position.assets.raw, "1050000");
  assert.equal(position.assets.amount, "1.05");
  assert.deepEqual(position.sources, [CHAINS.base.rpc[0], CHAINS.base.rpc[1]]);
});

test("observeMorphoVaultPosition(): a zero share balance reports checked and empty, never a fabricated assets read", async () => {
  const zeroRows = rows().map((row) => (row.label === "balanceOf"
    ? { ...row, result: vaultIface.encodeFunctionResult("balanceOf", [0n]) } : row));
  const fetchImpl = rpcFake(zeroRows);
  const position = await observeMorphoVaultPosition(CHAINS.base, VAULT, OWNER, { fetchImpl });
  assert.equal(position.checked, true);
  assert.equal(position.empty, true);
  assert.equal(position.shares.raw, "0");
});

test("observeMorphoVaultPosition(): endpoints disagreeing on convertToAssets is refused, never averaged", async () => {
  const disagreeRows = rows().map((row) => (row.label === "convertToAssets"
    ? { ...row, altResult: vaultIface.encodeFunctionResult("convertToAssets", [999_999n]) } : row));
  const fetchImpl = rpcFake(disagreeRows, { disagreeAt: "convertToAssets" });
  const position = await observeMorphoVaultPosition(CHAINS.base, VAULT, OWNER, { fetchImpl });
  assert.equal(position.checked, false);
  assert.match(position.reason, /independent sources disagree on convertToAssets/);
});

test("observeMorphoVaultPosition(): a chain with fewer than two registered RPC endpoints is refused, never silently read from one", async () => {
  const oneEndpointChain = { ...CHAINS.base, rpc: [CHAINS.base.rpc[0]] };
  const position = await observeMorphoVaultPosition(oneEndpointChain, VAULT, OWNER, { fetchImpl: rpcFake(rows()) });
  assert.equal(position.checked, false);
  assert.match(position.reason, /two independent sources are required/);
});

test("observeMorphoConvertToShares(): two independent Base endpoints agreeing yields a checked share count", async () => {
  const convertToSharesRows = [
    { to: VAULT, label: "convertToShares", selector: vaultIface.getFunction("convertToShares").selector, result: vaultIface.encodeFunctionResult("convertToShares", [47_619n]) },
  ];
  const fetchImpl = rpcFake(convertToSharesRows);
  const result = await observeMorphoConvertToShares(CHAINS.base, VAULT, "50000", { fetchImpl });
  assert.equal(result.checked, true);
  assert.equal(result.sharesRaw, "47619");
});

test("deriveAccruedYield(): assets above principal is the accrued amount", () => {
  const accrued = deriveAccruedYield({ assetsRaw: "1050000", principalAssetsRaw: "1000000", decimals: 6 });
  assert.equal(accrued.accruedRaw, "50000");
  assert.equal(accrued.accruedAmount, "0.05");
  assert.equal(accrued.nonNegative, true);
});

test("deriveAccruedYield(): assets below principal is reported honestly, never clamped to zero", () => {
  const accrued = deriveAccruedYield({ assetsRaw: "900000", principalAssetsRaw: "1000000", decimals: 6 });
  assert.equal(accrued.accruedRaw, "-100000");
  assert.equal(accrued.accruedAmount, "-0.1");
  assert.equal(accrued.nonNegative, false);
});

test("fetchMorphoVaultApy(): parses state.netApy from the documented Morpho GraphQL response shape", async () => {
  const fetchImpl = async () => ({
    ok: true, status: 200,
    json: async () => ({ data: { vaultByAddress: { state: { apy: 0.045, netApy: 0.0422, netApyExcludingRewards: 0.0422 } } } }),
  });
  const apy = await fetchMorphoVaultApy({ vault: VAULT, chainId: 8453 }, { fetchImpl });
  assert.equal(apy.checked, true);
  assert.equal(apy.netApy, 0.0422);
});

test("fetchMorphoVaultApy(): an http failure is reported as unreachable, never a fabricated rate", async () => {
  const fetchImpl = async () => ({ ok: false, status: 503 });
  const apy = await fetchMorphoVaultApy({ vault: VAULT, chainId: 8453 }, { fetchImpl });
  assert.equal(apy.checked, false);
  assert.match(apy.reason, /morpho api http 503/);
});
