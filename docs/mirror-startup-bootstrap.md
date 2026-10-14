# Explicit per-target mirror bootstrap

This standalone API is not wired into application startup or the CLI. The runtime mirror gate remains in place. It does not start polling, send Discord messages, create mappings, or authorize a live deployment.

## Caller contract

Construct a `MirrorTargetBootstrapCoordinator` with the exact bridge database path, thread, rollout path, Discord channel, fresh-operation ID/time, context limits, and total timeout. Its constructor takes an immutable bounded snapshot; relative paths are pinned once. Call `run(signal)` once, and retain the caller's target/channel owner until the call and `close()` have joined. Concurrent calls on the same coordinator reject immediately; there is no waiting queue. A later ordinary startup uses a new coordinator.

Both extension schemas must already have been explicitly prepared with `NativeMirrorCursorStore.initializeSchema()` and `NativeMirrorStartupIntentStore.initializeSchema()`, against an existing base store. Bootstrap only requires and reads them. Missing or incompatible schemas are held, never created or repaired by a read.

The caller must independently maintain exclusive target/channel ownership, a stable database-path identity, the current target/channel mapping, and the rollout producer's append-only contract for the operation. The initial read checks the exact current mapping in one SQLite read transaction, including foreign reuse of the channel. It does not acquire an application-wide lock or make later writes atomic with that mapping check. The coordinator cannot safely be substituted for the application's existing owner.

## State transitions

1. One read-only transaction checks the schemas and current mapping, then reads pending intent before bound cursor. Pending reads reject either cursor row. Bound reads reject pending, legacy-only, orphaned, and mismatched cursor state. These guards are not weakened.
2. An existing valid bound cursor with the exact thread and rollout path returns unchanged. No rollout file is opened, no historical context is rescanned, and no cursor revision is advanced. Polling must perform its own current continuity and delivery checks.
3. A valid pending intent resumes its original operation, timestamp, rollout, and cutoff. Fresh-operation fields supplied on restart do not replace it. Recovery reads only the persisted original cutoff.
4. Only genuinely absent pending and cursor state permits one authentic EOF capture. The exact cutoff is durably retained before historical context is read. Recovery then reconstructs the turn at that cutoff, and the existing completion primitive atomically installs both cursor rows and retires that exact intent.

This preserves the source's initial-history skip-to-EOF policy for a complete initial record boundary. It adds an explicit conservative full-record hold: a non-LF initial EOF is saved as held intent and never upgraded merely because a later append supplies a newline. It does not rewind to zero or replay initial events. Byte/record/decode/continuity failures also preserve the pending original cutoff instead of substituting empty context or a new EOF.

## Uncertainty and resource lifetime

The coordinator submits at most one capture, one retain, and one completion. A submitted write failure first joins native exit. Within the remaining total budget, it makes at most one read-only reconciliation for that write:

- Retain reconciliation accepts only the exact original pending packet, including cutoff, stamp, operation, and time.
- Completion reconciliation uses the original owning recovery evidence, brackets database identity, and accepts only the exact completed cursor. It never opens the rollout or reruns completion. An unchanged original pending packet is not reported as successful completion.

If reconciliation cannot establish the exact result, `MirrorBootstrapReconciliationRequiredError` preserves the original immutable pending packet and, for completion, the descriptive recovery evidence. Cancellation, absence, or failed readback does not prove rollback. Do not manufacture a fresh operation or resample EOF after this error; explicitly reconcile the recorded original operation. Structural evidence in the error is not a native write capability. A durable pending record can be resumed after restart; a completed valid bound record can be read without rescanning history. The error can also require operator investigation, particularly when no original packet is durably visible.

Stages use existing native owners sequentially on the main runtime owner, with no outer worker slot and no nested worker submission. Normal fresh startup uses five workers; both uncertain-write reconciliations bring the finite maximum to seven. The existing global native and cutoff-reader budgets still reject saturation. A monotonic total deadline is checked before each new stage, and an abort timer cancels already-submitted work. Total budget exhaustion stops new work but always waits for actual native exit; this is not a hard upper bound on a blocked OS operation's exit time. `close()` aborts and joins the whole attempt.

## Evidence limits and next integration decision

Database identity checks during recovery/completion detect observed replacement. Initial target snapshot and retain are not one identity-bracketed transaction; caller-stable database identity remains a prerequisite. Sampled rollout metadata and bounded anchors do not certify unseen middle rewrites, filesystem ABA, or historical integrity. File observations and SQLite commit are not globally atomic.

The remaining application decision is where the trusted runtime target/channel owner invokes this coordinator, prepares schemas explicitly, retains reconciliation-needed errors, and hands the established cursor to existing bound polling without releasing ownership prematurely. This change deliberately leaves that integration and the CLI gate untouched.

Credential-free tests exercise a synthetic SQLite store and local HTTP server: initial history produces no messages; the first append passes through existing bound polling and the real HTTP adapter, commits its durable receipt/cursor, and repeated EOF polls send nothing. They do not qualify live Discord, production data, Windows behavior, or whole-runtime startup/shutdown.
