# treasury-observation-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Read-only observation of the Group's on-chain treasury: EVM balances and positions plus normalized, provenance-bearing cross-chain earning opportunities. Distinguishes a checked zero from an unchecked chain and unavailable APY from zero yield, always.

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
