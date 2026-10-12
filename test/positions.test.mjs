import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { CHAINS } from "../src/chains.mjs";
import { observeVaultPosition, observeCompoundForkMarket } from "../src/positions.mjs";

const VAULT = "0x1c43d0d5c9f62db3b9e0c5d6e5b7a9c0f6f6f6f1";
const MARKET = "0x1111111111111111111111111111111111111111";
const WALLET = "0x32886F6F361C1d570255c2762967A2e41D0E9B1a";
const erc20 = new Interface(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const vaultIface = new Interface(["function getPricePerFullShare() view returns (uint256)"]);
const cTokenIface = new Interface([
  "function getAccountSnapshot(address) view returns (uint256,uint256,uint256,uint256)",
  "function symbol() view returns (string)",
  "function underlying() view returns (address)",
  "function supplyRatePerTimestamp() view returns (uint256)",
  "function borrowRatePerTimestamp() view returns (uint256)",
]);
const decimalsIface = new Interface(["function decimals() view returns (uint8)"]);

function encodedFake(rows) {
  return async (url, init) => {
    const { data } = JSON.parse(init.body).params[0];
    for (const [selector, result] of rows) {
      if (data.startsWith(selector)) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
}

test("observeVaultPosition(): computes underlying amount from shares × price-per-share", async () => {
  const fetchImpl = encodedFake([
    [erc20.getFunction("balanceOf").selector, erc20.encodeFunctionResult("balanceOf", [15965393491500772420573n])],
    [erc20.getFunction("decimals").selector, erc20.encodeFunctionResult("decimals", [18])],
    [erc20.getFunction("symbol").selector, erc20.encodeFunctionResult("symbol", ["mooDOGINME"])],
    [vaultIface.getFunction("getPricePerFullShare").selector, vaultIface.encodeFunctionResult("getPricePerFullShare", [10n ** 18n])],
  ]);
  const p = await observeVaultPosition(CHAINS.base, VAULT, WALLET, { fetchImpl });
  assert.equal(p.checked, true);
  assert.equal(p.empty, false);
  assert.equal(p.underlyingRaw, "15965393491500772420573");
  assert.equal(p.priceSource, "onchain");
});

test("observeVaultPosition(): falls back to Beefy's public API when on-chain getPricePerFullShare() fails", async () => {
  const rpc = encodedFake([
    [erc20.getFunction("balanceOf").selector, erc20.encodeFunctionResult("balanceOf", [1000000000000000000n])],
    [erc20.getFunction("decimals").selector, erc20.encodeFunctionResult("decimals", [18])],
    [erc20.getFunction("symbol").selector, erc20.encodeFunctionResult("symbol", ["rmooAeroWETH-QI"])],
    // getPricePerFullShare() deliberately NOT in this table — every RPC attempt "fails".
  ]);
  const fetchImpl = async (url, init) => {
    if (init?.body === undefined) {
      // The Beefy vaults GET, not a JSON-RPC POST.
      return {
        ok: true, status: 200,
        json: async () => ([
          { id: "aerodrome-weth-qi", chain: "base", earnedTokenAddress: VAULT, pricePerFullShare: "4331774333684763880" },
        ]),
      };
    }
    return rpc(url, init);
  };
  const p = await observeVaultPosition(CHAINS.base, VAULT, WALLET, { fetchImpl });
  assert.equal(p.checked, true);
  assert.equal(p.empty, false);
  assert.equal(p.priceSource, "beefy-api");
  assert.equal(p.pricePerFullShareRaw, "4331774333684763880");
  assert.equal(p.underlyingRaw, "4331774333684763880");
});

test("observeVaultPosition(): both on-chain AND Beefy failing is checked:false naming both reasons, never a silent zero", async () => {
  const rpc = encodedFake([
    [erc20.getFunction("balanceOf").selector, erc20.encodeFunctionResult("balanceOf", [1000000000000000000n])],
    [erc20.getFunction("decimals").selector, erc20.encodeFunctionResult("decimals", [18])],
    [erc20.getFunction("symbol").selector, erc20.encodeFunctionResult("symbol", ["mooGhost"])],
  ]);
  const fetchImpl = async (url, init) => {
    if (init?.body === undefined) {
      return { ok: true, status: 200, json: async () => ([]) }; // no matching vault in Beefy's list either
    }
    return rpc(url, init);
  };
  const p = await observeVaultPosition(CHAINS.base, VAULT, WALLET, { fetchImpl });
  assert.equal(p.checked, false);
  assert.match(p.reason, /on-chain getPricePerFullShare\(\) failed/);
  assert.match(p.reason, /beefy api fallback also failed/);
  assert.equal(p.shares.raw, "1000000000000000000");
  assert.equal(p.shares.checked, true);
  assert.equal(p.empty, false);
  assert.equal("underlyingRaw" in p, false);
});

test("observeVaultPosition(): an empty share balance is reported empty without pricing it", async () => {
  const fetchImpl = encodedFake([
    [erc20.getFunction("balanceOf").selector, erc20.encodeFunctionResult("balanceOf", [0n])],
    [erc20.getFunction("decimals").selector, erc20.encodeFunctionResult("decimals", [18])],
    [erc20.getFunction("symbol").selector, erc20.encodeFunctionResult("symbol", ["mooX"])],
  ]);
  const p = await observeVaultPosition(CHAINS.base, VAULT, WALLET, { fetchImpl });
  assert.equal(p.checked, true);
  assert.equal(p.empty, true);
  assert.equal("underlyingRaw" in p, false);
});

test("observeCompoundForkMarket(): reports supplied and borrowed underlying with current rates", async () => {
  const fetchImpl = encodedFake([
    [cTokenIface.getFunction("getAccountSnapshot").selector, cTokenIface.encodeFunctionResult("getAccountSnapshot", [0n, 1000000n, 0n, 10n ** 18n])],
    [cTokenIface.getFunction("symbol").selector, cTokenIface.encodeFunctionResult("symbol", ["mUSDC"])],
    [cTokenIface.getFunction("underlying").selector, cTokenIface.encodeFunctionResult("underlying", ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"])],
    [cTokenIface.getFunction("supplyRatePerTimestamp").selector, cTokenIface.encodeFunctionResult("supplyRatePerTimestamp", [1000n])],
    [cTokenIface.getFunction("borrowRatePerTimestamp").selector, cTokenIface.encodeFunctionResult("borrowRatePerTimestamp", [2000n])],
    [decimalsIface.getFunction("decimals").selector, decimalsIface.encodeFunctionResult("decimals", [6])],
  ]);
  const p = await observeCompoundForkMarket(CHAINS.base, MARKET, WALLET, { fetchImpl });
  assert.equal(p.checked, true);
  assert.equal(p.suppliedUnderlyingRaw, "1000000");
  assert.equal(p.suppliedUnderlyingAmount, "1");
  assert.equal(p.borrowedUnderlyingRaw, "0");
  assert.equal(p.empty, false);
  assert.equal(p.symbol, "mUSDC");
  assert.equal(p.supplyRatePerTimestampMantissa, "1000");
  assert.equal(p.borrowRatePerTimestampMantissa, "2000");
});

test("observeCompoundForkMarket(): a nonzero snapshot error code is NOT reported as a position", async () => {
  const fetchImpl = encodedFake([
    [cTokenIface.getFunction("getAccountSnapshot").selector, cTokenIface.encodeFunctionResult("getAccountSnapshot", [9n, 0n, 0n, 0n])],
  ]);
  const p = await observeCompoundForkMarket(CHAINS.base, MARKET, WALLET, { fetchImpl });
  assert.equal(p.checked, false);
  assert.match(p.reason, /error code 9/);
});

test("observeCompoundForkMarket(): reads Moonwell supply and borrow rates through the fixed Base boundary", async () => {
  const boundary = Object.freeze({ chain: "base", chainId: 8453, caip2: "eip155:8453", requestedFinality: "finalized",
    finality: "finalized", blockNumber: "100", blockTag: "0x64", blockHash: `0x${"ab".repeat(32)}`,
    observedAt: "2026-09-01T12:00:00.000Z", provider: CHAINS.base.rpc[0] });
  const underlying = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const rows = [
    [cTokenIface, "getAccountSnapshot", cTokenIface.encodeFunctionResult("getAccountSnapshot", [0n, 1000000n, 2n, 10n ** 18n])],
    [cTokenIface, "symbol", cTokenIface.encodeFunctionResult("symbol", ["mUSDC"])],
    [cTokenIface, "underlying", cTokenIface.encodeFunctionResult("underlying", [underlying])],
    [cTokenIface, "supplyRatePerTimestamp", cTokenIface.encodeFunctionResult("supplyRatePerTimestamp", [1000n])],
    [cTokenIface, "borrowRatePerTimestamp", cTokenIface.encodeFunctionResult("borrowRatePerTimestamp", [2000n])],
    [decimalsIface, "decimals", decimalsIface.encodeFunctionResult("decimals", [6])],
  ];
  const methods = [];
  const publicEvmReadPool = { async requestAtBoundary({ boundary: selected, method, params }) {
    assert.equal(selected.blockHash, boundary.blockHash);
    methods.push(method);
    const [{ data }] = params;
    const row = rows.find(([iface, fn]) => data.startsWith(iface.getFunction(fn).selector));
    if (row == null) throw new Error("unexpected fixed-boundary market read");
    return { value: row[2], provider: { url: CHAINS.base.rpc[1] } };
  } };
  const position = await observeCompoundForkMarket(CHAINS.base, MARKET, WALLET, { boundary, publicEvmReadPool });
  assert.equal(position.checked, true);
  assert.equal(position.supplyRatePerTimestampMantissa, "1000");
  assert.equal(position.borrowRatePerTimestampMantissa, "2000");
  assert.equal(methods.length, 6);
  assert.ok(methods.every((method) => method === "eth_call"));
});


test("failed finalized vault conversion retains checked shares at their original boundary", async () => {
  const boundary = { chain: "base", chainId: 8453, caip2: "eip155:8453", requestedFinality: "finalized", blockNumber: "100", blockTag: "0x64", blockHash: "0x" + "a".repeat(64), provider: CHAINS.base.rpc[0], observedAt: "2026-10-08T01:00:00Z", finality: "finalized" };
  const rpc = encodedFake([
    [erc20.getFunction("balanceOf").selector, erc20.encodeFunctionResult("balanceOf", [123456789n])],
    [erc20.getFunction("decimals").selector, erc20.encodeFunctionResult("decimals", [18])],
    [erc20.getFunction("symbol").selector, erc20.encodeFunctionResult("symbol", ["rmooTEST"])],
  ]);
  let apiCalls = 0;
  const fetchImpl = (url, init) => {
    if (!init?.body) { apiCalls++; throw new Error("unpinned API forbidden"); }
    const body = JSON.parse(init.body);
    if (body.method === "eth_chainId") return Promise.resolve({ ok: true, json: async () => ({ result: "0x2105" }) });
    if (body.method === "eth_getBlockByNumber") return Promise.resolve({ ok: true, json: async () => ({ result: { number: boundary.blockTag, hash: boundary.blockHash } }) });
    assert.equal(body.params.at(-1), boundary.blockTag);
    return rpc(url, init);
  };
  const p = await observeVaultPosition(CHAINS.base, VAULT, WALLET, { fetchImpl, boundary });
  assert.equal(p.checked, false);
  assert.equal(p.empty, false);
  assert.equal(p.shares.checked, true);
  assert.equal(p.shares.raw, "123456789");
  assert.equal(p.provenance.blockHash, boundary.blockHash);
  assert.deepEqual(p.provenance, p.shares.provenance);
  assert.equal("underlyingRaw" in p, false);
  assert.equal("pricePerFullShareRaw" in p, false);
  assert.equal(apiCalls, 0);
});


test("v2 boost retains deposited vault shares, converts their quantity, and decodes every unpaid reward", async () => {
  const boost = new Interface(["function stakedToken() view returns (address)", "function earned(address) view returns (address[],uint256[])"]);
  const stakedToken = "0x2222222222222222222222222222222222222222";
  const rewardTokens = ["0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444"];
  const rpc = encodedFake([
    [erc20.getFunction("balanceOf").selector, erc20.encodeFunctionResult("balanceOf", [1000000000000000000n])],
    [erc20.getFunction("decimals").selector, erc20.encodeFunctionResult("decimals", [18])],
    [erc20.getFunction("symbol").selector, erc20.encodeFunctionResult("symbol", ["rmooTEST"])],
    [boost.getFunction("stakedToken").selector, boost.encodeFunctionResult("stakedToken", [stakedToken])],
    [boost.getFunction("earned").selector, boost.encodeFunctionResult("earned", [rewardTokens, [123n, 456n]])],
  ]);
  let conversionTarget;
  const fetchImpl = (url, init) => {
    const [{ to, data }] = JSON.parse(init.body).params;
    if (data.startsWith(vaultIface.getFunction("getPricePerFullShare").selector) && to.toLowerCase() === stakedToken.toLowerCase()) {
      conversionTarget = to;
      return Promise.resolve({ ok: true, json: async () => ({ result: vaultIface.encodeFunctionResult("getPricePerFullShare", [2000000000000000000n]) }) });
    }
    return rpc(url, init);
  };
  const p = await observeVaultPosition(CHAINS.base, VAULT, WALLET, { fetchImpl });
  assert.equal(p.checked, true);
  assert.equal(p.positionKind, "staking-boost");
  assert.equal(p.shares.raw, "1000000000000000000");
  assert.equal(p.stakedAsset.token.toLowerCase(), conversionTarget.toLowerCase());
  assert.equal(p.stakedAsset.raw, p.shares.raw);
  assert.equal(p.stakedAsset.underlyingRaw, "2000000000000000000");
  assert.deepEqual(p.earnedRewards, rewardTokens.map((token, i) => ({ token, raw: ["123", "456"][i] })));
  assert.equal("underlyingRaw" in p, false);
  const duplicateRewards = async (url, init) => {
    const [{data}] = JSON.parse(init.body).params;
    if (data.startsWith(boost.getFunction("earned").selector)) return {ok: true, json: async () => ({result: boost.encodeFunctionResult("earned", [[rewardTokens[0], rewardTokens[0]], [123n, 456n]])})};
    return fetchImpl(url, init);
  };
  const refused = await observeVaultPosition(CHAINS.base, VAULT, WALLET, {fetchImpl: duplicateRewards});
  assert.equal(refused.checked, false);
  assert.equal(refused.shares.raw, p.shares.raw);
  assert.equal(refused.stakedAsset.underlyingRaw, p.stakedAsset.underlyingRaw);
  assert.equal("earnedRewards" in refused, false);
  assert.match(refused.reason, /distinct boost reward/);
});
