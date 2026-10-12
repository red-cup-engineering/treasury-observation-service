/**
 * ERC-20 balance discovery and targeted reads. Same checked/unreachable discipline as
 * `native.mjs`. ABI encoding goes through `ethers.Interface` rather than a hand-rolled selector
 * table, because a wrong 4-byte selector silently calls a different function and can return data
 * that looks exactly like a balance — the one failure mode this service exists to prevent.
 */
import { Interface, getAddress } from "ethers";
import { call, formatUnits, observationBlockTag, observationProvenance } from "./chains.mjs";

const erc20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

/** @throws {TypeError} if `value` is not a valid EVM address. */
function normalizedAddress(name, value) {
  try {
    return getAddress(value);
  } catch {
    throw new TypeError(`tokens: ${name} is not an EVM address: ${JSON.stringify(value)}`);
  }
}

function isEvmContractAddress(value) {
  try {
    getAddress(value);
    return true;
  } catch {
    return false;
  }
}

async function encodedCall(chainDescriptor, to, fn, args, options) {
  const data = erc20.encodeFunctionData(fn, args);
  const result = await call(chainDescriptor, "eth_call", [{ to, data }, observationBlockTag(options)], options);
  if (!result.ok) return result;
  try {
    return {
      ok: true, value: erc20.decodeFunctionResult(fn, result.value)[0], via: result.via,
      ...(result.provenance === undefined ? {} : { provenance: result.provenance }),
    };
  } catch (error) {
    return { ok: false, reason: `malformed ${fn} response from ${result.via}: ${error.message}`, attempts: [] };
  }
}

/**
 * Exact on-chain balance of one already-known ERC-20 token for one address.
 * @param {import("./chains.d.ts").ChainDescriptor} chainDescriptor
 * @param {string} tokenAddress
 * @param {string} walletAddress
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<import("./tokens.d.ts").TokenBalance>} `checked: false` means the balance was
 *   incomplete, not that the token is absent. `balanceObserved` retains exact atoms when metadata fails.
 */
export async function balanceOfToken(chainDescriptor, tokenAddress, walletAddress, options = {}) {
  const token = normalizedAddress("tokenAddress", tokenAddress);
  const wallet = normalizedAddress("walletAddress", walletAddress);
  const balanceResult = await encodedCall(chainDescriptor, token, "balanceOf", [wallet], options);
  if (!balanceResult.ok) {
    return {
      chain: chainDescriptor.id, token, address: wallet,
      checked: false, reason: balanceResult.reason, attempts: balanceResult.attempts,
    };
  }
  const [decimalsResult, symbolResult] = await Promise.all([
    encodedCall(chainDescriptor, token, "decimals", [], options),
    encodedCall(chainDescriptor, token, "symbol", [], options),
  ]);
  if (options.boundary !== undefined && (!decimalsResult.ok || !symbolResult.ok)) {
    const failed = !decimalsResult.ok ? decimalsResult : symbolResult;
    return {
      chain: chainDescriptor.id, token, address: wallet, checked: false,
      reason: `boundary-coherent token metadata unavailable: ${failed.reason}`, attempts: failed.attempts ?? [],
      balanceObserved: true, raw: balanceResult.value.toString(), empty: balanceResult.value === 0n,
      decimals: decimalsResult.ok ? Number(decimalsResult.value) : null,
      symbol: symbolResult.ok ? String(symbolResult.value) : null,
      provenance: observationProvenance(options.boundary, [balanceResult, ...[decimalsResult, symbolResult].filter(result=>result.ok)]),
    };
  }
  const decimals = decimalsResult.ok ? Number(decimalsResult.value) : null;
  const symbol = symbolResult.ok ? String(symbolResult.value) : null;
  const raw = balanceResult.value;
  return {
    chain: chainDescriptor.id, token, address: wallet, checked: true,
    symbol, decimals, raw: raw.toString(),
    amount: decimals == null ? null : formatUnits(raw, decimals),
    empty: raw === 0n, via: balanceResult.via,
    ...(options.boundary === undefined ? {} : {
      provenance: observationProvenance(options.boundary, [balanceResult, decimalsResult, symbolResult]),
    }),
  };
}

/**
 * Ask a chain's registered block-explorer indexer(s) what ERC-20 tokens an address holds.
 * Discovery only, never proof — see `verifiedTokenHoldings`. A chain with no registered
 * indexer returns `checked: false` immediately; no URL is ever guessed.
 * @param {import("./chains.d.ts").ChainDescriptor} chainDescriptor
 * @param {string} walletAddress
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<import("./tokens.d.ts").TokenDiscovery>}
 */
export async function discoverTokenHoldings(chainDescriptor, walletAddress, options = {}) {
  const wallet = normalizedAddress("walletAddress", walletAddress);
  const { fetchImpl = fetch, timeoutMs = 15000 } = options;
  if (chainDescriptor.indexers.length === 0) {
    return {
      chain: chainDescriptor.id, address: wallet, checked: false,
      reason: `${chainDescriptor.id} has no registered indexer`, attempts: [],
    };
  }
  const attempts = [];
  for (const configured of chainDescriptor.indexers) {
    const indexer = typeof configured === "string" ? { id: "blockscout", url: configured } : configured;
    const base = indexer?.url;
    const url = indexer?.id === "rabby"
      ? `${base.replace(/\/$/u, "")}/v1/user/token_list?id=${wallet}&chain_id=${chainDescriptor.id}&is_all=true`
      : `${base?.replace(/\/$/u, "")}/addresses/${wallet}/token-balances`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(url, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) {
        attempts.push({ url, error: `http ${response.status}` });
        continue;
      }
      const payload = await response.json();
      if (!Array.isArray(payload)) {
        attempts.push({ url, error: "malformed response: not an array" });
        continue;
      }
      const discovered = indexer.id === "rabby"
        // Rabby includes the native asset as `id: "base"` and can include arbitrary index
        // metadata. Neither is an ERC-20 candidate. Only a parsable EVM contract proceeds to
        // on-chain balance verification; indexer balances and metadata remain untrusted.
        ? payload.filter((entry) => entry?.chain === chainDescriptor.id && isEvmContractAddress(entry?.id)).map((entry) => ({
          tokenAddress: entry.id,
          claimedSymbol: entry.name ?? null,
          claimedDecimals: entry.decimals == null ? null : Number(entry.decimals),
          claimedRawBalance: String(entry.raw_amount_hex_str ?? "0"),
        }))
        // Blockscout API v2 names the token's contract address `address_hash`, not `address`.
        : payload.filter((entry) => entry?.token?.type === "ERC-20" && entry?.token?.address_hash).map((entry) => ({
          tokenAddress: entry.token.address_hash,
          claimedSymbol: entry.token.symbol ?? null,
          claimedDecimals: entry.token.decimals == null ? null : Number(entry.token.decimals),
          claimedRawBalance: String(entry.value ?? "0"),
        }));
      return { chain: chainDescriptor.id, address: wallet, checked: true, via: url, discovered };
    } catch (error) {
      attempts.push({ url, error: error?.name === "AbortError" ? `timeout after ${timeoutMs}ms` : String(error?.message ?? error) });
    }
  }
  return {
    chain: chainDescriptor.id, address: wallet, checked: false,
    reason: `all ${chainDescriptor.indexers.length} indexer(s) failed for ${chainDescriptor.id}`, attempts,
  };
}

/**
 * Discovery followed by on-chain proof: every token an indexer claims is held is re-read with
 * `balanceOfToken`, so the reported holding is an exact on-chain fact, not a cached index claim.
 * The indexer's claimed symbol/balance ride along so a mismatch stays visible.
 * @param {import("./chains.d.ts").ChainDescriptor} chainDescriptor
 * @param {string} walletAddress
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<import("./tokens.d.ts").VerifiedTokenHoldings>}
 */
export async function verifiedTokenHoldings(chainDescriptor, walletAddress, options = {}) {
  const discovery = options.discovery ?? await discoverTokenHoldings(chainDescriptor, walletAddress, options);
  if (!discovery.checked && !discovery.discovered?.length) return { ...discovery, holdings: [] };
  if (!Array.isArray(discovery.discovered) || discovery.discovered.length > 2048) throw new TypeError("bounded-token-candidates-required");
  if (normalizedAddress("walletAddress", discovery.address) !== normalizedAddress("walletAddress", walletAddress) || discovery.chain !== chainDescriptor.id) throw new TypeError("token-candidate-wallet-chain-mismatch");
  const holdings = [];
  // Multicall retains one boundary while avoiding hundreds of public round trips.
  // Chains/providers that cannot return an aggregate retain bounded direct reads.
  for (let offset = 0; offset < discovery.discovered.length; offset += 32) {
    const candidates = discovery.discovered.slice(offset, offset + 32);
    const aggregate = await tokenBalanceBatch(chainDescriptor, walletAddress, candidates, options);
    if (aggregate !== null) { holdings.push(...aggregate); continue; }
    for (let cursor = 0; cursor < candidates.length; cursor += 4) {
      const batch = await Promise.all(candidates.slice(cursor, cursor + 4).map(async candidate => ({
        ...await balanceOfToken(chainDescriptor, candidate.tokenAddress, walletAddress, options),
        indexerClaimedSymbol: candidate.claimedSymbol,
        indexerClaimedRawBalance: candidate.claimedRawBalance,
      })));
      holdings.push(...batch);
    }
  }
  if (options.boundary !== undefined) {
    const failed = holdings.find((holding) => !holding.checked);
    if (failed !== undefined) {
      return {
        chain: chainDescriptor.id, address: discovery.address, checked: false,
        reason: `boundary-coherent token verification failed: ${failed.reason}`,
        attempts: failed.attempts ?? [], holdings,
        provenance: { ...options.boundary, reads: holdings.flatMap(holding => holding.provenance?.reads ?? []) },
      };
    }
    return {
      ...discovery,
      holdings,
      provenance: { ...options.boundary, reads: holdings.flatMap((holding) => holding.provenance?.reads ?? []) },
    };
  }
  return { ...discovery, holdings };
}

/** Multicall3: the same address on every EVM chain it is deployed to, Base among them. */
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicall3 = new Interface([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

async function tokenBalanceBatch(chainDescriptor, walletAddress, candidates, options) {
  const wallet = normalizedAddress("walletAddress", walletAddress);
  const tokens = candidates.map(candidate => normalizedAddress("tokenAddress", candidate.tokenAddress));
  const methods = ["balanceOf", "decimals", "symbol"];
  const data = multicall3.encodeFunctionData("aggregate3", [tokens.flatMap(target => methods.map(method => ({
    target, allowFailure: true, callData: erc20.encodeFunctionData(method, method === "balanceOf" ? [wallet] : []),
  })))]);
  const result = await call(chainDescriptor, "eth_call", [{to:MULTICALL3,data}, observationBlockTag(options)], options);
  if (!result.ok) return null;
  let values;
  try { [values] = multicall3.decodeFunctionResult("aggregate3", result.value); }
  catch { return null; }
  if (values.length !== tokens.length * methods.length) return null;
  return tokens.map((token,index) => {
    const decoded = methods.map((method,field) => {
      const item = values[index * methods.length + field];
      if (!item.success) return {ok:false};
      try { return {ok:true,value:erc20.decodeFunctionResult(method,item.returnData)[0]}; }
      catch { return {ok:false}; }
    });
    const [balance,decimals,symbol] = decoded;
    const common = {chain:chainDescriptor.id,token,address:wallet,indexerClaimedSymbol:candidates[index].claimedSymbol,indexerClaimedRawBalance:candidates[index].claimedRawBalance};
    if (!balance.ok) return {...common,checked:false,reason:"multicall balanceOf reverted or was malformed",attempts:[]};
    const metadataComplete = decimals.ok && symbol.ok;
    const provenance = options.boundary === undefined ? {} : {provenance:observationProvenance(options.boundary,[result])};
    return {...common,checked:options.boundary === undefined || metadataComplete,
      ...(!metadataComplete && options.boundary !== undefined ? {balanceObserved:true,reason:"boundary-coherent token metadata unavailable: multicall metadata reverted or was malformed",attempts:[]} : {}),
      raw:balance.value.toString(),empty:balance.value === 0n,
      decimals:decimals.ok ? Number(decimals.value) : null,symbol:symbol.ok ? String(symbol.value) : null,
      amount:decimals.ok ? formatUnits(balance.value,Number(decimals.value)) : null,via:result.via,...provenance};
  });
}

/**
 * One known ERC-20 token's exact balance for many addresses in one read (Multicall3
 * `aggregate3`), at the caller's boundary when given: a public endpoint that throttles per-call
 * reads answers one call. Each address is `{checked: true, raw}` or `{checked: false, reason}`; a
 * failed inner call is unlearned, never zero.
 * @param {import("./chains.d.ts").ChainDescriptor} chainDescriptor
 * @param {string} tokenAddress
 * @param {ReadonlyArray<string>} walletAddresses
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, boundary?: object, publicEvmReadPool?: object}} [options]
 * @returns {Promise<Array<{address: string, checked: boolean, raw?: string, reason?: string}>>}
 */
export async function balancesOfToken(chainDescriptor, tokenAddress, walletAddresses, options = {}) {
  const token = normalizedAddress("tokenAddress", tokenAddress);
  const wallets = walletAddresses.map((address) => normalizedAddress("walletAddress", address));
  if (wallets.length === 0) return [];
  const data = multicall3.encodeFunctionData("aggregate3", [wallets.map((wallet) => ({ target: token, allowFailure: true, callData: erc20.encodeFunctionData("balanceOf", [wallet]) }))]);
  const result = await call(chainDescriptor, "eth_call", [{ to: MULTICALL3, data }, observationBlockTag(options)], options);
  if (!result.ok) return wallets.map((address) => ({ address, checked: false, reason: result.reason }));
  let returned;
  try { [returned] = multicall3.decodeFunctionResult("aggregate3", result.value); }
  catch (error) { return wallets.map((address) => ({ address, checked: false, reason: `malformed aggregate3 response from ${result.via}: ${error.message}` })); }
  return wallets.map((address, index) => {
    const { success, returnData } = returned[index];
    if (!success) return { address, checked: false, reason: "balanceOf reverted" };
    try { return { address, checked: true, raw: erc20.decodeFunctionResult("balanceOf", returnData)[0].toString() }; }
    catch (error) { return { address, checked: false, reason: `malformed balanceOf: ${error.message}` }; }
  });
}
