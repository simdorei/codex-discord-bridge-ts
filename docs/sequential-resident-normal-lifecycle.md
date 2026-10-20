# Sequential resident preparation components

Checkpoint 948, 2026-10-16. This package is uninstalled preparation, not a runnable persistent resident or migration-completion verdict.

## Implementation boundary

A distinct version 2 main-owned broker supports sequential ordinary, queue and stop mutation persistence through the unchanged fixed NativeMutationTransport and existing global Control lane/completion FIFO. Checkpoint 947's version 1 implementation is unchanged. One original requester, one active mutation, zero submission waiters and one exchange credit remain fixed. Native success is only the exact passive `{ok:true}` result from the original submission promise after its native worker joined.

Operation retirement requires terminal acknowledgement. The high-level finish promise does not resolve until that acknowledgement returns. A lost acknowledgement may leave a known durable confirmation in diagnostics while sequencing is quarantined; it does not establish rollback or replay permission. Unknown, protocol loss, unexpected close and nonzero requester exit permanently quarantine the module singleton. After actual native, endpoint and requester joins, payload retention can end, but a fixed root-sized quarantine record remains for the main isolate lifetime. There is no reset or replacement API.

The worker-local adapter owns private, one-use receipts and synchronously applies the existing exact original-claim revalidator. The existing resident final admission/client/generation/target checks and DB-to-Writable.write ordering are not replaced with an IPC permission acknowledgement. Explicit synchronous Unknown hooks survive both existing pinning wrappers and cover the original request's cancellation-rethrow and outer-finally paths. The new adapter requires this hook; existing legacy callers without it retain their behavior.

The mandatory persistent role is separate from optional store accounting. Its fixed preparation entry requires the descriptor even when no StoreAuthorityDomain is enrolled. The descriptor carries the exact module/path and a four-byte live SharedArrayBuffer. Registration precedes the fixed Worker construction, environment data is restored synchronously, and a submitted registration is released only after actual exit. The entry performs only role-ready / close-unstarted / unstarted-closed, then normal exit. It opens no store and starts no resident, native service or child. Role readiness is not runtime readiness or SQL/wire authority.

These are cooperative trusted-module rules. Worker.prototype.postMessage is not a hostile-object brand oracle; MessagePort does not intrinsically bound a hostile sender's queue. A SharedArrayBuffer descriptor is not an authentication capability. Store registration remains bookkeeping, not physical-file exclusion or external-writer protection. The exact configured mirror database path must be preserved in future integration; the runtime root does not certify an independently overridden database.

## Frozen component profile

Every constructor limit is required. The component profile uses 1,048,576 claim UTF-8 bytes and UTF-16 units; 65,536 expanded nodes/edges/container entries; depth 64; 16,384 native result bytes. Native, handshake, exchange, prepared-retention and terminal-retention deadlines are each 5,000 ms. Status spacing is 1 ms, phase observation is 10,000 ms, and operation/exchange maxima are 2,147,483,647.

Logical lifecycle reservation is 22,249,600 bytes, 393,488 nodes and 393,484 edges. Fixed root accounting is separately 49,152 bytes, 192 nodes and 192 edges. The lifecycle remains charged between operations until actual joins and reference disposal. These are logical representation counts, not heap, RSS, GC, serializer or native-memory measurements.

Each observation phase counts every status post, including rate-limited responses, against floor(phaseObservationTimeoutMs/minStatusIntervalMs)+1. Begin reserves headroom for both phases and retirement: 2*(statusCount+2)+2 exchanges. Consumed counters never reset. Separate adversarial profiles use maxOperationId=2, minStatusIntervalMs=1000 and maxExchangeId=64 or 8; the latter must refuse before the first begin. No qualification timeout was increased after a failure.

## Qualification status

Author version 4 and the separate serial independent version 4 each passed the selected 113 tests, with zero failures, cancellations or skips. Durations were 69.276 seconds and 69.414 seconds respectively. Both passed strict compilation and separate production-only JavaScript byte parity. This is a component-only qualification result, not resident installation or whole-migration PASS.

The identical source-graph SHA-256 is dff1e9ef18d4db21192a7d384d4174cc53df93d32ede69450bbe483b2c45d846. The identical emitted-graph SHA-256 is 5fe8991d9089a7ac657ea4c2d14a2800d57ade612c94e30de3e759111b2a38a2. The fixed qualification runner SHA-256 is 144f7f89cf4e5f465b9296be6d781cb74f0267fbc4c882254befbce2a7df54a6. Each compile additionally audited 178 pinned compiler/Node dependency declaration inputs; the selected and production project lists were exactly 313 and 301.

The selected qualification uses strict TypeScript 7.0.2, Node 24.21.0, an explicit guarded 313-project-source closure and a separate 301-production-source build whose emitted JavaScript bytes must match. Seven exact test entrypoints are specified; there is no automatic test discovery or project-root typecheck. Test processes use the preselected 300,000 ms outer watchdog. Individual fixture observation limits are 10,000 ms and only fail observation; they do not release resources or certify cleanup.

### Retained attempts

- Initial source-freeze preflight stopped before compilation because a lexical URL scanner followed a deliberately nonexistent foreign-module descriptor in a negative test. The scanner was narrowed to static imports and executable relative URLs based on import.meta.url; fixed production and test entrypoints are explicit roots. The original scanner and failure description were retained.
- Version 1 was frozen but never executed; test authoring completed afterward and a new freeze was made.
- Version 2 stopped at compilation, with five diagnostics: three callback-mutated state comparisons, one nullable parent-port capture and one negative-test Serializable argument. No tests ran. Minimal typing changes preserved the runtime checks. After this compile-only failure, failure-only observation wrappers were added to previously unbounded join and child-exit awaits using the already specified 10,000 ms observation value. Those wrappers were new harness behavior, not present in version 2.
- Version 3 passed strict compilation and production-byte parity but failed 10 of 113 tests, with 103 passing and none skipped. All ten raw requester scenarios exited before their close observation: removing the once-message listener had unreferenced the MessagePort, and a close-only listener did not retain it. The subsequent fixture correction explicitly references the endpoint before its two final close awaits. It changes no production code, deadline or assertion. The complete failed candidate and evidence remain retained.

## What the tests do and do not establish

The isolated real-SQLite requester scenario performs ordinary -> queue -> stop and eleven further ordinary mutations, using original queue/stop claim constructors and the unchanged native fence. It observes monotonically distinct IDs, native exits, terminal retirement and constant lifecycle accounting. Queue and stop each occur once; this is not a repeated queue/stop workload benchmark. Separate normally exiting test processes isolate permanent quarantine records without a reset API.

Other selected cases cover private receipt clone/foreign/consumed rejection, original-row deletion before local synchronous validation, local pre-post busy and invalid-input refusals, finite sequence headroom, drain without reopening admission, prepared expiry, four correlated reply-loss positions, known confirmation despite lost retirement acknowledgement, invalid raw framing/sequences, requester retention and nonzero requester exit after close-idle. Pure checks cover claim schemas, fixed reservations and native result shape. Hook tests exercise the original attempt guard and wrapper propagation directly.

The changed actual PortableResidentLifecycle cancellation path is source-reviewed and strictly compiled, not newly executed as an integrated resident cancellation test. No resident or app-server child is launched by this package's qualification. Mandatory-role tests use the real unstarted entry and actual exit, but do not establish the complete writable-open/foreign-handle/reopen graph. Malformed native results are checked by the validator, not injected into a replacement transport. The new fixture does not cover every phase/ID/duplicate permutation or a fresh blocked-Control/native-lock matrix.

Still required before installation: fixed response-completion/startup/idle/observation mediation; actual original ingress/workflow construction; same-target response and control liveness; configured production deadlines; full no-bypass store-open coverage; original singleton/root retention and actual child cleanup. No fake guard substitutes for the unavailable integrated-root run. No physical-store exclusion, abrupt worker/child containment, native Windows, full G1-G7, performance parity or whole-migration PASS is claimed. Restricted earlier review scopes are not revisited.
