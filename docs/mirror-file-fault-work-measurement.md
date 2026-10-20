# Integrated mirror file-fault read-work measurement

Checkpoint 923 measures eight small, independent synthetic file-fault cases through the existing bootstrap, bound poll, native decoder, ownership, receipt, and cursor paths. It adds no production code, runtime root, server, scheduler, recovery API, or deployment capability. The synthetic receipt transport returns distinct valid message IDs above 2^53; temporary SQLite persistence, file mutations, native adapters, and cursor transactions are real.

This is partial synthetic G1 evidence only. It supplements the separate checkpoint 922 warm incremental experiment without changing or importing its test, summary, or documentation. Each case uses 4 KiB of historical data; it does not repeat or replace 922’s 4 MiB observation.

## Frozen workload

The source, selected dependency graph, and following expectations are frozen before the first execution. Every per-poll expectation is primary. A mismatch fails the experiment; it does not authorize changing workload, thresholds, limits, or production behavior.

- Eight independent temporary stores and rollouts, run sequentially, one target/channel each.
- Each bootstrap consumes exactly 16 LF-terminated JSON records of 256 UTF-8 bytes, totaling 4,096 bytes. First and last records are turn contexts, with 14 historical messages between them. No historical transport attempt occurs. The final turn is retained, cursor revision is 1, and the startup intent is retired.
- Each case begins with one measured seed-message poll. It reads 1,280 bytes, calls eight native adapters, sends once, confirms one receipt, and advances to offset 4,352, revision 2. This is baseline C below.
- Bootstrap limits: 4,096 total/window bytes, 16 records, 512 bytes per record, 16,384 turn bytes, 5,000 ms native timeout, and 10,000 ms coordinator deadline.
- Warm limits: 4,096 window bytes, 512 record bytes, four records, and 5,000 ms native timeout. Ownership limits remain 32 jobs and 1,048,576 value bytes.
- The entire 30-poll matrix has a 60-second safety guard. This is not a latency acceptance threshold or shutdown guarantee.
- Setup, mapping/schema preparation, bootstrap, discovery, fixture mutations outside transport, and assertion reads are outside the measured intervals. Every seed and fault poll is measured. Every complete pre-existing receipt row is retained exactly; every nonadvancing poll retains the complete durable cursor snapshot.

### Exact fault sequence

Every case includes its seed poll in addition to the polls below. Byte figures are actual returned rollout bytes, including all continuity/next-boundary anchors and repeated read-ahead. Record counts come from successful original decoder responses; an absent decoder submission is distinguished from a zero-record response.

| Case | Fault polls: returned bytes | Decoded records | Native calls | Transport attempts | Durable result |
| --- | --- | --- | --- | --- | --- |
| Split UTF-8 | 1,352; 584; 1,280; 512 | 1; 0; 1; 0 | 8; 2; 8; 2 | 1; 0; 1; 0 | Prefix commits, incomplete suffix waits, completed record commits once, final EOF unchanged |
| Invalid JSON | 1,792; 1,024; 1,024 | 1; 0; 0 | 8; 2; 2 | 1; 0; 0 | Valid prefix commits; both later polls hold at the malformed record |
| Invalid UTF-8 | 1,792; 1,024; 1,024 | 1; 0; 0 | 8; 2; 2 | 1; 0; 0 | Valid prefix commits; both later polls hold at the malformed record |
| Oversized record | 2,049; 1,281; 1,281 | 1; 0; 0 | 8; 2; 2 | 1; 0; 0 | Valid prefix commits; 513-byte record remains above the 512-byte limit |
| Same-path replacement | 512; 512 | none; none | 1; 1 | 0; 0 | Original cursor and seed receipt remain unchanged |
| Truncation | 128; 128 | none; none | 1; 1 | 0; 0 | Original cursor and seed receipt remain unchanged |
| Prefix changed plus growth | 512; 512 | none; none | 1; 1 | 0; 0 | Original cursor and seed receipt remain unchanged |
| Accepted send plus append | 1,280; 1,536; 512 | 1; 2; 0 | 7; 8; 2 | 1; 1; 0 | First confirmation persists despite cursor hold; next poll reuses it and sends only the new item |

1. **Split UTF-8:** append a complete 256-byte message and the first 72 bytes of another 256-byte record. The split is after two bytes of a four-byte code point whose start is byte 70; construction is asserted before measurement. The first poll stops at `IncompleteRecord`, advances to C+256/revision 3, and leaves two receipts. The unchanged suffix poll also stops at `IncompleteRecord`, with no writes. Append the remaining 184 bytes. The next poll stops at `WindowEnd`, advances to C+512/revision 4 with three receipts, and the final EOF poll is unchanged.
2. **Invalid JSON:** append a valid 256-byte prefix, a 256-byte LF-terminated invalid JSON record, and a valid 256-byte sentinel. The first poll stops at `InvalidJson` after committing only the prefix to C+256/revision 3 with two receipts. Both later polls require `MirrorPollRecordHeldError` with exact `InvalidJson` stop and no cause. The sentinel is never transported. No corruption repair or skipping occurs.
3. **Invalid UTF-8:** use the same layout with a first byte of 0xFF in the bad record. Exact behavior is the same, with `InvalidUtf8` stop and held error. The sentinel remains unsent.
4. **Oversized record:** append a valid 256-byte prefix, a valid JSON record padded to 513 bytes including LF, and a 256-byte sentinel. The first poll commits only the prefix and stops at `OversizedRecord`. Both subsequent polls require that exact held stop. The record budget remains 512, and neither the oversized record nor sentinel is sent.
5. **Same-path replacement:** rename the original aside, then create an identical-byte replacement at the original path. Keeping the original inode alive avoids inode-reuse ambiguity. Both polls require `MirrorFileChangedError` with no cause after 512 anchor bytes, before decoder submission. There is no adoption, reset, or resume.
6. **Truncation:** shrink the original to C−128 = 4,224. Each poll returns only 128 bytes from the old tail start, then requires `MirrorFileChangedError` before the prefix read or decoder. No replacement cursor is created.
7. **Prefix changed plus growth:** change byte 254 of the historical first record’s padding from a space to a tab, preserving valid JSON, size, and LF; append a 256-byte record. Both polls require `MirrorFileChangedError` after 512 anchor bytes and before decoding. This exercises observed prefix mismatch during same-inode growth; it cannot establish unseen middle-history integrity.
8. **Accepted send plus append:** append a 256-byte message. Its real synthetic transport callback appends the following 256-byte message before returning a valid acceptance ID. Native confirmation persists the first receipt, then final file-stamp verification requires `MirrorBatchExecutionError`, caused by `MirrorFileChangedError`, with a retained non-null packet and no cursor `MixedAdvance` submission. The complete baseline cursor stays C/revision 2 while receipt count becomes two. A fresh poll decodes both records, reuses the confirmed receipt, sends only the newly appended message, and commits C+512/revision 3 with three receipts. Its satisfied-delivery count is two, while actual transport attempts are one. Final EOF preserves cursor and receipt rows exactly. There is no sleep, native-response substitution, cursor repair, or blind network replay.

## Aggregate reconciliation

The eight seed polls contribute 10,240 returned bytes and 64 native adapter calls. The fault sequences contribute 21,651 bytes and 79 calls. Exact totals are:

- 30 measured polls, 31,891 returned bytes: 9,619 payload-window bytes and 22,272 anchor bytes.
- 143 `OwnedWorkerSlot.run` invocations: cursor Read 30, decoder 24, ownership 30, receipt plan 15, receipt Begin 15, receipt Confirm 15, cursor MixedAdvance 14.
- 16 decoded records, including the accepted item decoded again during confirmed-receipt reuse.
- 15 actual transport attempts and 15 final confirmed receipt rows summed across the eight stores; zero unknown receipts.
- 14 cursor advances after bootstrap, including eight measured seeds.
- All five native lanes and active mirror-file reads must be zero after every successful or expected-failure poll, before verification reads, and after cleanup.

These totals cannot mask a per-poll mismatch. Successful prefix progress is distinguished from a current-record hold; decoded next offset is distinguished from committed cursor offset; satisfied deliveries are distinguished from actual sends; and retained receipts are distinguished from cursor advancement.

## Observation and cleanup boundary

The test follows checkpoint 922’s observation design without importing its executable test. It wraps only exact-rollout opens and original `FileHandle.read` calls, forwarding receiver, arguments, successful return values, and rejections. It counts read entries before execution and records each real returned byte count. Every logical range is reconciled, including truncated tails, read-ahead, and both anchor pairs. Each poll retains bounded numeric range evidence: position, requested and returned bytes, and contributing read calls. Real short reads may split a range, so syscall count is recorded rather than fixed as an acceptance constant. Metadata-only opens contribute no bytes.

The native adapter wrapper identifies exact expected worker URLs rather than basenames and forwards the original `OwnedWorkerSlot.run` invocation unchanged. Calls are counted at entry, and decoder metrics are inspected from the successful original native response. It does not create a substitute decoder, rewrite responses, reparse rollout data, or submit additional native work. Transport attempts are counted before request validation, including failed validation. Request validation occurs only at the synthetic transport boundary.

Outside each measured interval, native cursor reads and read-only SQLite queries verify the complete cursor and every durable receipt column. Existing receipt rows must remain exactly equal. Exact error classes, nested causes, held stops, and packet presence are asserted. Raw request bodies, rollout data, paths, SQLite contents, worker payloads, and exception text are excluded from the bounded summary.

Instrumentation is restored in `finally`. Every owner close is attempted with `Promise.allSettled`, all attempts settle, then any rejection remains a test failure. Temporary fixture removal precedes final diagnostic emission. The pass outcome is assigned only after all fixtures and cleanup assertions succeed. Unexpected failures retain completed rows, unfinished poll counters, a fixed failure-stage label, and final holdings in a bounded diagnostic; they never assert that unfinished work committed. Original exceptions still fail the test, and raw TAP/compiler output remains private.

## Recorded outcome

The author execution and independent compile/execution both passed the unchanged frozen 30-poll acceptance. Their complete 53,928-byte bounded diagnostics matched exactly, including every numeric read range, native-call map, error/stop classification, durable progress observation, and zero native/file holdings after every poll and cleanup. The [result summary](../test/fixtures/mirror-file-fault-work-summary.json) is identical to that independent result. The [focused test](../test/runtime/session-mirror/file-fault-work-measurement.test.ts) and workload remain unchanged.

A separately authorized reporting probe modified only a private copy of emitted JavaScript to throw during the first synthetic transport validation. It exited with status 1 as expected; it was not a workload acceptance run. Its 703-byte sanitized diagnostic retained no completed rows and an unfinished first seed poll with 1,280 returned bytes, five read entries/returns, six adapter calls, one decoder response, and one transport entry. All five native lanes and active file reads were zero, and the private temporary fixture parent was empty after cleanup. Diagnostic SHA-256: `23fe75149796f693ee7f0fb4f931a1b2279d8001fa2def27d9185da4967c37dc`. The candidate source and positive-run emitted graph remained unchanged. This probe checks failure accounting and cleanup; it does not add another successful workload or qualify provider-failure behavior.

Frozen test SHA-256: `a3eeb45ec005f35b78daeaaae5b0938b67f06ed91fd3cb7789cb1ccce2b831a9`. Source graph SHA-256: `dd8b9d0d474e8977d7d4c1f8060db01231a2e6ae472dab506a7d28a91ceb1359`. The actual compiler list exactly matched the guarded 302-source graph. Emitted graph SHA-256: `365082ccd8cedcc9bdd604bf51c6d3654b9d315ab65aebdc46f933069f91dd76`. Summary SHA-256: `d4f579188d7af95110558c3f0bd212e24402259e346cf467bc96c1ae48f4193b`.

## Reproduction profile

Use pinned Node 24.21.0 at `.runtime/node24/node_modules/node-linux-x64/bin/node` and TypeScript 7.0.2 at `node_modules/typescript/bin/tsc`. Compile the selected test and its static relative TypeScript dependencies, including literal native-worker URLs, to fresh private output. Use ES2023/NodeNext, strict checking, rewritten `.js` imports, explicit files, and empty include/exclude arrays. Guard each lexical and canonical path before reading it. Verify the actual compiler project-source file list exactly equals the selected graph before executing emitted JavaScript with `--no-strip-types --test --test-concurrency=1` and `NODE_OPTIONS=--no-strip-types`.

No broad test-build profile, repository-wide content search or test glob is used. The protected redaction test, restricted remote-agent native-read paths, and reserved Windows directories remain excluded without inspection or fallback. No Git, uploads, live Discord, live database, listener, operational command, Rust oracle, restart, or deployment is needed.

## Evidence limits

This is bounded synthetic integrated file-fault/read-work evidence, not full performance or reliability qualification. Bootstrap and other native-isolate file IO are unmeasured. Returned bytes are not physical storage IO, cache misses, SQL statements or rows scanned, memory/RSS, throughput, fairness, or latency. Adapter invocations are not an independently witnessed count of Worker construction.

The experiment does not qualify crash/restart behavior, provider uncertainty, a real independent append-only producer, arbitrary concurrency, unseen middle-history integrity, cold-cache IO, Windows behavior, live Discord, Rust equivalence, complete G1, G7, or deployment readiness. No gate is promoted. Prior checkpoint 922 warm-scaling evidence remains separate.
