# Native response completion — checkpoint 931

Status: narrow installed post-effect persistence slice, independently reviewed on 2026-10-16. The final synchronous-guard and broader migration qualification gates remain incomplete.

## Installed ownership and persistence

`startRuntimeResident` installs `NativeResponseCompletionOwner` through the separate `nativeResponseCompletion` capability. `ResponseAttempt` synchronously captures its already-owned original claim into an opaque receipt before writer admission. The owner privately retains the exact runtime, resident, generation, request ID and occurrence bytes, request metadata, captured authority, and response payload. Capture performs no database operation and grants no permission to write.

Original authority capture, synchronous `beginResponse`, target/admission checks, final validation-to-native-write ordering, and legacy synchronous `ResponseFence.finishResponse` remain intact. The installed path explicitly awaits `finishOwned`; it never falls back to the legacy completion hook. Only an admitted attempt with a definitive pre-start `not_sent` or an observed successful `flushed` outcome submits completion. Started-wire uncertainty submits none. The existing identity-matched caller-cancellation bypass before finish is preserved.

Completion accepts only that owner's unused receipt. Copied, foreign, consumed, and closed-owner receipts cannot authorize settlement. A valid receipt is consumed before submission. The dedicated worker invokes `StateAccessFacade.finishResponseCustody`, retaining the original `finishResponseCustodyOn` identity/hash checks, current-runtime checks, IMMEDIATE transaction, and terminal-row preservation. No selected-target substitution, fresh authority capture, new SQL transaction policy, or replay is added. The ACK's correlation ID identifies this worker invocation; it creates no execution authority.

Completion uses the existing Control lane and bounded completion FIFO. Defaults remain one Control worker, a 128-entry completion FIFO, and a 5,000 ms completion deadline. No additional queue or pool is introduced. The original response Value behavior is preserved, including payloads larger than one MiB; this slice establishes no new response heap-size qualification.

The original caller signal reaches the completion wait. Cancellation, timeout, worker failure, absent ACK, or invalid/foreign/repeated ACK produces an Unknown result. A worker can have committed before its ACK is lost, so the stored row may already be `flushed`; the caller must not infer rollback, synthesize `not_sent`, or retry the effect. A late ACK cannot change that result to success. The workflow retains its target and resident admission through actual native worker exit and cleanup. Terminal shutdown joins these workflows and the native owner before completing resident exit settlement.

## Verification

Author and independent reviewer each passed the same frozen profile:

- Pinned Node 24.21.0, explicit `--no-strip-types`, and TypeScript 7.0.2 CLI
- Strict selected compile: 314 files, with the actual compiler file list audited against the guarded explicit dependency graph
- Selected tests: **129 passed; 0 failed, cancelled, or skipped**, across 11 explicit test roots
- Source-only strict compile: **301 modules**, with byte-identical emitted JavaScript against the selected-test build
- Source graph SHA-256: `89acce707b2a277fa6146e03b5354de9d821c81e4492fb064c0388e33c4671f8`
- Emitted graph SHA-256: `83f4f637abe1bbded2a8289df9d6b19235bf6966dc13f52a44465294aa5390da`

The profile covers response attempts/clients, synchronous and owned-preflight writers, resident lifecycle/native dispatch, response custody, existing native mutation ownership, runtime resident startup, the new native completion owner, and the real installed response path. Fixtures use disposable SQLite stores and owned child processes only. They cover poisoned synchronous completion fallback; exact original ID/occurrence/payload and single-use receipts; successful, definitive-unsent, and unknown outcomes; held locks; cancellation and deadlines; queued cancellation; committed ACK loss; foreign/duplicate ACKs; actual-exit retention; shutdown joins; and no effect replay. An installed fault after the actual native response write proves that started-wire uncertainty leaves custody unresolved without submitting completion.

Historical evidence is retained: the initial profile had **117 passes and 9 failures**. All nine new installed-fixture failures occurred before initialize because the fixture child's newline was incorrectly escaped. The fixture was corrected, additional cancellation/started-wire coverage was added, and the final 129-test profile passed. The initial RED evidence was not overwritten or represented as a production pass.

## Remaining limits

This is selected synthetic evidence, not a broad repository regression, live-bot/database/deployment run, performance guarantee, sustained-load/crash qualification, or native Windows qualification. Protected redaction and remote-agent native-read paths were excluded before reads and compilation; this profile excludes all remote-agent and reserved Windows paths. Checkpoint 893 remains inactive and supplies no external-writer authority. No UNIX-listen EPERM retry, Git action, upload, or deployment was performed by this implementation/verification slice.

The final guard problem remains: moving its database check across an await can invalidate original authority before native write. This completion-only change introduces its await after the observed effect boundary and does not resolve that separate ownership requirement.
