# Checkpoint 877: bounded native runner display

2026-10-14 UTC. Scoped implementation and verification, not overall migration/runtime/deployment PASS.

Detail, Summary, TargetCounts and Global display routes share a pinned zero-queue Background reader in the actual dispatcher. Existing native selection, resident-generation and control checks remain separate. Read-only existing database snapshots reject missing/partial schema, nonordinary tables and oversized schema catalog text without repair. SQL preflight bounds rows, storage bytes, identifiers and cumulative evidence before decoding in the same snapshot. Payload decode, credential-name redaction and bounded pretty formatting occur inside the worker; only bounded display output returns.

Existing actor/channel privacy, latest-20 ordering with full authorized-record decode, big integers, prompt text and the distinct global-versus-target quarantine/NULL behavior are preserved. No synchronous fallback, automatic retry, state mutation or remote probe is introduced. Cancellation/deadline joins actual native exit; it does not terminate SQLite or establish a hard execution-time bound.

## Verification

Frozen emitted profile Q9RbfL on Node 24.21.0 / SQLite 3.53.4, NODE_OPTIONS=--no-strip-types and CLI --no-strip-types: 97/97 focused cases and 121/121 affected regressions passed, zero failures/cancellations/skips. Strict typecheck, production build and diff checks passed. Evidence includes actual RuntimeCommandExecutor routing, shared-owner admission, actor/path capture, SQLite lock event-loop progress, missing stores/schema, byte/type/output boundaries, worker lifetime, table-kind rejection and WAL preflight/decode snapshot stability. Earlier overlapping runs are not added to final counts.

Native owner SHA-256 c1f39059f33b727a534a8f76662735fe66f48154898e4788461bb72a806dac29; store SHA-256 2f6b0eb02b66eb9c3b7bdd94d55a48d59be9ac0432fe3246f09009da6929ebd0.

Result-size limits do not prove bounded SQL scan/sort duration or G1-G7 performance. Full singleton launch, live Discord/Codex, Windows and long-duration acceptance remain unverified. Only source, synthetic tests and documentation are included, excluding secrets, actual databases, raw logs, generated artifacts and protected redaction fixtures. No main merge or deployment.
