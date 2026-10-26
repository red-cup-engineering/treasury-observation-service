/**
 * `chains` — the chain registry and the JSON-RPC transport every other module here reads through.
 *
 * This exists because of a specific failure. A treasury scan across sixteen wallets was run by
 * hand with batched `eth_getBalance` calls, and five of eight chains silently rejected the batch
 * form. The scan reported zero holdings on those chains. Nothing in the output distinguished
 * "this address holds nothing" from "this chain was never reached", so the first read of the
 * result was that the wallets were empty — a false negative about the Group's own money,
 * produced by transport behaviour rather than by anything on chain.
 *
 * So the contract of this module is narrow and absolute: **an unreachable endpoint never yields
 * a value.** Every call returns either an answer or a stated reason it has none, and callers
 * cannot accidentally read the second as the first, because a failure is not a number. Nothing
 * here defaults to zero, falls back to an empty array, or swallows an error.
 *
 * Two consequences shape the design:
 *
 *   - Every chain carries a LIST of RPC endpoints, tried in order, because public endpoints
 *     rate-limit, geoblock, sit behind Cloudflare 521s, and disappear. A chain with one
 *     endpoint is a chain that will eventually be reported as empty.
 *   - Requests are single, never batched. Batching is faster and was the direct cause of the
 *     false negative: an endpoint that rejects a batch returns one error for twenty addresses,
 *     and a caller that maps over the response sees twenty zeroes. `callMany` keeps the
 *     one-request-one-answer shape and bounds concurrency instead.
 *
 * Amounts are returned as raw hex or BigInt and never as `Number`. A balance is money, and the
 * estate has already been bitten once by a float in a value path.
 *
 * Plain JavaScript, shapes in the co-located chains.d.ts, matching the house convention for a
 * package meant to be imported from inside a consumer's node_modules.
 */
import {
  BASE_PUBLIC_EVM_CHAIN, BASE_PUBLIC_EVM_PROVIDERS, createPublicEvmReadPool,
} from "@red-cup-engineering/ethereum-engineering-services-section/public-evm-read";

/** Endpoints verified reachable from this operator's network on 2026-08-27. Order is
 *  deliberate: the first entry is the one that answered most reliably. `llamarpc` and
 *  `polygon-rpc.com` are recorded but demoted — both returned Cloudflare 521s during that
 *  scan, which is exactly the failure this module refuses to convert into a zero. */
export const CHAINS = Object.freeze({
  ethereum: Object.freeze({
    id: "ethereum", chainId: 1, caip2: "eip155:1", nativeSymbol: "ETH", nativeDecimals: 18,
    rpc: Object.freeze(["https://cloudflare-eth.com", "https://eth.drpc.org", "https://1rpc.io/eth", "https://rpc.flashbots.net"]),
    indexers: Object.freeze(["https://eth.blockscout.com/api/v2"]),
  }),
  base: Object.freeze({
    id: "base", chainId: 8453, caip2: "eip155:8453", nativeSymbol: "ETH", nativeDecimals: 18,
    rpc: Object.freeze(["https://mainnet.base.org/", "https://base-rpc.publicnode.com/", "https://base.drpc.org/"]),
    indexers: Object.freeze([
      Object.freeze({ id: "blockscout", url: "https://base.blockscout.com/api/v2" }),
      Object.freeze({ id: "rabby", url: "https://api.rabby.io" }),
    ]),
  }),
  arbitrum: Object.freeze({
    id: "arbitrum", chainId: 42161, caip2: "eip155:42161", nativeSymbol: "ETH", nativeDecimals: 18,
    rpc: Object.freeze(["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"]),
    indexers: Object.freeze(["https://arbitrum.blockscout.com/api/v2"]),
  }),
  optimism: Object.freeze({
    id: "optimism", chainId: 10, caip2: "eip155:10", nativeSymbol: "ETH", nativeDecimals: 18,
    rpc: Object.freeze(["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"]),
    indexers: Object.freeze(["https://optimism.blockscout.com/api/v2"]),
  }),
  polygon: Object.freeze({
    id: "polygon", chainId: 137, caip2: "eip155:137", nativeSymbol: "POL", nativeDecimals: 18,
    rpc: Object.freeze(["https://1rpc.io/matic", "https://polygon-bor-rpc.publicnode.com"]),
    indexers: Object.freeze(["https://polygon.blockscout.com/api/v2"]),
  }),
  bsc: Object.freeze({
    id: "bsc", chainId: 56, caip2: "eip155:56", nativeSymbol: "BNB", nativeDecimals: 18,
    rpc: Object.freeze(["https://bsc-rpc.publicnode.com", "https://bsc-dataseed.binance.org"]),
    indexers: Object.freeze([]),
  }),
  avalanche: Object.freeze({
    id: "avalanche", chainId: 43114, caip2: "eip155:43114", nativeSymbol: "AVAX", nativeDecimals: 18,
    rpc: Object.freeze(["https://api.avax.network/ext/bc/C/rpc"]),
    indexers: Object.freeze([]),
  }),
  ronin: Object.freeze({
    id: "ronin", chainId: 2020, caip2: "eip155:2020", nativeSymbol: "RON", nativeDecimals: 18,
    rpc: Object.freeze(["https://api.roninchain.com/rpc"]),
    indexers: Object.freeze([]),
  }),
});

/** Every registered chain, as an array. */
export function allChains() {
  return Object.values(CHAINS);
}

/** A chain by id. Throws rather than returning undefined — a typo'd chain name must not
 *  quietly become "no chains scanned". */
export function chain(id) {
  const found = CHAINS[id];
  if (found === undefined) {
    throw new RangeError(`chains: unknown chain "${id}" (known: ${Object.keys(CHAINS).join(", ")})`);
  }
  return found;
}

/** An outcome carrying a value. */
export function ok(value, via, provenance) {
  return provenance === undefined ? { ok: true, value, via } : { ok: true, value, via, provenance };
}

/** An outcome carrying a stated reason there is no value. Deliberately has no `value` key at
 *  all, so `result.value` on a failure is `undefined` rather than a plausible-looking zero. */
export function unreachable(reason, attempts) {
  return { ok: false, reason, attempts };
}

function boundaryIdentity(boundary) {
  return {
    chain: boundary.chain,
    chainId: boundary.chainId,
    caip2: boundary.caip2,
    requestedFinality: boundary.requestedFinality,
    finality: boundary.finality,
    blockNumber: boundary.blockNumber,
    blockTag: boundary.blockTag,
    blockHash: boundary.blockHash,
    ...(boundary.blockTimestampSeconds === undefined ? {} : {
      blockTimestampSeconds: boundary.blockTimestampSeconds,
    }),
    observedAt: boundary.observedAt,
    provider: boundary.provider,
  };
}

export function sameObservationBoundary(left, right) {
  if (left == null || right == null) return false;
  return left.chain === right.chain
    && left.chainId === right.chainId
    && left.blockNumber === right.blockNumber
    && left.blockTag === right.blockTag
    && left.blockHash === right.blockHash
    && left.blockTimestampSeconds === right.blockTimestampSeconds
    && left.requestedFinality === right.requestedFinality
    && left.finality === right.finality
    && left.provider === right.provider;
}

export function observationBlockTag(options = {}) {
  return options.boundary?.blockTag ?? "latest";
}

export function observationProvenance(boundary, outcomes = []) {
  if (boundary === undefined) return undefined;
  const reads = [];
  for (const outcome of outcomes) {
    if (outcome?.provenance === undefined || !sameObservationBoundary(boundary, outcome.provenance)) {
      throw new Error("chains: observation read provenance does not match the supplied boundary");
    }
    reads.push({
      method: outcome.provenance.method,
      blockTag: outcome.provenance.blockTag,
      provider: outcome.provenance.provider,
    });
  }
  return { ...boundaryIdentity(boundary), reads };
}

async function requestAt(url, method, params, options) {
  const { fetchImpl, timeoutMs } = options;
  try {
    options.acquisitionBudget?.assertAvailable();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let payload;
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, error: `http ${response.status}` };
      payload = await response.json();
    } finally {
      clearTimeout(timer);
    }
    if (payload && payload.error) {
      return { ok: false, error: `rpc ${payload.error.code ?? "?"}: ${payload.error.message ?? "error"}` };
    }
    if (payload === null || typeof payload !== "object" || payload.result === undefined) {
      return { ok: false, error: "malformed response: no result" };
    }
    return { ok: true, value: payload.result };
  } catch (error) {
    return {
      ok: false,
      error: error?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(error?.message ?? error),
    };
  }
}

function baseBoundary(boundary) {
  return {
    chainId: boundary.chainId,
    blockNumber: boundary.blockNumber,
    blockHash: boundary.blockHash,
    ...(boundary.blockTimestampSeconds === undefined ? {} : {
      blockTimestamp: boundary.blockTimestampSeconds,
    }),
  };
}

function baseReadPool(options, chainDescriptor) {
  if (options.publicEvmReadPool != null) return options.publicEvmReadPool;
  const transportOptions = { ...options, timeoutMs: options.timeoutMs ?? 15000 };
  const createClient = options.fetchImpl == null ? undefined : ({ provider }) => ({
    async getChainId() {
      const result = await requestAt(provider.url, "eth_chainId", [], transportOptions);
      if (!result.ok) throw new Error(result.error);
      return Number(hexToBigInt(result.value));
    },
    async getBlock({ blockNumber } = {}) {
      const tag = blockNumber == null ? "latest" : `0x${blockNumber.toString(16)}`;
      const result = await requestAt(provider.url, "eth_getBlockByNumber", [tag, false], transportOptions);
      if (!result.ok) throw new Error(result.error);
      return {
        ...result.value,
        number: hexToBigInt(result.value?.number),
        timestamp: result.value?.timestamp == null ? undefined : hexToBigInt(result.value.timestamp),
      };
    },
    async request({ method, params }) {
      const result = await requestAt(provider.url, method, params, transportOptions);
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    async multicall() { throw new Error("treasury boundary adapter does not expose Multicall3"); },
  });
  return options.publicEvmReadPool ?? createPublicEvmReadPool({
    chain: BASE_PUBLIC_EVM_CHAIN,
    providers: chainDescriptor.rpc.map((url, index) => ({
      id: BASE_PUBLIC_EVM_PROVIDERS.find((provider) => new URL(provider.url).href === new URL(url).href)?.id
        ?? `treasury-base-${index + 1}`,
      url,
    })),
    ...(createClient === undefined ? {} : { createClient }),
    ...(options.acquisitionBudget === undefined ? {} : { sleep: options.acquisitionBudget.sleep }),
  });
}

async function requestBaseBoundary(chainDescriptor, options, request) {
  // A spent portfolio budget must not start another rate-scheduled pool operation.
  options.acquisitionBudget?.assertAvailable();
  const pool = baseReadPool(options, chainDescriptor);
  const endpoints = new Set(chainDescriptor.rpc.map((url) => new URL(url).href));
  const providerIds = Array.isArray(pool.providers)
    ? pool.providers.filter((provider) => endpoints.has(new URL(provider.url).href)).map(({ id }) => id)
    : undefined;
  if (providerIds?.length === 0) throw new Error("Base read pool has no selected chain endpoint");
  const result = await pool.requestAtBoundary({
    ...request,
    ...(providerIds === undefined ? {} : { providerIds }),
  });
  if (!endpoints.has(new URL(result.provider?.url).href)) {
    throw new Error("Base read pool answered from an unselected chain endpoint");
  }
  return result;
}

function poolAttempts(error) {
  return error?.report?.failures?.map(({ endpoint, message }) => ({ url: endpoint, error: message })) ?? [];
}

async function fixedBaseCall(chainDescriptor, boundary, method, params, options) {
  try {
    const result = await requestBaseBoundary(chainDescriptor, options, {
      boundary: baseBoundary(boundary), method, params,
    });
    // The pool independently verifies every provider's chain and exact block hash before use.
    // Keep the original boundary as provenance: its provider selected the finality boundary,
    // while result.provider is the provider that safely replayed this individual read.
    return ok(result.value, result.provider.url, {
      ...boundaryIdentity(boundary), method, blockTag: boundary.blockTag,
    });
  } catch (error) {
    return unreachable(`fixed-boundary Base read failed: ${String(error?.message ?? error)}`, poolAttempts(error));
  }
}

function validateBoundary(chainDescriptor, boundary) {
  if (boundary.chain !== chainDescriptor.id || boundary.chainId !== chainDescriptor.chainId
    || boundary.caip2 !== chainDescriptor.caip2) {
    return `boundary identifies ${boundary.caip2 ?? boundary.chain}, not ${chainDescriptor.caip2}`;
  }
  if (!chainDescriptor.rpc.includes(boundary.provider)) {
    return `boundary provider ${boundary.provider} is not registered for ${chainDescriptor.id}`;
  }
  if (!new Set(["latest", "safe", "finalized"]).has(boundary.requestedFinality)
    || boundary.finality !== (boundary.requestedFinality === "latest" ? "unfinalized" : boundary.requestedFinality)) {
    return "boundary lacks one consistent latest/unfinalized, safe or finalized classification";
  }
  if (typeof boundary.blockTag !== "string" || !/^0x[0-9a-fA-F]+$/u.test(boundary.blockTag)
    || typeof boundary.blockHash !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(boundary.blockHash)) {
    return "boundary lacks a resolved block tag/hash";
  }
  if (typeof boundary.blockNumber !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(boundary.blockNumber)
    || hexToBigInt(boundary.blockTag).toString() !== boundary.blockNumber) {
    return "boundary block number and tag do not identify the same block";
  }
  if (typeof boundary.observedAt !== "string" || !Number.isFinite(Date.parse(boundary.observedAt))) {
    return "boundary lacks a valid observation time";
  }
  if (boundary.blockTimestampSeconds !== undefined
    && (typeof boundary.blockTimestampSeconds !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(boundary.blockTimestampSeconds))) {
    return "boundary lacks a valid block timestamp in seconds";
  }
  return null;
}

const BLOCK_BOUND_METHODS = new Set(["eth_getBalance", "eth_getTransactionCount", "eth_getCode", "eth_call"]);

function validateBoundParams(method, params, boundary) {
  if (!BLOCK_BOUND_METHODS.has(method)) return null;
  const supplied = params.at(-1);
  return supplied === boundary.blockTag
    ? null
    : `${method} used ${JSON.stringify(supplied)} instead of boundary ${boundary.blockTag}`;
}

/**
 * One JSON-RPC call against a chain, trying each endpoint in order until one answers.
 *
 * Returns an outcome, never throws for network reasons. A JSON-RPC error object counts as a
 * failed endpoint and moves to the next one: an endpoint that answers "method not supported"
 * has not told us the balance is zero, it has told us to ask someone else.
 */
export async function call(chainDescriptor, method, params, options = {}) {
  const { fetchImpl = fetch, timeoutMs = 15000, boundary } = options;
  const attempts = [];
  if (boundary !== undefined) {
    const boundaryError = validateBoundary(chainDescriptor, boundary) ?? validateBoundParams(method, params, boundary);
    if (boundaryError !== null) return unreachable(`chains: ${boundaryError}`, []);
  }
  if (boundary !== undefined && chainDescriptor.chainId === BASE_PUBLIC_EVM_CHAIN.id) {
    return fixedBaseCall(chainDescriptor, boundary, method, params, options);
  }
  const endpoints = boundary === undefined ? chainDescriptor.rpc : [boundary.provider];
  for (const url of endpoints) {
    const result = await requestAt(url, method, params, { ...options, fetchImpl, timeoutMs });
    if (!result.ok) {
      attempts.push({ url, error: result.error });
      continue;
    }
    const provenance = boundary === undefined ? undefined : {
      ...boundaryIdentity(boundary), method, blockTag: boundary.blockTag,
    };
    return ok(result.value, url, provenance);
  }
  return unreachable(`all ${endpoints.length} endpoint(s) failed for ${chainDescriptor.id}`, attempts);
}

export async function acquireObservationBoundary(chainDescriptor, options = {}) {
  const {
    fetchImpl = fetch,
    timeoutMs = 15000,
    finality = "finalized",
    now = () => new Date(),
  } = options;
  if (!new Set(["latest", "safe", "finalized"]).has(finality)) {
    throw new RangeError(`chains: finality must be "latest", "safe" or "finalized", got ${JSON.stringify(finality)}`);
  }
  const attempts = [];
  for (const provider of chainDescriptor.rpc) {
    const chainIdResult = await requestAt(provider, "eth_chainId", [], { ...options, fetchImpl, timeoutMs });
    if (!chainIdResult.ok) {
      attempts.push({ url: provider, error: `eth_chainId: ${chainIdResult.error}` });
      continue;
    }
    let observedChainId;
    try {
      observedChainId = Number(hexToBigInt(chainIdResult.value));
    } catch (error) {
      attempts.push({ url: provider, error: `malformed eth_chainId: ${error.message}` });
      continue;
    }
    if (observedChainId !== chainDescriptor.chainId) {
      attempts.push({ url: provider, error: `wrong chain id ${observedChainId}, expected ${chainDescriptor.chainId}` });
      continue;
    }
    const blockResult = await requestAt(provider, "eth_getBlockByNumber", [finality, false], { ...options, fetchImpl, timeoutMs });
    const block = blockResult.ok ? blockResult.value : null;
    if (!blockResult.ok || block === null || typeof block !== "object"
      || typeof block.number !== "string" || typeof block.hash !== "string") {
      attempts.push({
        url: provider,
        error: blockResult.ok ? `malformed ${finality} block` : `eth_getBlockByNumber(${finality}): ${blockResult.error}`,
      });
      continue;
    }
    try {
      const boundary = Object.freeze({
        chain: chainDescriptor.id,
        chainId: chainDescriptor.chainId,
        caip2: chainDescriptor.caip2,
        requestedFinality: finality,
        finality: finality === "latest" ? "unfinalized" : finality,
        blockNumber: hexToBigInt(block.number).toString(),
        blockTag: block.number,
        blockHash: block.hash,
        blockTimestampSeconds: hexToBigInt(block.timestamp).toString(),
        observedAt: now().toISOString(),
        provider,
      });
      const invalid = validateBoundary(chainDescriptor, boundary);
      if (invalid !== null) throw new Error(invalid);
      return ok(boundary, provider);
    } catch (error) {
      attempts.push({ url: provider, error: `malformed ${finality} block: ${error.message}` });
    }
  }
  return unreachable(`no ${finality} observation boundary available for ${chainDescriptor.id}`, attempts);
}

export async function verifyObservationBoundary(chainDescriptor, boundary, options = {}) {
  const { fetchImpl = fetch, timeoutMs = 15000 } = options;
  const invalid = validateBoundary(chainDescriptor, boundary);
  if (invalid !== null) return unreachable(`chains: ${invalid}`, []);
  if (chainDescriptor.chainId === BASE_PUBLIC_EVM_CHAIN.id) {
    try {
      await requestBaseBoundary(chainDescriptor, options, {
        boundary: baseBoundary(boundary), operation: async () => true,
      });
      return ok(boundary, boundary.provider);
    } catch (error) {
      return unreachable(`cannot reconcile fixed Base boundary: ${String(error?.message ?? error)}`, poolAttempts(error));
    }
  }
  const chainIdResult = await requestAt(boundary.provider, "eth_chainId", [], { ...options, fetchImpl, timeoutMs });
  if (!chainIdResult.ok) {
    return unreachable(`cannot reconcile boundary chain identity: ${chainIdResult.error}`, [
      { url: boundary.provider, error: chainIdResult.error },
    ]);
  }
  let observedChainId;
  try {
    observedChainId = Number(hexToBigInt(chainIdResult.value));
  } catch (error) {
    return unreachable(`cannot reconcile boundary chain identity: ${error.message}`, []);
  }
  if (observedChainId !== boundary.chainId) {
    return unreachable(`boundary provider changed chain id from ${boundary.chainId} to ${observedChainId}`, []);
  }
  const blockResult = await requestAt(
    boundary.provider, "eth_getBlockByNumber", [boundary.blockTag, false], { ...options, fetchImpl, timeoutMs },
  );
  if (!blockResult.ok) {
    return unreachable(`cannot reconcile boundary ${boundary.blockTag}: ${blockResult.error}`, [
      { url: boundary.provider, error: blockResult.error },
    ]);
  }
  const block = blockResult.value;
  if (block === null || typeof block !== "object" || block.number !== boundary.blockTag || block.hash !== boundary.blockHash) {
    return unreachable(`boundary ${boundary.blockTag} changed or returned a different block hash`, []);
  }
  return ok(boundary, boundary.provider);
}

export async function observeCoherentSnapshot(chainDescriptor, observers, options = {}) {
  if (!Array.isArray(observers) || observers.length === 0 || observers.some((observer) => typeof observer !== "function")) {
    throw new TypeError("chains: observeCoherentSnapshot requires a non-empty observer function array");
  }
  const boundaryResult = await acquireObservationBoundary(chainDescriptor, options);
  if (!boundaryResult.ok) {
    return { chain: chainDescriptor.id, checked: false, reason: boundaryResult.reason, attempts: boundaryResult.attempts };
  }
  const boundary = boundaryResult.value;
  const boundOptions = { ...options, boundary };
  let observations;
  try {
    observations = await Promise.all(observers.map((observer) => observer(boundOptions)));
  } catch (error) {
    return {
      chain: chainDescriptor.id, checked: false, boundary,
      reason: `coherent snapshot observer threw: ${String(error?.message ?? error)}`, attempts: [],
    };
  }
  for (const observation of observations) {
    if (observation?.checked !== true) {
      return {
        chain: chainDescriptor.id, checked: false, boundary,
        reason: `coherent snapshot leg failed: ${observation?.reason ?? "unchecked observation"}`,
        attempts: observation?.attempts ?? [],
      };
    }
    if (!sameObservationBoundary(boundary, observation.provenance)) {
      return {
        chain: chainDescriptor.id, checked: false, boundary,
        reason: "coherent snapshot leg returned missing or mismatched boundary provenance", attempts: [],
      };
    }
  }
  const verified = await verifyObservationBoundary(chainDescriptor, boundary, options);
  if (!verified.ok) {
    return { chain: chainDescriptor.id, checked: false, boundary, reason: verified.reason, attempts: verified.attempts };
  }
  return { chain: chainDescriptor.id, checked: true, boundary, observedAt: boundary.observedAt, observations };
}

/**
 * Run many async thunks with bounded concurrency, preserving input order.
 *
 * Used instead of JSON-RPC batching. Batching is faster and is what produced the false
 * negative this module exists to prevent — one rejected batch looks like twenty zero balances.
 * Here, one input is one output, and a failure is visibly a failure.
 */
export async function callMany(thunks, concurrency = 6) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError(`chains: concurrency must be a positive integer, got ${concurrency}`);
  }
  const results = new Array(thunks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, thunks.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= thunks.length) return;
      results[index] = await thunks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

/** Parse a hex quantity into a BigInt. Never returns a Number: a balance is money. */
export function hexToBigInt(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/u.test(hex)) {
    throw new TypeError(`chains: not a hex quantity: ${JSON.stringify(hex)}`);
  }
  return hex === "0x" ? 0n : BigInt(hex);
}

/** Render an integer amount of base units as an exact decimal string, trailing zeros trimmed.
 *  Pure BigInt arithmetic — no float ever touches a value on this path. */
export function formatUnits(raw, decimals) {
  const units = typeof raw === "bigint" ? raw : BigInt(raw);
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new RangeError(`chains: decimals must be a non-negative integer, got ${decimals}`);
  }
  if (decimals === 0) return units.toString();
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/u, "");
  const body = fraction === "" ? whole : `${whole}.${fraction}`;
  return negative && /[1-9]/u.test(body) ? `-${body}` : body;
}

