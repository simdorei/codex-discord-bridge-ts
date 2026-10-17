# Fixed response completion transport extraction

Checkpoint 950, 2026-10-16. This extracts the installed response owner's existing post-effect native scheduling into `NativeResponseCompletionTransport`. The owner actually uses the transport; this is not an additional unused implementation. It is not a persistent-worker endpoint, an execution-authority grant, a throughput qualification, or a whole-migration PASS.

## Preserved boundary

The original owner still validates and pins constructor inputs, captures and freezes the original response claim, owns private one-use response receipts, validates public finish arguments synchronously, generates the ACK correlation UUID, forwards cancellation, and classifies the final ACK. Existing response payload behavior above one MiB is retained. No payload cap, SQL change, alternate worker, queue limit, or retry path was introduced.

Public setup order remains receipt consumption, AbortController creation, synchronous Control slot preparation, UUID creation, caller listener setup and abort forwarding, controller registration, then the classified asynchronous task. An empty frozen transport handle is associated with one slot in a private WeakMap; it is not a response receipt or non-submission proof. Prepared but abandoned handles create no worker or scheduling lease and are not held in a strong outstanding-handle collection. Foreign or used handles cannot submit. Preparation remains possible after transport close, preserving the original slot-allocation stage; submission after close fails.

The transport captures the already validated path at construction. Submission builds the fixed worker payload explicitly and never accepts a caller path override, URL, callback or lane. It invokes the unchanged response completion worker through the unchanged Control completion FIFO without a preceding asynchronous hop. It waits for actual slot join in a finally block. Submitted tasks, not prepared handles, are retained until settlement.

The owner keeps its cancellation controllers and public tasks through final ACK classification. It checks the same internal abort signal immediately after awaiting the transport. Close marks the owner closed and aborts owned controllers synchronously, then joins transport and public classification tasks. Busy therefore spans the full public operation rather than just worker settlement. The existing fixed Unknown error classification remains: even failure before native submission grants no replay permission, and a flushed row may coexist with an Unknown caller outcome.

Response custody, synchronous begin and final DB-to-wire checks, response-client behavior, worker implementation, store enrollment, slot implementation, resident lifecycle and startup composition are unchanged. The existing cancellation-during-begin bypass remains intact; completion was not moved into lifecycle finally cleanup.

## Qualification

Author qualification used pinned Node 24.21.0 with type stripping disabled and TypeScript 7.0.2 strict explicit compilation. The selected pre-read guarded dependency graph contained 313 project files. A separate production-only compilation of 304 source files produced byte-identical JavaScript for every corresponding production module. Compiler actual inputs were checked against the frozen graphs and allowed declaration paths.

The six explicit test roots were:

- `test/app-server/response-attempt.test.ts`
- `test/app-server/response-client.test.ts`
- `test/runtime/response-custody-fence.test.ts`
- `test/runtime/native-response-completion-owner.test.ts`
- `test/runtime/discord-runtime/resident-startup.test.ts`
- `test/runtime/discord-runtime/installed-response-completion.test.ts`

The author run passed 81/81 tests with zero skipped, failed or cancelled tests in 35.192 seconds. There was no failed author candidate and no deadline increase. The existing 5000 ms default and explicit 100 ms owner timeout test remain unchanged. Source graph SHA-256: `2473bac946ad913bf4e76e76e1246c71db20d138127ab6f90e11d752c1a0ddb2`. Selected emitted graph SHA-256: `a03f3ec8f234069d89b04c9adacfc7b218ddef6a2a9090d081a6cbe06de66708`.

Two added tests intercept transport settlement only in the test process. Each awaits the real transport operation and actual native exit, verifies the disposable row is flushed and public busy remains true, then closes the owner or aborts the caller before the owner's classification continuation. Both assert Unknown, consumed receipt, retained flushed row and final busy=false. The close case also verifies close has not already settled at the interception point. No fabricated ACK, production injection hook or alternate native implementation is used. This tests the added continuation boundary; it is not abrupt-process-death or power-loss evidence.

Existing selected regressions cover original and alias ownership, payloads above one MiB, invalid/copied/used receipts, closed and preaborted operations, actual SQLite lock waiting and late commit, queued cancellation, lost/foreign/duplicate ACKs, real worker exit retention and installed lifecycle completion behavior. Private handle refusal is enforced in source; this run adds no separate direct handle-misuse matrix or injected synchronous UUID/listener failure qualification.

Independent qualification also passed 81/81 tests with zero failed, skipped or cancelled tests in 34.586 seconds. Its strict compiler input audit, separate 304-module production-only JavaScript parity, source graph and selected emitted graph matched the author qualification. No required code findings remained for this extraction. This is scoped component and installed-path qualification, not broader migration approval.

## Explicit limits

All database executions used the selected disposable test fixtures. This is not actual production-root singleton qualification, Windows qualification, hostile-isolate containment, physical external-writer exclusion, or a new store authority domain. Existing main-thread guards and the inactive accounting scope remain unchanged. Protected redaction and denied remote-agent native-read dependencies were excluded before traversal; checkpoint 936 was not inspected or executed. No operational deployment, bot restart, IPC activation or broader completion gate is covered.
