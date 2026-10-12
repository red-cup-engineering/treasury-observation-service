import type { ChainDescriptor, Attempt, ChainReadOptions, ObservationProvenance } from "./chains.d.ts";

export type NativeObservation =
  | { readonly chain: string; readonly caip2: string; readonly address: string; readonly label?: string | null;
      readonly checked: true; readonly symbol: string; readonly decimals: number;
      readonly raw: string; readonly amount: string; readonly empty: boolean;
      readonly nonce: number | null; readonly via: string; readonly provenance?: ObservationProvenance }
  | { readonly chain: string; readonly caip2: string; readonly address: string; readonly label?: string | null;
      readonly checked: false; readonly reason: string; readonly attempts: readonly Attempt[] };

export interface ChainCoverage {
  readonly addressesChecked: number;
  readonly addressesAttempted: number;
  readonly complete: boolean;
  readonly holdings: number;
  readonly unreachable: readonly { address: string; reason: string }[];
}

export interface FleetReport {
  readonly observedAt: string | null;
  readonly addressCount: number;
  readonly chainCount: number;
  readonly holdings: readonly NativeObservation[];
  readonly totals: Readonly<Record<string, string>>;
  readonly byChain: Readonly<Record<string, ChainCoverage>>;
  readonly usedButEmpty: readonly { chain: string; address: string; label: string | null; nonce: number }[];
  readonly coverage: { readonly complete: boolean; readonly incompleteChains: readonly string[]; readonly note: string };
}

export declare function observeAddress(chain: ChainDescriptor, address: string, options?: ChainReadOptions): Promise<NativeObservation>;
export declare function scanFleet(input: { addresses: readonly (string | { address: string; label?: string | null; index?: number })[]; chains?: readonly ChainDescriptor[]; concurrency?: number; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<FleetReport>;
export declare function summarize(observations: readonly NativeObservation[], chains: readonly ChainDescriptor[], addressCount: number): FleetReport;
