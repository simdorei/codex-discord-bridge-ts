# Rust PR5 terminal Stop recovery delta — priority follow-on

Main3ebf4223b75b9d36237a73a78ce52ce794aee4ca, merged2026-10-12T21:14:36Z, directly verified21:20UTC. All16 changed source files retrieved at immutable merge commit and Git blob identities checked against PR file list. Frozen original Rust checkout remains unchanged. Current TS lacks this newly merged behavior. This is source/plan evidence, not TS parity or deployment approval.

## Preserve exact behavior
1. Stop recovery has separate signed keyset cursor and2s skipped tick, original250ms interrupt worker retained; outer cycle2s and each candidate1500ms bound. Candidate SQL LIMIT16 includes can_settle and settled records only when original queue rows remain. Advance cursor before target-lock attempt.
2. Fresh exact-turn native observation shares existing lifetime guards, requests compact history itemsView=notLoaded, permits thread idle or notLoaded only in Stop-specific mode, requires ended goal and every encountered turn terminal. General recovery mode remains idle/full and must not loosen. No resume, replay or interrupt in reconciliation.
3. Borrowed IMMEDIATE transaction receives original StopControl and native proof. Require can_settle,1..128 original jobs, exact retained record, reader256byte/positivei64/timefinite, current binding, no archive/prepared mutation fence. Observed payload<=1MiB and exactly originalturn terminal.
4. Custody preserves opaque job record strings and immutable holds. Only unstarted Pending routing generation may normalize to original for equality. Missing rows are not terminal proof; new nonpending work outside captured IDs refuses. New pending work remains untouched.
5. Cancel only captured original queue jobs through existing cancellation authority; settle async execution only entries whose owner turn matches. Preserve publication/receipt policy. Append previous terminal proof and exact current observer/generation; update Stop phase=settled only exactrecord; verify holds, cancellations, saved proof and retained original again.
6. Final commit must stay inside native observation current-connection lifetime and unsealed control admission, with selected-target recheck immediately before commit. An asynchronous native write cannot simply move the existing synchronous observation.withCurrentConnection or permit.withUnsealed callback outside commit. This requires a separate custody design before write offload.

## Implementation sequence
First source-complete pure observation validation and bounded candidate read; then same-transaction settlement/cancellation helpers, preserving original general history path. Add exact negative/rollback tests from source contract. Only then observation mode and resident lifetime API, followed by Stop runtime recovery loop and timer/cancellation integration. Existing783 candidate is unrelated lane fix; do not claim new PR5 recovery already installed.

## Remaining source closure
Changed-file snapshot alone is not full transitive closure. Read retained_in, Stop validate/hold_snapshot, queue cancel_request_in, terminal history capture/proof/settle/verify, collector dependencies and original runtime admission/observation lifetimes before implementing each leaf. Current TS helper accessibility and exact function signatures must be checked from real files, not inferred from Rust names. No live database or process changes.
