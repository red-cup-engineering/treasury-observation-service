import type { ChainDescriptor, Attempt, ChainReadOptions, ObservationProvenance } from "./chains.d.ts";

export type TokenBalance =
  | { readonly chain: string; readonly token: string; readonly address: string;
      readonly checked: true; readonly symbol: string | null; readonly decimals: number | null;
      readonly raw: string; readonly amount: string | null; readonly empty: boolean; readonly via: string;
      readonly provenance?: ObservationProvenance }
  | { readonly chain: string; readonly token: string; readonly address: string;
      readonly checked: false; readonly reason: string; readonly attempts: readonly Attempt[] };

export interface DiscoveredToken {
  readonly tokenAddress: string;
  readonly claimedSymbol: string | null;
  readonly claimedDecimals: number | null;
  readonly claimedRawBalance: string;
}

export type TokenDiscovery =
  | { readonly chain: string; readonly address: string; readonly checked: true; readonly via: string; readonly discovered: readonly DiscoveredToken[] }
  | { readonly chain: string; readonly address: string; readonly checked: false; readonly reason: string; readonly attempts: readonly Attempt[] };

export type VerifiedTokenHoldings = TokenDiscovery & {
  readonly holdings: readonly (TokenBalance & { indexerClaimedSymbol?: string | null; indexerClaimedRawBalance?: string })[];
  readonly provenance?: ObservationProvenance;
};

export declare function balanceOfToken(chain: ChainDescriptor, tokenAddress: string, walletAddress: string, options?: ChainReadOptions): Promise<TokenBalance>;
export declare function discoverTokenHoldings(chain: ChainDescriptor, walletAddress: string, options?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<TokenDiscovery>;
export declare function verifiedTokenHoldings(chain: ChainDescriptor, walletAddress: string, options?: ChainReadOptions): Promise<VerifiedTokenHoldings>;
