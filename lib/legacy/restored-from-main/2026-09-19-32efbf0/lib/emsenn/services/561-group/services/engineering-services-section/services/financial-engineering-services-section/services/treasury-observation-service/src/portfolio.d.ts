import type {
  Attempt, BoundaryOptions, ChainDescriptor, ChainReadOptions, ObservationBoundary, Outcome,
} from "./chains.d.ts";
import type { NativeObservation } from "./native.d.ts";
import type { VaultPosition } from "./positions.d.ts";
import type { MoonwellOutstandingRewards } from "./rewards.d.ts";
import type { VerifiedTokenHoldings } from "./tokens.d.ts";

export interface PortfolioRosterEntry {
  readonly subject: string;
  readonly address: string;
}

export interface PortfolioInput {
  readonly roster: readonly PortfolioRosterEntry[];
  readonly chains?: readonly ChainDescriptor[];
  readonly moonwell?: Readonly<Record<string, { readonly rewardDistributor: string }>>;
  readonly finality?: "safe" | "finalized";
  readonly timeoutMs?: number;
}

export interface UnpricedValuation {
  readonly priced: false;
  readonly usd: null;
  readonly reason: string;
}

export type PortfolioBeefyPositions =
  | { readonly checked: true; readonly positions: readonly (VaultPosition & { readonly valuation?: UnpricedValuation })[] }
  | { readonly checked: false; readonly positions?: readonly (VaultPosition & { readonly valuation?: UnpricedValuation })[];
      readonly reason: string; readonly attempts: readonly Attempt[] };

export type PortfolioMoonwellRewards =
  | ({ readonly supported: true; readonly valuation?: UnpricedValuation } & MoonwellOutstandingRewards)
  | { readonly supported: false; readonly checked: false; readonly reason: string; readonly attempts: readonly Attempt[] };

export interface PortfolioWalletObservation {
  readonly subject: string;
  readonly address: string;
  readonly checked: true;
  readonly native: NativeObservation & { readonly valuation?: UnpricedValuation };
  readonly verifiedTokens: VerifiedTokenHoldings & {
    readonly holdings: readonly (VerifiedTokenHoldings["holdings"][number] & { readonly valuation?: UnpricedValuation })[];
  };
  readonly moonwellRewards: PortfolioMoonwellRewards;
  readonly beefyPositions: PortfolioBeefyPositions;
}

export interface UncheckedPortfolioWallet {
  readonly subject: string;
  readonly address: string;
  readonly checked: false;
  readonly reason: string;
  readonly attempts: readonly Attempt[];
}

export interface PortfolioChainCoverage {
  readonly walletsAttempted: number;
  readonly walletsObserved: number;
  readonly complete: boolean;
  readonly unchecked: readonly { readonly subject: string; readonly component: string; readonly reason: string }[];
}

export type PortfolioChainObservation =
  | { readonly chain: string; readonly caip2: string; readonly checked: true;
      readonly provenance: ObservationBoundary; readonly wallets: readonly PortfolioWalletObservation[];
      readonly coverage: PortfolioChainCoverage }
  | { readonly chain: string; readonly caip2: string; readonly checked: false;
      readonly provenance: ObservationBoundary | null; readonly reason: string; readonly attempts: readonly Attempt[];
      readonly wallets: readonly UncheckedPortfolioWallet[]; readonly coverage: PortfolioChainCoverage };

export interface PortfolioReport {
  readonly observedAt: string;
  readonly roster: readonly PortfolioRosterEntry[];
  readonly chains: readonly PortfolioChainObservation[];
  readonly coverage: { readonly complete: boolean; readonly incompleteChains: readonly string[] };
}

export interface PortfolioDependencies {
  readonly now?: () => Date;
  readonly fetchImpl?: typeof fetch;
  readonly acquireBoundary?: (chain: ChainDescriptor, options?: BoundaryOptions) => Promise<Outcome<ObservationBoundary>>;
  readonly verifyBoundary?: (chain: ChainDescriptor, boundary: ObservationBoundary, options?: ChainReadOptions) => Promise<Outcome<ObservationBoundary>>;
  readonly observeNative?: (chain: ChainDescriptor, address: string, options?: ChainReadOptions) => Promise<NativeObservation>;
  readonly observeTokens?: (chain: ChainDescriptor, address: string, options?: ChainReadOptions) => Promise<VerifiedTokenHoldings>;
  readonly observeMoonwell?: (chain: ChainDescriptor, distributor: string, address: string, options?: ChainReadOptions) => Promise<MoonwellOutstandingRewards>;
  readonly observeVault?: (chain: ChainDescriptor, vault: string, address: string, options?: ChainReadOptions) => Promise<VaultPosition>;
  readonly observeChain?: (
    chain: ChainDescriptor,
    roster: readonly PortfolioRosterEntry[],
    config: Readonly<Record<string, unknown>>,
    dependencies: PortfolioDependencies,
  ) => Promise<PortfolioChainObservation>;
}

export declare function observePortfolio(input: PortfolioInput, dependencies?: PortfolioDependencies): Promise<PortfolioReport>;
