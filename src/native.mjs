/**
 * `native` — native-currency balances across a wallet fleet, with the unchecked/empty
 * distinction preserved all the way to the report.
 *
 * The scan this replaces produced a single number — a total — and lost, on the way there, the
 * fact that three of eight chains had never answered. A total is the most dangerous shape a
 * treasury observation can take, because it reads as complete. Every function here returns
 * coverage alongside value, and `scanFleet` refuses to hand back a total without also handing
 * back what it could not see.
 *
 * `nonce` is collected with each balance and is not incidental. An address with a zero balance
 * and a nonzero nonce has been used and emptied; one with a zero balance and a zero nonce has
 * never been touched. Those are different facts about a wallet, and only the second justifies
 * ignoring it — a used-and-emptied address may hold tokens, an NFT, or a vault receipt that a
 * native-balance check cannot see, so it stays on the list for the token and position modules.
 *
 * Plain JavaScript, shapes in the co-located native.d.ts.
 */
import {
  allChains, call, callMany, formatUnits, hexToBigInt, observationBlockTag, observationProvenance,
} from "./chains.mjs";

/** Native balance and nonce for one address on one chain. Returns an observation whose
 *  `checked` flag is the load-bearing field: false means we learned nothing, not that the
 *  address is empty. */
export async function observeAddress(chainDescriptor, address, options = {}) {
  const [balance, nonce] = await Promise.all([
    call(chainDescriptor, "eth_getBalance", [address, observationBlockTag(options)], options),
    call(chainDescriptor, "eth_getTransactionCount", [address, observationBlockTag(options)], options),
  ]);

  if (!balance.ok) {
    return {
      chain: chainDescriptor.id, caip2: chainDescriptor.caip2, address,
      checked: false, reason: balance.reason, attempts: balance.attempts,
    };
  }

  let raw;
  try {
    raw = hexToBigInt(balance.value);
  } catch (error) {
    return {
      chain: chainDescriptor.id, caip2: chainDescriptor.caip2, address,
      checked: false, reason: `malformed balance from ${balance.via}: ${error.message}`, attempts: [],
    };
  }

  return {
    chain: chainDescriptor.id, caip2: chainDescriptor.caip2, address,
    checked: true,
    symbol: chainDescriptor.nativeSymbol,
    decimals: chainDescriptor.nativeDecimals,
    raw: raw.toString(),
    amount: formatUnits(raw, chainDescriptor.nativeDecimals),
    empty: raw === 0n,
    // A nonce failure is not a balance failure; record it as unknown rather than dropping the
    // whole observation, since the balance is the thing we actually came for.
    nonce: nonce.ok ? Number(hexToBigInt(nonce.value)) : null,
    via: balance.via,
    ...(options.boundary === undefined ? {} : {
      provenance: observationProvenance(options.boundary, [balance, ...(nonce.ok ? [nonce] : [])]),
    }),
  };
}

/**
 * Scan a fleet of addresses across a set of chains.
 *
 * `addresses` may be plain strings or `{ address, label }` records; labels are carried through
 * so a holding can be traced back to which wallet key opens it, which is the whole point of
 * scanning a fleet rather than an address.
 */
export async function scanFleet({ addresses, chains = allChains(), concurrency = 6, ...options } = {}) {
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new RangeError("native: scanFleet requires a non-empty addresses array");
  }
  const entries = addresses.map((a) => (typeof a === "string" ? { address: a, label: null } : a));

  const jobs = [];
  for (const chainDescriptor of chains) {
    for (const entry of entries) {
      jobs.push(async () => ({
        label: entry.label,
        index: entry.index ?? null,
        ...(await observeAddress(chainDescriptor, entry.address, options)),
      }));
    }
  }

  const observations = await callMany(jobs, concurrency);
  return summarize(observations, chains, entries.length);
}

/** Fold observations into a report that cannot state a total without stating its coverage. */
export function summarize(observations, chains, addressCount) {
  const holdings = observations.filter((o) => o.checked && !o.empty);
  const byChain = {};
  for (const chainDescriptor of chains) {
    const forChain = observations.filter((o) => o.chain === chainDescriptor.id);
    const checked = forChain.filter((o) => o.checked);
    byChain[chainDescriptor.id] = {
      addressesChecked: checked.length,
      addressesAttempted: forChain.length,
      // Complete coverage is the only condition under which "no holdings" means "empty".
      complete: checked.length === forChain.length && forChain.length > 0,
      holdings: forChain.filter((o) => o.checked && !o.empty).length,
      unreachable: forChain.filter((o) => !o.checked).map((o) => ({ address: o.address, reason: o.reason })),
    };
  }

  // Sum per symbol, never across symbols: ETH and POL are not addable, and a single "total"
  // across denominations is the kind of number that reads as fact and is not one.
  const totalsBySymbol = {};
  for (const holding of holdings) {
    const current = totalsBySymbol[holding.symbol] ?? { raw: 0n, decimals: holding.decimals };
    totalsBySymbol[holding.symbol] = { raw: current.raw + BigInt(holding.raw), decimals: holding.decimals };
  }
  const totals = Object.fromEntries(
    Object.entries(totalsBySymbol).map(([symbol, t]) => [symbol, formatUnits(t.raw, t.decimals)]),
  );

  const incompleteChains = Object.entries(byChain).filter(([, c]) => !c.complete).map(([id]) => id);

  // Addresses used and emptied — zero native, nonzero nonce. These must not be dropped from
  // later token and position scans; a spent address is exactly where a forgotten receipt token
  // or an NFT tends to sit.
  const usedButEmpty = observations
    .filter((o) => o.checked && o.empty && typeof o.nonce === "number" && o.nonce > 0)
    .map((o) => ({ chain: o.chain, address: o.address, label: o.label, nonce: o.nonce }));

  return {
    observedAt: null, // stamped by the caller; this module takes no clock
    addressCount,
    chainCount: chains.length,
    holdings,
    totals,
    byChain,
    usedButEmpty,
    coverage: {
      complete: incompleteChains.length === 0,
      incompleteChains,
      note: incompleteChains.length === 0
        ? "every address was checked on every chain; an absent holding here means an empty address"
        : `NOT complete: ${incompleteChains.join(", ")} could not be fully checked. Absence of a holding on those chains means nothing was learned, not that nothing is held.`,
    },
  };
}
