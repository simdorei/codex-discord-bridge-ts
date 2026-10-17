# Writer retained-work accounting (checkpoint 939)

This bounded observational prerequisite for migration G2 adds per-instance snapshots to `AppServerWriter` and `TargetLocks`. It does not complete G2, install admission controls, activate checkpoint 893, or alter defaults. Full installed counts, bytes, submissions, all-lane behavior and memory evidence remain separate work.

## API and meaning

`TargetLocks.snapshotRetainedWork()` returns a fresh frozen object with only numeric fields:

- `activeTargetCount`: current registry map entries, also exposed by the existing getter.
- `queuedWaiterCount`: actual queued array entries. Insertion increments it; cancellation removal or FIFO grant removal decrements it once.
- `heldLeaseReferenceCount`: unreleased original lease and private pin handles. Each handle increments once; first release decrements once. Repeated release does nothing. Releasing an original lease while pins remain does not unlock the target.

`AppServerWriter.snapshotRetainedWork()` returns a fresh frozen object with:

- `retainedWriteOperationCount`: operations whose successfully encoded Buffer is still in the writer's ownership scope.
- `retainedEncodedBufferBytes`: sum of those Buffers' actual UTF-8 byte lengths, including each terminating newline.
- `stdinLock`: a fresh frozen `TargetLocks` snapshot. It includes shutdown's lock work as well as writes, so lock counts need not match write counts.

All scalar fields are numbers; neither snapshot exposes targets, buffers, values, tokens, signals, callbacks, histories or lease capabilities. Snapshots are observations only and must not become admission criteria, authority, memory limits or synchronization mechanisms. Reading them allocates snapshots on demand; transition accounting is O(1), with no additional registry traversal or strong-reference collection.

## Ownership boundaries

Closed admission, pre-aborted signals and failed serialization do not acquire encoded-buffer ownership. Successful Buffer creation increments operations and the saved numeric byte length before lock acquisition. An outer accounting-only `try/finally` covers aborted acquisition, native preflight, adapter write/flush, close coordination and all existing preflight disposal. The existing inner lease-release placement and cleanup behavior are unchanged. The outer finally clears the writer-local encoded reference and subtracts the saved byte count and operation count exactly once.

Cancellation of a queued write removes its actual waiter synchronously. Its byte ownership ends when the rejected acquisition resumes and the outer finally runs. Active cancellation or timeout does not release ownership while native preflight, adapter work, close coordination or disposer cleanup remains accepted and unjoined. Abandoning a Promise is not cancellation. Shutdown itself adds lock work but no encoded bytes.

The same Buffer is passed to the adapter; snapshots neither copy nor replace it. Original token and lease identities, FIFO behavior, error identity and AggregateError ordering remain unchanged. No new await or callback is inserted between the final synchronous validation/checks and write-start dispatch.

## Memory interpretation

These are logical ownership gauges, not heap, RSS, allocator or native-memory measurements. Bytes exclude serializer transient strings and Buffers, original input and token graphs, closures/Promises, pooled backing-store capacity, stream/native copies and allocator overhead. An adapter can retain an alias to the original Buffer after the writer clears its own reference. Released lease objects retained by callers may still close over the registry, entry or reference group: the reference gauge counts unreleased handles, not every live JavaScript reference.

Zero gauges mean only that the accounted ownership scopes or handles have ended. They do not establish garbage collection, reclaimed heap, lower RSS or released native memory.

## Qualification

Focused tests cover multibyte UTF-8 and newline accounting, queued totals and FIFO, queued/active abort and timeout, delayed native/adaptor/close/disposer settlement, pins and duplicate releases, admission and preflight failures, exact error/AggregateError ordering, shutdown lock-only work, adapter aliases, independent instances, and immutable fresh snapshots. Existing writer and owned-preflight suites remain required regressions.

Qualification uses exact guarded roots and an audited compiler list with pinned Node 24.21.0 and TypeScript 7.0.2 CLI `--ignoreConfig`. A separate production-only build must have byte-identical production JavaScript to the focused-test build. Test launch uses an immutable, nonempty explicit emitted-file argv in a fail-fast subprocess. No broad test discovery, protected-path access, deadline inflation, production deployment or G2-completion claim is part of this checkpoint.

### Recorded checkpoint 939 result

The implementer and independent reviewer each passed the same four explicit test roots: 38 tests passed, zero failures, cancellations or skips. Both qualification runs compiled the 23-file focused closure and a separate 19-file production-only closure with Node 24.21.0 and TypeScript 7.0.2. Actual compiler file lists were audited; all 19 emitted production JavaScript files were byte-identical across the focused and production-only builds. Production and test source bytes stayed frozen across both runs.

The first attempt compiled successfully, then stopped at the compiler-list audit before any tests: the audit allowlist omitted TypeScript 7's installed bundled standard-library directory, `node_modules/@typescript/typescript-linux-x64/lib/`. Its receipt and compiler log were preserved. Independent review confirmed the exact bundled dependency, and only that directory was added to the private runner's dependency allowlist. No production or test source, timer, deadline or discovery scope changed for the successful qualification. Each subprocess retained the original 60-second fail-fast limit.

The final documentation-only update records these results; it does not change the tested production/test freeze. This qualification demonstrates the bounded logical-accounting contract and regressions above. It does not measure heap, RSS or native-memory reclamation, audit every installed queue, prove full migration parity, close G2, activate 893, or authorize production use.
