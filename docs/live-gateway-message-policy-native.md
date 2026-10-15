# Native installed Gateway message policy and original retry

Checkpoint 906 installs native dynamic mirror-policy refresh for Normal and Emergency Gateway messages. Prepared message and prepared typed ingress require separate, explicit `messagePolicyLimits`. The local application supplies the startup-equivalent bounds: 4096 rows, 4194304 selected value bytes, 8192 output IDs and 10000 ms. Interaction and history limits remain independent. Direct `createGatewayMessageHandler` and `prepareGatewayMessage` callers retain the compatibility refresh unless they explicitly provide a captured port; the shared bootstrap context capture does not itself install a message policy reader.

## Exact refusal and original ownership

The existing native policy reader still has one process-global slot sharing the three Background slots within the eight-worker total. Its complete, ordered reads use the original two separate existing-only read-only connections. This is not an atomic multi-query snapshot. Missing, incompatible, malformed, over-budget and failed reads never initialize or migrate a store, return a partial list, or fall back to stale/allow-all policy.

Preparation preserves the exact native refresh Promise and consumes its one-use capacity proof. Only a proven refusal before submission can create a private message-policy error. The outer preparation adapter binds that error to its own invocation and exact returned Promise; the handler consumes this second proof once. Public classes/names, forged objects, old genuine errors replayed through another invocation, wrapped/wrong Promises and already-consumed evidence cannot authorize retry. Classification, settings binding, journal admission, admitted native failure, timeout, action, HTTP and receipt failures do not create policy-capacity evidence. Distinct non-capacity failures survive concurrent cancellation unchanged for the existing identity guard to report.

The handler retries preparation for the same deeply immutable decoded original, under the same consumer operation. It captures the first observation time at the original post-drain-probe/pre-preparation point and reuses it for durable admission. The message, source timestamp, exact channel/message IDs, original process sequence and downstream raw plan are not replaced or republished. Processor validation still precedes policy and durable admission. A fresh drain/pending-text probe and fresh policy run on every attempt; settings, authorization, bot/self filtering and canonical deduplication remain mandatory after capacity becomes available.

The serial delay is 1, 2, 4, 8, 16, then 30 seconds, capped at 30 seconds with no attempt ceiling. A monotonic deadline is computed from completion of each proven refusal. The clock methods are captured before asynchronous work. Only one saturating index, deadline and the already-owned original are needed per active handler. No admission permit or native slot is held during delay. This is an explicit TypeScript liveness policy, not a claim of Rust retry timing parity.

The existing consumer identity guard owns the whole handler, including every retry and sleep. Shutdown, force and identity conflict cancel and join the actual operation before the consumer completes its exact original. An admitted native timeout or cancellation keeps the worker slot until actual native exit; it never terminates native I/O to simulate a completed join.

## Anti-discard foundation and boundaries

[Checkpoint 905 accepted-original custody](gateway-accepted-message-custody.md) keeps both queued and active originals protected from periodic processed-marker-only Discard, including while an active original sleeps. Discard deferral commits no periodic cursor and does not poison the gap tracker. History Process may still win canonical durable admission; the later original retry observes the duplicate and performs no second effect/receipt. The custody bound remains Normal capacity plus four Emergency queued messages plus two active originals.

There is no new payload queue, capacity queue, recovery gap, sequence, cache, worker pool or native budget. Real overflow/Closed/Stopping gaps retain their original revision/source-floor semantics. No new history authority for forced restart is introduced. Legacy synchronous message/history classification, including same-page `!new` visibility, remains unchanged. Final resident authority, store schema, inactive stage 893, deployment status and Windows qualification remain unchanged.

This is in-process recovery from exactly proven pre-submission policy contention. It is not a durable queue or a general no-loss guarantee after process loss, disposal, unrelated handler failure or uncertain admitted work.

## Verification

Validation uses pinned Node 24.21.0, `tools/build-test-profile.mjs`, and emitted JavaScript with `NODE_OPTIONS=--no-strip-types`. Focused checks cover actual installed consumers under singleton/shared Background contention with no subsequent event, same-lane ordering and other-lane progress, serial capped timing, original observation/source identity, exact proof refusal, periodic queued/active anti-discard and History Process deduplication, sleep/native cancellation joining, live mapping removal and exact large IDs, explicit captured limits, poisoned compatibility policy reads, pending replies and sealed/emergency control behavior. Existing message, history, journal, receipt, prompt, identity and typed bootstrap suites are included in bounded affected validation.

The protected remote-agent redaction test and known Unix root-store-authority EPERM fixture are excluded from bounded execution. No live database, secrets, external messages, publication or deployment is involved. Results below qualify this offline scope only, not the full suite, full migration, live service, crash/load, long-running production or Windows behavior.

### Checkpoint 906 writer validation

Final emitted profile: `.runtime/compiled-tests-hV8pAa`, Node 24.21.0, baseline `a697351d72be0401b39cceac23514f52ae7f9131`.

- Strict full source/test typecheck, production build and whitespace check passed.
- All 938 emitted production modules byte-match the production build. Their sorted SHA256/path graph digest is `bfeafdd75f665787d9f54f6c9713947d7e1ba04953fc2959e95565769174ec56`.
- Final focused validation: 107/107 passed across six selected files, including 57 native Gateway-message policy cases.
- Bounded affected validation: 450/450 passed across 33 additional selected files on `.runtime/compiled-tests-8UOYzg`. Every emitted file in that profile byte-matches the final profile except `test/runtime/discord-runtime/native-message-policy.test.js`, which is outside the affected selection. All selected affected tests, production modules and fixtures therefore match the final graph exactly.
- Both completed writer runs had zero failures, cancellations or skipped tests. Earlier candidate runs with test-instrumentation/assertion defects are excluded from final passing totals.

This is bounded offline verification, not a full-suite, live-service, durable/no-loss, full-migration or deployment claim.

Independent scoped review approved the source and tests with no blocking production finding. The final-profile policy invocation passed 57/57 cases, with zero failures, cancellations or skips. A separate run passed 232 tests across 14 affected suites on an earlier candidate whose relevant emitted production/test/fixture bytes match the final profile. These are separate invocations and overlap writer coverage; they are not an additional unique full-suite total. Five separately authored adversarial probes also passed on the same production graph, covering post-probe timestamp retention, mapping removal during delay, distinct failure preservation under abort, failed sleep without retry, and slow cancellation joining active/queued custody. The reviewer independently reproduced the 938-module production graph and build equivalence.
