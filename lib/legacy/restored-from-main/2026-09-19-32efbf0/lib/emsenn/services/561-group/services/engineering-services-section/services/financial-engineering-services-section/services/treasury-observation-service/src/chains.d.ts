export interface ChainDescriptor {
  readonly id: string;
  readonly chainId: number;
  readonly caip2: string;
  readonly nativeSymbol: string;
  readonly nativeDecimals: number;
  readonly rpc: readonly string[];
  readonly indexers: readonly (string | { readonly id: "blockscout" | "rabby"; readonly url: string })[];
}
export interface Attempt { readonly url: string; readonly error: string }
export interface ObservationBoundary {
  readonly chain: string;
  readonly chainId: number;
  readonly caip2: string;
  readonly requestedFinality: "safe" | "finalized";
  readonly finality: "safe" | "finalized";
  readonly blockNumber: string;
  readonly blockTag: string;
  readonly blockHash: string;
  readonly observedAt: string;
  readonly provider: string;
}
export interface ReadProvenance extends ObservationBoundary {
  readonly method: string;
}
export interface ObservationProvenance extends ObservationBoundary {
  readonly reads: readonly { readonly method: string; readonly blockTag: string; readonly provider: string }[];
}
export interface ChainReadOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly boundary?: ObservationBoundary;
  /** Injectable fixed-boundary Base provider pool for deterministic callers and tests. */
  readonly publicEvmReadPool?: { requestAtBoundary(input: unknown): Promise<unknown> };
}
export interface BoundaryOptions extends ChainReadOptions {
  readonly finality?: "safe" | "finalized";
  readonly now?: () => Date;
}
export type Outcome<T> =
  | { readonly ok: true; readonly value: T; readonly via: string; readonly provenance?: ReadProvenance }
  | { readonly ok: false; readonly reason: string; readonly attempts: readonly Attempt[] };

export declare const CHAINS: Readonly<Record<string, ChainDescriptor>>;
export declare function allChains(): ChainDescriptor[];
export declare function chain(id: string): ChainDescriptor;
export declare function ok<T>(value: T, via: string, provenance?: ReadProvenance): Outcome<T>;
export declare function unreachable(reason: string, attempts: readonly Attempt[]): Outcome<never>;
export declare function sameObservationBoundary(left: ObservationBoundary | null | undefined, right: ObservationBoundary | null | undefined): boolean;
export declare function observationBlockTag(options?: ChainReadOptions): string;
export declare function observationProvenance(boundary: ObservationBoundary | undefined, outcomes?: readonly Outcome<unknown>[]): ObservationProvenance | undefined;
export declare function call(chain: ChainDescriptor, method: string, params: unknown[], options?: ChainReadOptions): Promise<Outcome<string>>;
export declare function acquireObservationBoundary(chain: ChainDescriptor, options?: BoundaryOptions): Promise<Outcome<ObservationBoundary>>;
export declare function verifyObservationBoundary(chain: ChainDescriptor, boundary: ObservationBoundary, options?: ChainReadOptions): Promise<Outcome<ObservationBoundary>>;
export type CoherentSnapshot<T> =
  | { readonly chain: string; readonly checked: true; readonly boundary: ObservationBoundary; readonly observedAt: string; readonly observations: readonly T[] }
  | { readonly chain: string; readonly checked: false; readonly boundary?: ObservationBoundary; readonly reason: string; readonly attempts: readonly Attempt[] };
export declare function observeCoherentSnapshot<T extends { readonly checked: boolean; readonly provenance?: ObservationProvenance }>(
  chain: ChainDescriptor,
  observers: readonly ((options: ChainReadOptions & { readonly boundary: ObservationBoundary }) => Promise<T>)[],
  options?: BoundaryOptions,
): Promise<CoherentSnapshot<T>>;
export declare function callMany<T>(thunks: readonly (() => Promise<T>)[], concurrency?: number): Promise<T[]>;
export declare function hexToBigInt(hex: string): bigint;
export declare function formatUnits(raw: bigint | string, decimals: number): string;
