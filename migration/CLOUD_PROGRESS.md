# Cloud migration checkpoint

Latest verified Linux checkpoint: **2,289 tests passed**, no failures/skips;
strict TypeScript passed. Migration and Windows/live transport validation remain incomplete.

## Baseline

- TS snapshot: `47d0f7f9a3c75a6ec94b38833cd1992740efaeb3`.
- User-approved remote Rust authority: `release/stabilization-held-20261002`,
  commit `4e213aa69dc89bed1552d8b83e12471d7664b7ae`.
- This replaces the unavailable local frozen source for new work. It is not a
  claim that every previous unit has been revalidated against this commit.
- Linux Node 24.21.0: baseline 2,061 tests passed, zero failed/skipped; strict TS passed.
- From this checkpoint, implementation and review are performed directly by SSS
  at the user's request. AGY is not the author of the changes below.

## Borrowed async admission coordinator

`src/store/async-resolution-admission.ts` implements the unsettled query,
lifecycle admission loop, and policy/unsettled/lifecycle/legacy coordinator.
Authority: `crates/cdr-store/src/async_resolution.rs` (`held_in`) and
`async_resolution/lifecycle.rs` (`admission_held_in`) at the commit above.

The lifecycle query projects CASE-result storage class and bytes rather than
TEXT to prevent Node's eager row conversion from decoding an unused outcome or
the 129th row. It retains the SQL byte limit, filters, order, and LIMIT. Text is
decoded only when needed using the existing SQLite encoding decoder; encoding
is read lazily once per invocation. Ordinary records skip outcome conversion.
Native SQLite prepare/step errors propagate. Typed text conversion failures use
the existing TS StoreIntegrityError taxonomy; Rust exception class/message
identity is not claimed.

Validation: 14 new in-memory SQLite tests; full Linux suite 2,075 passed, zero
failed/skipped; strict TypeScript passed. Tests include invalid UTF-8, SQL types,
CASE NULL, UTF-8/UTF-16LE/UTF-16BE byte boundaries, 128/129 rows, control precedence,
refusal disposition, thread/owner filters, error masking, query-only reads and
caller transaction rollback. Diagnostic fixtures intentionally allow corrupt
types/NULL; they do not claim full production-schema reachability.
The raw UTF-16 test reuses all 22 retained Rust observations from
`migration/oracles/sqlite-utf16-0.40.2/decoded-results.json` through the new
lifecycle query. These are reused historical observations, not a fresh Rust run.

Remaining: fresh cross-language differential execution, complete raw malformed
UTF-16 matrix, complete runtime wiring, actual Discord/Codex
transport, Windows restart/end-to-end validation. A Rust toolchain installation
attempt's execution approval was cancelled; no fresh Rust oracle run is claimed.
No deployment, live database, credential, hook, or existing source changes.

Local logs: `.runtime/cloud-baseline-20261007/` and
`.runtime/cloud-admission-001/` (ignored execution evidence, not source artifacts).

## Owned reads and saved-request presentation

The owned admission and target-dispatch wrappers now use `openInitialized`,
close the first handle before opening the second, and skip the second open on
an admission hold. They are exposed through `StateAccessFacade` so the new
runtime presentation code performs state reads through that interface.

`presentSavedSubmission` and `withTargetHold` follow the Rust submission
presentation rules: only Pending/Starting jobs query admission; existing turn
IDs and protected warnings skip the read; current holds overlay a warning
without changing the stored job, attempts, queued flag or turn ID. Database
errors propagate rather than being converted into permission.

Full Linux suite: 2,084 passed, zero failed/skipped; strict TypeScript passed.
Three owned-store tests use real initialized temporary databases and verify
one/two-handle closure plus start/steer/thread behavior. Six presentation tests
use the state interface to check masking, warning precedence, isolation and
error identity. These are not live Discord execution or a complete queue
coordinator. Existing runtime intake/start/recovery orchestration remains open.
Latest local logs: `.runtime/cloud-admission-owned-002/`.

## Target serialization and queue read coordinator

`TargetLocks` implements shared normal/non-waiting target leases, FIFO waiting,
queued cancellation, idempotent release and cleanup after the final owner.
Unlike Rust RAII, JavaScript callers must release explicit leases or use `run`,
which releases in `finally`. Aborting a granted lease does not release its owner.
This is event-loop-local coordination, not a distributed/process-wide mutex.
Authority: `queue_runner.rs::target_lock`, `target_lease.rs` and lock-cache tests.

`QueueReadCoordinator.busyStatus` uses that shared lock and the exact backend →
queue-list → durable-hold-filter sequence; even an active turn does not mask a
later storage error. `controlBinding` preserves its unlocked read and exactly-one
Starting/Running non-goal-waiting selection. Storage reads go through the facade.
`eligibleJobs` excludes only held Pending records and does not mutate inputs.

Full Linux suite: 2,101 passed, zero failed/skipped; strict TypeScript passed.
New tests cover FIFO, cross-target progress, 1,000 historical target cleanups,
cancelled waiters, stale releases, errors, real queue/hold filtering and unchanged
attempt counts. A first test run caught unsupported TS parameter-property syntax;
explicit field declarations fixed it without changing Node execution flags.
Test job construction was shared rather than duplicated across runtime suites.
Latest logs: `.runtime/cloud-target-locks-003/`.

Still missing: claim-fenced start/ACK/failure transitions, resident late-stop
binding, full submit/completion/recovery coordination and transport/restart wiring.
The existing compatibility mutation helpers must not substitute for guarded
`try_begin_attempt` / `*_if_claimed` APIs.

## Claim-fenced queue mutations

`queue-claims.ts` now implements `tryBeginAttempt`,
`recordStartFailureIfClaimed`, and the **non-resident** `markRunningIfClaimed`.
Authority: `crates/cdr-store/src/queue/write/attempt.rs` at the pinned Rust commit.
All use one IMMEDIATE transaction owner and the exact job/target/generation/
attempt/timestamp/raw-baseline/state/turn/fork comparisons. Input snapshots are
captured before asynchronous initialization. Existing dead-generation, async
admission, baseline, reply-binding and origin helpers are reused.

Definite execution-held failure atomically writes the hold and notice; neither
may commit if the notice fails. ACK turn replacement by a trigger is rejected
and rolled back. A stale comparison returns no claim, never replay permission.
The non-resident ACK API does not accept a resident argument and must not replace
`mark_running_with_resident_if_claimed`; late-stop binding is still pending.

Full Linux suite: 2,119 passed, zero failed/skipped; strict TypeScript passed.
18 claim tests include competing callers, stale identities, generation/dead
holds, ignored/aborted updates, rollback, Unicode bounds, mutable caller input,
atomic notices and ACK/origin failures. This is not a cross-process contention
or Windows run. Clock precision remains Date.now milliseconds, unlike Rust's
submillisecond SystemTime. Typed AsyncResolutionHeld errors are defined here;
complete central runtime error routing remains unfinished.
Latest logs: `.runtime/cloud-claims-004/`.

## Resident ACK and previously accepted Stop custody

`markRunningWithResidentIfClaimed` now binds an exact late ACK within the same
IMMEDIATE writer transaction. `stop-late-start.ts` follows the pinned Rust
late-start helper and its revision, binding/mapping, hold-snapshot and intake-read
dependencies. It verifies the global/per-target stop revision, original job and
owner, accepted scope, existing hold, new turn and resident. Existing controls
are not widened or replaced. Insertion is followed by checks of pristine control
state, exact record retention, hold/job identity and unchanged latest scope.
Any failure rolls back both ACK and control receipt. It performs no interrupt.

StopControl JSON retains struct field order and opaque serialized job strings.
Settlement eligibility is false for broad/missing scope evidence or queue/intake
ID collision; the intake presence check decodes the full row rather than hiding
corrupt data behind SELECT EXISTS.

Full Linux suite: 2,130 passed, zero failed/skipped; strict TypeScript passed.
11 new DB tests cover ownership/turn limits, revisions, mapped/selected routes,
malformed scope/intake, collision, ignored inserts and hostile post-insert triggers.
This does not implement Stop acceptance/dispatch/terminal recovery as a whole.
Fresh Rust differential execution and Windows validation remain open.
Latest logs: `.runtime/cloud-late-stop-005/`.

## Direct submission and queued-start coordinator

`QueueStartCoordinator` connects existing enqueue/mirror checks, shared target
locks, async/dead-generation holds, restart admission permits, all-generation
queue eligibility, retry delay, backend preflight, guarded claim, dispatch and
claim-fenced ACK/failure. It implements direct and identified/mirrored submission;
intake-claim promotion and authoritative recovery are not implemented here.

Backend interfaces are explicit. Resident identity is captured before dispatch;
the backend receives an owned, frozen claim copy rather than mutable CAS authority.
Known backend failures retain typed context. Unknown exceptions are propagated;
after an uncertain dispatch the durable Starting job is not automatically replayed.
Usage-limit failure commits its hold/notice before notifying the delivery callback.
The callback still needs actual message-worker wiring.

22 coordinator tests exercise real initialized SQLite with a fake backend, including
duplicate Discord-message admission, mirror refusal, delayed retry, stale claims,
old-generation head blocking, shared-lock concurrency, restart drain occupancy and
cross-thread progress. Full Linux suite: 2,152 passed; strict TS passed. No real
Discord/Codex network call or process restart was performed.
Latest logs: `.runtime/cloud-start-006/`.


## Completion prerequisites: inbox ownership and typed proof decoding

The completion-owned inbox reconciliation now preserves exact generation,
attempt, channel, user and unique non-pending queue ownership before any job
removal. Seven real SQLite tests verify rejection, legacy fallback, existing-row
preservation and caller rollback. The caller must supply an active transaction.

Typed evidence decoding preserves required-field Serde struct semantics: map or
positional sequence, duplicate known-field rejection (including escaped aliases),
exact i64, and nested Value semantics. Unknown values are lexically validated but
not incorrectly subjected to Value numeric/Unicode/depth rules. Known values
share the parent struct recursion budget. This is deliberately not a general
Serde derive implementation (no Option/default/flatten/custom visitors).

Authority: pinned Rust ownership.rs and terminal.rs; serde_json 1.0.151 source
from the official crates.io archive, verified against Cargo.lock checksum
`c841b55ecdae098c80dcae9cf767f6f8a0c2cdb3416bbef72181df4d0fe73f14`.
Relevant functions: deserialize_struct, ignore_value/ignore_integer/ignore_escape,
parse_number, check_recursion. These are source-based tests, not a new Rust
executable differential run. Fresh Rust execution remains unavailable.

The pure terminal-proof check binds canonical terminal identity/status, exact
observer/generation/claim/revision, source, owner verification and canonical hash.
Unknown metadata remains retained. Pure decoding does not establish live ownership
or authorize settlement; transaction-level conflict/owner checks are still pending.
Seven parser and seven proof tests were added. Full Linux suite: 2,173 PASS,
zero failures/skips; strict TypeScript passed. Logs: `.runtime/cloud-proof-009/final/`.

Review also corrected a misleading precondition error in late-start binding:
a missing transaction now reports StoreIntegrityError requiring a transaction,
not the opposite migration-only ActiveTransactionError. No guard was weakened.
Completion/outbox settlement, recovery, intake promotion, transport integration,
Windows and live deployment remain incomplete.


## Owned completion transaction and coordinator

Added exact async obligation reads (claim/seal/owner length-prefixed SHA-256,
lossless integers, ordered conversion, 129-row decode-before-limit semantics),
original/latest-handoff ownership validation, accepted terminal-proof checks,
revision-fenced settlement and conservative terminal-journal retention.
SQLite TEXT decoding retains UTF-8/UTF-16 handling. Claim and seal byte equality,
mirror mapping, full Running job identity and timestamp IEEE bit patterns are
required. These checks do not create original preparation or handoff authority.

The owned completion writer now atomically checks the whole captured job and
unique turn owner, rejects dead targets, records mirror origin, reconciles inbox,
settles eligible async obligations, stages final delivery, removes the job,
conditionally retains its terminal journal, removes final-answer observation,
and stages an unsent idle-release candidate. Capacity defers release, not the
final; existing unresolved intents are preserved. No unsubscribe is sent.

The runtime coordinator uses the same target lock and StateAccessFacade as
submission/start. It snapshots generation/resident around reads, suppresses
release authority if either changes or observed generation is missing, commits
final delivery before notification and starting the next job, and preserves the
committed final even when next-start fails. Compatibility completion never gains
release authority. Shared stored-job snapshot/equality helpers avoid divergent
claim/ACK/completion ownership logic.

Verification: full Linux Node 24.21.0 suite 2,212 PASS, zero failed/skipped;
strict TypeScript PASS. New real SQLite and fake-backend tests cover ownership,
raw claim bytes, large integers, UTF encodings, page limits, stale/oversized/
conflicting evidence, revision overflow, ignored CAS, transactional rollback,
inbox-before-delete, idle capacity/history, resident changes and start-next failure.
A facade API-list test was updated to include the new whole-function alias;
initial failed integration logs remain under `.runtime/cloud-completion-011/`.
Final logs: `.runtime/cloud-completion-011/runtime-final/`.

Still incomplete: resident notification proof producer/candidate capture, Goal
progress and handoff writer, authoritative recovery, intake promotion, actual
Discord delivery/transport workers, centralized runtime error handlers, Windows
and live process validation. No Rust differential execution, merge or deployment.


## Resident notification proof producer and raw journal

Ported terminal notification capture and its lifetime-bounded diagnostic
candidates (8 unverified, 1 conflict, 2 replaced). Exact accepted evidence uses
Rust struct declaration order. Duplicate accepted observations do not rewrite
proof; conflicting accepted outcomes persist their conflict before throwing.
Invalid old proofs are retained byte-for-byte before replacement, and a full
retention budget blocks replacement rather than discarding evidence.

The live-resident raw journal producer preserves Rust's two-transaction order:
proof capture commits first; a separate writer transaction rechecks live owner,
accepted proof and canonical notification before recording raw payload/resident.
A failure of the second transaction does not erase accepted proof. Exact Stop
control and server-response terminal hooks run in that journal transaction.
Recovery must not invoke this producer to manufacture resident provenance.

New tests cover typed proof field order, foreign diagnostics, conflict persistence,
lifetime replacement capacity, lost proof CAS rollback, proof-survives-journal-
failure retry, Stop hold disposition, response custody and resident stamping of
only byte-matching raw observations. Full Linux suite: 2,222 PASS, zero failed/
skipped; strict TypeScript PASS. Logs: `.runtime/cloud-resident-proof-012/final/`.
The live Codex notification adapter itself is not connected yet.


## Outbox lifecycle and ambiguous-start recovery leaf

Added pending-delivery reads, transactional failure bookkeeping with Rust trim/
Unicode-scalar bounds, and idempotent completion. Integer overflow or corrupt
stored data rolls back failure increments. No Discord send occurs in these APIs.

The ambiguous-start writer now uses the original full claim predicate and raw
baseline JSON, atomically creates its hold marker and bounded outbox notice,
refreshes only a still-pending notice, and never recreates one already consumed.
Candidate IDs are unique and sorted by UTF-8 bytes, with scalar-based truncation.
The hold prefix now has one shared definition across store, restart snapshot and
saved-submission classification.

The recovery-attempt leaf preserves the 120-second lease, single-candidate
claim-fenced attachment, permanent ambiguous-candidate hold and cold/changed-
generation empty-history uncertainty. Empty history never authorizes redispatch.
Terminal Running history remains unresolved until the completion writer stages
its final. The caller must still supply authoritative history under the shared
target lock; the full target recovery scheduler is not wired by this leaf.

Full Linux suite: 2,235 PASS, zero failed/skipped; strict TypeScript PASS.
Logs: `.runtime/cloud-recovery-attempt-014/`. Outbox checkpoint 2,225 PASS is
retained in `.runtime/cloud-outbox-013/`. No service/network/deployment action.


## Recovery state, journal reads and historical evidence

Added one coordinator-owned recovery state for cold targets, monotonic retry
backoff and unavailable-error suppression. Read and mutation failures remain
separate; clearing/pruning a target cannot clear another target's retry state.
Nanosecond BigInt deadlines avoid wall-clock jumps; platform-specific Rust Instant
maximum-overflow behavior is not independently reproduced. This state is prepared
for the full recovery coordinator, not claimed wired to it yet.

Observed-completion reads retain row order and lossless generations. Error
bookkeeping bounds Unicode scalars without trimming. Finish retains unprovable
async journals and preserves the source's separate read/delete opens; it is not
an atomic ownership certificate. These APIs are exposed through StateAccessFacade.

Historical review validates complete original question seals, exact answer prompt,
64-bit question/selection indices and body defaults. The bounded Serde struct
reader now additionally supports explicit defaults, u64 and string vectors for
QuestionBody; it still does not implement general flatten/Option/custom visitors.
Snapshots have private WeakMap custody and owned data. Caller observations are
copied before awaits. History candidates preserve canonical hashes, exact input,
conflicts and semantic keys, revalidate persisted bytes after insertion, and may
confirm answer receipt but never execution authority. Saturated evidence storage
or corrupted matching keys leave receipt state unchanged.

Historical terminal snapshots require no active target owner or surviving
original job, exact question/mapping/seal, supported policy and conflict-free
prior evidence. Fresh observations must prove idle thread, ended/absent Goal,
unique exact owner turns and terminal statuses. Settlement rechecks the snapshot,
updates revisions/certificates/questions atomically, and verifies post-write
source/certificate identity. Publishing recovery remains held. No prompt replay,
resident notification provenance or delivery authority is fabricated.

Verification: full Linux suite 2,264 PASS, zero failed/skipped; strict TS PASS.
Logs `.runtime/cloud-history-016/final/`; earlier recovery-state/journal checkpoint
2,242 PASS in `.runtime/cloud-recovery-state-015/`. Tests include snapshot mutation,
forgery, capacity/ignored writes, semantic-key corruption, conflicting answers,
active/reappearing owners, changed revision, idle/Goal gates and post-write tamper
rollback. Real backend observation adapters and full recovery scheduling remain
unfinished, as do Windows/live validation and fresh Rust differential execution.


## Selected-target authoritative recovery

Connected recoverTarget to the same target-lock registry, state facade and
start/complete coordinator. Observation and mutation are separate lock passes as
in Rust. Starting attempts preserve lease/ambiguity; Running terminal history
waits for final delivery; old Pending generations are adopted only after successful
resume/read and start uses that captured baseline without a second resume/read.
Read and mutation unavailability remain distinct and unknown untyped history is
refused rather than inferred. Error types and retry policy are shared modules.

Async-held targets use read-only historical APIs with one 10-second deadline,
resident/generation rechecks and an optional control permit. Without a gate only
review candidates are retained; settlement requires the control-gated second
observation. A timeout aborts the adapter signal and releases its permit; actual
transport cancellation still depends on the future adapter honoring AbortSignal.
No backend support means no historical settlement, not a resume/start fallback.

Recovery bootstrap ports legacy definite-fork repair: exact unobserved, nonambiguous
handoffs get durable notices before retirement. Notice failure rolls back the
marker and handoff together. Exact-routing mode reuses copy-only retirement.
No new fork operation is performed by selected-target recovery.

Full Linux suite: 2,277 PASS, zero failed/skipped; strict TypeScript PASS, including
a real 10-second timeout/permit cleanup test. Logs `.runtime/cloud-target-recovery-017/`.
Bulk recovery inventory/unmanaged-target and conflict-fork orchestration, Goal
progress/handoff writer, intake promotion, real backend/Discord adapters, central
runtime error dispatch, Windows and live validation remain incomplete. The
recovery report/log callback is not a substitute for that final error-dispatch wiring.


## Owned Goal progress and successor handoff

Added owned progress staging with exact full-job/unique-owner checks, durable
payload conflict detection, mirror-origin retention, goal-waiting transition and
journal consumption in one transaction. Empty progress still preserves waiting
custody without fabricating a message. Pending/error/completion APIs and the
legacy NULL-job protection predicate are available through the state facade.

Observed Goal attachment preserves original execution generation and separately
binds the actual turn-observation generation. It refuses duplicate all-generation
Running owners, stale snapshots and completed-origin rewind. Async obligations
require exact original sealed owner and accepted prior terminal proof; the new
handoff retains that proof, hashes declaration-ordered evidence, checks the
128-entry lifetime chain and revision overflow, and atomically advances policy
revision. Failure rolls back the queue update and handoff evidence together.

Runtime Goal APIs use the shared target mutex, recheck live observation generation
after acquiring it, and snapshot expected jobs before awaits. Compatibility
attachment remains its existing separate behavior and does not manufacture async
handoff authority. Legacy non-owned progress staging is not newly implemented.

Full Linux suite: 2,289 PASS, zero failed/skipped; strict TS PASS. Tests include
cross-generation exact successors, no-proof/ignored-CAS rollback, evidence-chain
capacity/revision overflow, stale and delayed events, duplicate owners, immutable
payload conflicts and continued terminal settlement. Logs `.runtime/cloud-goal-handoff-018/`.
Actual notification/Discord adapters and bulk scheduling remain unfinished.


## User-requested second phase (registered 2026-10-07)

Complete the first implementation before changing its Rust authority. Then apply
`ts-runtime-parity-pro-reviewed-20261007.md`, review ID
`TS-RUNTIME-PARITY-20261007-R2`, together with the final Rust deployment-review
changes. The original is retained privately in the user's Library, not published
here. Whole-file SHA-256:
`a0799cfa3d7419a45e7003e1f579167a05dcdca0a8709dc4f891e7b0ac04bb72`.
Reviewed-body SHA-256 (UTF-8/LF):
`b38ec59008b6a98955ca86b0e13034d05eda3b045152e8df1fa235e02c06f22a`.
Both identities were independently checked. Its PASS is document/plan only.

After freezing the phase-1 TS commit/evidence:
1. Pin the final reviewed Rust commit and actual CI/release evidence. Current
   observed review refs are integration/stabilization-pr2-20261007 at
   `6c9b06b9b898918f7e3a28ad43203bbb789a06df` and fix/stabilization-ci-20261007 at
   `57ad8c01ae4895a81858c728d8ab2511792c1d9e`; these are pending-review references,
   not approved deployment baselines. Repin at phase-2 entry.
2. Compare the new Rust delta against phase-1 authority
   `4e213aa69dc89bed1552d8b83e12471d7664b7ae`, preserving changed durable semantics.
3. Classify contract A-G as met/unmet/unverified using actual TS functions and
   evidence. Cover durable admission/cursor responsibility, bounded work/queues/
   bytes, event-loop isolation, DB ownership/concurrency, timeout versus real
   resource reclamation, late-result fencing and old/new runtime ownership.
4. Fix numerical latency/regression/capacity/recovery acceptance thresholds BEFORE
   the G1-G7 stress/crash/compatibility tests; do not move thresholds after results.
5. Implement and verify only evidenced gaps. Unit-test counts and document PASS
   do not establish performance, 24-hour operation or deployment approval.

The current DatabaseSync implementation is synchronous and its final isolated
execution placement is still unfinished. AbortSignal timeout is not evidence of
actual worker reclamation. These remain explicit second-phase evaluation items.
The document adds no live DB, replay, deployment or main-merge authorization.

## 2026-10-07: durable prompt intake and queue transfer

Root implemented the pinned Rust prompt_intake read/write/lease/promotion flow,
shared strict intake decoding with late Stop binding, and added ingress ownership
and immutable attachment preparation. The original ingress envelope is retained;
preparation fingerprints bind the exact original envelope and prepared prompt.
The queue transfer validates current lease, stable identity, both queue identity
lookups, held targets, mirror mapping and new-input evidence in one transaction.
A renewed lease can be used by the original token's snapshot; transformed queue
prompt intentionally need not equal raw input. Final intake deletion failure
rolls back queue/evidence writes. Claim and new-job values are copied before waits.
QueueStartCoordinator.submitPromptIntake uses the same target lock and central
StateAccessFacade as ordinary submission, and commits transfer before dispatch.

Authority remains Rust 4e213aa69dc89bed1552d8b83e12471d7664b7ae:
crates/cdr-store/src/prompt_intake/{storage,read,write,lease,promotion}.rs,
ingress/{read,ownership,new_command,new_input,new_evidence,mapped_slash}.rs,
and crates/cdr-runtime/src/queue_runner/{submission,prompt_intake_submission}.rs.
Existing queue/mirror/new-reply primitives are reused rather than duplicated.

Evidence: .runtime/cloud-ingress-prompt-020 and cloud-intake-promotion-021.
The first integration run found one stale facade key-list assertion after adding
the promotion API; its original log is retained. The exact API list and direct
function-identity checks were updated, without weakening product validation.
No fresh Rust executable differential, Windows run, live transport or deployment
is claimed. Typed decode-error taxonomy is not yet an exact rusqlite error mapping.
The intake worker, new-thread admission and busy-choice routing remain unfinished;
startup-only lease release is implemented but is not called by any live startup.

Final combined target for this slice: **2,311 tests PASS, 0 fail/skip/cancel;
strict TypeScript exit 0** on pinned Node 24.21.0. This is isolated SQLite/pure and
injected-backend runtime evidence, not full bridge readiness. Existing hook hashes
remain unchanged. Phase-2 contract registration above does not alter phase-1 pin.

## 2026-10-07: new-thread intake admission and busy-choice receipts

Implemented the source-backed atomic new-thread admission: original prepared input,
actor/event identity and recorded creation generation are verified before managed
ownership, intake handoff and optional acknowledgement seed are committed together.
The existing Windows-native-path seed adapter is reused; this adds no Linux-native
path certification. Optional reply data is snapshotted before asynchronous opens.

Busy-choice creation/read/claim/release/count/cleanup and busy-queue admission now
preserve the original route and exact displayed choice. Acceptance, intake and
canonical owner receipt share a transaction. Receipt repeats return no intake
preparation authority even after transient choice/intake removal; no automatic
replay is inferred. Expired/corrupt rows are decoded before cleanup as in Rust.
Exact-room mapping duplicates fail, while one project fallback is retained.

Additional pinned Rust authorities: prompt_intake/{new_thread,busy_queue}.rs,
claims.rs, claims/creation.rs, mapping/thread.rs, ingress/ownership.rs and
new_reply/intent.rs. State implementations reuse the existing managed-target,
intake writer and reply-seed primitives. End-to-end Discord component admission,
control routing and intake preparation worker remain unfinished. Busy-choice
receipt serialization preserves typed field order; no fresh Rust binary oracle
was run. Evidence is in .runtime/cloud-intake-new-thread-022 and
.runtime/cloud-intake-busy-023, including 17 focused tests.
Final combined target: **2,328 tests PASS, 0 fail/skip/cancel; strict TS exit 0**.
This is isolated SQLite/pure/injected-backend evidence; full bridge and deployment
remain unfinished. No source, live service or configuration on 5060 was changed.

## 2026-10-07: prepared submission orchestration and component claims

Ported component claim acquire/release/count/cleanup transactions from claims.rs.
Added the queue_result.rs presentation leaf: original input echo uses Rust
whitespace and Unicode scalar truncation, and held/ambiguous outcomes are not
misrepresented as successful running work or automatic retry. The exact pinned
interview header is copied as inert data; it is not an instruction to this worker.
The presenter's acceptance diagnostic logging remains for outer runtime wiring.

PreparedPromptExecutor follows queue_submission.rs: busy check precedes prompt
preparation; intake canonicalization retains the original lease token; only the
submission error scope may retry mapping/source moves, at most once. Non-fork
backends refuse retargeting; disappeared mappings do not fall back to selection;
post-submit recovery errors cannot replay submission. Dependency interfaces for
actual fork/preprocessor/verified-control services are explicit and mandatory.
Those production services are not supplied by this slice. A real SQLite intake +
QueueStartCoordinator integration test confirms enriched prompt custody is
committed before the injected backend starts, while UI echoes original input.
Shared canonicalization is routed through StateAccessFacade (exact alias checked).

Evidence: .runtime/cloud-component-claims-024, cloud-action-result-025 and
cloud-prepared-submission-026. Actual periodic intake renewal/cancellation worker
is NOT implemented: Rust future-drop and JS Promise cancellation/reclamation are
not treated as interchangeable. No live adapter, actual cancellation or deployment
PASS is claimed by these leaf and injected-backend tests.
Final combined target: **2,342 tests PASS, 0 fail/skip/cancel; strict TS exit 0**.

## 2026-10-07: shared bridge state persistence

Ported bridge_state.rs selected/tracked thread state, settings and fork inheritance
into one BridgeState owner. Operations preserve unrelated lossless JSON, source
settings and any pre-existing target entry. Rust whitespace and UTF-8 key ordering
are retained; prototype-like keys are ordinary data. A single leading UTF-8 BOM
is accepted; corrupt bytes/JSON/nonobjects fail without replacing the file.

Save uses an exclusive same-directory temporary file, full write, fsync and
rename. Cleanup checks the temporary inode/device and never deletes the target.
Injected fsync/rename failures preserve original bytes and remove only the owned
temporary file. The pretty formatter operates on the existing lossless serializer's
tokens without JSON-number rounding. No fresh Rust serializer oracle was run.

Synchronous methods contain no await and require a single execution-context owner;
final filesystem-worker placement, Rust mutex poisoning equivalence, Windows
rename semantics and process-crash durability remain unverified. This is not a
cross-process file lock or directory-fsync guarantee. Evidence:
.runtime/cloud-bridge-state-027 (8 focused tests, actual full 2,350 PASS with
0 fail/skip/cancel, strict TS exit 0). No live bridge-state file was accessed.

## 2026-10-07: durable fork begin, response staging and finalization

Implemented fork_handoff.rs begin and target.rs stage/finalize/cancel using the
complete storage.rs and transition.rs/transition/validation.rs authorities.
Shared full-record reads now support ID/source/ambiguous-job selectors without
reconstructing rows. Beginning records a source mapping snapshot only after dead
hold, exact existing intent, 120-second Starting lease and other-in-flight checks.

Staging deliberately retains the observed response even when target custody will
fail finalization. Finalization validates source mapping and target non-use, then
atomically quarantines the ambiguous Starting job, publishes its notice, clears
old unresolved notices, moves pending jobs/intakes and mapping/detail state, and
CAS-marks the handoff complete. Failed finalization retains the separately committed
observation. Repeated completion preserves its original generation and does not
move work again. Unobserved cancellation refuses sticky ambiguity or any observed
target. Existing typed cancellation errors and notice/queue readers are reused.

Evidence: .runtime/cloud-fork-begin-028 and cloud-fork-target-029. One initial test
incorrectly assumed the fork schema survived a rolled-back failed begin; its log
is retained and the oracle now accepts absence as zero records. Product validation
was not loosened. Focused begin/read tests 19 PASS; target tests 6 PASS. Actual
full target **2,363 PASS, 0 fail/skip/cancel, strict TS exit 0**. Runtime RPC fork
orchestration and recording failure wrappers remain unfinished. No actual Codex
fork, live DB, Windows test or fresh Rust executable comparison was performed.

## 2026-10-07: fork failure recording and definite cancellation

Ported failure.rs and the exact-expected entrypoint of definite_failure.rs.
Ambiguous failure and unresolved notices share one transaction; later definite
reporting cannot clear sticky ambiguity. An observed target cannot be overwritten
by a fork-outcome error. Finalization errors preserve the observed target and stage
phase-specific notices. Definite cancellation compares all 12 expected handoff
fields before writing notices and deleting the fence atomically. Expected input
is copied before awaits through own-data fields; the field list is immutable.
Existing notice format/staging and typed cancellation errors are reused.

Evidence: .runtime/cloud-fork-failure-030. Six focused cases cover sticky ambiguity,
notice/cancellation rollback, observed-target protection, complete expected
identity and caller mutation. Runtime fork orchestration remains pending; no RPC
was sent. Final combined target: **2,369 tests PASS, 0 fail/skip/cancel; strict TS
exit 0** on pinned Node 24.21.0.

## 2026-10-07: selected-target fork runtime and ordered finalization locks

QueueForkCoordinator now drives the durable begin → RPC → response-stage →
finalize flow through StateAccessFacade and the same TargetLocks as queue work.
It follows completed chains, blocks unobserved unresolved intents, handles managed
and forced targets, and preserves typed backend/recording/staging/finalization
errors. Unknown JS backend exceptions retain the fence instead of authorizing
cancellation. Generation is evaluated even when a Starting job supplies the stored
generation, preserving Rust's eager map_or argument behavior. No actual RPC adapter
is supplied; tests inject the backend. Bulk unmanaged recovery remains pending.

TS-specific lock safety adaptation: after response staging is durably committed,
the source lock is released and source/target locks are reacquired in deterministic
order. Finalization rechecks the expected pair inside its transaction. This avoids
self-lock and AB/BA waits while durable intent prevents repeat RPC. A fault-injected
crossing-response test exposed a completed A→B→A cycle in the initial TS candidate.
The runtime's expected-routing path now refuses a target already used as another
fork source. The legacy store entrypoint without expected routing retains pinned
SQL behavior. This is an explicit extra runtime refusal, not an exact Rust-runtime
parity assertion or a demonstrated Rust executable defect.

Same-test SHA RED→GREEN evidence is retained in
.runtime/cloud-fork-coordinator-032/{red-tests.log,green-tests.log,same-test-sha.txt,
before-crossing-guard/fork-target.ts}. 8 coordinator tests PASS; ordered-pair and
store scope tests cover cancellation cleanup and stale routing. Actual full target:
**2,381 tests PASS, 0 fail/skip/cancel; strict TS exit 0**. Source authority is pinned
queue_runner/fork_handoff.rs and types.rs, with the lock/cycle adaptation above.

## 2026-10-07: action target services and saved-submission replay

ActionTargetServices connects actual queue fork/recovery, centralized store mapping
reads and BridgeState inheritance. Completed target chains do not fork again;
only ActiveWriter warnings on fork-capable backends trigger the source's one force
handoff/recovery/replay sequence. The same durable job is resumed and then read for
presentation; there is no new submission in this recovery path. Missing replay is
an error. Queue replay APIs by job/message/target remain read/presentation-only.
Mandatory prompt preparation and verified busy-control adapters are still separate.

Authority: action_executor/app_server_target.rs and queue_runner/submission.rs.
Real isolated SQLite + queue + filesystem integration covers completed-chain
settings inheritance, active-writer failure → one fork → same-job start, explicit
cycle failure, mirror lookup and no backend call on saved replay. Evidence:
.runtime/cloud-action-target-033. Final combined target: **2,386 tests PASS,
0 fail/skip/cancel; strict TS exit 0**. No live Codex, Discord or 5060 operation.

Phase-2 source checkpoint, independently read at 14:45 UTC: Rust PR #2
https://github.com/simdorei/codex-discord-remote-rust/pull/2 is merged, merge commit
`786e18994477f681dae1c48a31121c9f410c48ae`, PR head
`50a027209b38d1e0f9e1db0bfb64057f2281369f`. Separately, `git ls-remote` reports main
`ed47c482420631447f0a38ef55a8d29acc1f6f6a`. These identities are distinct. This does
not establish deployment approval or replace phase-1 authority `4e213aa...`.
Repin final reviewed source/evidence when the registered second phase starts.

## 2026-10-07: intake processing, lease renewal and recovery worker

PromptIntakeProcessor now composes durable admission, claim acquisition, original
route validation, prepared submission, atomic-promotion checks, manual hold
presentation, owned backoff, saved-request replay and ready-intake recovery.
Recovery continues other ready items after a backoff-recording failure and returns
the first recording error. Existing queued intakes are cleaned without replay;
dead-target holds retain their intake. All store access uses StateAccessFacade.
The caller's original busy policy remains stored, but admitted requests queue if
the target becomes busy, matching the pinned runtime's explicit durable policy.

PromptClaimLeaseRunner performs initial renewal, 600-second extensions and delayed
2-minute renewal ticks. Missing lease after durable queue/outbox transfer waits for
that operation rather than cancelling it. On lease loss/error, AbortSignal reaches
preparation and safe pre-dispatch boundaries; the runner joins processing before
returning. This is an explicit JS lifetime adaptation, not equivalence between
Rust future-drop and Promise cancellation. Processing adapters must not detach
owned work. Uncooperative work can still stall: no hard worker termination, bounded
reclamation latency or production transport cancellation is certified.

A real SQLite/injected-backend regression exposed cancelled intake submission
waiting on a target lock and then dispatching after unlock. The same unchanged
regression is RED→GREEN in .runtime/cloud-intake-cancel-race-036, including the prior
start coordinator and test SHA. Cancellation now removes waiters without releasing
foreign leases, gates late preflight/baseline continuation, and prevents new
pre-dispatch work. If a durable Starting claim already exists, it is conservatively
retained rather than silently reset/replayed. After dispatch begins, actual ACK or
ambiguous failure is awaited and persisted before target/admission release.

The 30-second periodic recovery worker uses a common admission gate, skips sealed
admission, reports other admission/recovery errors and never abandons an in-flight
cycle on shutdown. A delayed/coalesced timer starts its next period from late tick
consumption, avoiding catch-up bursts. Timer behavior is tested with controlled
Node timers; exact real-time Tokio scheduling/Windows timing remains unverified.
Startup release of all leases is deliberately not wired without singleton runtime
ownership. Real preprocessing, Discord transport and production startup remain
unfinished.

Pinned authorities: action_executor/prompt_intake.rs,
action_executor/prompt_intake/recovery.rs, queue_submission.rs,
prompt_intake_worker.rs and queue_runner/submission.rs/start flow. Evidence:
.runtime/cloud-intake-renewal-034, cloud-intake-processor-035,
cloud-intake-cancel-race-036 and cloud-intake-worker-037. Actual final combined
**2,417 tests PASS, 0 fail/skip/cancel; strict TS exit 0** on Node 24.21.0. No live
DB/service/Codex/Discord operation or fresh Rust executable differential was run.

## 2026-10-07: bulk queue recovery and unmanaged-target preparation

Connected recovery.rs bulk ordering to the shared QueueRecoveryCoordinator state:
repair/retire legacy handoffs, snapshot/observe all initial targets, prepare unmanaged
targets, rescan mutation targets, and mutate each under the same target registry.
Active-writer conflicts get only the source's safe handoff checks. If targets move,
a fresh observation/mutation report is returned (not summed with the first pass),
while original active-writer identities remain in the report.

Unmanaged preparation iterates Rust UTF-8 target order, excludes quarantined jobs,
skips held or unfenced in-flight targets, and continues only a typed nonfatal
blocker WITH a durable unresolved fence. Native/recording errors and refusals
without a fence are not swallowed. Read-unavailable targets do not prevent safe
independent targets from progressing. Simultaneous bulk passes share target locks
and cannot dispatch the same pending job twice in the tested single-process model.

Authorities: queue_runner/recovery.rs recover/recovery_targets/pass helpers and
fork_handoff.rs prepare_unmanaged_targets/fork_writer_conflict_if_safe/nonfatal
classification. Evidence: .runtime/cloud-fork-bulk-038 (6 focused) and
cloud-queue-bulk-039 (5 focused). Actual full target: **2,428 tests PASS,
0 fail/skip/cancel; strict TS exit 0**. The pinned whole-inventory observation
barrier/unbounded scan is retained; bounded incremental lanes and measured latency
remain later work, not certified by this pass. No live service/backend operation.

## 2026-10-07 — Original route and Stop revision snapshots

Added the pinned mapping/new_origin.rs route snapshot and the ordinary two-field
origin/read/validation subset of ingress/stop/revision.rs. Snapshots retain exact
room/project/parent identities and sorted chat candidates, excluding mutable
labels/timestamps. Stop capture requires an existing transaction; owned capture
opens read-only and does not initialize a missing store. Legacy missing evidence
stays revision zero; a current clock is never borrowed to authorize an old request.
Per-target history and index must match, and global clock must equal receipt max.
Archive subtree and Stop mutation/command orchestration remain separate unfinished
scope. New public ordinary-origin arguments reject accessors/proxies without
invoking them; this is a TS boundary constraint on top of Rust Value inputs.

The existing late-ACK Stop path now shares revision and mirror lookup helpers;
central StateAccessFacade exposes both owned snapshot reads. All 11 old late-ACK
regressions pass. New tests cover route ambiguity, borrowed transactions, exact
origin shape, stale/other-target revisions, corrupted histories, Unicode and
read-only non-migration. Native SQLite/isolated filesystem tests only.

Evidence: .runtime/cloud-origin-040. Final 30 focused tests PASS, full **2,439 PASS,
0 fail/skip/cancel; strict TS exit 0**. Earlier fixture column typo and facade
signature/key-list integration failures were corrected without weakening guards.
No full ingress admission, production startup, backend, Windows or performance
certification is implied; frozen Rust authority and phase-2 ordering unchanged.

## 2026-10-07 — Durable ingress admission, original order and new-prompt reservation

Connected the pinned ingress/admission.rs, ingress/new_prompt_arm.rs and
async_resolution/admission_order.rs paths. Owned admission snapshots its typed
request before the first await, opens one IMMEDIATE writer transaction, checks
both ID and original-event reads eagerly, returns duplicates before capture, and
keeps old processed messages without inventing journal/ordinal records. New rows
capture original route/Stop metadata, prepare any !new reservation, save the
journal, record its ordinal, save the processed marker and reverify the original
proof before committing. Wrappers can retain the same opaque WeakMap-backed proof;
cloning or serializing it does not acquire custody.

The ordinal digest uses exact Rust struct field order, raw serialized payload,
lossless i64 fields and normalized zero f64 timestamp bits. Current format is
checked per operation, not just by schema cache. Trigger mutation, ignored INSERT,
sequence exhaustion and later original-identity changes fail closed. Phase/state
updates remain outside original identity as in source. Duplicate/legacy paths do
not mint a proof. This is first-admission ordering, never execution/release authority.

!new without text reserves the next eligible same-room/same-owner human message.
Event order, mention-arm identity and original route snapshots are checked. A
changed route consumes the reservation with a refusal response. Downstream failure
rolls back reservation consumption together with journal, ordinal and processed
receipt. The unchanged access checks and final Discord response adapter are still
caller responsibilities. Payload API is an already-parsed Serde Value contract,
not a passive inspector for arbitrary hostile JavaScript objects/prototypes.

Actual evidence: .runtime/cloud-admission-order-041 (9 focused) and
.runtime/cloud-ingress-042 (30 focused including facade, full **2,461 PASS,
0 fail/skip/cancel; strict TS exit 0**). Includes concurrent same-event admission,
post-receipt fault injection, stale/changed route, command/bot/old-event/non-owner
reservation exclusions and unchanged ordinary Stop regressions. No live Discord
or Codex call, fresh Rust executable comparison or operational/performance PASS.

## 2026-10-07 — Ingress execution/result lifecycle

Migrated the pinned ingress/lifecycle.rs transitions and exposed owned APIs through
StateAccessFacade: acknowledge, bounded canonical confirmation retry, execution
claim, generation-bound thread/start and created-thread recording, result recording,
confirmation and staged processing-mode writes. Frozen slash targets recheck actual
mirror ownership before a claim. New attachments require the existing durable input
proof before thread/start. A matching original cancellation rejects a late result.
Result writes preserve original Stop receipt and New creation/verification/input
metadata even if a caller supplies conflicting fields; held records reject results.

The existing new-reply decoder gates confirmation by the normal acknowledgement
receipt (internal Action is the source exception). This retains the source's TWO
separate opened connections for reply lookup and final confirmation UPDATE; no new
atomic acknowledgement guarantee is claimed. Processing mode remains writable
while staged, including repeated staged writes as in source, and freezes after
that state transition. These behaviors are recorded rather than silently hardened.

Evidence .runtime/cloud-ingress-lifecycle-043: 10 new lifecycle cases, 18 focused
including facade identity checks, full **2,471 PASS / 0 fail/skip/cancel; strict
TS exit 0**. Fixture syntax typo corrected before tests. No live backend calls,
production message-handler integration, startup, fresh Rust executable differential,
Windows or performance certification. Central error dispatch integration remains
unfinished; RequestCancelled is a typed error, not an automatic replay signal.

## 2026-10-07 — Slash route and New creation context custody

Connected mapped_slash.rs admission and new_creation.rs context recording. Slash
ask/interview mapping is resolved inside original admission's writer transaction,
with no selected-target guess. Duplicate admission retains its original target;
execution still rechecks the frozen route. Unsupported envelopes and ambiguous
rooms refuse. The supported-envelope predicate is shared with execution checks.

New creation context writes require the same semantic room/project snapshot from
classification/admission, exact generation-bound thread/start phase, original
channel and an unwritten new_creation field. Display metadata is excluded as in
source; null cwd is permitted, blank cwd refused. Context cannot be overwritten
by a retry or a later created-thread acknowledgement.

Evidence .runtime/cloud-ingress-routing-044: 5 new cases, 23 focused with lifecycle
and facade regressions; full **2,476 PASS, 0 fail/skip/cancel; strict TS exit 0**.
No remote thread creation, live routing, full bridge startup or deployment occurred.

## 2026-10-07 — Busy interaction original custody and canonical repeats

Migrated ingress/busy.rs before-ACK custody: durable receipt first, then original
non-duplicate parent, then active unclaimed/unexpired choice. Owner and room must
match. The original choice and selected button action are persisted with admission.
A new interaction ID can become a canonical duplicate linked to the durable prompt
or parent ingress after transient choice expiry. Held rows do not acquire duplicate
execution ownership. Explicit preflight rejection without control dispatch is
excluded from parent selection. allow_steer remains only the source display snapshot,
not permission to issue a Steer RPC; actual control verification remains downstream.

Later custody UPDATE retains/reverifies the original admission proof, so injected
identity mutation rolls the entire new admission back. Malformed durable receipts
are not replaced with a fresh live choice. BusyChoice deserialization uses the
existing raw typed-struct parser, extended narrowly for f64 and Option<String>:
duplicate fields reject, missing map Option defaults to null, short sequences
remain invalid, explicit defaults take precedence. No new Rust executable oracle
was run for this extension; tests plus pinned Rust field/call-path inspection are
the evidence, not universal Serde compatibility certification.

Evidence .runtime/cloud-ingress-busy-045: 10 new cases / 18 focused including facade,
full **2,486 PASS, 0 fail/skip/cancel; strict TS exit 0**. Existing typed-parser and
queue/ingress regressions are included. No live control RPC, handler/startup,
Windows, performance or deployment approval is established.

## 2026-10-07 — Ingress hold/recovery and owner-scoped inspection

Migrated the bounded hold/prior-runtime path from ingress/recovery.rs and the exact
archived_rejections::preserves predicate, plus owner-scoped reads from ingress/read.rs.
Recovery never dispatches Codex work. Owned requests retain their existing queue/
intake authority; only missing acknowledgement recovery is marked. Known cleanup
refusals preserve their original outcome and do not stage a new differently keyed
Saved POST. Exact archived audit AND extant matching fence preserve the closed
room without fabricating confirmation. Other unowned records receive one durable
notice, with preserved known/not-executed/unknown outcome distinctions. Hold changes,
notice staging and prior-runtime batches share a writer transaction and roll back
on notice failure. Public-safe reasons are truncated by Unicode scalars without
materializing the whole input as an array.

Owner inspection opens read-only, checks the exact schema version, filters room/
actor before decoding, and never initializes or migrates a file. Review lists retain
the source 20-row cap. Prior-runtime recovery keeps the source unbounded inventory
read, and explicitly REQUIRES the exclusive runtime guard before intake; it is not
wired to startup yet. Legacy manual-reserve retirement and recovery-command claim/
cancellation sequences remain separate unfinished work.

Evidence .runtime/cloud-ingress-recovery-046: 10 new cases / 18 focused with facade;
full **2,496 PASS, 0 fail/skip/cancel; strict TS exit 0**. Includes partial-batch rollback,
closed-room evidence, one-notice behavior, malformed other-owner payload exclusion,
read-only missing/old schema and owner pagination. No live effects or deployment.

Remote refresh requested by the user: Git advertised TS main 47d0f7f unchanged and
Rust main ed47c482420631447f0a38ef55a8d29acc1f6f6a unchanged from the prior latest
observation; both repositories' branch heads were enumerated. Rust is 29 commits
INCLUDING merges / 41 files beyond phase-1 pin. Selected new production diff was
read: channel-scoped Final head ranking, one-transaction already-confirmed final
retirement with ordinary fallback, current-catalog/receipt helpers, plus the listed
Codex discovery/process changes. Raw immutable delta and inventory retained under
.runtime/phase-2-contract. These are phase-2 obligations, not already-ported features;
phase-1 authority was not changed and full 41-file review remains pending.

## 2026-10-07 — Original recovery-command custody and cancellation owner validation

Migrated ingress/recovery_custody.rs and ingress/cancellation.rs owner validation.
A Recover/Repair claim compares every stored ingress field to the caller's original
snapshot, requires the exact message/event/source identity and executing/processing
phase, validates the persisted command/route, then records recovery_claimed once.
The opaque claim keeps the original post-claim row privately; validation before each
consequential step rejects changes, forged/cloned claims and current mapping drift.
A Selected route still REQUIRES the runtime's separate exact selected-thread snapshot
check; the store alone does not grant selected-target authority. No recovery RPC or
request-cancellation sequence is wired by this slice.

Cancellation owner lookup validates EVERY matching job/event ingress before returning
keys. Same-room ordinary owners must match exactly; a New request originally admitted
in another room additionally needs versioned creation evidence and the current exact
new-room mirror. It never rewrites the original channel, mutates a queue or cancels a
request. Caller-owned transaction lifetime is preserved.

Evidence .runtime/cloud-recovery-custody-047: 12 new cases / 20 focused with facade;
full **2,508 PASS, 0 fail/skip/cancel; strict TS exit 0**. Tests cover single original
claim, changed expected input, post-claim mutations, route drift, external selected
precondition, borrowed rollback, all-owner conflict and cross-room creation checks.
No native Rust execution, live backend, full restart/recovery controller, Windows,
performance or deployment certification is claimed.

## 2026-10-07 — Ordinary pending cancellation

Migrated queue/cancel_pending.rs plus cancel_ingress.rs into one owned writer path.
Candidate order combines queue, intake and unowned Ask/Interview ingress rows by
the source ordering and chooses the latest ELIGIBLE row (an older pending request
may be selected while newer started work remains intact). Only exact pure active-
writer preflight evidence admits the source's attempted-but-unstarted exception.
Room-route, unresolved/moved fork and dead-generation guards precede cancellation.

Job/event ownership must be unambiguous and have no uncertain outbox. The immutable
cancellation receipt, pending row deletion and all original ingress outcome updates
share one IMMEDIATE transaction. Scalar/array prior results are preserved under
prior_result for ordinary cancellation. Unstarted ingress updates use the exact
original event/target/room/owner and state predicates. Claimed intake can be removed
before promotion; existing cancellation triggers prevent resurrection. This does
not interrupt a running Codex process or certify preparer resource reclamation.

Evidence .runtime/cloud-cancel-pending-048: 9 new cases / 17 focused with facade,
full **2,517 PASS, 0 fail/skip/cancel; strict TS exit 0**. Tests cover replay fencing,
started-work refusal, precise preflight exception, intake withdrawal, unstarted
custody, prior-result preservation, ownership/outbox ambiguity, routing/generation
fences and failed-delete rollback. Full recovery cancellation and live command
routing remain unfinished; no production or deployment change occurred.

## 2026-10-07 — Explicit full-recovery cancellation and Stop revision revocation

Migrated queue/cancel_recovery.rs and the recovery-cancellation branch of
stop/revision.rs. All scoped queue/intake owners must match the original room and
actor and stay within the combined 128-request bound. Queue/intake evidence is
retained in execution holds before cancellation receipts and removal; started or
uncertain requests are counted explicitly. Existing delivery outbox is retained.
Unowned Ask/Interview preparations also lose replay authority with original payload
and state preserved as evidence. Later actor/scope/check failures roll back the
whole transaction, including earlier tentative cancellations.

The trusted synchronous custody check runs before and after the sequence. Its
TypeScript return type is undefined; direct async/generator/proxy callbacks are
rejected before their body and non-undefined returns refuse. This is an INTERNAL
trusted callback contract, not a sandbox for arbitrary or detached JavaScript work.
The final original Stop revision is advanced by checked clock/receipt/index writes
and reverified, even for an empty cancellation scope, so earlier ordinary RPC
metadata cannot borrow the new state. No process-exit proof or interrupt grant is
inferred: the external recovery controller must establish process termination.

Evidence .runtime/cloud-cancel-recovery-049: 10 new cases / 18 focused with facade,
full **2,527 PASS, 0 fail/skip/cancel; strict TS exit 0**. Source/test hash inventory
was pinned before the resumed verification and unchanged afterward. Earlier saved
logs retained separately. Tests cover dead-generation/outbox preservation, mixed
queue/intake and unowned work, owner/128-bound rejection, final-check and ignored
revision rollback, async-check rejection, empty/max revision and invalid UTF-8
intake evidence. No live DB/backend/process or production deployment was touched.

## 2026-10-07 — Discord text chunks, logical nonce and sequential retry

Migrated cdr-discord text.rs and delivery.rs's bounded millisecond policy profile,
plus idempotent_message.rs::message_nonce. Text splitting preserves Rust Unicode
scalar boundaries and whitespace behavior (NEL trimmed, BOM retained), preferred
newlines, exact structured-payload whitespace and the 32-character marker budget.
The source's short-limit truncation suffix behavior is deliberately retained.
An independent simple scalar reference matches deterministic mixed-input cases.

Nonce framing uses the exact context, UTF-8 byte-length prefixes and big-endian u64
identities/index, then masks the SHA-256 prefix to signed i64 range. Both immutable
Rust contract goldens match exactly (2340874901045434203 and 3227115366091472613).
This is time-window server nonce support, not permanent exactly-once delivery.
HTTP request building, mention/component policy and receipt handling remain next work.

Retry owns snapshots of chunks/delays, waits for each actual send, retries only the
same indexed failed chunk, and preserves exact failure part/attempt/raw source.
Defaults are 750ms then 2000ms. Supported injected policies are nonnegative integer
milliseconds within Node's native timer range; general Rust Duration/nanosecond
semantics and task-drop/abort/resource reclamation are not certified by this adapter.

Evidence .runtime/cloud-discord-delivery-050: 12 focused, full **2,539 PASS,
0 fail/skip/cancel; strict TS exit 0**. Pure formatting/golden and injected transport/
sleep tests only; no live Discord request, publication or production startup.

## 2026-10-07 — Nonce-enforced request construction and bound button protocol

Added immutable CreateMessage request construction, preserving content, exact u64
nonce JSON, the four-field no-components body and optional generated components.
Default mention serialization is parse:[]; false replied_user and empty roles/users
are omitted. This was checked against twilight-model 0.17.1's official source and
its serializer, rather than inferred from Discord UI behavior.

Migrated all helper button rows and custom-ID variants from components.rs and its
six children: busy, legacy/bound approval/input, async options and publication/
abandonment intent. Strict canonical fingerprints/revisions, bounded IDs and Unicode
labels are retained. Thread/request fingerprints match FOUR pinned Rust goldens,
including String versus Integer IDs and per-occurrence binding. Persistent claim
keys retain their original domains and answer-independent scope; busy/recovery
intents remain excluded from this generic claim mechanism.

Only helper-produced immutable button/action-row objects serialize through this
bridge profile. It is not a generic codec for every Twilight component variant.
No copied/forged object can add arbitrary wire fields. Component parsing or rendering
is not approval, execution or release authority; worker authorization is still needed.
HTTP transport, full Message receipt decoding and permanent delivery receipt
integration are NOT implemented by this pure request-construction slice.

Dependency evidence: Cargo.lock pins twilight-model 0.17.1. Official tagged source
https://github.com/twilight-rs/twilight/tree/twilight-0.17.1/twilight-model/src
was read in relevant ranges: allowed_mentions.rs git blob
63d66bad30591cc7fbd4d7910e9c8cce6ebe9cfe; component/mod.rs serializer
be7ce26a07b4ae685811685498aef00809078a48; component/action_row.rs
4399bb454a738b34968223cbf8d103405d4cf299; component/kind.rs
edf64202f5a00388cda94c2f30b28e887731f1ce; http/interaction.rs
c2d7416389e7c28f99e9517d375ddf525988165c. These are returned Git blob identities,
not a fresh dependency build or full-crate hash/behavior certification.

Evidence .runtime/cloud-discord-request-051: 18 new cases / 30 Discord-focused,
full **2,557 PASS, 0 fail/skip/cancel; strict TS exit 0**. No real Discord message,
credential configuration, component click or backend operation was performed.

## 2026-10-07 — Durable message receipts and original delivery-claim guards

Migrated delivery_receipt.rs intent/confirmation/rejection states with the complete
claim-time dependencies used by this slice: new_reply claim/notice, legacy Reserve
transition/start notice validation, and existing final_recovery grant validation.
An unknown intent never becomes New on reopen. An authoritative no-message rejection
may release one same-content retry; blocked rejection stays blocked. A confirmed
message ID cannot be replaced. Intent and acknowledgement/warning state changes
share the writer transaction and roll back together on identity or SQL failure.

New acknowledgement keys/body hashes bind the original first-turn identity and room.
Only its confirmed normal receipt opens the acknowledgement barrier; warning receipts
do not. Generated output still needs verified first input and exact-turn custody.
Historical Reserve notices validate recorded held/no-turn state and actual mapping,
without entering or restoring automatic Reserve. Existing final-recovery grants
recheck exact saved final identity/content, the original confirmed error receipt,
one canonical ingress, current destination and absence of executable/progress custody,
then bind each actual chunk hash and delivery guard. This slice READS existing grants;
it does not implement the separate authorize operation or grant publication approval.

Typed receipt keys preserve the original i64/String/String/usize profile, including
large integer boundaries. Acknowledgement recovery permission alone cannot resend an
unknown or operator-blocked intent. HTTP transport and full Twilight Message receipt
decoding are still unfinished; no actual message was sent. Definite-rejection APIs
require trusted authoritative failure classification from that future adapter.

Evidence .runtime/cloud-delivery-receipts-052: 16 new cases / 24 focused with facade;
full **2,573 PASS, 0 fail/skip/cancel; strict TS exit 0**. Covers reopen/no-replay,
one retry, immutable confirmed ID, new ACK/warning isolation, drift rollback,
continuation ownership, legacy notice predicates, final grant conflicts and atomic
confirmation failure. One Reserve test fixture initially omitted the stored attempt/
error setup; corrected fixture and original RED log retained, guards unchanged.
Source-authority scope is pinned Rust 4e213aa; newer complete_confirmed optimization
remains phase 2. No live HTTP, process, Windows or performance certification.

## 2026-10-07 — Final-only read preflight and visible-first-reply ordering

Migrated delivery/preflight.rs with first_reply::pending_in and the existing
commentary/Goal predicates. A CheckedRead snapshot validates an existing saved-final
grant first, then New readiness, earliest visible original reply, commentary and
Goal progress in the pinned order. Later unconfirmed canonical duplicates do not
re-close a confirmed original reply; headless Actions have no ordinary first-reply
barrier. Explicit saved-final grants retain only the existing exception and still
revalidate their error/progress evidence. Readiness is never cached or itself a send
authorization; the receipt writer must independently validate the actual claim.

A stable typed StoredDelivery snapshot rejects caller accessors before opening the
read, and the read snapshot finishes before any result returns. Existing receipt
fixtures were factored into a shared test-only helper without changing guards.
Evidence .runtime/cloud-final-preflight-053: 8 new cases / 32 focused with receipts
and facade, full **2,581 PASS, 0 fail/skip/cancel; strict TS exit 0**. Tests exercise
live data changes between read snapshots, exact ordering, legacy/foreign-job Goal
scope, grant error precedence, missing-file read-only behavior and zero getter calls.
No POST, grant creation, backend connection, worker-loop scheduling or performance
certification is established by this preflight slice.

## 2026-10-07 — Receipt-aware chunk send orchestration

Connected completion_worker/receipt.rs ordering: validate immutable request before
storage, claim the exact logical intent/body (including component tuple bytes),
skip Delivered, refuse Unknown/conflict/blocked/Held without sending, then await a
trusted transport's validated nonzero u64 message ID and commit its receipt. Input
chunk/guard/component data is captured before storage awaits. Simultaneous same-key
calls cannot both reach the transport in the tested SQLite ownership model.

Failure classification follows the pinned typed categories/status list: only 429
is retryable; authoritative local/selected 4xx rejections block; transport, receipt
decode, 5xx and unclassified failures stay unknown. Registered fault metadata is
private, so forged/proxy errors cannot create retry authority or trigger property
inspection. After accepted-message receipt commit failure, no new send is permitted.

The transport is a REQUIRED trusted interface. It must decode the COMPLETE provider
response before returning an exact bigint ID; this slice validates that returned ID
but DOES NOT implement or certify the HTTP/Twilight Message decoder. No production
transport default, credentials or network POST is installed. Caller must own/await
the whole Promise; detached work, task-drop equivalence and hard cancellation are
not certified. Full completion-loop/error-dispatch integration remains unfinished.

Evidence .runtime/cloud-receipt-sender-054: 12 new cases / 33 focused, full
**2,593 PASS, 0 fail/skip/cancel; strict TS exit 0**. Uses real isolated receipt store
and injected transport only. Tests include in-flight same-key concurrency, exact
nonce retry, definitive versus ambiguous failures, zero-trap forged errors, no-file
invalid input, commit failure, component identity changes, held New output, invalid
IDs, beyond-IEEE754 confirmed ID preservation and caller mutation after entry.

## 2026-10-07 — Completion logical delivery identities

Ported pinned completion_worker/delivery_identity.rs: outbox, Goal progress and
commentary have separate nonce domains; compound keys use UTF-8 byte lengths.
Commentary hashes Rust White_Space-trimmed UTF-8 followed by one zero byte. The
sequential chunk adapter preserves logical key, index and content across retries.
Factory-owned immutable identities reject forged/accessor inputs before sending.
This is identity construction and injected callback orchestration, not permission
or a production completion worker. Full HTTP and response decoding remain absent.

Evidence .runtime/cloud-completion-identity-055: 6 new tests, full **2,599 PASS,
0 fail/skip/cancel; strict TS exit 0**. UTF-8 lengths, NEL/BOM distinction, source
retry scenario, domain isolation, empty policy failure ownership and zero-trap
forgeries are covered. No fresh Rust executable differential is claimed.

## 2026-10-07 — Completion and commentary message formatting

Ported pinned completion_message/commentary_message and error_message::readable_error.
Final/Failed/Interrupted/InProgress headings and non-complete Goal prefixes preserve
exact-empty distinctions. Error envelopes peel at most four times using the existing
Serde Value parser: present nested null/nonstring blocks fallback, unknown JSON is
retained, and successfully peeled text is not silently retrimmed. Own-only lookup
prevents inherited property interpretation. This pure function expects an already
validated outcome status; it neither observes nor finalizes a live turn.

Evidence .runtime/cloud-completion-message-056: 5 new tests, full **2,604 PASS,
0 fail/skip/cancel; strict TS exit 0**. Covers all status/Goal labels, Unicode trim,
known envelope precedence, nesting cap, malformed/range-invalid Serde input and
last-duplicate-key semantics. No new runtime or deployment certification.

## 2026-10-07 — Final outbox delivery orchestration

Connected final preflight, immutable outbox identity, guarded receipt chunks and
outbox retirement in pinned phase-1 order. There are no within-invocation retries.
Held returns without a failure timestamp or attempt increment; other preflight/send
failures record once, and a recording/clock failure takes precedence. Retirement
runs only after all receipt confirmations and is outside failure recording. Later
invocations skip confirmed earlier chunks; unknown sends remain unsent. Batch helper
awaits every item and returns the first thrown value, including undefined.

REQUIRED adapters remain: trusted full-response-validating transport, Unix clock,
and one synchronous passive/public-safe failure renderer. This slice preserves raw
errors and partial-chunk metadata but does not claim exact Rust Display/Debug text
or install a production central error dispatcher. A validating finite timestamp
check is the explicit TS clock boundary. Scheduler, start/commentary integration,
HTTP, native cancellation and newer complete_confirmed optimization remain pending.

Evidence .runtime/cloud-final-delivery-057: 11 new real SQLite/injected transport
cases; full **2,615 PASS, 0 fail/skip/cancel; strict TS exit 0**. Covers partial 429
retry, ambiguous no-resend, Held, commentary barrier, bad channel, failed receipt
commit, failed retirement/reentry, clock/record error precedence, input mutation and
sequential batch failure ownership. Initial commentary fixture used nonexistent
columns; corrected fixture only, original RED retained, production guards unchanged.

## 2026-10-07 — Durable commentary outbox

Ported commentary_outbox stage/pending/has_pending/complete. Stage captures the
running thread/turn owner inside BEGIN IMMEDIATE, rejects dead targets, trims with
Rust White_Space and deduplicates the exact Serde tuple digest without replacing
saved owner/channel/text. Missing running owner returns None before dead-target
lookup. Pending reads preserve sequence ordering and typed lossless SQLite values.
Existing final preflight now reuses the shared job/before predicate; four owned
entrypoints join StateAccessFacade (102 functions), with no borrowed handles exposed.

Evidence .runtime/cloud-commentary-outbox-058: 8 new tests / 24 focused, full
**2,623 PASS, 0 fail/skip/cancel; strict TS exit 0**. Tests cover deduplication, byte
hash/trim semantics, saved-owner retention, strict sequence barrier, held targets,
failed insert rollback, borrowed transaction preservation and native missing-table
errors. Empty source commentary is intentionally preserved. No HTTP or runtime
commentary loop is connected by this storage slice.

## 2026-10-07 — Ordered commentary receipt delivery

Connected delivery_order.rs: New readiness, then original visible first reply,
then earlier same-job commentary are checked through owned state entrypoints.
The immutable commentary snapshot is sent with its source domain/trimmed digest,
heading and New claim guard. The shared chunk sender now serves final and progress
paths. Sequence retirement occurs only after confirmed chunks. A pending batch
continues unrelated jobs after the first error; later same-job items remain held.

Evidence .runtime/cloud-commentary-delivery-059: 6 new cases / 17 focused with
final delivery, full **2,629 PASS, 0 fail/skip/cancel; strict TS exit 0**. Tests use
isolated SQLite and mandatory fake transport, including original ACK/New barriers,
retirement failure and confirmed-receipt reentry, failed-job isolation and zero-read
caller accessors. Production scheduler/log dispatch, real HTTP/full decoder and
native cancellation are still unfinished; separate owned reads are source behavior,
not an atomic authorization snapshot or permission to bypass the receipt writer.

## 2026-10-07 — Goal progress receipt delivery

Ported goal_progress.rs delivery ordering: legacy missing-job evidence is retained;
New/original first-reply readiness and signed channel conversion precede send-stage
error recording. Goal identity uses thread/turn, the shared guarded chunk sender
awaits confirmations, and only then retires progress. Send failures are recorded
through the mandatory central diagnostic adapter; record failure takes precedence.
Preflight and retirement failures do not rewrite saved error text. A late send-stage
Held is recorded per the source, unlike final-outbox Held handling.

Evidence .runtime/cloud-goal-delivery-060: 7 new cases / 24 focused, full
**2,636 PASS, 0 fail/skip/cancel; strict TS exit 0**. Tests cover legacy/early Held,
invalid channel, ambiguous no-resend, failed error record, confirmed-receipt recovery
after retirement failure and later-item recovery. Uses isolated SQLite and required
injected transport; production scheduler, full response decoder and central Rust
Display/Debug parity remain incomplete. No network POST or deployment occurred.

## 2026-10-07 — Start rejection notices and pending delivery phases

Added owned start-notice list/retirement through StateAccessFacade (104 functions),
and connected the source no-turn rejection receipt domain. Delivery revalidates
exact held no-turn job custody, never invents a turn, changes a model or reexecutes
work. The pending-output utility attempts start notices, commentary and final batches
in source order, retains the first batch error, and preserves the distinct immediate
final-list decode-error precedence. It installs no scheduler or logger.

Evidence .runtime/cloud-pending-delivery-061: 8 new cases / 16 focused, full
**2,644 PASS, 0 fail/skip/cancel; strict TS exit 0**. Tests include stale start custody,
confirmed-receipt retirement reentry, batch/first-error order, final barrier after
commentary failure, final-list decoder precedence and timestamp/job ordering.
All HTTP remains injected. These source inventory utilities are unbounded; the
separate bounded scheduler/metadata discovery is not yet ported, and the utilities
must not be presented as the completed production scheduling or latency contract.
