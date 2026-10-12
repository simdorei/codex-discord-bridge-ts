# Bounded Repair preflight candidate review

Scope: two store reads before the original thread/read RPC. The concrete executor installs existing native queue List and prompt-intake List adapters. No new pool, operation, retry or mutable authorization path is added. Original short-circuit, target lease, deadlines, synchronous RecoveryGuard checks, mutation custody, reset/init/probe and unknown-effect retention remain unchanged.

The port captures own data functions without running getters or proxy traps and requires native Promise results. Native readers own their complete DTO decoding, fixed path binding, Control capacity admission and actual worker join. Cancellation is checked after the original read expression, so the target lock is retained until reads finish. This does not interrupt a read earlier than its native deadline and does not offload claim/lifecycle admission or synchronous mutation checks.

Initial compiled focused 40/40 passed. Expanded focused 45/45 passed, including queued short-circuit, both read failures preserving identity, cancellation while a read is pending, selection drift before RPC and accessor rejection. Additional concrete-composition test observes both native worker calls. Final focused/full evidence is pending and candidate remains unapplied.

Paired native fixture uses the existing production total deadline 25000ms, retaining call250ms and lock100ms fault budgets. Original direct fixture remains total2000ms. This is a test profile distinction, not a changed production timeout. Existing full concurrency2 timing failure is not fixed by this patch; full regression retains concurrency1 qualification.
