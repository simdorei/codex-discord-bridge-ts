# PLAN799 — Archive durable writes outside the main event loop

Baseline: applied798, local650977f4f52ecd53a1493900cadf005440e52ac7. Migration remains incomplete.

Authority: Rust main3ebf4223b75b9d36237a73a78ce52ce794aee4ca, crates/cdr-store/src/archive_fence.rs, read from the immutable GitHub file on2026-10-13. Reservation checks all exact scope targets under BEGIN IMMEDIATE, excludes only the original ingress, generates one UUID after successful prechecks, inserts attempted fences atomically, then commits. Verified/rejected writes affect only matching operation and attempted phase and require affected rows. Ambiguous outcomes never authorize release or retry.

First slice800 extracts shared private SQL functions, keeping the existing initialized entry points unchanged and adding existing-only entry points for a future native worker. Existing-only uses100ms database busy timeout, never creates/migrates a store, and closes its own handle. Central state facade exposes the exact new functions. Tests distinguish missing store, malformed schema, atomic rollback, busy lock, original scope validation, operation isolation and verified retention.

Next slice must use the existing global bounded worker ownership abstraction, not another pool. Capture a bounded immutable request and fixed database path; bind reply to request/path/kind. Native exit must be joined before releasing runtime target leases. An admitted write with no valid acknowledgement has unknown outcome even if no effect may have occurred. Worker-generated operation UUID remains source-compatible; absence of its reply must preserve all fences and stop dispatch. No automatic replay or guessed operation ID.

Connect reserve/verify/release together, including the exact pre-effect rejection handler. Keep existing target locks through joined native completion. Preserve original actor/ingress/channel/command, descendant limits and complete-scope confirmation. Read-only archive preflight/persistence already has native support and is not recreated. Windows and live operational acceptance remain separate unqualified work.
