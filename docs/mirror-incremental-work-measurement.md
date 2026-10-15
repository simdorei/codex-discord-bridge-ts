# Warm incremental mirror read-work measurement

Checkpoint 922 adds a narrowly scoped synthetic experiment over the existing mirror bootstrap, bound poll, native decoder/ownership/receipt adapters, and durable cursor transaction. It changes no production code and introduces no runtime root, HTTP server, queue, or scheduler. The synthetic receipt transport returns distinct valid message IDs above 2^53. SQLite, rollout files, native worker adapters, receipt persistence, and cursor advancement are real, temporary test resources.

## Frozen workload and acceptance

These expectations were declared before the first measurement. A mismatch is a failure to retain and investigate, not permission to tune limits or acceptance to the result.

- One target/channel, one temporary SQLite store, one append-only rollout, sequential polls.
- Initial history: exactly 16,384 LF-terminated JSON records, each 256 UTF-8 bytes, totaling 4,194,304 bytes (4 MiB). First and last records are turn contexts; the middle 16,382 are unique historical agent messages. ASCII spaces before LF pad valid JSON to the exact size.
- Real explicit bootstrap: no historical transport attempts, offset 4,194,304, revision 1, final historical turn retained, startup intent retired. Schemas, mapping, bootstrap, discovery, and assertion reads are outside measured intervals.
- Bootstrap context limits: 4,194,304 bytes, 16,384 records, 512 record bytes, 65,536 window bytes, 16,384 turn bytes, 5,000 ms native timeout; coordinator deadline 10,000 ms.
- Warm poll limits: 4,096 window bytes, 512 record bytes, four records, 5,000 ms native timeout. Ownership limits: 32 jobs and 1,048,576 value bytes.
- Eight unchanged EOF polls; append one unique 256-byte message and poll once; append 33 unique messages (8,448 bytes) and poll nine times; eight final EOF polls. Total: 26 polls.
- Backlog decode counts: 4, 4, 4, 4, 4, 4, 4, 4, 1. Stops: eight `RecordLimit`, then `WindowEnd`. EOF and the single append stop at `WindowEnd`.
- Exactly 34 decoded records, unique transport attempts, and confirmed durable receipts; zero unknown receipts. Ten cursor advances end at revision 11, offset 4,203,008. Every EOF poll preserves the entire cursor snapshot and receipt rows.
- Every native worker lane and the active mirror-file-read count must be zero after every poll, before outside-interval verification.
- The 60-second test timeout is a safety guard, not latency acceptance or a shutdown-latency guarantee. Native deadlines and limits are unchanged after any failure.

### Read-work arithmetic

Every poll reads the existing 256-byte tail and 256-byte prefix continuity anchors. Every advancing poll also reads both next-boundary anchors. EOF therefore returns 512 actual rollout bytes; an advancing poll returns its actual payload-window bytes plus 1,024 anchor bytes.

The single append returns 1,280 bytes. The nine backlog polls return 5,120, 5,120, 5,120, 5,120, 5,120, 4,352, 3,328, 2,304, and 1,280 bytes. The complete warm workload must return exactly 46,336 bytes: 27,904 payload-window bytes plus 18,432 anchor bytes. Only 8,704 appended bytes are decoded. The difference is deliberate record-limited read-ahead, counted again when reread; it is not silently removed from the measurement.

Adapter call expectations: cursor Read 26, decoder 26, ownership 44 (10 batch and 34 per-item), receipt plan 10, receipt Begin 34, receipt Confirm 34, cursor MixedAdvance 10. Total 184, with two per EOF and at most 17 per four-record advancing poll. These are calls to `OwnedWorkerSlot.run`, not an independently witnessed count of Worker construction or SQL statements/rows scanned.

## Observation boundary

The test transparently wraps exact-rollout `fs/promises.open` results and their real `FileHandle.read` methods. It forwards the original receiver, arguments, returned result, and rejection. Counting is enabled only while awaiting each existing production `pollBoundMirrorTarget` invocation. Each requested range and actual returned `bytesRead` is reconciled with the predeclared ranges, including both anchor pairs and read-ahead. Real short reads may split a range; read-call count is recorded rather than treated as a fixed acceptance value. Metadata-only opens return no measured bytes.

A transparent `OwnedWorkerSlot.run` wrapper forwards unchanged native modules, data, limits, and signals. Decoder record/event/offset/stop metrics come from the original successful native response. The observer does not reread or reparse rollout data, substitute a decoder, synthesize native results, or create workers. Request-body validation belongs to the synthetic transport and does not parse rollout records. Receipt and cursor assertions run after counting stops. Instrumentation is restored in `finally`.

`counts.sent` alone is insufficient: the existing executor counts satisfied deliveries, including cached durable receipts. This experiment separately counts actual synthetic transport calls. Its unique-message workload does not claim to test receipt reuse.

All 26 poll rows are retained in the bounded fixture summary, together with aggregate bytes, adapter counts, receipts, and cursor progress. The summary contains synthetic numeric evidence and fixed labels, never raw rollout/message content, temporary paths, database files, worker payloads, or error text. The bounded outcome is emitted only after native-owner and temporary-fixture cleanup settles. A passing summary requires every fixed assertion and cleanup to pass. Failures retain the completed rows, the unfinished poll's observed counters, a fixed failure-stage label, and post-cleanup holdings; they never claim that incomplete work committed. Transport invocations are counted at entry, including validation failures. Original failure exceptions still fail the test, while raw compiler/test output stays private and is preserved separately. The first candidate's workload was frozen before execution; a reporting-only instrumentation revision added this after-cleanup failure accounting without changing any workload or acceptance constant.

## Recorded outcome

The [focused test](../test/runtime/session-mirror/incremental-work-measurement.test.ts) passed both the author execution and an independent compile/execution of the final reporting revision. The complete bounded diagnostic from the independent run exactly matched the checked-in [26-poll result summary](../test/fixtures/mirror-incremental-work-summary.json). Both runs met the frozen 46,336-byte, 184-adapter-call, 34-confirmed-receipt, revision-11 acceptance, with zero remaining native/file holdings after cleanup. These outcomes remain partial synthetic G1 evidence only.

The actual compiler file list was verified against the guarded 302-source graph in each execution. Final test source SHA-256: `dd21016ffdc0303c155fd6bc79f5b3e7c60ce2a7adeba28cadcf98b5a861d802`. Source graph SHA-256: `699c854e8ea512a7e477e2cd9930ab0d7c43429af395db39517cabaae2806eb2`. Emitted graph SHA-256: `b7863249c3b01bbec7b4069e06ac71061272c50b66735c06a25983cc35e07305`. Reviewed JSON SHA-256: `bdd7737aaea80f2dde40a95ab8c57fc8be0329c2541393313f1280c6525cde2f`.

The byte/accounting boundary follows the existing [file reader](../src/runtime/session-mirror/file-window.ts), [continuity anchors](../src/runtime/session-mirror/continuity-observation.ts), [native decoder adapter](../src/runtime/session-mirror/decode-reader.ts), and [bound poll](../src/runtime/session-mirror/bound-poll.ts). The first candidate also passed its unchanged workload; its evidence was retained before the reporting-only revision, without using it as the final reviewed summary.

## Reproduction profile

Use pinned Node 24.21.0 at `.runtime/node24/node_modules/node-linux-x64/bin/node` and TypeScript 7.0.2 at `node_modules/typescript/bin/tsc`. Compile the selected test and its static relative TypeScript dependencies, including literal native-worker URLs, to a fresh private output directory. Use ES2023/NodeNext, strict checking, rewritten `.js` imports, explicit files, and empty include/exclude arrays. Guard each path before reading it. Verify the compiler's actual project-source file list exactly matches the selected graph before running the emitted test with `--no-strip-types --test --test-concurrency=1` and `NODE_OPTIONS=--no-strip-types`.

Do not use the broad test-build profile or repository-wide test globs. The restricted redaction test, remote-agent native-read paths, and reserved Windows runtime directories remain outside the selected graph and are never opened or compiled. No credentials, production database, live Discord, network listener, Rust oracle execution, or publication is required.

## Evidence limits

This is partial synthetic G1 evidence that an already-bootstrapped warm cursor performs bounded incremental file-read work for this frozen sequential workload. Bootstrap file IO occurs in native isolates and is deliberately unmeasured. Returned file bytes are not physical storage IO, cache misses, SQL scan volume, memory/RSS, throughput, latency qualification, or fairness evidence. Startup is not cold-cache qualified.

It does not qualify crash/restart behavior, the full truncation/rotation/partial-UTF8/corruption matrix, a real independent append-only producer, live Discord, process ownership, concurrent targets, Windows behavior, Rust equivalence, complete runtime performance, or G7. Existing receipt, corruption, startup/recovery, and backlog tests remain separate evidence. No gate is promoted or deployment readiness inferred from this result.
