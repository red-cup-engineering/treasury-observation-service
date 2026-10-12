import type { ChainDescriptor, Attempt, ChainReadOptions, ObservationProvenance } from "./chains.d.ts";
import type { TokenBalance } from "./tokens.d.ts";

export type VaultPosition =
  | { readonly chain: string; readonly vault: string; readonly address: string; readonly checked: true; readonly empty: true; readonly shares: TokenBalance; readonly provenance?: ObservationProvenance }
  | { readonly chain: string; readonly vault: string; readonly address: string; readonly checked: true; readonly empty: false;
      readonly shares: TokenBalance; readonly pricePerFullShareRaw: string; readonly underlyingRaw: string; readonly via: string;
      readonly priceSource: "onchain" | "beefy-api"; readonly provenance?: ObservationProvenance }
  | { readonly chain: string; readonly vault: string; readonly address: string; readonly checked: false; readonly reason: string; readonly attempts: readonly Attempt[] };

export type CompoundForkMarketPosition =
  | { readonly chain: string; readonly market: string; readonly address: string; readonly checked: true;
      readonly symbol: string | null; readonly underlying: string | null; readonly underlyingDecimals: number | null;
      readonly mTokenBalanceRaw: string; readonly suppliedUnderlyingRaw: string; readonly suppliedUnderlyingAmount: string | null;
      readonly borrowedUnderlyingRaw: string; readonly borrowedUnderlyingAmount: string | null;
      readonly supplyRatePerTimestampMantissa: string | null; readonly borrowRatePerTimestampMantissa: string | null; readonly empty: boolean;
      readonly provenance?: ObservationProvenance }
  | { readonly chain: string; readonly market: string; readonly address: string; readonly checked: false; readonly reason: string; readonly attempts: readonly Attempt[] };

export declare function observeVaultPosition(chain: ChainDescriptor, vaultAddress: string, walletAddress: string, options?: ChainReadOptions): Promise<VaultPosition>;
export declare function observeCompoundForkMarket(chain: ChainDescriptor, marketAddress: string, walletAddress: string, options?: ChainReadOptions): Promise<CompoundForkMarketPosition>;
