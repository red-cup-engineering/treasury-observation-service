/**
 * Moonwell (Compound-fork) incentive reward accrual: outstanding, unclaimed emission-token
 * balances a wallet has earned across every market a MultiRewardDistributor tracks for it.
 * Same checked/unreachable outcome discipline as `positions.mjs`. No USD attached — pricing is
 * a separate, caller-side step, same design boundary as the rest of this package.
 */
import { Interface, getAddress } from "ethers";
import { formatUnits, observationProvenance } from "./chains.mjs";
import { encoded } from "./contract-call.mjs";

const rewardDistributorInterface = new Interface([
  "function getOutstandingRewardsForUser(address _user) view returns (tuple(address mToken, tuple(address emissionToken, uint256 totalAmount, uint256 supplySide, uint256 borrowSide)[] rewards)[])",
]);
const erc20MetaInterface = new Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

/**
 * A wallet's outstanding (unclaimed) rewards across every Moonwell market a MultiRewardDistributor
 * tracks for it — one row per non-zero {market, emissionToken} pair. A market/token combination
 * with a zero `totalAmount` is omitted rather than reported as a zero-value row, so the returned
 * `rewards` array is exactly what a claim would pay out.
 * @param {import("./chains.d.ts").ChainDescriptor} chainDescriptor
 * @param {string} rewardDistributorAddress MultiRewardDistributor contract (or its proxy).
 * @param {string} walletAddress
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number}} [options]
 * @returns {Promise<import("./rewards.d.ts").MoonwellOutstandingRewards>}
 */
export async function observeMoonwellOutstandingRewards(chainDescriptor, rewardDistributorAddress, walletAddress, options = {}) {
  const distributor = getAddress(rewardDistributorAddress);
  const wallet = getAddress(walletAddress);
  const outcome = await encoded(
    rewardDistributorInterface, chainDescriptor, distributor, "getOutstandingRewardsForUser", [wallet], options,
  );
  if (!outcome.ok) {
    return {
      chain: chainDescriptor.id, distributor, address: wallet,
      checked: false, reason: outcome.reason, attempts: outcome.attempts ?? [],
    };
  }

  const nonzero = [];
  for (const row of outcome.value[0]) {
    for (const r of row.rewards) {
      if (r.totalAmount > 0n) {
        nonzero.push({
          market: row.mToken, emissionToken: r.emissionToken,
          totalAmountRaw: r.totalAmount, supplySideRaw: r.supplySide, borrowSideRaw: r.borrowSide,
        });
      }
    }
  }

  // One symbol()/decimals() lookup per distinct emission token, never per row — the same
  // emission token recurs across many markets.
  const metaByToken = new Map();
  const rewards = [];
  const readOutcomes = [outcome];
  for (const entry of nonzero) {
    const key = entry.emissionToken.toLowerCase();
    if (!metaByToken.has(key)) {
      const [symbolResult, decimalsResult] = await Promise.all([
        encoded(erc20MetaInterface, chainDescriptor, entry.emissionToken, "symbol", [], options),
        encoded(erc20MetaInterface, chainDescriptor, entry.emissionToken, "decimals", [], options),
      ]);
      if (options.boundary !== undefined && (!symbolResult.ok || !decimalsResult.ok)) {
        const failed = !symbolResult.ok ? symbolResult : decimalsResult;
        return {
          chain: chainDescriptor.id, distributor, address: wallet, checked: false,
          reason: `boundary-coherent reward metadata unavailable: ${failed.reason}`,
          attempts: failed.attempts ?? [],
        };
      }
      readOutcomes.push(symbolResult, decimalsResult);
      metaByToken.set(key, {
        symbol: symbolResult.ok ? String(symbolResult.value[0]) : null,
        decimals: decimalsResult.ok ? Number(decimalsResult.value[0]) : null,
      });
    }
    const meta = metaByToken.get(key);
    rewards.push({
      market: entry.market,
      emissionToken: entry.emissionToken,
      symbol: meta.symbol,
      decimals: meta.decimals,
      totalAmountRaw: entry.totalAmountRaw.toString(),
      totalAmount: meta.decimals == null ? null : formatUnits(entry.totalAmountRaw, meta.decimals),
      supplySideRaw: entry.supplySideRaw.toString(),
      borrowSideRaw: entry.borrowSideRaw.toString(),
    });
  }

  return {
    chain: chainDescriptor.id, distributor, address: wallet, checked: true, rewards,
    ...(options.boundary === undefined ? {} : {
      provenance: observationProvenance(options.boundary, readOutcomes),
    }),
  };
}
