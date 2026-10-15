# Native original-message abandonment proposals

Checkpoint 908 moves the post-admission saved-request abandonment proposal flow off the main runtime thread when the original message was admitted through the installed native message journal. Prepared Gateway and history paths already install that private journal profile; no caller-controlled native flag or public binding handle grants completion authority. Direct compatibility helpers retain their original behavior.

## Original custody and ordering

The created-admission `OriginalMessageJournal` proves the exact database and ingress identity. One private native owner may be minted per journal, including after refusal or an unconfirmed outcome. The decoded immutable human message, event/channel/actor/application IDs, job UUID, exact content, proposal UUID and pinned database path are captured before native work. Each operation captures its timestamp and independent request ID before submission. Requests and acknowledgements have exact own-data fields and lossless bigint identities.

The owner performs:

1. Zero-queue native Route using the existing held-job routing reader. The classifier's earlier target is not final proposal authority.
2. Acquisition of the existing main-runtime `ControlTurnVerifier` target lease with the original two-second deadline.
3. Zero-queue native Prepare under that retained lease. It repeats routing and rejects a changed target, checks the exact original ingress using `getIngressExisting`, then calls the unchanged `proposeAbandonment`. These remain separate observations followed by the original IMMEDIATE proposal transaction, snapshot, revision, immutable-seal and final-freshness checks.
4. Original proposal receipt delivery. The exact `recovery-abandonment-proposal-v1` domain uses the original channel, `proposal-id:revision`, null guard, part zero and body-plus-components hash. The existing receipt state machine reuses Delivered, refuses Unknown without sending, rejects content conflicts and records definite rejection separately. Begin has zero queue; accepted confirmation/rejection persistence uses the existing completion FIFO.
5. Native Bind through the existing accepted-completion FIFO. Before calling unchanged `bindAbandonmentDelivery`, the worker reads the retained immutable proposal and exact receipt row, verifies the original proposal/ingress/job/target/channel/actor/application/revision/review hash and derived receipt body/components hash, and requires the original confirmed message ID. A transport ID or UPDATE changes count alone is insufficient. This readback remains separate from the unchanged IMMEDIATE binding transaction and its repeated freshness and retained-row checks.
6. Original-message Result and Confirm persistence before releasing the retained target lease and admission permits.

The private cloned admission permit survives asynchronous work. Target ownership, native worker registrations and accepted Gateway-original membership are retained until actual native exit and required completion. Known HTTP acceptance keeps receipt confirmation, Bind, Result and Confirm uncancelled. A cancellation never turns a pending native exit into a completed join.

## Uncertainty and capacity

Route, Prepare and receipt Begin use the existing one-Control/eight-total budget with no new pool or queue. Only already accepted original completion uses the existing 128-entry FIFO. There is no post-admission retry loop, second proposal, automatic resend or binding retry; 906/907 pre-admission retry proofs do not apply.

An admitted timeout, cancellation, missing/duplicate/crossed/malformed acknowledgement or worker failure is unconfirmed after actual exit. The owner retains its original UUID, ingress and receipt identity and cannot be reconstructed for the same journal. A missing proposal acknowledgement authorizes no HTTP. An uncertain HTTP/receipt outcome authorizes no resend. A missing binding acknowledgement authorizes no second binding or fresh proposal. No database worker is terminated to simulate joining.

Once Prepare was actually submitted, failures from that private original flow are logged at the shared message error boundary without sending another-key ERROR message. This includes proposal, HTTP, receipt, Bind and accepted Result/Confirm uncertainty. Fresh pre-submission Route/Prepare failures and unrelated ordinary message errors retain their existing reporting behavior. Required original-ingress hold persistence remains active.

Shared native receipt storage now binds acknowledgements to an exact request nonce, path, key, content hash, guard, operation and operation fields. Its result variants reject extra/missing/accessor/proxy/nonplain fields. The existing 16 MiB reply ceiling is retained and requests are also bounded; this does not narrow previously supported receipt domains or change their SQL state machines.

## Bounds and exclusions

Proposal transport is bounded to 262144 request bytes and 524288 reply bytes. Existing evidence limits remain 128 rows per page, 393216 snapshot bytes, 131072 original source/prompt bytes and 524288 seal bytes. These are selected evidence/transport bounds, not hard SQLite scan, allocation, heap or process RSS guarantees.

The worker is registered as an original-path potential writer through the existing accounting mechanism. The closed inventory is now 82 modules, 48 potential writers. Baseline 907 already had 81 modules and 47 potential writers; its old inventory test still asserted 80 modules and is corrected here. Scheduling, registration, native-exit accounting and completion-FIFO capacities are unchanged.

There is no queue start, abandonment decision, request cancellation or policy release in this slice. Store schema, final resident authority, inactive stage 893, deployment status and Windows qualification are unchanged. Periodic processed-marker Discard remains synchronous: accepted-original membership and current gap fencing stay adjacent to its INSERT under the original transaction, with no await or cached substitute.

## Verification

Validation uses pinned Node 24.21.0, a private compiler profile excluding exactly `test/remote-agent/redaction.test.ts`, emitted JavaScript and `NODE_OPTIONS=--no-strip-types`. The protected file is never read, compiled, executed or reconstructed. The known Unix root-store-authority EPERM fixture is excluded and not retried. Production build excludes all tests.

Focused coverage includes installed Gateway/history dispatch with poisoned compatibility route/proposal/ingress/bind/receipt functions, exactly one POST and confirmed original result, immutable identity and forged-owner rejection, full request ACK mutation and size/type bounds, receipt reuse/Unknown/conflict/rejection, receipt hash or message mutation during/after HTTP, mapping changes across asynchronous boundaries and lock waits, zero-queue saturation, no outer retry, SQLite writer stalls/deadlines, lost ACK after commit, enrolled worker lifetime, accepted-delivery cancellation and queued Bind. Installed shutdown/force/identity-conflict tests retain accepted Gateway originals, permits and target leases through actual Prepare/receipt/Bind exit. Existing 905 Discard/custody, store abandonment, component recovery, native journal and receipt regressions remain in the bounded affected selection.

This is bounded offline verification, not a full-suite, full-migration, live-service, crash/load, durable no-loss, long-running production or Windows claim. No live database, secrets, external messages, Git writes, uploads or deployment are involved.

### Checkpoint 908 writer verification

Final emitted profile: `.runtime/compiled-tests-Jh5KaO`, pinned Node 24.21.0 and TypeScript 7.0.2, baseline `95bac3cca7e1c5d8052ce1ad6b2aeb9bdcb6e2d7`.

- Strict source/test typecheck with the exact protected-test exclusion and production build passed. This is not an all-test typecheck claim.
- All 947 emitted production modules byte-match the production build. The sorted SHA256/path graph digest is `e8998800588780ee3eea452b02ee5d0e87d9c2135171648ff6ede921e6563844`.
- The exact focused and bounded affected selections, final run results and changed-file hashes are recorded under `.runtime/abandonment-908/`. Initial failed fixture instrumentation and the stale inventory assertion were corrected; their runs are not substituted for final verification.
- Final focused validation passed 116/116 tests across five selected files; final bounded affected validation passed 572/572 across 41 additional selected files. Both ran the final emitted graph with zero failures, cancellations or skips. The selections are `focused-tests.txt` and `affected-tests.txt`; final logs are `focused-frozen.tap` and `affected-frozen.tap`.
- Whitespace checks passed for all 17 changed/new files. The final source/test freeze, full changed-file freeze and production graph manifests are retained with the validation results.
- Independent scoped review found and prompted fixes for same-original owner reconstruction, exact receipt retained-row evidence, diagnostic-only handling after proposal submission and inert Proxy rejection. Final independent review approved this bounded scope: the reviewer passed 320/320 tests across 15 selected suites and eleven adversarial probes on the final graph, with zero failures, cancellations or skips; independently reproduced all 947 production modules and 18 copied fixtures; and verified the strict excluded-profile typecheck and whitespace check. These reviewer-reported command results and exact selection are recorded in `independent-review.json`; no local reviewer log files are claimed. These separate checks overlap writer coverage and are not an additional unique full-suite total.
