# Checkpoint 900: Native installed message-journal lifecycle

2026-10-15 UTC. Local baseline `7f205b71e56633ad833d343aaaf26e84dee2213c`; preceding published checkpoint 899 `59b4932e470c3e43711aef9bbaecbd9c556a092e`. This checkpoint contains local implementation and verification only. No commit, push, deployment, operational database or live-service work was performed.

## Installed scope

The normal gateway, sealed-drain pending reply, history-gap and history-poll paths now carry a captured, original-database `MessageJournal` port through preparation, admission, custody and processing. Its six operations are admission, processing-mode persistence, execution begin, result persistence, confirmation and hold. Mode persistence remains conditional on pending-reply-only admission.

The native worker uses existing-only store leaves. Admission and hold reuse their existing shared implementations; execution begin, processing mode, result and confirmation now have existing-only leaves sharing their original SQL bodies. The native adapter does not initialize, repair or migrate a missing or incompatible database.

Original message custody is minted only after a confirmed, newly created admission. It binds the original database, ingress key and captured port origin. The processor verifies this same origin before using it. A compatibility owner cannot be relabeled as an installed native owner. Captured callbacks and immutable source payloads survive source-object replacement across awaits.

Known cleanup-refusal result/notification-hold paths and abandonment-proposal result persistence use the same original custody callbacks in installed processing. Their direct helper defaults remain compatible. Special recovery business reads and proposal logic retain their existing implementation; only the journal lifecycle is migrated here.

## Preserved semantics

- Admission retains the original processed-message dedup transaction and immutable New reservation decisions. Exact i64 message IDs, actor/channel identity and null application identity cross the worker boundary without numeric conversion.
- Begin, mode and result retain their original transaction bodies. Result persistence preserves stop acceptance, New creation/verification/input evidence and original cancellation precedence.
- Confirmation deliberately retains two separate connections: first-reply receipt validation, then the ingress outcome update. This is not a new atomic acknowledgement guarantee.
- Pending text replies retain the original sequence: resident response, saved `pending_reply` result, exact pending-confirmation receipt, then ingress confirmation. Final resident response/occurrence/generation/turn guards are unchanged.
- Malformed, missing, foreign-path, foreign-identity or lost acknowledgements remain unconfirmed. No resident response, command, New creation or HTTP receipt is automatically replayed. Duplicate original messages remain deduplicated after uncertainty.
- A successfully persisted confirmation suppresses disposal hold. Other paths join required hold persistence, preserving known-result versus not-executed versus uncertain-outcome classification.

## Bounded ownership and cancellation

Fresh admission, mode and execution begin use the shared zero-queue Control lane. Existing prompt authority reads remain separately joined zero-queue operations. Public journal mutations cannot enter the completion FIFO. Only an admission-minted private original custody owner can queue its result, confirmation or hold in the existing finite Control completion FIFO. No new worker pool or fallback executor was added.

Every accepted native operation joins actual worker exit before releasing its ownership. Deadline or cancellation does not turn a still-running SQLite operation into a released permit. Disposal joins the in-flight transition, then its required hold, before the outer message/history/drain permit can be released.

Cancellation is rechecked after execution begin and immediately before command dispatch, so cancellation while native persistence is blocked cannot start a new business action. An already accepted resident result or HTTP confirmation is still persisted. Known cleanup refusals retain their outcome before any cancelled notification. An accepted abandonment proposal receipt retains its exact delivery binding and journal result; this adds no post-cancellation HTTP, decision or execution. The existing outer cancellation boundary still propagates after required persistence joins.

These are finite queue, packet and deadline policies, not throughput, native-memory, SQL-work or wall-clock latency guarantees.

## Verification

Pinned Node 24.21.0 and TypeScript 7.0.2. Tests are emitted with `tools/build-test-profile.mjs` and executed as JavaScript using `NODE_OPTIONS=--no-strip-types`.

- Strict source/test typecheck: passed.
- Production build and whitespace check: passed.
- All 935 production JavaScript modules match the final emitted test graph byte-for-byte.
- Final focused suite: 73/73 passed, zero failures, cancellations or skips.
- Final bounded affected suite: 1,410/1,410 passed across 146 selected files, zero failures, cancellations or skips (624 seconds).
- Independent read-only review: 125/125 affected tests plus four adversarial checks passed; no remaining blocker identified within this checkpoint. These overlapping checks are not added to aggregate counts.

The focused tests cover poisoned installed compatibility lifecycle methods; gateway/drain/gap/poll propagation; exact large IDs and receipt keys; payload/port mutation across awaits; protected original New decisions; zero-queue saturation; finite completion FIFO saturation; locked native exit with retained permits; cancellation before action dispatch and after accepted response/receipt/proposal; no automatic replay after lost ACK or unknown response; foreign path/application/operation/identity acknowledgements; missing-store refusal; original evidence/cancellation preservation; first-reply confirmation guards; and native cleanup-refusal/abandonment persistence.

Evidence is retained under `.runtime/checkpoint-900-*`: exact graph metadata, selected test files, initial and final results, typecheck/build/whitespace logs, production parity and SHA256 manifests. Initial evidence includes one test-only assertion error (17/18 pass), followed by 41/41 and 64/64 passing focused checks on intermediate graphs. Independent review found and corrected a post-begin cancellation gap, missing path/application acknowledgement binding, mismatched port-origin custody acceptance and reachable special-branch compatibility lifecycle writes. Final results apply only to the final frozen candidate.

## Explicit exclusions and limits

The protected redaction fixture was not read, reconstructed, executed or uploaded. The known UNIX-root `test/runtime/discord-runtime/store-authority-profile.test.ts` fixture is explicitly excluded from bounded affected validation because of its previously established `listen EPERM` environment failure. It was not retried or escalated.

This is not full-suite, Windows, load, performance, crash/restart or live-runtime qualification. Classification, attachment preparation, special recovery business reads, other message receipt families and final resident response authority remain outside this lifecycle migration. Checkpoint 893 accounting WIP is not enabled as an exclusion mechanism. No schema, receipt domain, original claim identity or resident response payload was changed.
