# Checkpoint 892: native standard prompt-authority reads

2026-10-15 UTC. Installed BoundApproval/BoundInput handling now uses existing native adapters for its three preliminary prompt-authority storage reads. This closes the standard component read gap left explicitly outside checkpoint 889. It does not complete question handling or migrate the final resident response journal/authority architecture.

Baseline: 0ad540687c70fd3dc07c0d6f0704122c5ee7f138 (checkpoint 891). Five production files and two test files are frozen in .runtime/prompt-authority-final-sha256.txt. No SQL, schema, facade export, ingress payload, claim key, confirmation marker, response payload or final response hook is changed.

## Installed scope and passive observations

RuntimeCommandExecutor creates one prompt-authority read port and passes it only to the ordinary standard BoundApproval/BoundInput branch. The port is retained across interactionServices calls. Direct/default helpers, text replies, prompt redisplay/publication, AsyncChoice and recovery publication/abandonment retain their compatibility defaults. Busy handling is unchanged.

capturePromptAuthorityReads captures own data functions before the caller's first await, rejects accessors, proxies and generator functions, requires actual Promise results, and binds every invocation to the original database string. The native adapters independently pin the filesystem path at construction. Replacing functions on the supplied object cannot change an already captured port. The port neither catches nor replaces failures and supplies no mutation permission.

The installed port composes the existing NativeControlEvidenceReader through createNativeControlReads, createNativeQueueReadState.listFiltered, and createNativePromptIntakeState.mirroredThreadId. Queue reads use null target and generation filters, which invoke exactly the allJobs SQL and decoder used by listQueueJobs. Malformed unrelated queue rows therefore remain errors; they are not filtered out or converted into missing ownership. No new worker, SQL transaction, worker pool or fallback path is introduced. Existing-only opens do not create, initialize or repair missing databases/catalogs.

Each invocation remains fresh and sequential: validate the original request and initial lifecycle/active turn; read completion evidence; read all queue jobs and check the unique running original owner, goal-waiting flag and generation; read that owner's channel mapping; recheck the original generation and complete pending request identity; then check the captured actor/channel. This is the source sequence of separate observations, not an atomic cross-query snapshot or an enduring response grant. No queue owner, request, turn, generation or actor is refreshed from a newer observation after it has been captured.

## Original request and response boundaries

The installed standard flow captures the exact pending request, occurrence, method/params, response payload and generation before the native claim await. Its component and actor/channel are already snapshotted; NativeStandardClaimOwner separately captures the original routed click, raw custom ID, application/interaction/ingress IDs and source message before its first await. A changed caller work object or component cannot redirect either authority or payload.

Pre-claim request-selection errors are retained and raised only if the claim returns ExecuteAction. DeliverConfirmation still returns its durable confirmation plan when the original request is already gone, and ActionUnconfirmed keeps its existing disposition. Capturing an absent or invalid request does not turn confirmation-only recovery into action execution. Default direct callers retain their original post-claim selection timing.

An authority failure releases only the original privately owned confirmed claim. Native read failures retain their unavailable error identity within the existing component Authority wrapper; they are never laundered into empty authority, a successful response or a synchronous fallback. The existing native claim, release uncertainty barrier, response error allowlist, ready persistence and completed-action-before-confirmation rules are unchanged.

PortableResidentLifecycle.respond and its synchronous final response authority/admission/finish hooks are untouched. The preliminary native reads do not replace those hooks. In particular, source admitResponse permits an already pending response to drain when restartPending is set after the initial authority snapshot. This checkpoint preserves that behavior rather than adding a new final lifecycle refresh. Generation/current-request mismatches are still rejected, and the existing final response custody suites remain part of verification.

## Bounded ownership and cancellation

All three adapters use the existing shared Control1 lane with zero-queue read admission. They retain their original transfer/deadline bounds and join actual native exit before settlement on success, error, timeout or cancellation. They do not terminate database workers, release execution custody early, cache a successful observation or automatically retry. Existing native Release/Ready completion behavior remains on its finite completion FIFO.

Transfer and admission bounds do not bound allJobs SQL work, native memory or wall-clock latency. No performance or load qualification is claimed. Tests inject native cancellation and deadlines independently at completion, queue and mapping reads while another SQLite connection holds an EXCLUSIVE lock. Event-loop progress continues, and Control plus the original interaction admission/custody remain owned until native exit, after which no response is sent and the original claim is released.

## Verification

Pinned Node 24.21.0, TypeScript 7.0.2 and NODE_OPTIONS=--no-strip-types were used throughout. Strict no-emit, production build and whitespace checks passed. Final emitted graph: .runtime/compiled-tests-20MQzO. All seven frozen hashes matched after the production build and after the complete affected run.

The final eight-file focused run passed 135/135 tests, with zero failures, cancellations or skips (exit 0; 69.221 seconds). The 141-file affected run passed 1,574/1,574 tests across 12 suites, with zero failures, cancellations or skips (exit 0; 554.270 seconds). The affected selection extends checkpoint 891's explicit set with prompt authority, direct native queue/mapping adapter, compatibility prompt and final-response suites. It contains no protected fixture test.

Coverage includes actual installed approval and input through the real interaction worker with hasObservedCompletion/listQueueJobs/listFiltered/mirroredThreadId compatibility functions poisoned; exact read ordering; confirmation-only retries after the pending request disappears; original mutable click/component capture; wrong actor/channel; completed turns; absent/ambiguous/non-running/goal-waiting/wrong-generation queue ownership; invalid owner/channel; absent and remapped mirror rows; malformed unrelated queue rows; source-ordered changes between reads; request method/params/ID/occurrence and generation races; each adapter's unavailable result; missing databases/catalogs; passive function/path capture; Control saturation; and actual-exit cancellation/deadline custody at every read.

The initial emitted run passed 79/80. Its only failure was an incorrect new test expectation that restartPending alone would prevent final response admission after the last read. Source inspection confirmed the established response-drain contract; the test was corrected, a final-generation rejection test was added, and production was unchanged. The final candidate also adds an original mutable click capture test and uses a genuine replacement occurrence in the occurrence race test. The initial evidence is retained.

Independent read-only review found no blocking production findings, verified all seven frozen hashes, passed strict typecheck and whitespace checks, and independently passed 49/49 emitted compatibility/final-response tests. Those overlapping tests are not added to either aggregate above.

Evidence prefix: .runtime/prompt-authority-. Files include files.txt; final-sha256.txt; build-initial/tests.json and logs; focused-initial/final.tap and .exit; focused-tests.txt; affected-tests.txt; affected-final.tap and .exit; typecheck-final.log and .exit; production-build-final.log and .exit; whitespace-final.log and .exit; hashes-after-build.log; hashes-after-affected.log; and runtime-versions.json.

## Deferred scope

Final synchronous response authority/journal operations, other resident final validation, execution-custody persistence, AsyncChoice, recovery publication/abandonment, prompt publication/redisplay/text-reply native installation, startup/restart reconciliation and whole-question/whole-runtime migration remain incomplete. This is not a full-repository, Windows, live-runtime, crash/restart, load, performance or long-duration qualification.

No live database, credentials, raw operational logs, Git write, publication, deployment or operational restart was used. The protected redaction fixture was not inspected, reconstructed, modified, uploaded or selected for execution, and is not counted as a pass or skip.
