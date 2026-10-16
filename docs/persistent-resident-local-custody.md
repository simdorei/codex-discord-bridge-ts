# Persistent resident local custody extraction

Status: source-only WIP. NOT COMPILED / NOT RUN / NOT PASS.

This change extracts only the fixed path, mutation fence and dead-work persistence closure from `preparePersistentResidentComposition` into the internal `preparePersistentResidentLocalCustody(runtime)` factory. It does not activate an installed or production startup path, complete fixture-free lifecycle composition, or qualify migration acceptance gates.

## Preserved binding and ordering

- The factory first calls `requirePersistentResidentRole()` and derives the store path solely from that descriptor. Its only input remains the existing runtime identity. There is no caller-supplied path, SQL, fence, callback, executable, endpoint or selector.
- The same private fixed renderer returns `Disposable resident operation unavailable`. The composition retains its own identical private renderer for lifecycle and mutation construction; neither renderer is injectable.
- Error mapper, fence construction, capture of `state.captureDeadGenerationExisting`, and synchronous dead-work closure creation retain their original order. The extracted body is unchanged. The new frozen result contains only path, fence and the original closure.
- Fence construction prepares hooks; it does not invoke database operations. Dead-work cloning, signed-i64 upper-bound validation, target ordering, serialization, null startup channel, unscoped-request detection and invocation-time `Date.now()/1000` stay inside the synchronous closure.
- Composition makes one direct synchronous factory call at the old setup position. Its `started` guard, role recheck, mutation owner construction, fixture instrumentation, native owners, startup/cleanup sequence and idle installation remain unchanged.
- The persistence object `Object.freeze({persistDeadWork,oldChildExited(){}})` is still created in the original `PortableResidentLifecycle.start` call. It is not preconstructed by the new factory.
- The factory is an internal module export, not a package or public-barrel export. Its imports introduce no test dependency or fixture interception.

## Authority and responsiveness limits

No database operation moves across an await, isolate or IPC boundary. The final private-claim synchronous mutation revalidator, original client/state checks, target preflight, caller check and original write remain together and untouched. Response capture and IMMEDIATE begin/commit remain resident-local; native response finish remains post-effect. An IPC acknowledgement does not acquire write authority.

The default 5000 ms synchronous idle guard can still block the resident event loop. This extraction makes no zero-busy, nonblocking, latency, throughput, heap, full lifecycle or installed runtime performance claim.

## Evidence and remaining validation

Static comparison is against local checkpoint 952 (`383f25500341966a0abecacf2577f6fb2f5b6d1b`). Only the composition imports/setup change, the new internal module and this scope document belong to this slice. Existing lifecycle/writer authority code and bootstrap code are unchanged by it.

No compiler, tests, native fixture, process-control operation or runtime validation was run for this slice. The prior v4 descendant-containment uncertainty remains unresolved; source review does not establish process exit or cleanup. Protected paths and the blocked checkpoint 936 review are outside scope.

After independently resolving the physical-containment blocker, validation still requires an exact guarded dependency graph, compilation, production emitted-byte comparison accounting for the moved module, and component scenarios covering role/path binding, startup failures and cleanup retention. Those are future requirements, not successful results.
