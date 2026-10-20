# Checkpoint 896: native original server-prompt receipts

2026-10-15 UTC. Candidate change only; no Git write or publication. Baseline: 92f80bb3077ef587e3f6f0eee8be309a7475d6bc. Fifteen production/test files are frozen in `.runtime/checkpoint-896-freeze.json` (manifest SHA256 d70c985c063b97187bea27c8ca409e74bff172f0a611bf3ac9c8add35ac6aead). Emitted graph: `.runtime/compiled-tests-lp840L`.

## Scope

The installed automatic server-request worker and explicit approval/input redisplay paths use the existing NativeCompletionReceiptStore for exactly `server-request/prompt/v1` and `server-request/redisplay/v1`. Both domains require null delivery guards and retain their original multipart indices. No fabricated completion guard, arbitrary domain, new worker, SQL body, schema, transaction, pool, or fallback was added.

Automatic delivery captures a strict boolean opt-in privately in ServerRequestDelivery; runtime server-request startup supplies true. Explicit redisplay captures an own-data strict boolean and its immutable value flows through action delivery, the interaction processor/prepared bootstrap, and message processing/prepared composition. Normal/emergency gateway copies and both gap/periodic history copies preserve it. Direct callers default to compatibility. Invalid present values, accessors, and proxies cannot activate the profile or execute profile hooks.

Authority reads, pending-request preparation, local form responses, and AsyncQuestion publication remain unchanged. The profile only changes receipt persistence. Existing initialization behavior and unsigned-u64 channel acceptance remain in compatibility helpers; native receipt channels must fit positive i64, including its maximum value. A missing database or incomplete schema is not created, initialized, migrated, or repaired by the native receipt path.

## Preserved identity and delivery behavior

Automatic identity still binds generation, typed request ID, and the original semantic-v2 hash of occurrence bytes, method, thread, complete rendered text, and components. Explicit redisplay still uses Serde `[commandKey,generation,typedRequestId,occurrenceByteArray]`; it does not stringify the occurrence as a UUID. A fresh explicit command is a separate intent. Original request authority is revalidated for every chunk; redisplay accepts only branded prepared snapshots and checks the original actor, channel, and pending occurrence.

The existing splitter, chunk indices, receipt content hashes, nonce derivation, enforce_nonce, and final-chunk-only components are unchanged. Accepted prefixes commit independently; a later explicit retry skips delivered chunks and stops at unknown or blocked outcomes. The process-local cache is filled only after every automatic chunk succeeds, and cache eviction/recreated owners still consult durable receipts. A known acceptance is confirmed despite caller cancellation. Unknown transport or receipt outcomes remain held, including confirmation failure after accepted HTTP. Definite 400 rejection blocks; an owned validated 429 permits an explicit later retry using the identical nonce. The existing HTTP client's own 429 retry behavior is unchanged.

Begin uses zero-queue Control admission. Only the already-owned Confirm/Release/Block operations use the existing finite Control completion FIFO. Cancellation and deadlines join actual worker exit, retaining the slot and surrounding operation while SQLite is locked. JavaScript timers remain responsive. The automatic transport continues to discard its optional signal as before; the existing in-flight HTTP operation is joined, with no new HTTP cancellation guarantee.

## Verification

Pinned Node 24.21.0, TypeScript 7.0.2, emitted JavaScript and NODE_OPTIONS=--no-strip-types. Strict no-emit, production build, and whitespace checks pass. A preliminary focused run passed 32/32; the final frozen graph additionally checks successful delivery at the maximum positive-i64 native channel in the same test. Independent read-only review found no findings and passed 95/95 focused emitted tests on the frozen graph, with no failures, cancellations, or skips. The reviewer reverified all 15 hashes and clean whitespace.

The first affected run selected 97 files and recorded 868 passes out of 872 tests, with four failures in the existing store-authority-profile fixture. All four reached the environment-denied temporary Unix-socket binding (EPERM); no prompt/receipt test failed. One isolated elevated recheck hit the same restriction and was not retried. This original run is not green and its four actual-root checks remain blocked, preserving checkpoint 893’s existing qualification limit. The final bounded 96-file rerun excludes that known blocked file and passed 868/868 tests, with no failures, cancellations, or skips (119.052 seconds, exit 0). Overlapping review results are not added into the affected counts.

Coverage includes poisoned facade receipt methods on actual installed automatic, slash, message, gap-history, and periodic-history paths; the shared emergency context copy; long prompt byte-for-byte compatibility/native parity; exact receipt keys and occurrence array; actual cache eviction and recreated owners; partial acceptance; malformed successful HTTP; failed native confirmation; wire 400/429/503; explicit validated 429 retry; lost/cancelled Begin; accepted cancellation; real SQLite lock/deadline join; Control saturation/FIFO; strict profile/accessor/proxy rejection; branded prepared snapshots; per-chunk mapping changes; and missing/incomplete stores.

Evidence prefix: `.runtime/checkpoint-896-`. The affected test list explicitly selects 97 test files and excludes the protected remote-agent redaction fixture; it is not counted as passed or skipped. No live service, operational database, credentials, raw operational log, deployment, or restart was used. All fixtures are temporary synthetic databases and loopback HTTP/resident processes.

Checkpoint 893 remains inactive opt-in work in progress, with its independent qualification blockers unchanged. No full-suite, Windows, performance, cross-restart reconciliation, or whole-runtime readiness claim is made.
