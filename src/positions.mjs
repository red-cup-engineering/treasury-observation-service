/**
 * DeFi position recognition: auto-compounding vault shares (Beefy-style) and Compound-fork
 * lending markets (Moonwell and siblings). Reports current on-chain state only — no
 * liquidation-risk or stress math; that lives with
 * `@red-cup-engineering/ethereum-engineering-services-section`'s `moonwell-account-health.mjs`.
 */
import { Interface, getAddress } from "ethers";
import { formatUnits, observationProvenance } from "./chains.mjs";
import { encoded } from "./contract-call.mjs";
import { balanceOfToken } from "./tokens.mjs";

const vaultInterface = new Interface([
  "function getPricePerFullShare() view returns (uint256)",
]);

// BeefyRewardPool stakes and mints an equal number of receipt atoms. Its v2
// earned(address) returns parallel token/amount arrays, not a scalar reward.
// https://github.com/beefyfinance/beefy-contracts/blob/master/contracts/BIFI/infra/BeefyRewardPool.sol
const boostInterface = new Interface([
  "function stakedToken() view returns (address)",
  "function earned(address) view returns (address[],uint256[])",
]);

async function observeBoostPosition(chainDescriptor, vault, walletAddress, shares, options) {
  const staked = await encoded(boostInterface, chainDescriptor, vault, "stakedToken", [], options);
  if (!staked.ok) return null;
  const token = getAddress(staked.value[0]);
  if (token === "0x0000000000000000000000000000000000000000" || token === vault) {
    return { chain: chainDescriptor.id, vault, address: walletAddress, checked: false,
      empty: false, shares, reason: "boost staked token must be a distinct nonzero asset" };
  }
  const [rewards, conversion] = await Promise.all([
    encoded(boostInterface, chainDescriptor, vault, "earned", [walletAddress], options),
    encoded(vaultInterface, chainDescriptor, token, "getPricePerFullShare", [], options),
  ]);
  const stakedAsset = { token, raw: shares.raw };
  if (conversion.ok) {
    stakedAsset.pricePerFullShareRaw = conversion.value[0].toString();
    stakedAsset.underlyingRaw = (BigInt(shares.raw) * conversion.value[0] / (10n ** 18n)).toString();
  } else stakedAsset.reason = conversion.reason;
  let earnedRewards;
  let rewardFailure;
  if (!rewards.ok) rewardFailure = rewards.reason;
  else {
    const [tokens, amounts] = rewards.value;
    if (tokens.length !== amounts.length || tokens.length > 100
      || new Set(tokens.map(token => token.toLowerCase())).size !== tokens.length
      || tokens.some(token => /^0x0{40}$/iu.test(token))) {
      rewardFailure = "bounded distinct boost reward token/amount pairs required";
    } else earnedRewards = tokens.map((token, index) => ({ token: getAddress(token), raw: amounts[index].toString() }));
  }
  const failures = [rewardFailure, conversion.ok ? undefined : conversion.reason].filter(Boolean);
  return {
    chain: chainDescriptor.id, vault, address: walletAddress, positionKind: "staking-boost",
    checked: failures.length === 0, empty: false, shares, stakedAsset,
    ...(earnedRewards === undefined ? {} : { earnedRewards }),
    ...(failures.length === 0 ? {} : { reason: failures.join("; "), attempts: [...(rewards.attempts ?? []), ...(conversion.attempts ?? [])] }),
    ...(options.boundary === undefined ? {} : { provenance: observationProvenance(options.boundary, [
      ...shares.provenance.reads.map(read => ({ provenance: { ...options.boundary, ...read } })),
      staked, ...[rewards, conversion].filter(result => result.ok),
    ]) }),
  };
}

const BEEFY_VAULTS_URL = "https://api.beefy.finance/vaults";

/**
 * Fallback for a vault whose on-chain `getPricePerFullShare()` is unreachable, via Beefy's public
 * API. Matched by `earnedTokenAddress` — the receipt token a wallet holds — case-insensitively.
 * @param {string} vaultAddress Checksummed vault (receipt-token) address.
 * @param {string} chainId Beefy's own chain-id string, e.g. "base".
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} options
 * @returns {Promise<{ok: true, value: bigint, via: string, vaultId: string} | {ok: false, reason: string}>}
 */
async function beefyPricePerFullShareFallback(vaultAddress, chainId, options) {
  const { fetchImpl = fetch, timeoutMs = 15000 } = options;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(BEEFY_VAULTS_URL, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      return { ok: false, reason: `beefy api http ${response.status}` };
    }
    const vaults = await response.json();
    if (!Array.isArray(vaults)) {
      return { ok: false, reason: "beefy api malformed response: not an array" };
    }
    const match = vaults.find((v) => v.chain === chainId
      && typeof v.earnedTokenAddress === "string"
      && v.earnedTokenAddress.toLowerCase() === vaultAddress.toLowerCase());
    if (!match) {
      return { ok: false, reason: `beefy api: no vault on chain "${chainId}" with earnedTokenAddress ${vaultAddress}` };
    }
    if (match.pricePerFullShare == null) {
      return { ok: false, reason: `beefy api: vault "${match.id}" has no pricePerFullShare` };
    }
    let pricePerFullShareRaw;
    try {
      pricePerFullShareRaw = BigInt(match.pricePerFullShare);
    } catch {
      return { ok: false, reason: `beefy api: vault "${match.id}" pricePerFullShare is not an integer string: ${JSON.stringify(match.pricePerFullShare)}` };
    }
    return { ok: true, value: pricePerFullShareRaw, via: BEEFY_VAULTS_URL, vaultId: match.id };
  } catch (error) {
    return {
      ok: false,
      reason: error?.name === "AbortError" ? `beefy api timeout after ${timeoutMs}ms` : `beefy api error: ${String(error?.message ?? error)}`,
    };
  }
}

const cTokenInterface = new Interface([
  "function getAccountSnapshot(address) view returns (uint256,uint256,uint256,uint256)",
  "function symbol() view returns (string)",
  "function underlying() view returns (address)",
  "function supplyRatePerTimestamp() view returns (uint256)",
  "function borrowRatePerTimestamp() view returns (uint256)",
]);
const erc20Decimals = new Interface(["function decimals() view returns (uint8)"]);

/**
 * One wallet's position in a Beefy-style auto-compounding vault: share balance, price per
 * share, and the underlying amount it represents. No USD attached — pricing needs the
 * protocol's own public price API and is a separate step for the caller. Tries the on-chain
 * `getPricePerFullShare()` first; on failure, recognizes v2 staking boosts using their
 * staked token and complete unpaid-reward tuple. A boost reports its deposited vault
 * shares and their conversion separately. Other unpinned reads fall back to Beefy's public API, which prices every vault shape — `priceSource` says which path won.
 * @param {import("./chains.d.ts").ChainDescriptor} chainDescriptor
 * @param {string} vaultAddress
 * @param {string} walletAddress
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<import("./positions.d.ts").VaultPosition>}
 */
export async function observeVaultPosition(chainDescriptor, vaultAddress, walletAddress, options = {}) {
  const vault = getAddress(vaultAddress);
  const shares = await balanceOfToken(chainDescriptor, vault, walletAddress, options);
  if (!shares.checked) {
    return { chain: chainDescriptor.id, vault, address: walletAddress, checked: false, reason: shares.reason, attempts: shares.attempts };
  }
  if (shares.empty) {
    return {
      chain: chainDescriptor.id, vault, address: walletAddress, checked: true, empty: true, shares,
      ...(options.boundary === undefined ? {} : { provenance: shares.provenance }),
    };
  }
  const priceResult = await encoded(vaultInterface, chainDescriptor, vault, "getPricePerFullShare", [], options);
  let pricePerFullShareRaw;
  let via;
  let priceSource;
  if (priceResult.ok) {
    pricePerFullShareRaw = priceResult.value[0];
    via = priceResult.via;
    priceSource = "onchain";
  } else {
    const boost = await observeBoostPosition(chainDescriptor, vault, walletAddress, shares, options);
    if (boost !== null) return boost;
    if (options.boundary !== undefined) {
      return {
        chain: chainDescriptor.id, vault, address: walletAddress, checked: false,
        empty: false, shares, provenance: shares.provenance,
        reason: `boundary-coherent getPricePerFullShare() failed: ${priceResult.reason}`,
        attempts: priceResult.attempts ?? [],
      };
    }
    const fallback = await beefyPricePerFullShareFallback(vault, chainDescriptor.id, options);
    if (!fallback.ok) {
      return {
        chain: chainDescriptor.id, vault, address: walletAddress, checked: false,
        empty: false, shares,
        reason: `on-chain getPricePerFullShare() failed (${priceResult.reason}); beefy api fallback also failed (${fallback.reason})`,
        attempts: priceResult.attempts ?? [],
      };
    }
    pricePerFullShareRaw = fallback.value;
    via = fallback.via;
    priceSource = "beefy-api";
  }
  const underlyingRaw = (BigInt(shares.raw) * pricePerFullShareRaw) / (10n ** 18n);
  return {
    chain: chainDescriptor.id, vault, address: walletAddress, checked: true, empty: false,
    positionKind: "auto-compounding-vault", shares, pricePerFullShareRaw: pricePerFullShareRaw.toString(),
    underlyingRaw: underlyingRaw.toString(), via, priceSource,
    ...(options.boundary === undefined ? {} : {
      provenance: observationProvenance(options.boundary, [
        ...shares.provenance.reads.map((read) => ({ provenance: { ...options.boundary, ...read } })),
        priceResult,
      ]),
    }),
  };
}

/**
 * One wallet's position in a Compound-fork market: supplied/borrowed underlying and the
 * per-timestamp rates the market currently quotes.
 * @param {import("./chains.d.ts").ChainDescriptor} chainDescriptor
 * @param {string} marketAddress
 * @param {string} walletAddress
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<import("./positions.d.ts").CompoundForkMarketPosition>}
 */
export async function observeCompoundForkMarket(chainDescriptor, marketAddress, walletAddress, options = {}) {
  const market = getAddress(marketAddress);
  const wallet = getAddress(walletAddress);
  const snapshotResult = await encoded(cTokenInterface, chainDescriptor, market, "getAccountSnapshot", [wallet], options);
  if (!snapshotResult.ok) {
    return { chain: chainDescriptor.id, market, address: wallet, checked: false, reason: snapshotResult.reason, attempts: snapshotResult.attempts ?? [] };
  }
  const [errorCode, mTokenBalance, borrowBalance, exchangeRateMantissa] = snapshotResult.value;
  if (errorCode !== 0n) {
    return { chain: chainDescriptor.id, market, address: wallet, checked: false, reason: `market snapshot error code ${errorCode}`, attempts: [] };
  }
  const [symbolResult, underlyingResult, supplyRateResult, borrowRateResult] = await Promise.all([
    encoded(cTokenInterface, chainDescriptor, market, "symbol", [], options),
    encoded(cTokenInterface, chainDescriptor, market, "underlying", [], options),
    encoded(cTokenInterface, chainDescriptor, market, "supplyRatePerTimestamp", [], options),
    encoded(cTokenInterface, chainDescriptor, market, "borrowRatePerTimestamp", [], options),
  ]);
  if (options.boundary !== undefined) {
    const failed = [symbolResult, underlyingResult, supplyRateResult, borrowRateResult].find((result) => !result.ok);
    if (failed !== undefined) {
      return {
        chain: chainDescriptor.id, market, address: wallet, checked: false,
        reason: `boundary-coherent market metadata unavailable: ${failed.reason}`, attempts: failed.attempts ?? [],
      };
    }
  }
  const underlying = underlyingResult.ok ? underlyingResult.value[0] : null;
  let underlyingDecimals = null;
  const metadataResults = [symbolResult, underlyingResult, supplyRateResult, borrowRateResult];
  if (underlying) {
    const decimalsResult = await encoded(erc20Decimals, chainDescriptor, underlying, "decimals", [], options);
    if (options.boundary !== undefined && !decimalsResult.ok) {
      return {
        chain: chainDescriptor.id, market, address: wallet, checked: false,
        reason: `boundary-coherent underlying metadata unavailable: ${decimalsResult.reason}`,
        attempts: decimalsResult.attempts ?? [],
      };
    }
    underlyingDecimals = decimalsResult.ok ? Number(decimalsResult.value[0]) : null;
    if (decimalsResult.ok) metadataResults.push(decimalsResult);
  }
  const suppliedUnderlyingRaw = (mTokenBalance * exchangeRateMantissa) / (10n ** 18n);
  return {
    chain: chainDescriptor.id, market, address: wallet, checked: true,
    symbol: symbolResult.ok ? String(symbolResult.value[0]) : null,
    underlying, underlyingDecimals,
    mTokenBalanceRaw: mTokenBalance.toString(),
    suppliedUnderlyingRaw: suppliedUnderlyingRaw.toString(),
    suppliedUnderlyingAmount: underlyingDecimals == null ? null : formatUnits(suppliedUnderlyingRaw, underlyingDecimals),
    borrowedUnderlyingRaw: borrowBalance.toString(),
    borrowedUnderlyingAmount: underlyingDecimals == null ? null : formatUnits(borrowBalance, underlyingDecimals),
    supplyRatePerTimestampMantissa: supplyRateResult.ok ? supplyRateResult.value[0].toString() : null,
    borrowRatePerTimestampMantissa: borrowRateResult.ok ? borrowRateResult.value[0].toString() : null,
    empty: mTokenBalance === 0n && borrowBalance === 0n,
    ...(options.boundary === undefined ? {} : {
      provenance: observationProvenance(options.boundary, [snapshotResult, ...metadataResults]),
    }),
  };
}
