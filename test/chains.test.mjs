import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAINS, allChains, call, callMany, chain, formatUnits, hexToBigInt } from "../src/chains.mjs";

/** A fetch stand-in driven by a url -> handler map. Every test is offline and deterministic. */
function fakeFetch(handlers, log = []) {
  return async (url, init) => {
    log.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    const handler = handlers[String(url)];
    if (handler === undefined) throw new Error(`no handler for ${url}`);
    return handler();
  };
}
const jsonResponse = (payload, status = 200) => () => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
});
const rpcResult = (result) => jsonResponse({ jsonrpc: "2.0", id: 1, result });

test("chain(): refuses an unknown id rather than returning undefined", () => {
  assert.throws(() => chain("nosuchchain"), RangeError);
  assert.equal(chain("base").chainId, 8453);
});

test("every registered chain has at least one RPC endpoint", () => {
  for (const c of allChains()) {
    assert.ok(c.rpc.length >= 1, `${c.id} has no RPC endpoint`);
    assert.equal(c.caip2, `eip155:${c.chainId}`);
  }
});

test("the chains most likely to be silently skipped carry a fallback endpoint", () => {
  // Ethereum, Base, Optimism and Polygon are the four that failed during the 2026-08-27 hand
  // scan. A single endpoint on any of them is how a chain becomes invisible.
  for (const id of ["ethereum", "base", "optimism", "polygon"]) {
    assert.ok(CHAINS[id].rpc.length >= 2, `${id} needs a fallback endpoint`);
  }
});

test("call(): returns the result from the first endpoint that answers", async () => {
  const log = [];
  const result = await call(CHAINS.base, "eth_getBalance", ["0xabc", "latest"], {
    fetchImpl: fakeFetch({ [CHAINS.base.rpc[0]]: rpcResult("0x2a") }, log),
  });
  assert.equal(result.ok, true);
  assert.equal(result.value, "0x2a");
  assert.equal(result.via, CHAINS.base.rpc[0]);
  assert.equal(log.length, 1, "must not call further endpoints once one answers");
});

test("call(): falls through an HTTP error to the next endpoint", async () => {
  const result = await call(CHAINS.base, "eth_getBalance", ["0xabc", "latest"], {
    fetchImpl: fakeFetch({
      [CHAINS.base.rpc[0]]: jsonResponse({}, 521), // the real Cloudflare failure seen on 2026-08-27
      [CHAINS.base.rpc[1]]: rpcResult("0x7"),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.value, "0x7");
  assert.equal(result.via, CHAINS.base.rpc[1]);
});

test("call(): a JSON-RPC error is a failed endpoint, not an answer", async () => {
  // An endpoint replying "unauthorized" has not told us the balance is zero.
  const result = await call(CHAINS.base, "eth_getBalance", ["0xabc", "latest"], {
    fetchImpl: fakeFetch({
      [CHAINS.base.rpc[0]]: jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Unauthorized" } }),
      [CHAINS.base.rpc[1]]: rpcResult("0x1"),
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.value, "0x1");
});

test("call(): when every endpoint fails it returns a reason and NO value key", async () => {
  const handlers = {};
  for (const url of CHAINS.base.rpc) handlers[url] = jsonResponse({}, 500);
  const result = await call(CHAINS.base, "eth_getBalance", ["0xabc", "latest"], { fetchImpl: fakeFetch(handlers) });
  assert.equal(result.ok, false);
  assert.equal("value" in result, false, "a failure must not carry a value that could be read as zero");
  assert.match(result.reason, /base/);
  assert.equal(result.attempts.length, CHAINS.base.rpc.length);
});

test("call(): a thrown network error is caught and reported, never thrown at the caller", async () => {
  const result = await call(CHAINS.base, "eth_getBalance", ["0xabc", "latest"], {
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(result.ok, false);
  assert.ok(result.attempts.every((a) => /ECONNREFUSED/.test(a.error)));
});

test("call(): a malformed body with no result is a failure, not an undefined value", async () => {
  const handlers = {};
  for (const url of CHAINS.base.rpc) handlers[url] = jsonResponse({ jsonrpc: "2.0", id: 1 });
  const result = await call(CHAINS.base, "eth_getBalance", ["0xabc", "latest"], { fetchImpl: fakeFetch(handlers) });
  assert.equal(result.ok, false);
  assert.match(result.attempts[0].error, /no result/);
});

test("call(): sends one request per call, never a batch", async () => {
  const log = [];
  await call(CHAINS.base, "eth_getBalance", ["0xabc", "latest"], {
    fetchImpl: fakeFetch({ [CHAINS.base.rpc[0]]: rpcResult("0x0") }, log),
  });
  // Batching is what produced the false negative this module exists to prevent: a rejected
  // batch returns one error for many addresses, and a caller mapping the response sees zeroes.
  assert.equal(Array.isArray(log[0].body), false, "request body must be a single object, not a batch array");
  assert.equal(log[0].body.method, "eth_getBalance");
});

test("callMany(): preserves input order regardless of completion order", async () => {
  const thunks = [
    async () => { await new Promise((r) => setTimeout(r, 12)); return "slow"; },
    async () => "fast",
    async () => { await new Promise((r) => setTimeout(r, 6)); return "middle"; },
  ];
  assert.deepEqual(await callMany(thunks, 3), ["slow", "fast", "middle"]);
});

test("callMany(): respects the concurrency bound", async () => {
  let live = 0;
  let peak = 0;
  const thunks = Array.from({ length: 12 }, () => async () => {
    live += 1; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 4));
    live -= 1;
    return true;
  });
  await callMany(thunks, 3);
  assert.ok(peak <= 3, `expected at most 3 concurrent, saw ${peak}`);
});

test("callMany(): refuses a nonsense concurrency", async () => {
  await assert.rejects(() => callMany([async () => 1], 0), RangeError);
});

test("hexToBigInt(): exact at any magnitude, and refuses non-hex", () => {
  assert.equal(hexToBigInt("0x0"), 0n);
  assert.equal(hexToBigInt("0x"), 0n);
  // 0.0149001 ETH, the real Base balance from the 2026-08-27 scan.
  assert.equal(hexToBigInt("0x34ef8fdf9e2800"), 14900100000000000n);
  // Far past Number.MAX_SAFE_INTEGER — a Number here would lose digits.
  assert.equal(hexToBigInt("0xde0b6b3a7640000"), 1000000000000000000n);
  assert.throws(() => hexToBigInt("nope"), TypeError);
  assert.throws(() => hexToBigInt(42), TypeError);
});

test("formatUnits(): exact at eighteen decimals — one wei does not vanish", () => {
  assert.equal(formatUnits(1n, 18), "0.000000000000000001");
  assert.equal(formatUnits(10n ** 18n, 18), "1");
  assert.equal(formatUnits(10n ** 18n + 1n, 18), "1.000000000000000001");
  assert.equal(formatUnits(0n, 18), "0");
  assert.equal(formatUnits(519488n, 6), "0.519488"); // the ephemeris payee's real USDC balance
  assert.equal(formatUnits(-1n, 18), "-0.000000000000000001");
  assert.equal(formatUnits(42n, 0), "42");
});

test("formatUnits(): refuses a negative decimals rather than producing nonsense", () => {
  assert.throws(() => formatUnits(1n, -1), RangeError);
});
