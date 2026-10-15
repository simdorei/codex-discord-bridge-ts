# Remote dispatcher ownership foundation (910)

This is an uninstalled, offline-qualified ownership slice. The remote CLI still rejects remote configuration, and no runtime root, managed agent, socket, credential, restart-handoff persistence, filesystem mutation, terminal, or UI backend is enabled by this change.

## Source authority

The implementation was checked against `simdorei/codex-discord-remote-rust` at `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`. The first four files below are byte-identical to the frozen `4e213aa69dc89bed1552d8b83e12471d7664b7ae` source verified by the planning review.

- `crates/cdr-remote-agent/src/dispatcher.rs`, blob `6e42420d8f684dd5863b7926cb5cbed2f6cea7cc`
- `dispatcher/state.rs`, blob `f9f9a5449780466175a285c3b17fe5db91bff43b`
- `dispatcher/session.rs`, blob `7874ee7501fdb599ec3da283db9eb8e90866bddb`
- `dispatcher/execution.rs`, blob `ae0f9c51833dbd573855138d4b404d887995b637`
- `dispatcher/error.rs`, blob `25714cda9528a28dd5b57d3d81cd3ad4241ad6b1`
- `dispatcher/execution/helpers.rs`, blob `f9c1c1bf1e2ac83d3fd15169dc8c14791ba9a87c`

All paths after the first are under the same remote-agent source directory. Source bytes were fetched read-only through the authorized GitHub connector. There was no operational network exercise.

## What is owned

`RemoteProjectDispatcher` owns connection receipts, a bounded set of project bindings, session identities/resources, per-project session and mutation locks, mutation-result caches, accepted operation joins, and resource cleanup receipts. A copied, forged, proxied, cross-owner, or retired connection receipt cannot start work. One dispatcher is retained across reconnects, so project cache state survives connection retirement and subsequent session acknowledgement.

The captured factory opens project resources. Its return supplies separate typed file/core/session leaf operations. A session factory transfers computer, terminal-execution, and terminal-window operation ports and their three release paths. There is no catch-all execute callback that purports to implement session or project authority. Factories must own partial initialization on rejection, and every returned operation/release promise must settle only after actual native work settles. Function references and passive binding/identity values are captured once, rather than dereferencing mutable caller configurations during later operations.

This factory boundary is a trusted backend contract, not proof of native backend correctness, canonical-path confinement, permission grant, or user authorization. Exclusive resource ownership is a factory obligation, not a runtime uniqueness proof: a faulty factory can return the same raw object or closure for multiple projects. The synthetic fixtures exercise custody without claiming physical-resource uniqueness. Trusted local `upsert` ingestion must eventually be connected to qualified binding persistence and authentication by a separate managed assembly. Commands must already have passed the protocol decoder; immutable graph checks here do not replace full command decoding.

## Preserved dispatch order

For an authentic current connection and decoded command, cancellation precedes DeviceSession upsert. DeviceSession intentionally opens/inserts its binding before deadline checking. Then the owner selects the exact project, checks missing binding, request deadline, and binding expiry, and performs activation or exact session requirement. Mutations hold one per-project lock across deadline recheck, cache lookup, leaf execution, and cache remember. The existing cache performs matching replay and conflicting-content rejection. The existing source helpers supply mutation classification and error messages. Project-open and list/read backend failures use the existing redacting file-error mapper. Malformed returned output remains a contract violation. Thrown mutation/backend failures retain uncertainty and reject; qualified checkpoint/core/terminal/UI-specific error classification is still part of the missing backend adapters, not claimed as complete execution-error parity.

Project and session replacement install the new owner before reporting prior cleanup failure. Cleanup attempts computer stop, terminal windows, and terminal execution in that order even after a component fails. Missing backends return a capability error; they do not manufacture success. ProjectInfo can return the exact trusted binding metadata; all other capabilities need their named backend.

## Explicit asynchronous safety/profile differences

These are intentional TS custody extensions, not claims of byte-for-byte runtime equivalence:

- Connection receipts add an owner-identity boundary before source dispatch. Retired connection receipts are rejected before DeviceSession can change a binding. A monotonic high-water generation survives retirement instead of forgetting the previous generation when source state becomes `None`. The source optional `None`-generation local execution path is not exposed by this remote receipt API.
- Begin, retire, trusted binding updates, and close block new admission and join all accepted operations. Retirement requests cancellation and waits for actual settlement before resource cleanup. Administrative upsert also drains existing accepted work. Competing control transitions reject rather than queue.
- Session and project replacement cancel and join all detached sessions/operations, including an older session still awaiting cleanup during a newer activation. Backend project release occurs only after all those operations settle.
- Deadline and binding expiry are rechecked after asynchronous lock waits and resource initialization. A late asynchronous nonmutating completion is normalized to cancellation after settlement; Rust synchronous file reads do not themselves perform that late check. Newly initialized expired/cancelled resources are cleaned before returning. The monotonic request-budget helper is passed to leaf operations.
- Every accepted direct call is charged against four concurrent calls and 4 MiB of retained command text; lock waiters are already included in that charge. There is no second worker pool. The existing outer command loop remains the only four-active/sixteen-total work queue. Text charges are conservative UTF-16/UTF-8 retention accounting, not a heap/RSS guarantee.
- At most sixteen bound projects are retained. Each cache has a 209,715-byte text budget and the existing 256-entry limit. Twenty possible live/detached project caches fit inside 4 MiB; detached caches are cleared after their operations join. Native hashing, decoding, and serialization reuse the existing worker lane. A bounded internal codec lock coordinates this owner's calls; contention with unrelated lane users still fails closed rather than creating retries or another pool.
- An exception after a mutation leaf is invoked, or a thrown cache-retention failure after execution, marks the project mutation outcome uncertain. Subsequent mutations fail closed until explicit binding replacement; reconnect does not reset the flag. No cache miss, eviction, cancellation, cleanup failure, or uncertain effect triggers an automatic replay. A cache budget non-retention or eviction remains the existing volatile-cache behavior: a newly submitted duplicate can execute again. Separate tests demonstrate both cases. This is not durable execution evidence or an exactly-once guarantee.
- Cleanup is never automatically retried. Failed session/project owners and their settled receipts remain retained. Malformed pre-install factory returns, including synchronous/non-Promise returns, are quarantined before release is attempted; no thenable is assimilated and no `then` getter is read; malformed release paths never execute accessors, and available valid cleanup phases are still attempted. A failed or unavailable release leaves the opaque transferred resource and its receipt retained, blocks creation/reconnect, and makes final close fail. Successful release removes the quarantine. Already pending factories that finish after another cleanup failure are released instead of installed. Further resource creation and reconnect are blocked after a cleanup failure; an already installed new session remains inspectable on the current connection. Close repeats the same success/failure receipt rather than reporting a previous failure as success. All current resources are attempted even if earlier cleanup failed.
- Native output serialization validates non-mutating results; mutation results are validated by the existing cache remember path. Synthetic results are deeply immutable and request identity is supplied by the owner.

## Verification boundary

Tests use synthetic bindings/resources and actual emitted native-codec workers, with pinned Node 24.21.0 and `--no-strip-types`. The protected test is excluded by a private exact-path compiler profile and is never read, compiled, run, or reconstructed. The known UNIX-root EPERM case is not retried. Focused and bounded affected runs are recorded separately; they are not a whole-suite or native backend PASS.

Remaining work includes real project filesystem/checkpoint/write/code/Git/image/command backends, native terminal/UI ownership, a single managed dispatcher-to-connection adapter, authenticated binding ingestion, restart-handoff custody, exact shared status, remote MCP/root assembly, and end-to-end platform qualification. Final wire authority, schema, and inactive 893 remain unchanged.
