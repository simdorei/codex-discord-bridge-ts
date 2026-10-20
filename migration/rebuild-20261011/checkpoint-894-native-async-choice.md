# Checkpoint 894: native ordinary AsyncChoice dispatch

2026-10-15 UTC. The installed ordinary AsyncChoice handler now performs its question reads, mapping checks, claim, dispatch guard and outcomes through one executor-owned native persistence owner. The slice also enables its exact existing confirmation-receipt domain. Migration and whole-runtime qualification remain incomplete.

Baseline: d57cc95160121cb5c7b11b918f0c993aad7cdcfe. Seventeen production/test files are frozen in .runtime/async-choice-final-sha256.txt. The manifest SHA256 is 77328db425d28ef3097908bb5ac265a8de3cd29961258cbe3a0b3fee29cc136b. Final emitted graph: .runtime/compiled-tests-47njQH. Checkpoint 893 remains inactive opt-in WIP, with its existing qualification and independent-review blockers unchanged.

## Original occurrence and native ownership

NativeAsyncChoiceOwner is created once by RuntimeCommandExecutor and shared across interactionServices calls. Its private handle captures the routed original click, application, exact bigint interaction and ingress identity, actor, channel, source message, custom ID, question ID and option. Its first scalar read captures the immutable question occurrence: runtime, generation, original thread and turn, item and originating job, actor/channel/message and complete question body. The second scalar read cannot substitute a changed occurrence. An explicit fresh interaction may retry the same original question and option, but its own interaction identity remains exactly bound in that operation's transport.

Each closed worker request and acknowledgment carries the operation UUID, pinned database path, click primitives, canonical question bytes and operation-specific claim or completion bytes. Bigints stay bigints and question bytes are not truncated. The whole request/reply budget is 1 MiB, question/claim/detail string bounds are finite, and errors retain the source's 1,000 Unicode-scalar bound. These are transport limits, not guarantees about native SQLite memory, SQL work or throughput. Missing databases and incomplete schemas are never initialized, created, migrated or repaired.

Reads and Begin use zero-queue Control admission. Only private already-owned Confirm/Reject/Error operations enter the existing finite Control completion FIFO. Every admitted operation, timeout, cancellation and owner close joins actual worker exit. A blocked worker retains Control capacity and the surrounding original-target lock; ordinary JS timers remain responsive. No extra pool, worker termination, synchronous fallback or retry loop was introduced.

An admitted mutation without an exact joined acknowledgment establishes an owner-wide unknown barrier. Crossed, malformed and lost Begin/Confirm/Reject/Error acknowledgments cannot mint action permission or release a reservation. Fresh mutations and later dispatch guards are blocked. An explicit same-original retry reads only durable state: only submitted plus the same chosen option can recover its display confirmation. Open, dispatching or otherwise uncertain state cannot reclaim or resend. The barrier is runtime-local and is not crash/restart reconciliation. A completion for a different private claim already owned before the barrier still records its exact known outcome; doing so never clears the original barrier.

## Source order and unchanged SQL transactions

Installed order remains get → original-target lock → second get → original actor/channel/message/option checks → separate mapping reads → submitted/ConfirmationOnly/open handling → original preflight → answerPrompt → durable claim → mapping → identical repeated preflight → dispatch guard → existing PortableResidentLifecycle.execute → outcome persistence → delivery notification → lazy confirmation.

The initialized compatibility APIs and new existing-only APIs share the same SQL bodies and decoders:

- Get uses the existing scalar/body decoder and adds no transaction.
- Mapping retains its separate scalar reads and is not converted into a combined snapshot.
- Begin retains IMMEDIATE: reread question, mapping, decode all jobs before filtering, reserve a quarantined Start reply job if needed, write dispatching/chosen, seal, read back and commit atomically. The native path additionally compares the captured immutable occurrence inside this same transaction.
- Guard reuses validateAsyncDispatchGuardsExisting, with its original DEFERRED rollback-only scope and seal verification.
- Confirm retains IMMEDIATE: original occurrence and seal verification, exact accepted-turn checks, Start-job promotion and submitted-state commit atomically.
- Definite rejection retains IMMEDIATE: original occurrence/seal verification, exact reserved-job deletion and rejected state.
- Error retains its original bounded scalar autocommit update, without a new read or transaction.
- Usage-limit rejection remains the definite-rejection alias and does not enter Reserve policy.

Original preflight, accepted-turn classification and final synchronous lifecycle/write authority are unchanged. Unknown app-server acceptance remains dispatching and retains a quarantined Start reservation. Wrong or missing accepted identity cannot become submitted. No question publication, recovery branch or broader facade export was changed.

## Confirmation-only delivery

PreparedOrdinaryComponentConfirmation and NativeCompletionReceiptStore now accept exactly async-question-confirmation-v1 alongside their prior ordinary domains. The original question ID remains the logical key, with null guard and chunk 0. No other recovery or question-publication domain was enabled.

The installed processor records completed-action custody before success HTTP begins. Durable POST receipt confirmation precedes the original source-message PATCH. A confirmed receipt retries only clearing; validated 429 rejection preserves its retry disposition and nonce; unknown delivery or receipt outcomes prevent resending. A prepared confirmation retains no callback capable of replaying the action.

## Verification

Initial expanded native, existing-only store, receipt and inventory graph CnlkaJ passed 69/69 tests, zero failures, skips or cancellations (40.061 seconds). The final graph adds explicit cancellation and owner-close join coverage and exercises async-question receipt 400/503 disposition. Strict no-emit, production build and whitespace checks pass on Node 24.21.0 and TypeScript 7.0.2, with NODE_OPTIONS=--no-strip-types. All 17 source/test hashes match after the build.

The preliminary 37IvJh focused graph passed 550/551; its sole failure was a pre-migration assertion expecting the AsyncChoice compatibility receipt path. The fixture now asserts the authorized native-domain migration while retaining historical submitted-question behavior. The final source delta also pins owner prototype calls consistently with Standard/Busy and includes a hostile-subclass regression. Earlier evidence is preserved as async-choice-focused-preliminary.log/.exit and async-choice-initial-sha256.txt.

Final focused emitted verification passed 552/552 across 36 explicit test files, zero failures, skips or cancellations (exit 0; 260.649 seconds). Final affected emitted verification passed 1,595/1,595 across 143 explicit test files and 12 suites, zero failures, skips or cancellations (exit 0; 586.757 seconds). All 17 frozen hashes match after both complete runs. Independent read-only review found no remaining findings after the owned-completion and prototype-pinning fixes. Its four targeted final-delta tests passed on 47njQH, and it independently verified all 17 final hashes and clean whitespace. Those overlapping checks are not added to the focused or affected count. No full-suite or live-runtime pass is claimed.

Evidence prefix: .runtime/async-choice-. Files include files.txt, final-sha256.txt, focused-tests.txt, affected-tests.txt, focused-final.log/.exit, affected-final.log/.exit, typecheck-final.log/.exit, production-build-final.log/.exit, whitespace-final.log/.exit hashes-after-build.log, hashes-handoff.log and runtime-versions.json. Final emitted graph: .runtime/compiled-tests-47njQH.

No Git write, publication, live database, credentials, raw operational logs, deployment or restart was used. The protected remote-agent redaction fixture was not inspected, reconstructed, modified or selected for execution and is not counted as passed or skipped. Windows, cross-restart reconciliation, performance qualification, checkpoint 893's blockers and whole-runtime readiness remain unqualified.
