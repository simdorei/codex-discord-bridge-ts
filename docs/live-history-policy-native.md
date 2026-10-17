# Native installed history policy and capacity retry

Installed Discord history now refreshes dynamic access policy through the existing native mirror-policy reader. Both prepared history and prepared typed ingress require a separate, explicit `historyPolicyLimits` profile. The local application uses the startup-equivalent bounds: 4096 rows, 4194304 selected value bytes, 8192 output IDs and 10000 ms. The original database, limits and refresh callback are captured before asynchronous work. Direct history callers retain the compatibility refresh unless they explicitly install a native callback.

## Ownership and exact refusal

The policy reader is still one process-global slot, sharing the existing three Background slots within the eight-worker budget. There is no new worker pool, queue, cache, fallback policy or budget increase. Its ordered complete reads and existing-only behavior are unchanged. Missing, incompatible, malformed and over-budget databases fail without creating/migrating stores or returning partial/stale policy.

History preserves the exact refresh Promise and consumes the one-use native policy capacity proof. Only a proven refusal before submission can carry a retry disposition. The channel adapter separately binds that evidence to the exact channel-attempt Promise and error, and the gap pass consumes it once. Public error names/classes, forged errors, a genuine old error replayed through another attempt, admitted worker failures, SQL errors, malformed results, row/value/output limits and timeouts cannot arm a capacity wake.

Timeout and cancellation continue to join actual native exit. A worker blocked in SQLite retains the native slot and the channel's outer admission permit until it actually exits; cancellation does not terminate native I/O to simulate completion.

## Gap passes and consumer scheduling

Each recovery pass takes a fresh sticky snapshot and visits each captured notice once. A capacity refusal leaves the original notice sticky, coalesces one retry flag, and continues to later channels. Success acknowledges only that pass's original revision-bound notice and only after coverage is Reached. New revisions cannot be cleared by an older acknowledgement. A full ten-message window that does not reach the source floor remains incomplete.

The recovery result is a small frozen `{retryCapacity: boolean}` disposition. Existing custom operations returning `undefined` remain compatible and request no retry. The consumer owns one retry deadline and one saturating index. It retains no page, command, admission, per-channel retry map or notice queue. A retry starts ordinary snapshot recovery again; durable deduplication and raw message plans remain authoritative.

The backoff is 1, 2, 4, 8, 16, then 30 seconds, capped at 30 seconds without an attempt ceiling. This is an explicit TypeScript liveness policy, not a claim of Rust timing parity. A monotonic deadline is computed after the pass completes. A real gap hint or periodic pass can recover earlier. A still-future retry deadline is preserved; when a fresh recovery pass completes at or after it, that pass satisfies the due recovery and the next backoff is scheduled from completion. Firing consumes the retry deadline before the next pass; a pass without proved capacity resets the deadline and index. Resource use and retry rate are bounded, while eventual recovery remains possible after prolonged contention.

The earlier periodic or retry deadline is used. Retry wakes never call periodic polling when the period is null. Gap hints retain priority, and losing timers/receives are cancelled and joined. There is only one active history operation, and no permit/native slot is held during retry delay. Shutdown, force and identity conflict cancel and join both active operations and waits.

Periodic history still fixes its initial Prime boundary before refreshing policy. Failed refresh cannot move that boundary forward and silently discard newer requests.

## Scope and verification

Checkpoint 904 left Gateway-message policy refresh unchanged; subsequent installation is documented in [the Gateway-message profile](live-gateway-message-policy-native.md). Checkpoint 907 subsequently installs [native per-message classification](native-message-classification.md), preserving conditional read order and same-page `!new` visibility. This is not an all-history-SQL-off-thread claim. Final resident authority, store schema, stage 893 activation, deployment status and Windows qualification are unchanged.

Validation uses pinned Node 24.21.0, `tools/build-test-profile.mjs`, and emitted JavaScript with `NODE_OPTIONS=--no-strip-types`. Focused tests cover genuine singleton/shared Background refusals with no subsequent message, fair notice traversal, capped serial retry timing, cancellation and actual-exit joining, exact one-use/replayed proof, ordinary failures, fresh revisions/source floors, incomplete coverage, initial Prime boundary, path/callback/limit capture, exact bigint IDs, raw plans, deduplication and installed poisoned compatibility policy reads. Bounded affected checks also exercise existing history, prepared ingress, journal, receipt and prompt paths.

The protected remote-agent redaction test and known Unix root-store-authority EPERM fixture are excluded from bounded execution. No live database, credentials, external messages, publication or deployment is involved.

### Checkpoint 904 writer validation

Final emitted profile: `.runtime/compiled-tests-eP2uFU`, Node 24.21.0, baseline `b428d71e38dfc3276ee52da6baff3e8cab30b1e8`.

- Strict full source/test typecheck, production build and whitespace check passed.
- All 937 emitted production modules byte-match the production build.
- Focused history validation: 74/74 passed across three selected files.
- Bounded affected validation: 271/271 passed across 22 additional selected files.
- Both final writer runs had zero failures, cancellations or skipped tests. Earlier candidate profiles are not counted as final passes.
- Independent final-profile core validation: 122/122 passed across eight selected suites, with zero failures, cancellations or skips. This overlaps writer coverage. Four additional independent probes passed for fresh source floors/new channels under Background contention and shutdown/force/conflict during locked native reads.
- Independent review reproduced the 937-module graph hash and byte equivalence and approved the scoped source change. A separate expanded independent run exceeded its 150-second outer bound after 137 passing subtests, with five suite entries cancelled; that incomplete run is excluded from passing totals. The writer's completed 271-test affected run above remains the bounded affected result.

This is bounded validation, not a full-suite, live-service, long-running production or Windows qualification.
