import type { ChainDescriptor, Attempt, ChainReadOptions } from "./chains.d.ts";

export interface MorphoShareBalance {
  readonly raw: string;
  readonly decimals: number;
  readonly amount: string;
}

export interface MorphoAssetAmount {
  readonly raw: string;
  readonly amount: string;
}

export type MorphoVaultPosition =
  | { readonly chain: string; readonly vault: string; readonly owner: string; readonly checked: true; readonly empty: true;
      readonly shares: MorphoShareBalance; readonly sources: readonly string[] }
  | { readonly chain: string; readonly vault: string; readonly owner: string; readonly checked: true; readonly empty: false;
      readonly shares: MorphoShareBalance; readonly asset: { readonly address: string; readonly decimals: number };
      readonly assets: MorphoAssetAmount; readonly sources: readonly string[] }
  | { readonly chain: string; readonly vault: string; readonly owner: string; readonly checked: false;
      readonly reason: string; readonly attempts: readonly Attempt[] };

export type MorphoConvertToShares =
  | { readonly chain: string; readonly vault: string; readonly checked: true; readonly sharesRaw: string; readonly sources: readonly string[] }
  | { readonly chain: string; readonly vault: string; readonly checked: false; readonly reason: string; readonly attempts: readonly Attempt[] };

export interface AccruedYield {
  readonly accruedRaw: string;
  readonly accruedAmount: string;
  readonly nonNegative: boolean;
}

export type MorphoVaultApy =
  | { readonly checked: true; readonly via: string; readonly apy: number | null; readonly netApy: number; readonly netApyExcludingRewards: number | null }
  | { readonly checked: false; readonly via: string; readonly reason: string };

export declare function observeMorphoVaultPosition(
  chain: ChainDescriptor, vaultAddress: string, ownerAddress: string, options?: ChainReadOptions,
): Promise<MorphoVaultPosition>;

export declare function observeMorphoConvertToShares(
  chain: ChainDescriptor, vaultAddress: string, assetsRaw: string, options?: ChainReadOptions,
): Promise<MorphoConvertToShares>;

export declare function deriveAccruedYield(input: {
  assetsRaw: string; principalAssetsRaw: string; decimals: number;
}): AccruedYield;

export declare function fetchMorphoVaultApy(
  input: { vault: string; chainId: number },
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number; endpoint?: string },
): Promise<MorphoVaultApy>;
