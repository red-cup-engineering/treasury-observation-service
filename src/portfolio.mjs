/**
 * Compose the package's read-only primitives into one secret-free treasury portfolio.
 *
 * The roster is explicit caller-owned data. This module never reads environment variables,
 * wallet files, signing material, or transaction instructions. Every value-bearing observation
 * retains its checked state, pinned-block provenance and explicit finality; unavailable discovery is not an
 * empty portfolio and an absent price is not zero dollars.
 */
import { getAddress } from "ethers";
import {
  acquireObservationBoundary, allChains, verifyObservationBoundary,
} from "./chains.mjs";
import { observeAddress } from "./native.mjs";
import { observeVaultPosition } from "./positions.mjs";
import { observeMoonwellOutstandingRewards } from "./rewards.mjs";
import { verifiedTokenHoldings } from "./tokens.mjs";

const BEEFY_SYMBOL_PATTERN = /^r?(?:moo|Moo)/u;

function validateRoster(roster) {
  if (!Array.isArray(roster) || roster.length === 0) {
    throw new RangeError("portfolio: roster must be a non-empty array");
  }
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
  if (moonwell === undefined) return {};
  if (moonwell === null || typeof moonwell !== "object" || Array.isArray(moonwell)) {
    throw new TypeError("portfolio: moonwell must be an object keyed by chain id");
  }
  const chainIds = new Set(selectedChains.map(({ id }) => id));
  const normalized = {};
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
  const wallets = await Promise.all(roster.map(async (wallet) => {
    const [native, tokens, moonwellRewards] = await Promise.all([
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
    };
  }));

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
    observeChain: injected.observeChain ?? defaultObserveChain,
    fetchImpl: injected.fetchImpl ?? fetch,
  };
  const config = {
    moonwell,
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

  const observations = await Promise.all(chains.map(
    (descriptor) => dependencies.observeChain(descriptor, roster, config, dependencies),
  ));
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
