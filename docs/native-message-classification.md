# Native installed message and history classification

Checkpoint 907 moves the installed per-message classification read sequence into one existing-only native operation. Prepared Gateway messages and prepared history each require explicit, separately captured `messageClassificationLimits` and `historyClassificationLimits`. Prepared typed ingress installs both profiles. Local startup supplies 4096 selected rows, 4194304 selected value bytes, 4194304 complete output bytes and a 10000 ms deadline. Direct callers retain the compatibility classifier unless they explicitly supply `classifyMessage`.

## Conditional source semantics

The owner captures the decoded immutable original, configuration and mention IDs, authenticated access flags, database path and callback before submission. Message and channel IDs must fit nonnegative SQLite i64. The authenticated actor remains u64 until a selected branch needs i64.

The worker performs the original ordered sequence:

1. Read the complete `NewThreadOrigin`, even when policy will later Ignore the message. Its version, channel, target, mapped project, parent channel, project, parent project and entire SQL-ordered chat-target vector are preserved, including nulls and exact bigint values.
2. Only for an unmapped human non-command with required mentions and none present, convert the actor to SQL i64 and read the pending new-prompt arm. The query selects the latest arm first and then evaluates consumption and event ordering. It never falls back to an older available arm.
3. Run the shared pure message planner. Malformed prefix commands remain candidate errors for later durable custody. They do not reject classification.
4. Only a successful human `Execute.DiscardRequest` performs the held-job abandonment routing read and actor i64 conversion. The returned target must equal the original route. No proposal is written during classification.

Origin, arm and abandonment remain separate observations/connections in that order. Origin and abandonment retain their own transactions; the arm retains its single SELECT. There is no eager prefetch, combined atomic snapshot, page classification batch or extra mapping fallback. Native existing-only origin and arm helpers reuse the legacy borrowed SQL and decoders, validate current schema compatibility and never initialize, migrate or create a missing database. The existing abandonment API remains read-only.

History continues oldest-first classify → bind → admit → process for each message before touching the next one. A same-page `!new` is therefore visible to the next prompt, consumption remains authoritative, and a mapping change cannot silently retarget it.

## Bounds and ownership

One zero-queue Control submission uses the existing global one-Control/eight-total worker budget. No new pool, FIFO, payload queue, retry queue or admission budget is introduced. The shared selected-row/value budget covers the selected origin rows, optional arm row, abandonment route, conditional held-policy/obligation/lifecycle/legacy witness reads and final exact mapping check. Value accounting includes native text/blob decoder evidence; fixed schema/catalog compatibility reads are outside this data budget. Bounds fail the complete operation rather than truncate a list or return partial policy. One native SQLite row may already be materialized before checking it; these are output/selected-data bounds, not hard SQLite scan, heap or process RSS guarantees. Captured planner input has a separate 4194304-byte transport ceiling.

The worker returns bounded plain data only. The owner validates exact fields, complete output bounds, bigint/null/vector shapes, original channel and selected branches, then reruns the same pure planner to reconstruct exact `MessagePlanError` and `PrefixPlanError` prototypes. The candidate's constructor token and single-use execution custody remain private on the owner. Settings binding, durable admission and effects remain downstream and independently authoritative.

Timeout and cancellation await actual native exit. They do not terminate blocked SQL to simulate a join or release the Control slot early.

## Precisely scoped capacity recovery

Only the exact `OwnedWorkerSlot.run` Promise with the private actual-unsubmitted admission-refusal proof can produce classification capacity evidence. The classifier binds it to its own exact returned Promise and error, consumed once. Public names/classes, forged errors, wrong/wrapped Promises, consumed proofs, old errors replayed through a different invocation, admitted worker failures, SQL/decode/budget failures, timeouts and cancellations never authorize retry.

Gateway preparation consumes proof only around the classifier await and separately binds it to the exact preparation Promise. The existing checkpoint 906 loop retries that same accepted immutable original with its first observed timestamp, fresh drain/pending-text probe and fresh dynamic policy. Its identity guard, 1/2/4/8/16/30-second serial capped delay and checkpoint 905 accepted-original anti-discard custody remain unchanged. Settings and journal refusals are not reclassified as classifier contention.

History consumes proof only around the classifier await. The channel adapter recognizes only its own private refusal as the immediate source of the runner's `HistoryPollRunError('Claim', source)`; it never recursively inspects arbitrary causes. The exact channel Promise gets a single-use proof consumed by the existing fair sticky-gap pass. Earlier successfully processed page messages deduplicate on a later pass, later channels are still visited, and retries use fresh revision/source-floor snapshots. Periodic history retains its normal cadence, original Prime boundary and no-cursor-on-failure behavior.

## Scope and verification

Final resident authority, store schema, inactive stage 893 and deployment status are unchanged. This does not move all message/history SQL off-thread: periodic processed-marker Discard and post-admission abandonment routing/proposal/binding remain outside this slice. Downstream Control contention is not a general retry mechanism. In-process capacity recovery is not a durable/no-loss guarantee after process loss or an uncertain admitted operation.

Validation uses pinned Node 24.21.0, the emitted `tools/build-test-profile.mjs` graph and `NODE_OPTIONS=--no-strip-types`. A private compiler profile excludes exactly `test/remote-agent/redaction.test.ts` without opening it; production build excludes all tests. The protected test and known Unix root-store-authority EPERM fixture are never run or retried. No live database, credentials, external messages, uploads, Git writes or deployment are involved. Passing checks qualify bounded offline source/test behavior only, not the full suite, Windows, live service, crash/load or long-running production.

### Checkpoint 907 writer verification

Final emitted profile: `.runtime/compiled-tests-gb7t4T`, pinned Node 24.21.0, baseline `d787bce10454cc635eb4523a9cc8276ba3b91049` (tree `a017dbeb816a58329c46263c18328a70c7166d44`).

- Strict source/test typecheck with the exact protected-test exclusion, production build and whitespace check passed. This is not an all-test typecheck claim.
- All 943 emitted production modules byte-match the production build. The sorted SHA256/path graph digest is `7e0e98668341d436a8a127fa88077072195eb303576e690ec2431e5317a2a38f`.
- Final focused validation passed 171/171 tests across six selected files on the final profile.
- Bounded affected validation passed 425/425 tests across 39 additional selected files on `.runtime/compiled-tests-hQKUrg`. Every selected test, production module and fixture byte-matches the final profile. The only emitted-JavaScript difference between these profiles is the focused installed-classifier test file, where one final fair-pass test was added.
- Both completed writer runs had zero failures, cancellations or skipped tests. Earlier candidate runs with test-fixture/instrumentation failures are excluded from final passing totals.

Independent scoped review found no blocking production issue. Its seven-suite final-production-graph run passed 119/119 with zero failures, cancellations or skips, and twelve independently authored adversarial probes passed on the same graph. These overlap writer coverage and are not an additional unique full-suite total. Independent probes cover path pinning across working-directory changes, separate origin/arm observations, semantic output rejection, precise plan-error/capacity behavior, worker-response root fields/accessors/proxies and branch-specific actor range defense. The reviewer independently reproduced production graph/build equivalence.

Evidence, exact selections, compiler exclusion and logs are in `.runtime/classification-907/`. The evidence qualifies only the bounded offline scope described above.

Checkpoint 908 subsequently moves the installed post-admission abandonment routing/proposal/receipt/binding flow into [native original-message proposal custody](native-abandonment-proposal.md). Periodic processed-marker Discard remains synchronous and outside that offload.
