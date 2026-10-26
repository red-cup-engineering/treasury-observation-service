# treasury-observation-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Read-only observation of the Group's on-chain treasury: EVM balances and positions plus normalized, provenance-bearing cross-chain earning opportunities. Distinguishes a checked zero from an unchecked chain and unavailable APY from zero yield, always.

## Wallet portfolios for agents and reports

`observePortfolio` combines native balances, verified token holdings, Beefy
positions, Moonwell rewards, and explicitly tracked lending markets and vaults.
Supply a public wallet roster and a `positions` map keyed by selected chain.
Each declaration has a contract `address` and a `kind`:

| Kind | Returned position data |
| --- | --- |
| `compound-fork` | Market shares, supplied underlying assets, borrowed underlying assets, token decimals, and the market's per-timestamp supply and borrow rates |
| `erc4626` | Vault shares, underlying asset identity and decimals, and the exact assets represented by those shares; both selected RPC endpoints must agree |

Every selected position is observed for every roster wallet on its chain.
Explicit positions are read independently of token discovery, so a failed
indexer still leaves available lending and vault observations in the response.
The result is `chains[].wallets[].trackedPositions`: its `positions` array
retains the declaration's `kind` and `contract` alongside the original position
reader's data. A failed position has `checked: false` and a reason. Other
positions remain available, and chain and portfolio coverage report the gap.

All components on a chain use the same selected block number and hash.
ERC-4626 reads verify that block at each distinct endpoint and retain the
original portfolio boundary together with the actual read endpoints. Supply,
borrow, share, and asset quantities are decimal strings of base units, with
formatted amounts where the original reader supplies decimals.

The public JSON entry point accepts registered chain names, which it resolves
through the existing chain registry:

```js
import { observePortfolioReport } from
  "@red-cup-engineering/treasury-observation-service/observe-portfolio";

const report = await observePortfolioReport({
  roster: [{ subject: "urn:wallet:operating", address: walletAddress }],
  chains: ["base"],
  finality: "latest",
  concurrency: 4,
  positions: {
    base: [
      { kind: "compound-fork", address: lendingMarketAddress },
      { kind: "erc4626", address: vaultAddress },
    ],
  },
});
```

Use the same request from a file or standard input:

```sh
npm run observe-portfolio -- --input portfolio-request.json
node scripts/observe-portfolio.mjs < portfolio-request.json
```

The command prints the JSON report. Exit status is `0` for complete coverage,
`1` for a report containing unavailable observations, and `2` for an invalid
request or invocation error. The input and output schemas are exported as
`/schemas/observe-portfolio.input` and `/schemas/observe-portfolio.output`.
Their field titles and position choices support the same request in agent
tools and human forms.

Requests accept up to 100 wallets, 16 chain selections, and 100 tracked
positions per chain. The original queue runs up to `concurrency` wallet
observations at once (default 4, maximum 16), retaining caller order; chains
complete in sequence. Each protocol reader keeps its own bounded request
behavior. The command accepts up to 1 MiB of JSON. The library `observePortfolio`
continues to accept explicit chain descriptors for callers that manage their
own registered providers. Its original response shape is retained when
`positions` is omitted.

## Observation boundaries

`observePortfolio` and `observeCoherentSnapshot` accept `latest`, `safe`, and
`finalized` block selection. `latest` means current, **unfinalized** state; it
does not establish settlement. `safe` and `finalized` retain their requested
classification. The default Treasury selection remains `finalized`; the Group
fleet explicitly selects `latest` when it requests current quantities.

Every fresh boundary retains the exact block number, hash, and decimal
`blockTimestampSeconds`, separately from the local `observedAt` time. Every
value-bearing leg uses that resolved block tag and retains the same boundary.
A changed finality label, mismatched leg timestamp, unpinned read, or changed
canonical block refuses the observation. A missing timestamp cannot produce a
new boundary. Existing caller-supplied boundaries without a timestamp retain
that absence; the observer does not invent a time for historical evidence.

The native contract tests use the real Ethereum read pool and streamed Hive
JSON-RPC transport with synthetic HTTP responses. They establish provider
composition and refusal behavior, not live account state or independently
reconciled money.

