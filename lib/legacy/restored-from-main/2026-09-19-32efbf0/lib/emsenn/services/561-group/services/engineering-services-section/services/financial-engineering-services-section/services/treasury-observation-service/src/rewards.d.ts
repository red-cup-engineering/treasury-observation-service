import type { ChainDescriptor, Attempt, ChainReadOptions, ObservationProvenance } from "./chains.d.ts";

export interface MoonwellRewardRow {
  readonly market: string;
  readonly emissionToken: string;
  readonly symbol: string | null;
  readonly decimals: number | null;
  readonly totalAmountRaw: string;
  readonly totalAmount: string | null;
  readonly supplySideRaw: string;
  readonly borrowSideRaw: string;
}

export type MoonwellOutstandingRewards =
  | { readonly chain: string; readonly distributor: string; readonly address: string; readonly checked: true;
      readonly rewards: readonly MoonwellRewardRow[]; readonly provenance?: ObservationProvenance }
  | { readonly chain: string; readonly distributor: string; readonly address: string; readonly checked: false;
      readonly reason: string; readonly attempts: readonly Attempt[] };

export declare function observeMoonwellOutstandingRewards(
  chain: ChainDescriptor, rewardDistributorAddress: string, walletAddress: string,
  options?: ChainReadOptions,
): Promise<MoonwellOutstandingRewards>;
