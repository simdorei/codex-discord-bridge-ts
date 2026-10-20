# Fixed resident startup composition

## Scope

Checkpoint 949 extracts the existing native-owner construction and capability
wrapping in `startRuntimeResident` into a module-private synchronous factory.
The production entrypoint uses this factory directly. It is not exported, accepts
no caller-selected adapters, and introduces no worker entrypoint or runtime mode.

The private frozen readonly bundle requires the existing persistence, maintenance,
mutation, response-completion, idle, observation, and dead-generation operations.
Idle exit settlement and both gap operations remain required in this composition,
even though the legacy lifecycle interfaces permit their absence. The original
concrete idle and observation objects are passed to installation. Installation
now depends only on structural `validateInstallation` and `activate` operation
interfaces; these types are not ownership or authentication proof.

## Preserved ordering and failure behavior

- Abort check, configuration clone and path pin precede custody activation.
- After custody activation, the dead-generation closer is registered and the
  original abort check precedes synchronous owner construction.
- Construction remains mutation, idle, response, observation, then gap owner.
  Cleanup registrations remain at the same construction points. The response
  closer is inserted before the idle closer despite later construction.
- Constructor/startup failure cleanup remains dead-generation, mutation, response,
  idle, observation, then gap owner. It stops on the first rejection, which can
  replace the primary error. This extraction does not change that behavior.
- Lifecycle startup is awaited, followed by the original abort check, awaited idle
  journal installation, final abort check, and return of the original resident.
- Installation retains its original body: original-client/generation check,
  validation and join, recheck, activation and join, recheck, final response
  admission, same-client check, and synchronous journal attachment. No await was
  added between final validation and attachment; original admission releases remain.
- Installation failure disposes the same resident. The existing cleanup error
  retains the original resident and both error identities. Successful shutdown
  remains owned by the lifecycle, not by the composition bundle.

Existing owner objects, bound receivers, signals, deadlines, limits, global slot
policies, synchronous final wire checks, and possible partial activation commits
are unchanged. No rollback, retry, or replacement permission is inferred.

## Qualification

Pinned Node 24.21.0 and TypeScript 7.0.2 on Linux were used with explicit roots,
strict compilation, audited transitive source and worker-URL closure, and an
explicit nonempty emitted test-file list. The selected project graph contains
307 files; a separate 303-file production-only compilation produced identical
production JavaScript bytes.

The author and independent runs each passed all 27 existing cases in:

- `test/runtime/discord-runtime/resident-startup.test.ts`
- `test/runtime/discord-runtime/resident-idle-exit-native.test.ts`

There were no skips, failed qualification attempts, test edits, or timeout changes.
The tests use disposable temporary stores and the pinned Node inline responder.
They exercise activation/installation ordering, real fixture child reaping,
pre-abort and invalid-channel no-spawn, cleanup error identity, joined native
acknowledgements, original configuration/path retention, final wire rejection,
and idle exit settlement. This is component evidence, not an operational bot
launch or real root/singleton qualification. The independent run reproduced the
same selected source and emitted graph hashes, input audits, and production-only
JavaScript parity, with no required findings. The author test duration was 23.787
seconds and the independent duration was 24.374 seconds; these are observations,
not approved performance thresholds.

Source graph SHA-256:
`5305912ecd495f10da1f2df8006eb87873dc3436dcb4704cb8e5ad34753aedee`

Emitted selected graph SHA-256:
`5c9816da6967a23c3afc2fdbca832760ec1121dee099eef45758a566200663a0`

## Remaining boundaries

This production-used decomposition does not install the checkpoint 948 adapter
or activate a persistent resident worker or inactive store authority. Future
worker integration still needs a separately reviewed fixed composition, mediated
response/dead-generation/idle/observation operations, original synchronous final
checks, exact store/root/lifetime bindings, actual child/native joins, and
unknown-outcome containment. Existing main-thread native constructors cannot
simply be invoked inside a worker. Native Windows, complete migration gates,
performance parity, long-running operation and deployment remain unqualified.
