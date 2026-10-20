# WIP783 Stop pending lane correction

Prior782 full was RED:8266tests,8265PASS1FAIL,0cancel/skip. Prepared lifetime restart snapshot failed with OwnedWorkerBudgetError while periodic Stop listing used Control1. Exact new regression is byte-identical on old/new stage: old fails with the same error; fixed passes. Final focused94PASS includes startup/lifetime and existing Stop paths, strictTS/build0. Full8267/805files is pending. Unapplied.

Only periodic Stop inventory moves to existing Maintenance1/FIFO2 via runMaintenanceRead. No pool growth, Control capacity expansion or new FIFO. Same-owner overlap still refuses; accepted work always joins native exit; queue timeout is not an empty page or cursor-reset grant. Parent worker awaits and checks cancellation before changing cursor. All original claim/selected checks and writes remain synchronous. Bounded4MiB response refusal is not unlimited Rust parity or a SQLite memory cap. Windows/live/hard2s remain unverified.

Rust main changed to3ebf4223b75b9d36237a73a78ce52ce794aee4ca via PR5, merged2026-10-12T21:14:36Z, independently fetched21:20UTC. Terminal-stop reconciliation is a NEW pending migration delta, not implemented by this lane fix. Existing frozen source remains unchanged.
