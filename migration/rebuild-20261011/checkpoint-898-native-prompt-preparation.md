# Checkpoint 898: Native server-prompt authority preparation

Base: 67cb03fb750ccbbe384ea0ac54ff3d9f324cefee. Local changes only; no Git writes, publication, deployment, or operational database access.

## Implementation

- Reuses the existing `createNativePromptAuthorityReads` port for automatic server-request delivery, explicit preparation, and each redisplay chunk. The three separate native observations remain completion, unfiltered allJobs queue evidence, then original-channel mapping.
- Captures optional read ports as passive own-data functions before awaits. Original database binding and function identities survive source context and property replacement. Missing ports keep direct compatibility behavior.
- Installs native reads in the automatic startup worker, `RuntimeCommandExecutor` Approval preparation, slash delivery, normal/emergency message contexts, and history gap/poll context copies.
- Keeps request ID, occurrence, generation, actor/channel requirements, prepared-snapshot comparisons, and per-chunk current-request checks on the original request. No fresh request or replacement authority is introduced.
- Receipt-only checkpoint 896 flags and semantics are unchanged. This adds no SQL, schema, native worker, persistent owner, or fallback.

## Verification

Pinned Node 24.21.0, emitted JavaScript only, `NODE_OPTIONS=--no-strip-types`.

- Strict source/test typecheck passed.
- Production build passed; all 933 production JavaScript modules match the emitted test build byte-for-byte.
- Whitespace check passed.
- Final focused review: 44/44 tests passed, with 17 frozen source/test/helper hashes verified independently.
- Bounded affected run: 998/998 passed across 100 test files, with zero failures, cancellations, or skips. Exact scope and results are recorded in `checkpoint-898-results.json`.

The focused tests exercise real automatic/slash/message/gap/poll composition for Approval and Input, poisoned compatibility authority and receipt methods, source parity, malformed unrelated allJobs rows, original occurrence drift after each awaited read, per-chunk channel/actor/mapping/turn/readiness/request drift, immutable context/port capture, confirmed receipt replay without a fresh request, zero-queue Control saturation, and actual blocked-read shutdown joining with no HTTP.

Initial test-only failures are retained: identical repeated pending requests are deduplicated without a new occurrence, and Node test mocks are proxies rejected by the passive-function contract. The corrected tests simulate changed current-request observations and use plain own functions for compatibility instrumentation; no production change was needed.

## Explicit limits

- The known UNIX-root fixture `test/runtime/discord-runtime/store-authority-profile.test.ts` is excluded from the bounded affected run. It was not retried or escalated. This is not a full-suite qualification.
- The existing automatic chunk check compares the original delivery channel, while explicit redisplay requires both channel and user. This source behavior is preserved rather than hardened in a wiring-only change.
- The test named "generation drift" uses restart-pending readiness, not generation rollover. Existing generation-mismatch tests remain part of the affected suite.
- Existing native read ports do not take the outer cancellation signal. Cancellation retains ownership until the bounded in-flight native read sequence exits, then the existing outer boundary observes cancellation. No detached read or early slot release is claimed.
- Final resident response/mutation guards, Repair, and text-reply authority wiring are unchanged; checkpoint 893 WIP stays inactive.
