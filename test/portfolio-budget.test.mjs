import test from "node:test";
import assert from "node:assert/strict";
import { createObservationBudget } from "../src/observation-budget.mjs";
import { observePortfolioReport } from "../scripts/observe-portfolio.mjs";
import { CHAINS } from "../src/chains.mjs";
import { portfolioRpc, WALLET, MARKET } from "./fixtures/portfolio-rpc.mjs";

const limits = overrides => ({ maxRequests: 256, maxDurationMs: 30_000,
  maxResponseBytes: 1_048_576, maxTokenCandidates: 32, ...overrides });
const input = { roster: [{ subject: "Public wallet", address: WALLET }], chains: ["ethereum"],
  positions: { ethereum: [{ kind: "compound-fork", address: MARKET }] } };

test("one captured host budget counts concurrent RPC and indexer requests together", async () => {
  let requests = 0;
  const selected = limits({ maxRequests: 3 });
  const budget = createObservationBudget(selected, async (_url, options) => {
    assert.equal(options.redirect, "error");
    requests += 1;
    await Promise.resolve();
    return Response.json({ observed: true });
  });
  selected.maxRequests = 100;
  try {
    const results = await Promise.allSettled(Array.from({ length: 7 }, (_, index) =>
      budget.fetch(`https://rpc.example/${index}`, index % 2 ? { method: "POST" } : {})));
    assert.equal(requests, 3);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 3);
    assert.equal(results.filter(result => result.status === "rejected").length, 4);
    assert.equal(budget.limits.maxRequests, 3);
    assert.equal(budget.limited, true);
  } finally { budget.close(); }
});

test("response byte limit counts streamed bytes and cancels the oversized body", async () => {
  let cancelled = false, aborted = false;
  const budget = createObservationBudget(limits({ maxResponseBytes: 8 }), async (_url, { signal }) => {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(9)); },
      cancel() { cancelled = true; },
    }), { headers: { "content-length": "1" } });
  });
  try {
    await assert.rejects(budget.fetch("https://rpc.example"), /exceeded 8 bytes/u);
    assert.equal(cancelled, true);
    assert.equal(aborted, true);
  } finally { budget.close(); }
});

test("whole-observation deadline includes a body that stalls after response headers", async () => {
  let cancelled = false, aborted = false;
  const budget = createObservationBudget(limits({ maxDurationMs: 30 }), async (_url, { signal }) => {
    signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
  });
  try {
    await assert.rejects(budget.fetch("https://indexer.example"), /exceeded 30 ms/u);
    assert.equal(cancelled, true);
    assert.equal(aborted, true);
    await assert.rejects(budget.fetch("https://rpc.example"), /exceeded 30 ms/u);
  } finally { budget.close(); }
});

test("token cap retains verified holdings and explicit positions with incomplete original coverage", async () => {
  const rpc = portfolioRpc({ chain: CHAINS.ethereum, indexerUnavailable: false });
  const candidates = ["55", "66", "77"].map(byte => ({ token: {
    type: "ERC-20", address_hash: `0x${byte.repeat(20)}`, symbol: "EXAMPLE", decimals: 18,
  }, value: "1000000000000000000" }));
  const report = await observePortfolioReport(input, {
    acquisitionLimits: limits({ maxTokenCandidates: 2 }),
    fetchImpl: (url, init) => init.body ? rpc.fetchImpl(url, init) : Promise.resolve(Response.json(candidates)),
  });
  const chain = report.chains[0], wallet = chain.wallets[0];
  assert.equal(chain.checked, true);
  assert.equal(wallet.verifiedTokens.checked, false);
  assert.equal(wallet.verifiedTokens.holdings.length, 2);
  assert.equal(wallet.verifiedTokens.holdings.every(holding => holding.checked), true);
  assert.equal(wallet.verifiedTokens.discoveredCount, 3);
  assert.match(wallet.verifiedTokens.reason, /examining 2 of 3/u);
  assert.equal(wallet.trackedPositions.checked, true);
  assert.equal(wallet.trackedPositions.positions[0].borrowedUnderlyingRaw, "2500000");
  assert.equal(report.coverage.complete, false);
  assert.equal(chain.coverage.unchecked.some(row => row.component === "verifiedTokens"), true);
});

test("shared RPC exhaustion retains acquired components under an unchecked final boundary", async () => {
  const rpc = portfolioRpc({ chain: CHAINS.ethereum, indexerUnavailable: false });
  const report = await observePortfolioReport(input, {
    acquisitionLimits: limits({ maxRequests: 8 }), fetchImpl: rpc.fetchImpl,
  });
  const chain = report.chains[0], wallet = chain.wallets[0];
  assert.equal(rpc.calls.length, 8);
  assert.equal(chain.checked, false);
  assert.equal(wallet.checked, false);
  assert.equal(typeof wallet.native, "object");
  assert.equal(typeof wallet.trackedPositions, "object");
  assert.equal(report.coverage.complete, false);
  assert.match(wallet.reason, /reconciled.*8 requests/u);
});

test("public request cannot select host acquisition limits or inject a transport", async () => {
  let calls = 0;
  for (const field of ["acquisitionLimits", "fetchImpl"]) {
    await assert.rejects(observePortfolioReport({ ...input, [field]: {} }, {
      acquisitionLimits: limits(), fetchImpl: async () => { calls += 1; return Response.json({}); },
    }), /invalid request/u);
  }
  await assert.rejects(observePortfolioReport(input, {
    acquisitionLimits: limits({ maxRequests: 0 }),
    fetchImpl: async () => { calls += 1; return Response.json({}); },
  }), /acquisitionLimits.maxRequests/u);
  assert.equal(calls, 0);
});

test("the original Base scheduler receives the same whole-observation deadline", async () => {
  const rpc = portfolioRpc({ indexerUnavailable: false });
  const started = performance.now();
  const report = await observePortfolioReport({ roster: input.roster, chains: ["base"] }, {
    acquisitionLimits: limits({ maxDurationMs: 30 }), fetchImpl: rpc.fetchImpl,
  });
  assert.ok(performance.now() - started < 120, "an original 125 ms provider scheduler wait must be cancelled");
  assert.equal(report.coverage.complete, false);
  assert.equal(report.chains[0].checked, false);
  assert.equal(report.chains[0].wallets[0].checked, false);
});
