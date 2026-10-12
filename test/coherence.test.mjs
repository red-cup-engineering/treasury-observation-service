import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { call, CHAINS, observeCoherentSnapshot } from "../src/chains.mjs";
import { observeAddress } from "../src/native.mjs";
import { observeVaultPosition } from "../src/positions.mjs";
import { observeMoonwellOutstandingRewards } from "../src/rewards.mjs";
import { balanceOfToken } from "../src/tokens.mjs";

const BLOCK_TAG = "0x64";
const BLOCK_HASH = `0x${"ab".repeat(32)}`;
const REORG_HASH = `0x${"cd".repeat(32)}`;
const WALLET = "0x32886F6F361C1d570255c2762967A2e41D0E9B1a";
const TOKEN = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const VAULT = "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB";
const DISTRIBUTOR = "0xe9005b078701e2A0948D2EaC43010D35870Ad9d2";

const erc20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);
const vault = new Interface(["function getPricePerFullShare() view returns (uint256)"]);
const rewards = new Interface([
  "function getOutstandingRewardsForUser(address _user) view returns (tuple(address mToken, tuple(address emissionToken, uint256 totalAmount, uint256 supplySide, uint256 borrowSide)[] rewards)[])",
]);

function rpcResult(result) {
  return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) };
}

function coherentRpc({ reorgOnVerification = false, failTokenBalance = false } = {}) {
  const log = [];
  let exactHeaderReads = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    log.push({ url, method: body.method, params: body.params });
    if (url !== CHAINS.base.rpc[0]) return { ok: false, status: 503, json: async () => ({}) };
    if (body.method === "eth_chainId") return rpcResult("0x2105");
    if (body.method === "eth_getBlockByNumber") {
      if (body.params[0] === BLOCK_TAG) exactHeaderReads += 1;
      const hash = reorgOnVerification && body.params[0] === BLOCK_TAG && exactHeaderReads > 0 ? REORG_HASH : BLOCK_HASH;
      return rpcResult({ number: BLOCK_TAG, hash });
    }
    if (body.method === "eth_getBalance") return rpcResult("0xde0b6b3a7640000");
    if (body.method === "eth_getTransactionCount") return rpcResult("0x7");
    if (body.method !== "eth_call") return { ok: false, status: 500, json: async () => ({}) };
    const [{ to, data }] = body.params;
    if (to.toLowerCase() === DISTRIBUTOR.toLowerCase()) {
      return rpcResult(rewards.encodeFunctionResult("getOutstandingRewardsForUser", [[]]));
    }
    if (data.startsWith(erc20.getFunction("balanceOf").selector)) {
      if (failTokenBalance && to.toLowerCase() === TOKEN.toLowerCase()) {
        return { ok: false, status: 503, json: async () => ({}) };
      }
      return rpcResult(erc20.encodeFunctionResult("balanceOf", [to.toLowerCase() === TOKEN.toLowerCase() ? 541862n : 1000000000000000000n]));
    }
    if (data.startsWith(erc20.getFunction("decimals").selector)) {
      return rpcResult(erc20.encodeFunctionResult("decimals", [to.toLowerCase() === TOKEN.toLowerCase() ? 6 : 18]));
    }
    if (data.startsWith(erc20.getFunction("symbol").selector)) {
      return rpcResult(erc20.encodeFunctionResult("symbol", [to.toLowerCase() === TOKEN.toLowerCase() ? "USDC" : "mooTEST"]));
    }
    if (data.startsWith(vault.getFunction("getPricePerFullShare").selector)) {
      return rpcResult(vault.encodeFunctionResult("getPricePerFullShare", [1100000000000000000n]));
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
  return { fetchImpl, log };
}

const fixedNow = () => new Date("2026-09-01T12:00:00.000Z");

test("observeCoherentSnapshot(): every native, token, position, and reward read shares one finalized boundary", async () => {
  const { fetchImpl, log } = coherentRpc();
  const snapshot = await observeCoherentSnapshot(CHAINS.base, [
    (options) => observeAddress(CHAINS.base, WALLET, options),
    (options) => balanceOfToken(CHAINS.base, TOKEN, WALLET, options),
    (options) => observeVaultPosition(CHAINS.base, VAULT, WALLET, options),
    (options) => observeMoonwellOutstandingRewards(CHAINS.base, DISTRIBUTOR, WALLET, options),
  ], { fetchImpl, now: fixedNow });

  assert.equal(snapshot.checked, true);
  assert.deepEqual(snapshot.boundary, {
    chain: "base", chainId: 8453, caip2: "eip155:8453",
    requestedFinality: "finalized", finality: "finalized",
    blockNumber: "100", blockTag: BLOCK_TAG, blockHash: BLOCK_HASH,
    observedAt: "2026-09-01T12:00:00.000Z", provider: CHAINS.base.rpc[0],
  });
  assert.equal(snapshot.observations.length, 4);
  for (const observation of snapshot.observations) {
    assert.equal(observation.provenance.blockHash, BLOCK_HASH);
    assert.equal(observation.provenance.blockTag, BLOCK_TAG);
    assert.equal(observation.provenance.provider, CHAINS.base.rpc[0]);
    assert.ok(observation.provenance.reads.length > 0);
  }
  const stateReads = log.filter(({ method }) => ["eth_getBalance", "eth_getTransactionCount", "eth_call"].includes(method));
  assert.ok(stateReads.length >= 10);
  assert.ok(stateReads.every(({ url }) => url === CHAINS.base.rpc[0]));
  assert.ok(stateReads.every(({ params }) => params.at(-1) === BLOCK_TAG));
  assert.equal(log.some(({ params }) => params.at(-1) === "latest"), false);
  assert.deepEqual(
    [...new Set(log.map(({ method }) => method))].sort(),
    ["eth_call", "eth_chainId", "eth_getBalance", "eth_getBlockByNumber", "eth_getTransactionCount"].sort(),
  );
});

test("call(): a boundary-bound reader cannot silently substitute latest", async () => {
  const { fetchImpl, log } = coherentRpc();
  const snapshot = await observeCoherentSnapshot(CHAINS.base, [async (options) => {
    const result = await call(CHAINS.base, "eth_call", [{ to: TOKEN, data: "0x" }, "latest"], options);
    return result.ok
      ? { checked: true, provenance: result.provenance }
      : { checked: false, reason: result.reason, attempts: result.attempts };
  }], { fetchImpl, now: fixedNow });
  assert.equal(snapshot.checked, false);
  assert.match(snapshot.reason, /used "latest" instead of boundary/);
  assert.equal(log.some(({ params }) => params.at(-1) === "latest"), false);
  assert.equal("observations" in snapshot, false);
});

test("observeCoherentSnapshot(): mismatched leg provenance fails closed without partial observations", async () => {
  const { fetchImpl } = coherentRpc();
  const snapshot = await observeCoherentSnapshot(CHAINS.base, [async (options) => {
    const observation = await observeAddress(CHAINS.base, WALLET, options);
    return { ...observation, provenance: { ...observation.provenance, blockHash: REORG_HASH } };
  }], { fetchImpl, now: fixedNow });
  assert.equal(snapshot.checked, false);
  assert.match(snapshot.reason, /mismatched boundary provenance/);
  assert.equal("observations" in snapshot, false);
});

test("observeCoherentSnapshot(): a changed canonical hash after the reads invalidates the whole snapshot", async () => {
  const { fetchImpl } = coherentRpc({ reorgOnVerification: true });
  const snapshot = await observeCoherentSnapshot(CHAINS.base, [
    (options) => observeAddress(CHAINS.base, WALLET, options),
  ], { fetchImpl, now: fixedNow });
  assert.equal(snapshot.checked, false);
  assert.match(snapshot.reason, /fixed-boundary Base read failed/);
  assert.equal("observations" in snapshot, false);
});

test("observeCoherentSnapshot(): one unreachable required leg refuses the composite rather than returning partial totals", async () => {
  const { fetchImpl } = coherentRpc({ failTokenBalance: true });
  const snapshot = await observeCoherentSnapshot(CHAINS.base, [
    (options) => observeAddress(CHAINS.base, WALLET, options),
    (options) => balanceOfToken(CHAINS.base, TOKEN, WALLET, options),
  ], { fetchImpl, now: fixedNow });
  assert.equal(snapshot.checked, false);
  assert.match(snapshot.reason, /coherent snapshot leg failed/);
  assert.equal("observations" in snapshot, false);
});


test("current quantities retain unfinalized classification and block time while every read stays pinned",async()=>{
 const {fetchImpl:base,log}=coherentRpc();
 const fetchImpl=async(url,init)=>{
  const body=JSON.parse(init.body);
  const response=await base(url,init);
  if(body.method==='eth_getBlockByNumber'&&response.ok){const value=await response.json();value.result.timestamp='0x64';return {...response,json:async()=>value};}
  return response;
 };
 const snapshot=await observeCoherentSnapshot(CHAINS.base,[options=>balanceOfToken(CHAINS.base,TOKEN,WALLET,options)],{fetchImpl,finality:'latest',now:fixedNow});
 assert.equal(snapshot.checked,true);
 assert.equal(snapshot.boundary.requestedFinality,'latest');assert.equal(snapshot.boundary.finality,'unfinalized');
 assert.equal(snapshot.boundary.blockTimestampSeconds,'100');
 assert.equal(snapshot.observations[0].provenance.blockTimestampSeconds,'100');
 assert.ok(log.some(row=>row.method==='eth_getBlockByNumber'&&row.params[0]==='latest'));
 assert.ok(log.filter(row=>row.method==='eth_call').every(row=>row.params.at(-1)===BLOCK_TAG));
});
