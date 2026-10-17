# Two-target large unread-backlog component measurement

Checkpoint 941 composes original MirrorDispatch, TargetLocks, withMirrorMappingLocks and pollBoundMirrorTarget over a real temporary SQLite store. It is not an installed full application, queue-registry binding, live Discord run or throughput/latency qualification.

## Frozen workload and outcomes

Two distinct threads A/B, channels 42/43 and rollout files each bootstrap through the original native coordinator from two 256-byte LF-terminated turn-context records. Authentic cursors begin at byte 512, revision 1, with distinct final turns. Native store discovery supplies the authentic empty jobs snapshot. Setup, bootstrap, discovery, appends and verification SQL are unmeasured.

Append 16,384 unique 256-byte A messages (4,194,304 unread bytes), and one 256-byte B message. Each of two finite rounds refreshes [A,B], admits both together once, then uses original waitForSettlement and harvest until both join. There is no redispatch between completions. Append only B's second message between rounds. No sleep, gate or replaced lock manufactures ordering.

Read limits remain 4,096 window bytes, 512 record bytes, four records, 5,000 ms decoder/native timeout; ownership limits 32 jobs and 1,048,576 value bytes. Ready budget is exactly two targets/18 bytes. Original 10-second target cancellation and 60-second test safety timeout remain unchanged; these are guards, not timing acceptance.

Frozen per-round outcomes:

- A: four decoded events, RecordLimit, four unique sends and receipts; offsets 512 → 1,536 → 2,560.
- B: one decoded event, WindowEnd, one unique send and receipt; offsets 512 → 768 → 1,024.
- Both finish revision 3 with original final turns. Exactly ten confirmed receipts correspond to A's first eight and B's first two messages; no unknown/retryable or unread-A receipts. A remains responsible for 4,192,256 unread bytes/16,376 records.

Original target-before-global lock ordering admits A/B but serializes their polls. At A's first actual transport callback, B has zero reads and transport attempts and the authentic registry must show three active targets, one queued waiter and three held lease references. Mapping callbacks enter/exit A then B in each round. B progresses after bounded A polling while A remains behind. This is not no-head-of-line blocking, slow-target isolation or a latency guarantee.

## Transparent read and native-submission accounting

The test observer forwards original fs.open/FileHandle.read receiver, arguments, return values and errors for the exact rollout paths. It counts actual returned bytes, not logical decoded bytes. Each advancing poll reads old tail 256, prefix 256, bounded payload, new tail 256 and prefix 256, in that order. Ordered byte positions, requested remaining sizes and actual returned counts must reconcile exactly; short reads can split ranges, so call count is observed rather than fixed.

A returns 4,096 payload + 1,024 anchor bytes per poll (5,120); B returns 256 + 1,024 (1,280). Total is 12,800 returned bytes, comprising 8,704 payload and 4,096 anchor bytes. This includes A read-ahead and anchor rereads. It does not establish physical storage IO, cold-cache behavior, SQL bytes or heap usage.

The observer also forwards the original OwnedWorkerSlot.run with unchanged module URL/data/timeout/signal and records operation identities. Each n-message advancing poll submits 3n+5 adapters: A 17, B 8, total 50. Exact totals: cursor Read 4, decoder 4, ownership 14, receipt plan 4, receipt Begin 10, receipt Confirm 10, cursor MixedAdvance 4. The original decoder performs detail SQL internally; that is not a separate adapter submission. No workers, native responses, receipts or cursors are fabricated.

Poll instrumentation ends in finally before verification. Native holdings and active file reads must be zero after every joined poll while mapping ownership is still held. After both completions are harvested, dispatch slots, ready entries, all native/file holdings, locks and waiters must be zero. Intermediate harvest may legitimately retain B. Final summary is emitted only after all owners and fixture cleanup; failures retain bounded observations and their original failure stage.

## Qualification and reproduction

The first author compile and execution passed all 33 selected tests without changing acceptance. All four polls made five actual read calls each, returning exactly 12,800 bytes and submitting exactly 50 native adapters. Ten exact confirmed receipts, both revision-3 cursors, expected offsets, the authentic waiter snapshot and zero joined holdings matched the frozen profile. Temporary fixture removal was verified. The bounded expected/actual evidence is in [the summary fixture](../test/fixtures/two-target-backlog-measurement-summary.json). An independent reviewer separately compiled and ran the unchanged frozen graph: all 33 tests passed, the complete parsed measurement diagnostic matched the summary fixture exactly, and all 300 production outputs were byte-identical both within and across the author/reviewer builds. This independently qualifies only the bounded component profile described here.

Before execution, independent source review tightened failed-attempt counting, original-error preservation and exact read-path attribution; the initial planning freeze remains retained privately. No compilation or execution failed, and workload, outcomes, byte ranges, operation counts and deadlines were unchanged. Source graph: 307 modules, SHA-256 `e37a0ff04cfe51464f6d8d44cd0b1c48f09528cca19220b0045a837f997f2612`. Emitted graph: `c5f7a238b7f921e9e90791ec53bc9e30581c9cec9fa1c4fc8dcf7765c6b917d3`. Actual compiler source lists matched the frozen graphs; all 300 separately compiled production modules were byte-identical.

Use pinned Node 24.21.0 at .runtime/node24/node_modules/node-linux-x64/bin/node and TypeScript 7.0.2. The private runner freezes exact guarded import/export/dynamic-import and literal worker-URL dependency closure, immutable nonempty argv and source hashes before execution. Compile using --ignoreConfig, explicit files, ES2023/NodeNext, strict checking and rewritten relative imports. Audit actual compiler project sources against the frozen closure and separately compile production-only roots to prove emitted byte parity. Execute only the explicit emitted test list using --no-strip-types --test --test-concurrency=1. Preserve failed compilation/tests privately and obtain reviewer approval before the first run.

No protected remote-agent native-read paths or redaction test, checkpoint 936 work, broad discovery/build/test, listeners, denied UNIX retry, provider credentials, operational store or deployment is part of this profile. This evidence does not establish full G1/G7, a Rust comparison, Windows qualification, full drain, corruption/restart/fairness matrices, application readiness or migration PASS.
