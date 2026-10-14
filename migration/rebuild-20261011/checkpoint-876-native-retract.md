# Checkpoint 876: bounded existing-only native Retract

2026-10-14 UTC. Scoped implementation and verification, not overall runtime/migration/deployment PASS.

The live RuntimeCommandExecutor Retract path now uses a pinned-database native writer behind StateAccessFacade. The initialized helper remains for compatibility. Control1 admission has no waiting queue; cancellation and deadlines join native exit. The existing-only store preserves candidate ordering, actor/channel and ownership fences, cancellation receipt ordering and transactional rollback while bounding candidate, owner, value and cumulative read budgets before materialization.

Missing or partial required schema fails closed without lazy repair. The existing-only compatibility policy handles wholly absent lazy handoff state separately. Trigger-induced ignored mutations and altered final ownership are rejected. Read budgets include repeated cross-room mapping reads, secondary handoff lookup and final identity rereads.

A submitted mutation without a valid acknowledgement is uncertain. The original ingress identity binds its acknowledgement and retained uncertainty; it is not a durable operation-idempotency guarantee. Existing gateway custody holds that ingress. Cancel-latest is never automatically replayed after an unknown result, because replay could cancel the next request.

## Verification

Frozen emitted-JavaScript affected batch: 188/188 passed across 14 files, zero failures, cancellations or skips, Node 24.21.0 with --no-strip-types. Includes 68 new store cases, 13 native-owner cases, 3 actual command/gateway cases and affected cancellation/recovery/archive/facade/shared-worker regressions. Earlier overlapping batches are not added to this total. Strict typecheck, production build, emitted test-profile build and diff checks passed.

Tests cover existing semantics/fences, missing stores/schema without repair, candidate/byte/UTF-16/BLOB bounds, rollback on trigger interference, parent event-loop progress under SQLite lock, admission/pre-abort, cancellation/deadline ownership through native exit, acknowledgement loss without a second cancellation, and actual command/gateway wiring. Independent read-only review found no remaining P1/P2 in this delta. Reviewed store SHA-256: 0d4cdc83493cbcb6b064e46c89d644e3344bdbf494f3b3d197af320bc7090c5e.

Full singleton application launch, live Discord/Codex, production stores, Windows behavior, external producer qualification, performance and long-duration acceptance remain outside this evidence. No secrets, actual databases, raw logs, generated outputs or protected redaction fixtures are archived. No main merge or deployment is included.
