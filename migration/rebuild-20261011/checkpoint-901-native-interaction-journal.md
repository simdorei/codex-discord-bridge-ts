# Checkpoint 901: Native installed interaction-journal lifecycle

2026-10-15 UTC. Local baseline `6584b92319b94115030886e1c34017cae7afd5a6`; preceding published checkpoint 900 `b32f4e1189ba168f736d0d7f0d7643dc822ba13d`, tree `ddedf1c5bc84f4a058d4ebaae2e28acf3e28ec65`. This checkpoint contains local implementation and verification only. No commit, push, deployment, operational database or live-service work was performed.

## Installed scope

The ordinary interaction ingress bootstrap, handler, dispatcher, staging custody, interaction execution bootstrap and worker now carry a captured original-database `InteractionJournal` port. Installed admission, pre-ACK recovery authorization, ACK persistence, execution/confirmation begin, journal reads, result persistence, confirmation and hold use the native worker. Compatibility adapters remain available for direct callers but are not the installed lifecycle authority.

Mapped-slash admission, Busy admission, ACK persistence and confirmation-only begin now have existing-only wrappers sharing the original store bodies. Mapped lookup remains inside the original IMMEDIATE transaction. Busy retains receipt, canonical-parent and active-choice precedence, actor/channel checks, frozen choice/action and original admission proof. ACK persistence and confirmation begin retain their original single-statement boundaries; confirmation-only begin retains its owned/canonical-duplicate/prompt restriction. Execution begin, result and confirmation reuse checkpoint 900's existing-only leaves. Confirmation still uses two separate connections rather than a newly atomic transaction.

Pre-ACK abandonment and publication authorization execute their original narrow store reads in the native worker. Abandonment retains both original clock reads; delivered publication retains historical routing even after ordinary intent expiry. The reply is only the authenticated target needed for staging. It does not transport a cloned proposal instance or reuse post-admission recovery ownership as pre-ACK authority.

Installed cleanup paths use the same original execution owner, including `finishNotification` and cleanup-refusal delivery through `recordCleanupNotificationFailure`. Known cleanup outcomes are retained before notification hold. Special-action owners and receipts are reused without rebuilding their authority model.

## Original identity and native acknowledgement

Each native reply is bound to the operation, exact database path, ingress/event/application/channel/user/source-message identity, original port origin, owner kind and per-call request identity. Bigint identities are not converted through floating point. Full stored-ingress decoding is reused, including payload, route, lifecycle, seal and evidence. Non-null Read replies must match both interaction kind and the full requested identity; a structurally valid foreign row is unavailable rather than authoritative.

Private original staged custody is minted only after confirmed Created admission. Private original execution custody is minted only after confirmed execution or confirmation-only begin. Both bind their original captured port and ingress identity. Interaction completion privilege is separate from private message custody privilege. Arbitrary callers cannot turn public journal methods or compatibility owners into private completion owners.

Execution retains the two ordered realpath checks and permits same-file symlink aliases while rejecting different stores. Only a private helper may rebind native execution to the validated canonical file; callers cannot supply an arbitrary canonical path and preserve the original port origin. The original execution clock is read after those checks. The canonical native target stays pinned even if the worker-path symlink is subsequently retargeted.

Malformed, crossed, late, missing and lost acknowledgements do not create a successful admission or authorize replay. A native transition that may already have committed is joined before the caller observes failure. Later disposal records the appropriate hold through original custody without replaying a command, result or HTTP response.

## Bounded ownership, deadlines and saturation

Fresh staging, pre-ACK authorization, Read and Begin use the shared zero-queue Control lane. Only the original private staged owner may use the finite completion FIFO for its required ACK or hold; only the original private execution owner may use it for required result, confirmation or hold. Public journal mutations cannot acquire this privilege. Packet size and operation deadline limits remain bounded, and no worker pool or fallback executor was added.

Every accepted native operation joins actual worker exit before disposal, handoff or outer permit release. Cancellation while SQLite is blocked retains the permit through the original operation and required hold. An unknown outcome is not converted into Created, retried or silently enqueued.

Dispatch retains stage, reservation, Discord ACK, durable ACK, claim commit and handoff order. The original `receivedAt + 2500` deadline is never reset, including after native ACK exit; an overdue request is held without a new ACK or enqueue. Queue-full handling persists hold before its status ACK. Result persistence still precedes success HTTP. Original conditional rejection checks, settings, lifecycle, seals and command evidence remain in force. Busy canonical-ingress repeats retain manual-review disposition, while canonical prompt repeats retain confirmation-only behavior.

A provably unsubmitted fresh native admission refusal has a private capacity brand. The dispatcher alone maps that brand to event-local Capacity reporting, so a refused overlap cannot abort another accepted normal-lane handler. Arbitrary or forged budget errors, admitted failures and unknown custody errors remain fail-closed custody failures. This is a refusal policy, not a new queue or replay policy.

The original typed-ingress happy-path fixture now waits for prefix completion before asserting a second successful slash request. Separate deterministic regressions exercise real overlap: a held native admission causes the second slash request to receive no ACK, enqueue or journal row, reports one capacity refusal, and allows the accepted first request and a later third request to complete. This is verified both within the actual Normal interaction lane and across the actual typed prefix-message/interaction consumers.

These are finite queue, packet and deadline policies, not throughput, native-memory, SQL-work or wall-clock latency guarantees.

## Verification and exact candidate

Pinned Node 24.21.0 and TypeScript 7.0.2. Tests are emitted with `tools/build-test-profile.mjs` and executed as JavaScript using `NODE_OPTIONS=--no-strip-types` and test concurrency one.

- Strict source/test typecheck: passed.
- Production build and whitespace check: passed.
- All 937 production JavaScript modules match the final emitted test graph byte-for-byte.
- Final focused native/execution/installed suite: 39/39 passed, zero failures, cancellations or skips.
- Final bounded affected suite: 466/466 passed across 46 selected files, zero failures, cancellations or skips (147.2 seconds).
- Independent read-only review on the same final graph and pinned Node: 371/371 affected tests across 33 files plus five adversarial checks passed, with no remaining scoped blocker. These overlapping checks are not added to aggregate counts.

The final emitted graph is `.runtime/compiled-tests-dqwytY`. The 25-file source/test candidate is frozen by `.runtime/checkpoint-901-source.sha256`; SHA256 of that standard checksum manifest is `8135b203a6b81f44ced50b7fea33e3c621a72467ee3da0d55805ab875210fc1a`. The independent review's alternate encoding (sorted path, NUL, individual SHA256, newline) yields `218d58adbc129c353f3b721b0806ae82cc12f58e18f3a9028a630bb15c87d158`. The checkpoint document is added separately after source/test freeze.

Coverage includes poisoned installed facade methods; exact large identities and captured inputs; mapped admission and Busy canonical repeats; original recovery authorization; zero-queue and finite FIFO refusal; locked worker exit and cancellation with retained permits; original deadline checks; queue-full hold-before-status-ACK; lost Admit/Result/Confirm ACK without replay; crossed operation/path/application/owner/request identity; foreign Read rows; result commitment after deadline; cleanup known-outcome holds; exact conditional rejection; original Stop/New evidence; same-file symlink acceptance, different-store refusal and post-validation symlink retargeting; and both real overlap regressions.

Independent review identified three substantive gaps in intermediate candidates: fresh saturation fatally cancelled another accepted handler, Read could decode a foreign row under a correct outer envelope, and an exported arbitrary canonical rebind could preserve the wrong port origin. Each was corrected and tested before the final frozen graph. Earlier test-only expectations and fixture adjustments are not presented as production evidence. Intermediate graph results remain separate from final results.

Evidence is retained under `.runtime/checkpoint-901-*`: source manifest and graph binding, selected files, final and intermediate test results, strict typecheck/build/whitespace logs, production parity and final deliverable hashes. Store-worker inventory expectations include both checkpoint 900's message worker and this interaction worker; that accounting change does not enable resident exclusion authority.

## Explicit exclusions and limits

The protected redaction fixture was not read, reconstructed, executed or uploaded. The known UNIX-root `test/runtime/discord-runtime/store-authority-profile.test.ts` fixture is explicitly excluded because of its previously established `listen EPERM` environment failure. It was not retried or escalated.

This is not full-suite, Windows, load, performance, crash/restart or live-runtime qualification. Live mirror-policy work remains separate. No schema, special-action receipt domain, original claim identity, final resident response authority or checkpoint 893 activation is introduced. The broader TypeScript migration remains incomplete.
