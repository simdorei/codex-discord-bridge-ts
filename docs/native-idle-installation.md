# Post-spawn native idle installation

Source baseline: Rust `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`,
`crates/cdr-runtime/src/idle_release.rs:13–25`. Installation preserves the
source order: validate old pending inventory, activate the resident observation
scope, attach the idle journal. Old-owner rows retain their existing holds.

`NativeIdleBeforeOwner.validateInstallation` runs only
`pendingIdleIntentsExisting` on the existing store. The source query decodes at
most 128 non-settled rows and its result is discarded inside the worker. There
is no initialization, new query, write transaction, automatic retry, or inventory
transfer. Success requires an exact operation/path/nonce acknowledgement and
actual worker exit. The ordinary Control budget and default 5000 ms deadline
remain unchanged.

The asynchronous runtime helper pins the path and constructs the journal before
its first await, capturing the exact resident, instance, generation, and live
client admission. It calls the already-existing observation owner's activate
operation only after validation is confirmed and joined. Activation retains its
existing `ok: true, value: null` acknowledgement; this does not add a path, scope,
or nonce echo. Activation can commit before cancellation, lost acknowledgement,
or failed attachment. No rollback or replay guarantee is implied.

Before attachment, cancellation and lifecycle checks reject closed, unhealthy,
quarantined, restart-pending, or changed generations. The original permit remains
owned and a final fresh admission must identify the same client. These checks
complete synchronously before `installIdleReleaseJournal`, whose target-gate
mutation precedes its own internal admission. Both held admissions release in
finally blocks before startup disposes its exact resident on failure. Existing
primary-plus-cleanup error retention is unchanged. Caller singleton custody is
still a prerequisite; no new lifecycle API or extra native owners are created.
The helper accepts independently supplied trusted native capabilities and does not
verify that their paths match its journal path. Its caller must supply the same-path
owners; production startup constructs them from the same pinned path.

The synchronous installation helper remains available for compatibility. This
slice does not offload synchronous journal hooks or final DB-to-wire guards and
does not establish complete database isolation, Windows qualification, deployment,
or permission to replay uncertain effects. Native activation errors are now
public-safe `IdleObservationError` values rather than raw SQLite trigger text.

Focused tests cover existing/malformed/missing inventory, unchanged old-owner
rows, ordered failures, stale lifetime/client conditions, final admission failure,
held-admission release, actual SQLite lock timer progress, held native joins,
malformed acknowledgements, cancellation, and exact startup child cleanup.

## Checkpoint934 qualification

F2 author qualification passed 86/86 selected tests (zero failed, cancelled, or
skipped). Independent review rebuilt and ran the same explicit selection: 86/86
passed, zero failed, cancelled, or skipped, plus 3/3 independent integration
probes. Review concluded scoped approval with no remaining code blocker.

Pinned Node 24.21.0 and TypeScript 7.0.2 compiled an explicitly enumerated,
pre-read screened graph of 309 selected modules. The actual compiler file list
was audited. All 301 production-only emitted modules were byte-identical to their
counterparts in the selected build. The F2 source graph SHA-256 is
`ce19d9129c0062231baae08c3ee89d862df9561c2ce0099cadc07abda2f10e60`;
the emitted graph SHA-256 is
`13222fcf3f7ad0c610616b5368207d818d77b4fb5e65e87b5361d6af0d11a0f4`.
Tests executed only nonempty explicit emitted argv, with type stripping disabled.
Forbidden remote-agent paths and reserved Windows work were excluded.

The preserved author F1 run also passed 86/86, but its lock tests measured from
submission and could have observed worker startup rather than blocked SQLite.
F2 supersedes that attribution: each test observes entry into the real facade
leaf, then demonstrates main-loop timer progress while the held SQLite lock
prevents that leaf from returning, before releasing the lock and joining the
exact worker. Production behavior and default deadlines did not change for F2.

This qualification covers the selected slice and explicit probes only. It does
not claim an exhaustive repository run, complete migration, native Windows
qualification, deployment, or stronger activation acknowledgement binding.
