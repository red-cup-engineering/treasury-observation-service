import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAINS } from "../src/chains.mjs";
import { observeAddress, scanFleet, summarize } from "../src/native.mjs";

const ADDR = "0x32886F6F361C1d570255c2762967A2e41D0E9B1a";
const OTHER = "0x42F72C0a340A4A55C082Fe42483e87691D2bff64";

/** Drive fetch from a (url, method) -> result map so balance and nonce can differ. */
function rpcFake(map) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    const key = `${url}|${body.method}`;
    const entry = map[key] ?? map[body.method];
    if (entry === undefined) return { ok: false, status: 503, json: async () => ({}) };
    if (entry instanceof Error) throw entry;
    return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: entry }) };
  };
}

test("observeAddress(): reports an exact balance and marks it checked", async () => {
  const o = await observeAddress(CHAINS.base, ADDR, {
    fetchImpl: rpcFake({ eth_getBalance: "0x34ef8fdf9e2800", eth_getTransactionCount: "0x3" }),
  });
  assert.equal(o.checked, true);
  assert.equal(o.raw, "14900100000000000");
  assert.equal(o.amount, "0.0149001");
  assert.equal(o.symbol, "ETH");
  assert.equal(o.empty, false);
  assert.equal(o.nonce, 3);
});

test("observeAddress(): a zero balance is checked-and-empty, not unchecked", async () => {
  const o = await observeAddress(CHAINS.base, ADDR, {
    fetchImpl: rpcFake({ eth_getBalance: "0x0", eth_getTransactionCount: "0x0" }),
  });
  assert.equal(o.checked, true);
  assert.equal(o.empty, true);
  assert.equal(o.amount, "0");
});

test("observeAddress(): an unreachable chain is NOT reported as empty", async () => {
  // The defect this service exists to prevent. `checked` false, and no amount at all.
  const o = await observeAddress(CHAINS.base, ADDR, { fetchImpl: async () => { throw new Error("521"); } });
  assert.equal(o.checked, false);
  assert.equal("amount" in o, false, "an unchecked address must not carry an amount");
  assert.equal("empty" in o, false, "an unchecked address must not claim emptiness");
  assert.match(o.reason, /endpoint/);
});

test("observeAddress(): a nonce failure does not discard a good balance", async () => {
  const o = await observeAddress(CHAINS.base, ADDR, {
    fetchImpl: rpcFake({
      [`${CHAINS.base.rpc[0]}|eth_getBalance`]: "0x2a",
      [`${CHAINS.base.rpc[1]}|eth_getBalance`]: "0x2a",
      [`${CHAINS.base.rpc[2]}|eth_getBalance`]: "0x2a",
    }),
  });
  assert.equal(o.checked, true);
  assert.equal(o.raw, "42");
  assert.equal(o.nonce, null, "an unknown nonce is null, not zero");
});

test("scanFleet(): totals are per symbol and never summed across denominations", async () => {
  const report = await scanFleet({
    addresses: [{ address: ADDR, label: "SIGMUND_WALLET" }, { address: OTHER, label: "ANOTHER_EVM_WALLET" }],
    chains: [CHAINS.base, CHAINS.polygon],
    fetchImpl: rpcFake({ eth_getBalance: "0xde0b6b3a7640000", eth_getTransactionCount: "0x1" }),
  });
  // ETH on Base and POL on Polygon are different things; adding them would be a lie.
  assert.deepEqual(Object.keys(report.totals).sort(), ["ETH", "POL"]);
  assert.equal(report.totals.ETH, "2");
  assert.equal(report.totals.POL, "2");
});

test("scanFleet(): carries wallet labels through to holdings", async () => {
  const report = await scanFleet({
    addresses: [{ address: ADDR, label: "SIGMUND_WALLET", index: 0 }],
    chains: [CHAINS.base],
    fetchImpl: rpcFake({ eth_getBalance: "0x1", eth_getTransactionCount: "0x0" }),
  });
  assert.equal(report.holdings[0].label, "SIGMUND_WALLET");
  assert.equal(report.holdings[0].index, 0);
});

test("scanFleet(): an entirely unreachable chain marks coverage incomplete", async () => {
  const report = await scanFleet({
    addresses: [ADDR],
    chains: [CHAINS.base, CHAINS.ethereum],
    fetchImpl: async (url, init) => {
      if (String(url).includes("base")) {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x1" }) };
      }
      throw new Error("blocked");
    },
  });
  assert.equal(report.coverage.complete, false);
  assert.deepEqual(report.coverage.incompleteChains, ["ethereum"]);
  assert.match(report.coverage.note, /NOT complete/);
  assert.match(report.coverage.note, /nothing was learned/);
  assert.equal(report.byChain.base.complete, true);
  assert.equal(report.byChain.ethereum.unreachable.length, 1);
});

test("scanFleet(): full coverage says so, so absence can be read as emptiness", async () => {
  const report = await scanFleet({
    addresses: [ADDR, OTHER],
    chains: [CHAINS.base],
    fetchImpl: rpcFake({ eth_getBalance: "0x0", eth_getTransactionCount: "0x0" }),
  });
  assert.equal(report.coverage.complete, true);
  assert.equal(report.holdings.length, 0);
  assert.match(report.coverage.note, /an absent holding here means an empty address/);
});

test("scanFleet(): flags used-but-empty addresses for the token and position scans", async () => {
  // Zero native with a nonzero nonce means spent, not untouched — exactly where a forgotten
  // receipt token or NFT sits. Dropping these from later scans loses real holdings.
  const report = await scanFleet({
    addresses: [{ address: ADDR, label: "SPENT" }, { address: OTHER, label: "VIRGIN" }],
    chains: [CHAINS.base],
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      const isSpent = body.params[0] === ADDR;
      const result = body.method === "eth_getTransactionCount" ? (isSpent ? "0x5" : "0x0") : "0x0";
      return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
    },
  });
  assert.equal(report.usedButEmpty.length, 1);
  assert.equal(report.usedButEmpty[0].label, "SPENT");
  assert.equal(report.usedButEmpty[0].nonce, 5);
});

test("scanFleet(): refuses an empty address list rather than reporting a zero treasury", async () => {
  await assert.rejects(() => scanFleet({ addresses: [] }), RangeError);
});

test("summarize(): a chain with zero attempted addresses is not 'complete'", () => {
  const report = summarize([], [CHAINS.base], 0);
  assert.equal(report.byChain.base.complete, false);
  assert.equal(report.coverage.complete, false);
});

test("summarize(): takes no clock — observedAt is the caller's to stamp", () => {
  assert.equal(summarize([], [CHAINS.base], 0).observedAt, null);
});
