/**
 * Compose wallet balances, token holdings, protocol positions, and rewards at one block per
 * chain. The caller supplies the public wallet roster and the protocol addresses to track.
 */
import { getAddress } from "ethers";
import {
  acquireObservationBoundary, allChains, callMany, sameObservationBoundary, verifyObservationBoundary,
} from "./chains.mjs";
import { observeAddress } from "./native.mjs";
import { observeCompoundForkMarket, observeVaultPosition } from "./positions.mjs";
import { observeMorphoVaultPosition } from "./morpho.mjs";
import { observeMoonwellOutstandingRewards } from "./rewards.mjs";
import { verifiedTokenHoldings } from "./tokens.mjs";

const BEEFY_SYMBOL_PATTERN = /^r?(?:moo|Moo)/u;
export const PORTFOLIO_LIMITS = Object.freeze({ wallets: 100, chains: 16, positionsPerChain: 100, concurrency: 16 });

function validateRoster(roster) {
  if (!Array.isArray(roster) || roster.length === 0) {
    throw new RangeError("portfolio: roster must be a non-empty array");
  }
  if (roster.length > PORTFOLIO_LIMITS.wallets) throw new RangeError(`portfolio: roster exceeds ${PORTFOLIO_LIMITS.wallets} wallets`);
  const subjects = new Set();
  return roster.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError(`portfolio: roster[${index}] must be an object`);
    }
    if (typeof entry.subject !== "string" || entry.subject.trim() === "") {
      throw new TypeError(`portfolio: roster[${index}].subject must be a non-empty public subject`);
    }
    const subject = entry.subject.trim();
    if (subjects.has(subject)) throw new RangeError(`portfolio: duplicate subject ${JSON.stringify(subject)}`);
    subjects.add(subject);
    let address;
    try {
      address = getAddress(entry.address);
    } catch {
      throw new TypeError(`portfolio: roster[${index}].address is not an EVM address`);
    }
    return Object.freeze({ subject, address });
  });
}

function validateChains(chains) {
  if (!Array.isArray(chains) || chains.length === 0) {
    throw new RangeError("portfolio: chains must be a non-empty array");
  }
  if (chains.length > PORTFOLIO_LIMITS.chains) throw new RangeError(`portfolio: chains exceeds ${PORTFOLIO_LIMITS.chains} selections`);
  const ids = new Set();
  for (const [index, descriptor] of chains.entries()) {
    if (descriptor === null || typeof descriptor !== "object"
      || typeof descriptor.id !== "string" || typeof descriptor.caip2 !== "string") {
      throw new TypeError(`portfolio: chains[${index}] is not a chain descriptor`);
    }
    if (ids.has(descriptor.id)) throw new RangeError(`portfolio: duplicate chain ${JSON.stringify(descriptor.id)}`);
    ids.add(descriptor.id);
  }
  return chains;
}

function validateMoonwell(moonwell, selectedChains) {
  if (moonwell === undefined) return Object.create(null);
  if (moonwell === null || typeof moonwell !== "object" || Array.isArray(moonwell)) {
    throw new TypeError("portfolio: moonwell must be an object keyed by chain id");
  }
  const chainIds = new Set(selectedChains.map(({ id }) => id));
  const normalized = Object.create(null);
  for (const [chainId, config] of Object.entries(moonwell)) {
    if (!chainIds.has(chainId)) {
      throw new RangeError(`portfolio: Moonwell configuration names unselected chain ${JSON.stringify(chainId)}`);
    }
    if (config === null || typeof config !== "object" || Array.isArray(config)) {
      throw new TypeError(`portfolio: moonwell.${chainId} must be an object`);
    }
    try {
      normalized[chainId] = Object.freeze({ rewardDistributor: getAddress(config.rewardDistributor) });
    } catch {
      throw new TypeError(`portfolio: moonwell.${chainId}.rewardDistributor is not an EVM address`);
    }
  }
  return normalized;
}

function validatePositions(positions, selectedChains) {
  const normalized = Object.create(null);
  if (positions === undefined) return normalized;
  if (positions === null || typeof positions !== "object" || Array.isArray(positions)) {
    throw new TypeError("portfolio: positions must be an object keyed by chain id");
  }
  const selected = new Set(selectedChains.map(({ id }) => id));
  for (const [chainId, entries] of Object.entries(positions)) {
    if (!selected.has(chainId)) throw new RangeError(`portfolio: positions names unselected chain ${JSON.stringify(chainId)}`);
    if (!Array.isArray(entries) || entries.length > PORTFOLIO_LIMITS.positionsPerChain) {
      throw new RangeError(`portfolio: positions.${chainId} must contain at most ${PORTFOLIO_LIMITS.positionsPerChain} positions`);
    }
    const seen = new Set();
    normalized[chainId] = Object.freeze(entries.map((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)
        || !["compound-fork", "erc4626"].includes(entry.kind)
        || Object.keys(entry).some((key) => !["kind", "address"].includes(key))) {
        throw new TypeError(`portfolio: positions.${chainId}[${index}] requires kind (compound-fork or erc4626) and address`);
      }
      let address;
      try { address = getAddress(entry.address); }
      catch { throw new TypeError(`portfolio: positions.${chainId}[${index}].address is not an EVM address`); }
      const key = `${entry.kind}:${address}`;
      if (seen.has(key)) throw new RangeError(`portfolio: duplicate ${entry.kind} position ${address} on ${chainId}`);
      seen.add(key);
      return Object.freeze({ kind: entry.kind, address });
    }));
  }
  return normalized;
}

function unchecked(reason, attempts = []) {
  return { checked: false, reason, attempts };
}

function unpriced(reason) {
  return { priced: false, usd: null, reason };
}

/** One unchecked-coverage row per roster wallet, all naming the same chain-level failure reason. */
function uncheckedChainCoverage(roster, reason) {
  return roster.map(({ subject }) => ({ subject, component: "chain", reason }));
}

async function observeBeefy(chainDescriptor, wallet, tokens, options, observeVault) {
  if (!tokens.checked && !tokens.holdings?.length) {
    return unchecked(`verified token discovery unavailable: ${tokens.reason}`, tokens.attempts ?? []);
  }
  const candidates = tokens.holdings.filter((holding) => holding.checked && !holding.empty
    && typeof holding.symbol === "string" && BEEFY_SYMBOL_PATTERN.test(holding.symbol));
  const positions = [];
  for (const candidate of candidates) {
    const position = await observeVault(chainDescriptor, candidate.token, wallet.address, options);
    positions.push(position.checked
      ? { ...position, valuation: unpriced("no USD valuation provider was supplied") }
      : position);
  }
  const failures = positions.filter(({ checked }) => !checked);
  return {
    checked: tokens.checked === true && failures.length === 0,
    positions,
    ...(!tokens.checked ? {reason: `verified token discovery incomplete: ${tokens.reason}`, attempts: tokens.attempts ?? []} : failures.length === 0 ? {} : {
      reason: `${failures.length} Beefy position observation(s) were unreachable`,
      attempts: failures.flatMap(({ attempts = [] }) => attempts),
    }),
  };
}

function componentFailures(wallet, moonwellConfigured) {
  const components = [
    ["native", wallet.native],
    ["verifiedTokens", wallet.verifiedTokens],
    ["beefyPositions", wallet.beefyPositions],
    ...(wallet.trackedPositions === undefined ? [] : [["trackedPositions", wallet.trackedPositions]]),
    ...(moonwellConfigured ? [["moonwellRewards", wallet.moonwellRewards]] : []),
  ];
  return components
    .filter(([, observation]) => observation.checked !== true)
    .map(([component, observation]) => ({
      subject: wallet.subject,
      component,
      reason: observation.reason ?? "unchecked observation",
    }));
}

async function observeTrackedPositions(chainDescriptor, wallet, selections, options, dependencies) {
  const positions = [];
  for (const { kind, address } of selections) {
    let observation;
    try {
      const observe = kind === "compound-fork" ? dependencies.observeCompound : dependencies.observeErc4626;
      observation = await observe(chainDescriptor, address, wallet.address, options);
      if (observation?.checked === true && !sameObservationBoundary(options.boundary, observation.provenance)) {
        observation = unchecked("position returned a different observation boundary");
      } else if (observation === null || typeof observation !== "object" || typeof observation.checked !== "boolean") {
        observation = unchecked("position reader returned an invalid observation");
      }
    } catch (error) {
      observation = unchecked(`position observation failed: ${String(error?.message ?? error)}`);
    }
    positions.push({ ...observation, kind, contract: address });
  }
  const failed = positions.filter(({ checked }) => !checked);
  return {
    checked: failed.length === 0,
    positions,
    ...(failed.length === 0 ? {} : {
      reason: `${failed.length} tracked position observation(s) were unavailable`,
      attempts: failed.flatMap(({ attempts = [] }) => attempts),
    }),
  };
}

async function defaultObserveChain(chainDescriptor, roster, config, dependencies) {
  const boundaryResult = await dependencies.acquireBoundary(chainDescriptor, {
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: config.timeoutMs,
    finality: config.finality,
    now: () => config.observedDate,
  });
  if (!boundaryResult.ok) {
    return {
      chain: chainDescriptor.id,
      caip2: chainDescriptor.caip2,
      checked: false,
      provenance: null,
      reason: boundaryResult.reason,
      attempts: boundaryResult.attempts,
      wallets: roster.map((wallet) => ({
        ...wallet,
        checked: false,
        reason: boundaryResult.reason,
        attempts: boundaryResult.attempts,
      })),
      coverage: {
        walletsAttempted: roster.length,
        walletsObserved: 0,
        complete: false,
        unchecked: uncheckedChainCoverage(roster, boundaryResult.reason),
      },
    };
  }

  const boundary = boundaryResult.value;
  const options = {
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: config.timeoutMs,
    boundary,
  };
  const moonwellConfig = config.moonwell[chainDescriptor.id];
  const trackedSelections = config.positions[chainDescriptor.id];
  const wallets = await callMany(roster.map((wallet) => async () => {
    const [native, tokens, moonwellRewards, trackedPositions] = await Promise.all([
      dependencies.observeNative(chainDescriptor, wallet.address, options),
      dependencies.observeTokens(chainDescriptor, wallet.address, options),
      moonwellConfig === undefined
        ? Promise.resolve({
          supported: false,
          checked: false,
          reason: "no Moonwell reward distributor configured for this chain",
          attempts: [],
        })
        : dependencies.observeMoonwell(
          chainDescriptor, moonwellConfig.rewardDistributor, wallet.address, options,
        ).then((result) => ({
          supported: true,
          ...result,
          ...(result.checked ? { valuation: unpriced("no USD valuation provider was supplied") } : {}),
        })),
      trackedSelections === undefined ? Promise.resolve(undefined)
        : observeTrackedPositions(chainDescriptor, wallet, trackedSelections, options, dependencies),
    ]);
    const beefyPositions = await observeBeefy(
      chainDescriptor, wallet, tokens, options, dependencies.observeVault,
    );
    const nativeWithValuation = native.checked
      ? { ...native, valuation: unpriced("no USD valuation provider was supplied") }
      : native;
    const tokensWithValuation = tokens.checked
      ? {
        ...tokens,
        holdings: tokens.holdings.map((holding) => (holding.checked && !holding.empty
          ? { ...holding, valuation: unpriced("no USD valuation provider was supplied") }
          : holding)),
      }
      : tokens;
    return {
      subject: wallet.subject,
      address: wallet.address,
      checked: true,
      native: nativeWithValuation,
      verifiedTokens: tokensWithValuation,
      moonwellRewards,
      beefyPositions,
      ...(trackedPositions === undefined ? {} : { trackedPositions }),
    };
  }), config.concurrency);

  const verified = await dependencies.verifyBoundary(chainDescriptor, boundary, {
    fetchImpl: dependencies.fetchImpl,
    timeoutMs: config.timeoutMs,
  });
  if (!verified.ok) {
    return {
      chain: chainDescriptor.id,
      caip2: chainDescriptor.caip2,
      checked: false,
      provenance: boundary,
      reason: verified.reason,
      attempts: verified.attempts,
      wallets: roster.map((wallet) => ({
        ...wallet,
        checked: false,
        reason: `observation boundary could not be reconciled: ${verified.reason}`,
        attempts: verified.attempts,
      })),
      coverage: {
        walletsAttempted: roster.length,
        walletsObserved: 0,
        complete: false,
        unchecked: uncheckedChainCoverage(roster, verified.reason),
      },
    };
  }

  const failures = wallets.flatMap((wallet) => componentFailures(wallet, moonwellConfig !== undefined));
  return {
    chain: chainDescriptor.id,
    caip2: chainDescriptor.caip2,
    checked: true,
    provenance: boundary,
    wallets,
    coverage: {
      walletsAttempted: roster.length,
      walletsObserved: wallets.length,
      complete: failures.length === 0,
      unchecked: failures,
    },
  };
}

/**
 * Observe a public EVM wallet roster across selected chains without constructing any action.
 * All effects are injectable so callers can govern transport and tests can remain offline.
 */
export async function observePortfolio(input, injected = {}) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("portfolio: input must be an object");
  }
  const roster = validateRoster(input.roster);
  const chains = validateChains(input.chains ?? allChains());
  const moonwell = validateMoonwell(input.moonwell, chains);
  const positions = validatePositions(input.positions, chains);
  const now = injected.now ?? (() => new Date());
  const observedDate = now();
  if (!(observedDate instanceof Date) || !Number.isFinite(observedDate.getTime())) {
    throw new TypeError("portfolio: now() must return a valid Date");
  }
  const dependencies = {
    acquireBoundary: injected.acquireBoundary ?? acquireObservationBoundary,
    verifyBoundary: injected.verifyBoundary ?? verifyObservationBoundary,
    observeNative: injected.observeNative ?? observeAddress,
    observeTokens: injected.observeTokens ?? verifiedTokenHoldings,
    observeMoonwell: injected.observeMoonwell ?? observeMoonwellOutstandingRewards,
    observeVault: injected.observeVault ?? observeVaultPosition,
    observeCompound: injected.observeCompound ?? observeCompoundForkMarket,
    observeErc4626: injected.observeErc4626 ?? observeMorphoVaultPosition,
    observeChain: injected.observeChain ?? defaultObserveChain,
    fetchImpl: injected.fetchImpl ?? fetch,
  };
  const config = {
    moonwell,
    positions,
    concurrency: input.concurrency ?? 4,
    finality: input.finality ?? "finalized",
    timeoutMs: input.timeoutMs ?? 15000,
    observedDate,
  };
  if (!new Set(["latest", "safe", "finalized"]).has(config.finality)) {
    throw new RangeError(`portfolio: finality must be "latest", "safe" or "finalized", got ${JSON.stringify(config.finality)}`);
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new RangeError("portfolio: timeoutMs must be a positive number");
  }
  if (!Number.isInteger(config.concurrency) || config.concurrency < 1 || config.concurrency > PORTFOLIO_LIMITS.concurrency) {
    throw new RangeError(`portfolio: concurrency must be an integer from 1 through ${PORTFOLIO_LIMITS.concurrency}`);
  }

  // Complete each chain's bounded wallet queue before acquiring the next chain boundary.
  const observations = await callMany(chains.map(
    (descriptor) => () => dependencies.observeChain(descriptor, roster, config, dependencies),
  ), 1);
  const incompleteChains = observations.filter(({ coverage }) => !coverage.complete).map(({ chain }) => chain);
  return {
    observedAt: observedDate.toISOString(),
    roster,
    chains: observations,
    coverage: {
      complete: incompleteChains.length === 0,
      incompleteChains,
    },
  };
}

