/**
 * Morpho ERC-4626 vault position and rate observation. Same checked/unreachable discipline as
 * the rest of this package: a share balance or exchange rate is read from two independently
 * selected RPC endpoints and reported `checked: true` only when both agree exactly.
 */
import { Interface, getAddress } from "ethers";
import { call, formatUnits, observationBlockTag, observationProvenance, verifyObservationBoundary } from "./chains.mjs";

const vaultInterface = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256 assets)",
  "function convertToShares(uint256 assets) view returns (uint256 shares)",
  "function asset() view returns (address)",
  "function decimals() view returns (uint8)",
]);

const MORPHO_GRAPHQL_ENDPOINT = "https://api.morpho.org/graphql";

/**
 * One `eth_call` decoded through `vaultInterface`, scoped to a single RPC endpoint.
 * @param {import("./chains.d.ts").ChainDescriptor} chainDescriptorAtOneEndpoint
 * @returns {Promise<{ok: true, value: unknown, via: string}|{ok: false, reason: string, attempts: readonly import("./chains.d.ts").Attempt[]}>}
 */
async function callOneEndpoint(chainDescriptorAtOneEndpoint, to, fn, args, options) {
  const data = vaultInterface.encodeFunctionData(fn, args);
  const sourceOptions = options.boundary === undefined ? options : {
    ...options,
    boundary: { ...options.boundary, provider: chainDescriptorAtOneEndpoint.rpc[0] },
  };
  const result = await call(chainDescriptorAtOneEndpoint, "eth_call", [{ to, data }, observationBlockTag(sourceOptions)], sourceOptions);
  if (!result.ok) return result;
  if (options.boundary !== undefined) {
    const verified = await verifyObservationBoundary(chainDescriptorAtOneEndpoint, sourceOptions.boundary, sourceOptions);
    if (!verified.ok) return verified;
  }
  try {
    return {
      ok: true, value: vaultInterface.decodeFunctionResult(fn, result.value)[0], via: result.via,
      ...(options.boundary === undefined ? {} : {
        provenance: { ...options.boundary, method: "eth_call", blockTag: options.boundary.blockTag },
      }),
    };
  } catch (error) {
    return { ok: false, reason: `malformed ${fn} response from ${result.via}: ${error.message}`, attempts: [] };
  }
}

/**
 * Reads one on-chain value against two independently selected endpoints and reports agreement.
 * Never averages or prefers one answer over the other -- a disagreement is a refusal.
 * @param {import("./chains.d.ts").ChainDescriptor} chainDescriptor
 * @returns {Promise<{ok: true, value: bigint, sources: readonly string[]}|{ok: false, reason: string, attempts: readonly import("./chains.d.ts").Attempt[]}>}
 */
async function dualSourceRead(chainDescriptor, to, fn, args, options) {
  if (options.boundary !== undefined && !chainDescriptor.rpc.includes(options.boundary.provider)) {
    return { ok: false, reason: "observation boundary provider is not registered for this chain", attempts: [] };
  }
  const endpoints = [...new Map(chainDescriptor.rpc.map((url) => [new URL(url).href, url])).values()];
  if (endpoints.length < 2) {
    return { ok: false, reason: `${chainDescriptor.id} has only ${endpoints.length} registered RPC endpoint(s); two independent sources are required`, attempts: [] };
  }
  const [urlA, urlB] = endpoints;
  const [resultA, resultB] = await Promise.all([
    callOneEndpoint({ ...chainDescriptor, rpc: [urlA] }, to, fn, args, options),
    callOneEndpoint({ ...chainDescriptor, rpc: [urlB] }, to, fn, args, options),
  ]);
  if (!resultA.ok || !resultB.ok) {
    const attempts = [...(resultA.ok ? [] : resultA.attempts ?? []), ...(resultB.ok ? [] : resultB.attempts ?? [])];
    const reason = !resultA.ok && !resultB.ok
      ? `both independent sources failed for ${fn}: ${resultA.reason}; ${resultB.reason}`
      : `only one of two independent sources answered ${fn}: ${(resultA.ok ? resultB : resultA).reason}`;
    return { ok: false, reason, attempts };
  }
  if (resultA.value.toString() !== resultB.value.toString()) {
    return {
      ok: false,
      reason: `independent sources disagree on ${fn}: ${urlA} returned ${resultA.value}, ${urlB} returned ${resultB.value}`,
      attempts: [],
    };
  }
  return { ok: true, value: resultA.value, sources: [urlA, urlB], reads: [resultA, resultB] };
}

function positionProvenance(boundary, outcomes) {
  if (boundary === undefined) return {};
  const reads = outcomes.flatMap((outcome) => outcome.reads);
  const provenance = observationProvenance(boundary, reads);
  return {
    provenance: {
      ...provenance,
      reads: provenance.reads.map((read, index) => ({ ...read, provider: reads[index].via })),
    },
  };
}

/**
 * One wallet's position in an ERC-4626 Morpho vault: share balance and its current asset value,
 * each confirmed by two independent RPC endpoints agreeing exactly. `checked: false` means the
 * position was never learned, not that it is empty.
 * @param {import("./chains.d.ts").ChainDescriptor} chainDescriptor
 * @param {string} vaultAddress ERC-4626 vault (Morpho Blue MetaMorpho or Vault V2).
 * @param {string} ownerAddress
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<import("./morpho.d.ts").MorphoVaultPosition>}
 */
export async function observeMorphoVaultPosition(chainDescriptor, vaultAddress, ownerAddress, options = {}) {
  const vault = getAddress(vaultAddress);
  const owner = getAddress(ownerAddress);

  const sharesRead = await dualSourceRead(chainDescriptor, vault, "balanceOf", [owner], options);
  if (!sharesRead.ok) {
    return { chain: chainDescriptor.id, vault, owner, checked: false, reason: sharesRead.reason, attempts: sharesRead.attempts };
  }
  const sharesRaw = sharesRead.value;

  const decimalsRead = await dualSourceRead(chainDescriptor, vault, "decimals", [], options);
  if (!decimalsRead.ok) {
    return { chain: chainDescriptor.id, vault, owner, checked: false, reason: decimalsRead.reason, attempts: decimalsRead.attempts };
  }
  const shareDecimals = Number(decimalsRead.value);

  if (sharesRaw === 0n) {
    return {
      chain: chainDescriptor.id, vault, owner, checked: true, empty: true,
      shares: { raw: "0", decimals: shareDecimals, amount: formatUnits(0n, shareDecimals) },
      sources: sharesRead.sources,
      ...positionProvenance(options.boundary, [sharesRead, decimalsRead]),
    };
  }

  const assetRead = await dualSourceRead(chainDescriptor, vault, "asset", [], options);
  if (!assetRead.ok) {
    return { chain: chainDescriptor.id, vault, owner, checked: false, reason: assetRead.reason, attempts: assetRead.attempts };
  }
  const assetAddress = getAddress(assetRead.value);

  // `asset()`'s ERC-20 shares the vault interface's bare `decimals()` selector, so the same
  // dual-source reader applies unchanged, just pointed at the asset's own address.
  const assetDecimalsRead = await dualSourceRead(chainDescriptor, assetAddress, "decimals", [], options);
  if (!assetDecimalsRead.ok) {
    return { chain: chainDescriptor.id, vault, owner, checked: false, reason: assetDecimalsRead.reason, attempts: assetDecimalsRead.attempts };
  }
  const assetDecimals = Number(assetDecimalsRead.value);

  const assetsRead = await dualSourceRead(chainDescriptor, vault, "convertToAssets", [sharesRaw], options);
  if (!assetsRead.ok) {
    return { chain: chainDescriptor.id, vault, owner, checked: false, reason: assetsRead.reason, attempts: assetsRead.attempts };
  }
  const assetsRaw = assetsRead.value;

  return {
    chain: chainDescriptor.id, vault, owner, checked: true, empty: false,
    shares: { raw: sharesRaw.toString(), decimals: shareDecimals, amount: formatUnits(sharesRaw, shareDecimals) },
    asset: { address: assetAddress, decimals: assetDecimals },
    assets: { raw: assetsRaw.toString(), amount: formatUnits(assetsRaw, assetDecimals) },
    sources: sharesRead.sources,
    ...positionProvenance(options.boundary, [sharesRead, decimalsRead, assetRead, assetDecimalsRead, assetsRead]),
  };
}

/**
 * The exact share count an ERC-4626 vault would burn for `assetsRaw` right now, confirmed by
 * two independent RPC endpoints agreeing exactly -- converts an accrued-yield asset amount into
 * the share count a `redeem()` call must specify, so a caller never redeems by guesswork.
 * @param {import("./chains.d.ts").ChainDescriptor} chainDescriptor
 * @param {string} vaultAddress
 * @param {string} assetsRaw
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<import("./morpho.d.ts").MorphoConvertToShares>}
 */
export async function observeMorphoConvertToShares(chainDescriptor, vaultAddress, assetsRaw, options = {}) {
  const vault = getAddress(vaultAddress);
  const read = await dualSourceRead(chainDescriptor, vault, "convertToShares", [BigInt(assetsRaw)], options);
  if (!read.ok) return { chain: chainDescriptor.id, vault, checked: false, reason: read.reason, attempts: read.attempts };
  return {
    chain: chainDescriptor.id, vault, checked: true, sharesRaw: read.value.toString(), sources: read.sources,
    ...positionProvenance(options.boundary, [read]),
  };
}

/**
 * Accrued yield in a vault's asset units: the asset value above a caller-supplied principal,
 * never invented and never clamped to zero -- a negative result is reported honestly.
 * @param {{assetsRaw: string, principalAssetsRaw: string, decimals: number}} input
 * @returns {import("./morpho.d.ts").AccruedYield}
 */
export function deriveAccruedYield({ assetsRaw, principalAssetsRaw, decimals }) {
  const assets = BigInt(assetsRaw);
  const principal = BigInt(principalAssetsRaw);
  const accrued = assets - principal;
  const nonNegative = accrued >= 0n;
  const magnitude = nonNegative ? accrued : -accrued;
  return {
    accruedRaw: accrued.toString(),
    accruedAmount: `${nonNegative ? "" : "-"}${formatUnits(magnitude, decimals)}`,
    nonNegative,
  };
}

/**
 * Reads a vault's current published APY from Morpho's public GraphQL API
 * (docs.morpho.org/developers/api/morpho-vaults/, endpoint api.morpho.org/graphql):
 * `vaultByAddress(address, chainId) { state { apy netApy netApyExcludingRewards } }`.
 * `netApy` includes reward-token APR; `netApyExcludingRewards` is base lending yield alone.
 * @param {{vault: string, chainId: number}} input
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, endpoint?: string}} [options]
 * @returns {Promise<import("./morpho.d.ts").MorphoVaultApy>}
 */
export async function fetchMorphoVaultApy({ vault, chainId }, options = {}) {
  const { fetchImpl = fetch, timeoutMs = 15000, endpoint = MORPHO_GRAPHQL_ENDPOINT } = options;
  const address = getAddress(vault);
  const query = "query($address: String!, $chainId: Int!) { vaultByAddress(address: $address, chainId: $chainId) { state { apy netApy netApyExcludingRewards } } }";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables: { address, chainId } }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) return { checked: false, reason: `morpho api http ${response.status}`, via: endpoint };
    const payload = await response.json();
    if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
      return { checked: false, reason: `morpho api error: ${payload.errors.map((e) => e.message).join("; ")}`, via: endpoint };
    }
    const state = payload?.data?.vaultByAddress?.state;
    if (state == null || typeof state.netApy !== "number") {
      return { checked: false, reason: `morpho api: vault ${address} on chain ${chainId} returned no state.netApy`, via: endpoint };
    }
    return {
      checked: true, via: endpoint,
      apy: typeof state.apy === "number" ? state.apy : null,
      netApy: state.netApy,
      netApyExcludingRewards: typeof state.netApyExcludingRewards === "number" ? state.netApyExcludingRewards : null,
    };
  } catch (error) {
    return {
      checked: false, via: endpoint,
      reason: error?.name === "AbortError" ? `morpho api timeout after ${timeoutMs}ms` : `morpho api error: ${String(error?.message ?? error)}`,
    };
  }
}

