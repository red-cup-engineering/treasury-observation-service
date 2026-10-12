import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEarningOpportunity } from "@red-cup-engineering/normalize-earning-opportunity-service";
import { observeHiveEngineLiquidityOpportunity } from "@red-cup-engineering/observe-hive-engine-liquidity-opportunity-service";

const OBSERVED_AT = "2026-09-02T02:32:05.207Z";
const BLOCK_ID = "a".repeat(64);

function response(result) {
  return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
}

function fetchFixture(calls) {
  return async (endpoint, options) => {
    const request = JSON.parse(options.body);
    calls.push({ endpoint, request });
    if (request.method === "getLatestBlockInfo") return response({ blockNumber: 987, hash: BLOCK_ID });
    const { contract, table, query } = request.params;
    if (contract === "tokens" && table === "balances") {
      return response([{ account: query.account, symbol: query.symbol, balance: query.symbol === "ZING" ? "35834.510" : "69.00738622" }]);
    }
    if (contract === "marketpools" && table === "pools") {
      return response([{ tokenPair: "ZING:SWAP.HIVE", baseQuantity: "44891805.37004403", quoteQuantity: "29661.25516993", totalShares: "1105463.01348207779783664309" }]);
    }
    if (contract === "marketpools" && table === "params") return response([{ tradeFeeMul: "0.9975" }]);
    throw new Error("unexpected fixture request");
  };
}

test("observeHiveEngineLiquidityOpportunity(): preserves fee, capacity, exit, risks, and boundary provenance", async () => {
  const calls = [];
  const candidate = await observeHiveEngineLiquidityOpportunity({
    account: "michael561", baseSymbol: "ZING", quoteSymbol: "SWAP.HIVE",
  }, { fetchImpl: fetchFixture(calls), now: () => new Date(OBSERVED_AT) });

  assert.equal(candidate.type, "NormalizedEarningOpportunity");
  assert.equal(candidate.account, "michael561");
  assert.match(candidate.mechanism, /0\.0025 gross swap fee/u);
  assert.deepEqual(candidate.apy, {
    availability: "unavailable", value: null, unit: "fraction-per-year",
    denomination: "ZING:SWAP.HIVE pool-share value",
    method: "gross fee fraction 0.0025; APY requires time-bounded volume and pool-share history",
    reason: "the public contract table exposes cumulative volume, not a time-bounded fee series",
  });
  assert.deepEqual(candidate.liquidity.accountAvailable, { ZING: "35834.510", "SWAP.HIVE": "69.00738622" });
  assert.deepEqual(candidate.liquidity.capacity, {
    ZING: "44891805.37004403", "SWAP.HIVE": "29661.25516993", totalShares: "1105463.01348207779783664309",
  });
  assert.equal(candidate.changedRisks.length, 4);
  assert.equal(candidate.exit.operation, "Hive Engine marketpools removeLiquidity");
  assert.deepEqual(candidate.freshness.chainBoundary, { blockNumber: 987, blockHash: BLOCK_ID });
  assert.equal(candidate.freshness.provenance.length, 6);
  assert.equal(calls.length, 6);
  assert.equal(JSON.stringify(candidate).includes("key"), false);
  assert.equal(JSON.stringify(candidate).includes("transaction"), true);
});

test("observeHiveEngineLiquidityOpportunity(): refuses missing holdings before producing a candidate", async () => {
  const calls = [];
  const fixture = fetchFixture(calls);
  await assert.rejects(() => observeHiveEngineLiquidityOpportunity({
    account: "michael561", baseSymbol: "ZING", quoteSymbol: "SWAP.HIVE",
  }, {
    now: () => new Date(OBSERVED_AT),
    fetchImpl: async (endpoint, options) => {
      const request = JSON.parse(options.body);
      if (request.params?.contract === "tokens" && request.params.query.symbol === "ZING") {
        return response([{ account: "michael561", symbol: "ZING", balance: "0" }]);
      }
      return fixture(endpoint, options);
    },
  }), /must be a positive decimal/u);
});

test("normalizeEarningOpportunity(): unavailable APY cannot masquerade as zero yield", () => {
  assert.throws(() => normalizeEarningOpportunity({
    id: "x", chain: "hive", account: "a", provider: "p", mechanism: "m", underlyings: ["HIVE"],
    apy: { availability: "unavailable", value: "0", denomination: "HIVE", method: "none", reason: "unknown" },
    liquidity: { kind: "none", capacity: {}, accountAvailable: {} }, changedRisks: ["risk"],
    exit: { operation: "exit", receives: ["HIVE"], constraints: ["constraint"] },
    freshness: { observedAt: OBSERVED_AT, chainBoundary: {}, provenance: [{}] },
  }), /unavailable APY must be null/u);
});

test("observeHiveEngineLiquidityOpportunity(): refuses table values when the sidechain advances", async () => {
  let boundaryReads = 0;
  const fixture = fetchFixture([]);
  await assert.rejects(() => observeHiveEngineLiquidityOpportunity({
    account: "michael561", baseSymbol: "ZING", quoteSymbol: "SWAP.HIVE",
  }, {
    now: () => new Date(OBSERVED_AT),
    fetchImpl: async (endpoint, options) => {
      const request = JSON.parse(options.body);
      if (request.method === "getLatestBlockInfo") {
        boundaryReads += 1;
        return response({ blockNumber: 987 + boundaryReads - 1, hash: String(boundaryReads).repeat(64) });
      }
      return fixture(endpoint, options);
    },
  }), /block advanced/u);
});
