# Cloud migration checkpoint

Latest verified Linux checkpoint: **3,247 tests passed**, no failures/skips;
strict TypeScript passed. Includes native local helper-session tests, not live Codex/Discord.
Migration, Windows and production validation remain incomplete. See the chronological
sections below for exact scope and evidence; counts are not a full Rust-parity claim.

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

## 2026-10-07 — Bounded completion metadata pages

Ported completion_work.rs source selectors/receipt-head predicates (mechanically
copied exact string values from pinned SHA 9652d8f9100b373108713dab5c4ac200cec7b572d38c1d8b2a6a4a1789033378),
32-entry pages, one source/lane head, 4096-byte identity filter and fixed pass high-water.
Payloads are represented only by byte lengths; over-budget bodies remain durable.
Unknown/blocked receipts retain their source head instead of promoting a later sibling.
The TS API returns a new opaque immutable cursor, leaving input untouched on failure;
this is an explicit ownership adaptation of the source's mutable cursor.

Owned inventory entrypoints join StateAccessFacade (106 functions). Borrowed page
reads retain the caller transaction. Standalone page/target-head APIs preserve the
source initialized read transaction. The bounded scheduler's lazy CheckedRead round,
orphan negative-only preflight, payload revalidation/loading and lane scheduler are
STILL UNFINISHED; these metadata hints grant no execution or send authority. Phase-1
target lookup intentionally preserves ranking-before-target-filter; newer Rust's
changed Final ranking is separately queued for phase 2.

Evidence .runtime/cloud-completion-metadata-062: 14 new cases / 22 focused, full
**2,658 PASS, 0 fail/skip/cancel; strict TS exit 0**. Covers every source, high-water
append isolation, same-channel held heads, retry/blocked/confirmed receipts, invalid
receipt JSON, oversized Unicode metadata/body, runtime/generation question filtering,
orphan ownership, UTF-8 compound receipt prefixes, transaction/cursor preservation
and phase-1 target ranking. Initial malformed-data fixture attempted a forbidden NULL;
changed fixture to invalid non-NULL channel, retained original RED, no DDL relaxation.
No SQL execution-cost, memory peak, Windows or fresh Rust executable certification.

## 2026-10-07 — Bounded negative-only async orphan preflight

Ported async_resolution/preflight.rs (pinned SHA
ca9cebe782155992101e051e26f056b40106dd9e58527cf0758ffc096414a5ea):
128 rows and 2 MiB shared materialization budget, scalar size/overflow probes first,
then original-question validation. Returns input positions only; never permission.
Unrecognized storage/query errors propagate. JSON negatives are recognized by a
private weak identity set populated only at the existing pure validator's decoder
calls; the original thrown error identity/type is preserved. Arbitrary SyntaxError
objects or caller getters do not become negative evidence by their name alone.

Evidence .runtime/cloud-orphan-preflight-063: 8 new tests / 16 focused with history,
full **2,666 PASS, 0 fail/skip/cancel; strict TS exit 0**. Covers valid/invalid seals,
parser numeric range, native query/type failure, exact 128/overflow 129 boundaries,
byte preflight and cumulative budget, no evidence mutation and decode-error origin.
Initial corrupt fixtures tried to update immutable claims; replaced with initial
malformed inserts, retained RED, no production trigger or validation weakened.
The lazy metadata round/scheduler connection is still pending; no RPC is authorized.

## 2026-10-07 — Lazy checked metadata read rounds

Ported completion_work/round.rs: lazily open one CheckedRead, allow each of eight
sources once, clone cursors, recheck snapshot liveness after every page/negative
preflight, and finish before returning staged results. Open/liveness failure is
sticky and the original failure wins at round completion. Orphan sidecar is bounded
to one <=32-entry AsyncOrphan page and grants negative hints only. Retained readers
expire after callback completion. No requested page means no connection or file.
StateAccessFacade now exposes 107 owned entrypoints.

The callback is trusted synchronous code and must stage, not publish, its changes
until this function succeeds. Direct async/generator/proxy callbacks and native
Promise returns are rejected and their rejection drained; this is not a sandbox or cancellation of arbitrary
work launched by caller code. The scheduler's own ready-draft commit/rollback layer
is still unfinished, as are payload loading and state/HTTP lanes.

Evidence .runtime/cloud-metadata-round-064: 9 new cases / 17 focused, full
**2,675 PASS, 0 fail/skip/cancel; strict TS exit 0**. Real read-only snapshots plus
explicit test-only liveness/finish fault injection verify lazy opening, one snapshot,
source caps, post-page invalidation, original failure precedence, no result return
on finish failure, bounded orphan sidecar and expired readers. No runtime scheduler
or live RPC/HTTP was started; no performance/Windows certification.

## 2026-10-07 — Typed async-question occurrence reader

Ported async_question.rs Question/read as a borrowed read-only leaf for the upcoming
bounded payload loader. Scalar fields are decoded before body JSON, chosen is exact
optional u16 (not arbitrary u64), and the existing strict Serde QuestionBody decoder
preserves defaults/duplicate-field rules. This grants no ownership or dispatch right.
Node's undefined-on-missing result is represented by AsyncQuestionNotFoundError with
QueryReturnedNoRows kind; it is explicitly a TS adapter, not a native SQLite exception
or completed cross-language error-taxonomy certification.

Evidence .runtime/cloud-question-read-065: 5 new cases, full **2,680 PASS,
0 fail/skip/cancel; strict TS exit 0**. Large integer/default/null fields, u16 limits,
scalar-before-JSON failure order, duplicate body fields, exact optional strings,
caller transaction and malformed BLOB/missing-row cases pass on isolated SQLite.

## 2026-10-07 — Bounded completion payload loading

Ported completion_work/payload.rs and current-entry lookup. A deferred read snapshot
rechecks the full metadata entry against the current eligible source head before
loading any selected body, rejects payloads above 2MiB, then uses typed readers for
Observed/commentary/Goal/start notice/question/final records. Queue/orphan hints do
not produce a delivery payload. Caller hints are captured before asynchronous open.
Metadata equality deliberately does not certify content bytes or receipt authority;
same-length edits are read as current content and still require later claim checks.

Evidence .runtime/cloud-completion-payload-066: 9 new cases / 17 focused, reviewed
full **2,689 PASS, 0 fail/skip/cancel; strict TS exit 0**. Covers stale identity/head,
new unknown receipt suppression, inclusive byte bound, retained oversized evidence,
all payload variants, runtime/generation scope and getter-free hint capture. Earlier
test-file syntax errors and RED logs retained; corrected tests do not weaken source
checks. Missing rows inside the read snapshot use an explicit TS integrity adapter;
full native error-taxonomy parity, scheduler and real transports remain unfinished.

## 2026-10-07 — Bounded ready-queue selection

Ported lanes.rs Ready selection: combined cap 128, live target cap 16, state FIFO
per target, active-target exclusion, native saturation without same-target overtaking,
and HTTP channel serialization. Live hints displace rediscoverable metadata before
other payloads; durable HTTP hints deduplicate only exact source identities. Busy
metadata is discardable, while live work remains queued. Target metadata is captured
at insertion. Native-blocked admission releases its explicitly owned permit.

The live envelope/byte-charge and state-admission adapters are REQUIRED trusted
interfaces, not yet a production decoder or authority provider. JS disposal is
explicit: queued/rejected live owners are disposed, selected owners transfer to
caller, and shutdown must call dispose. This is not GC-based Rust Drop equivalence,
4MiB accounting certification, detached-task cancellation or a running scheduler.

Evidence .runtime/cloud-ready-queues-067: 10 new pure tests, full **2,699 PASS,
0 fail/skip/cancel; strict TS exit 0**. Covers capacity/eviction, target FIFO,
channel serialization, native-slot reservation, permit disposal, busy-hint removal,
priority replacement and mutation-resistant routing. No network or live process.

## 2026-10-07 — Transactional metadata discovery drafts

Ported Scan discovery, rotated metadata rounds and ReadyDraft semantics. Existing
pending hints are offered before reading; a full ready queue retains the complete
unoffered page and blocks further reads. Finished Queue/orphan scans wait 30s and
other sources 1s, unless explicitly woken; wake does not interrupt the current finite
high-water pass. Per-source failures revert only that source's speculative tail;
common snapshot/finish failure reverts all cursor/pending/rotation updates and tails.
Existing live references/permits are never cloned, displaced or released by drafts.

Orphan negatives are returned only for exact newly appended positions from that
same page. Discard touches only matching durable orphan hints, never evidence or
live work. Unoffered pending entries deliberately carry no negative facts into a
later snapshot. Runtime must consume sidecars synchronously before await/dispatch.
Append-only synchronous TS draft callbacks are required; they are not a sandbox for
arbitrary caller code. No state/HTTP task launch, timers or server logger installed.

Evidence .runtime/cloud-discovery-drafts-068: 10 new cases / 20 focused, full
**2,709 PASS, 0 fail/skip/cancel; strict TS exit 0**. Actual SQLite plus a test-only
finish fault verify rollback, lazy no-file rounds, duplicate-source isolation,
backpressure, finite wake passes, rotation and orphan evidence retention. Initial
tests assumed a nonexistent list alias and one-page restart; corrected to actual
SQL count and bounded two-page behavior, original RED logs retained.

## 2026-10-07 — Typed terminal outcomes and structured usage metadata

Ported outcomes.rs terminal parsing/history-state map/journal payload and the bounded
structured usage detector from error.rs. Invalid-turn/thread/id/status/error order,
exact status spelling, interrupted origin, i64 duration classification, 1000-scalar
failed-message bound and last-duplicate-turn sorted map behavior are preserved.
A non-null codexErrorInfo takes precedence over incidental nested usage tokens;
arrays/prose/429 alone do not match. Journal payloads omit arbitrary extra details.
Completion message formatting now aliases this shared TurnStatus boundary.

These functions expect already-decoded Serde Values, preserving bigint integer vs
number float semantics. They neither run an app-server nor authorize model switching
or automatic Reserve. Central registration of new errors and full cross-language
error taxonomy are unfinished. Final-text extraction is a separate remaining leaf.

Evidence .runtime/cloud-turn-outcomes-069: 8 new cases, full **2,717 PASS,
0 fail/skip/cancel; strict TS exit 0**. Covers exact error precedence, every terminal
status, duration limits/exponents/-0, structured depth/priority, accessor-free own
fields, Unicode bound, sorted history and sanitized journal roundtrip. No fresh Rust
executable differential or live RPC.

## 2026-10-07 — Explicit final text versus legacy fallback

Completed the pinned outcomes.rs text readers and the independent async-message
classification predicate. History keeps the last explicit final_answer even when
later commentary exists; only absent explicit text uses the weaker last-agent/empty
fallback, carrying explicitFinal=false. Async messages are excluded even if their
choices are malformed. Direct text and supported content blocks follow source trim
and join rules. Item completion requires original thread/turn IDs and exact phase.

Evidence .runtime/cloud-final-text-070: 6 new cases / 14 focused, full **2,723 PASS,
0 fail/skip/cancel; strict TS exit 0**. Duplicate-turn first-match, malformed items,
Unicode trim, legacy fallback and async-not-Final cases are covered. These readers
preserve evidence strength but do not themselves supersede a stored final journal,
observe a live stream or authorize a send.

## 2026-10-07 — Thread Goal parsing boundary

Ported goal.rs statuses, get/update parsing and terminal predicate. Goal/get retains
exact thread comparison, while updates trim both identities and optional turn ID.
Only Blocked and Complete are terminal; paused/usage/budget-limited are not silently
promoted. Shared Serde-value field/trim accessors now serve outcomes and Goal parsing,
and completion presentation aliases the same ThreadGoalStatus type.

Evidence .runtime/cloud-goal-status-071: 5 new cases / 24 focused, full **2,728 PASS,
0 fail/skip/cancel; strict TS exit 0**. All status spellings, missing/null goal,
validation precedence, get/update identity distinction, optional turn and NEL/BOM
semantics pass. These pure parsers do not perform Goal RPC or change queue state.

## 2026-10-07 — Bounded commentary stream buffer

Ported commentary_stream.rs with 128 active items and 16KiB UTF-8 scalar-safe retained
summary text per item. Completion removes its exact thread/turn/item buffer before
classification. Only completed camel-case agentMessage/commentary text emits;
reasoning summaries, final answers and async-question messages do not become progress
replies. Output comes from the completed item, never retained reasoning deltas.

Evidence .runtime/cloud-commentary-stream-072: 6 new cases, full **2,734 PASS,
0 fail/skip/cancel; strict TS exit 0**. Tests cover scalar byte boundaries, capacity,
exact turn discard, tuple-key separation, empty-delta behavior and excluded message
classes. Diagnostic retainedSummaryBytes excludes key/map overhead and is not a total
heap bound; live event charging, producer connection and scheduler remain unfinished.

## 2026-10-07 — Terminal revocation and retention version

Ported terminal_fence.rs identities and compare-version retention. Stop records the
exact u64 generation/thread/turn and publishes the wrapping version synchronously,
before I/O. A stale queue snapshot cannot prune a later terminal. Only current
same-generation exact queue identities survive successful retention. All provided
snapshot fields are validated before pruning, without invoking job accessors.

JS watch subscriptions coalesce pending changes, support cancellation without
consuming a future update and require explicit dispose. Selected/queued subscriber
ownership is not delegated to GC. This is one synchronous JS execution context;
Rust mutex poisoning, cross-thread synchronization, HTTP abort and native future-drop
behavior remain unverified. Typing transport/worker orchestration is not wired here.

Evidence .runtime/cloud-terminal-fence-073: 8 new cases, full **2,742 PASS,
0 fail/skip/cancel; strict TS exit 0**. Tests cover stale retention, immediate revoke,
coalescing, generation isolation, abort/reuse, subscriber cleanup and atomic
getter-free pruning. No Discord typing request or live process was started.

## 2026-10-07 — Revocable typing orchestration

Connected typing.rs eligibility/order using central queue/terminal reads, original
active turn, lifecycle generation and terminal fence. Channels are deduplicated;
Goal-waiting/nonrunning/observed-terminal jobs cannot send typing. In-flight revocation
aborts the REQUIRED injected transport, then awaits settlement and releases watches.
Backend/HTTP failures preserve first-error precedence while later channels proceed.

The JS adapter requires nonthrowing lifecycle change status, abort-settling watch
Promises and a transport that cancels pending dispatch and reclaims owned work.
It intentionally joins, rather than claiming Rust future-drop equivalence. Default
store reads are not offloaded like Rust spawn_blocking; native/network cancellation,
latency bounds and actual HTTP implementation remain unverified. A noncooperative
adapter can still delay cancellation. No live typing request was made.

Evidence .runtime/cloud-typing-074: 9 focused tests, including actual SQLite facade,
full **2,751 PASS, 0 fail/skip/cancel; strict TS exit 0**. A same-test RED/GREEN found
an unexpected post-dispatch watch exception could bypass transport abort/join; cleanup
now unconditionally aborts and joins all three owned Promises. Original source and
cancellation-red.log retained; fixed test SHA is in the publication manifest.

## 2026-10-07 — Revalidated HTTP-work dispatch

Connected scheduler/work.rs delivery selection to the existing guarded final,
commentary, Goal and exact no-turn start-notice paths. Every entry reloads its current
source head/body bound first; stale hints return without POST. Observed records are
state work and do not send through this dispatcher. Start delivery now shares one
owned-notice helper instead of duplicating its receipt/retirement sequence.

Question delivery requires a separate checked UI adapter and re-reads the current
server generation after loading, as the source does. No unchecked/default question
sender is supplied and no question authorization is inferred from metadata. This
module must run in a separately channel-serialized lane; lane task launch, full UI,
production transport and native cancellation are still unfinished.

Evidence .runtime/cloud-http-work-075: 7 new real SQLite/fake transport cases / 15
focused, full **2,758 PASS, 0 fail/skip/cancel; strict TS exit 0**. Current/stale final,
progress branches, legacy Goal refusal, no-turn custody, current-generation checked
question delegation, Observed no-POST and pre-open integer bound are covered.

## 2026-10-07 — Charged live event envelopes

Ported lanes.rs event charging and state.rs thread-identity precedence. Notification
method/target plus Serde JSON UTF-8 bytes share a 4MiB ownership budget; over-budget,
missing/oversized target and Gap inputs cannot acquire it. The counter preserves
scalar escaping/number encoding without building one full JSON string. Successful
charge freezes transferred params and returns a disposal-owned immutable envelope;
ready rejection/explicit shutdown release that ownership.

This is serialized-byte accounting, not total V8 heap measurement: object/key
enumeration and representation overhead remain outside the count. Callers must not
retain/use payloads after disposal. JS does not enforce Rust moves/Drop, and production
producer/lane lifetime wiring remains unfinished. No network or live event stream.

Evidence .runtime/cloud-event-budget-076: 9 new tests, full **2,767 PASS,
0 fail/skip/cancel; strict TS exit 0**. Exact 4MiB/+1 and 4096-byte multibyte target
boundaries, canonical count comparisons, getter/proxy refusal, immutable payloads,
native hints and queue disposal are covered. No throughput or heap PASS is claimed.

## 2026-10-07 — Exact server-request response ownership

Ported state/server_requests.rs pending/claimed/deferred transitions and 500-unsettled
capacity. An exact (typed ID, 128-bit occurrence) detaches a response claim; identical
redelivery while claimed is suppressed, changed ID reuse is deferred, and exact old
resolution promotes only that deferred occurrence. Indeterminate responses remain
unsettled and cannot be claimed again. Arrival order and original thread filtering
are preserved; numeric and string request IDs remain distinct.

Request metadata is copied without JSON numeric roundtrip, then exposed immutably.
The module is one synchronous execution-context owner, not a cross-worker mutex or
wire responder. Resolve is an internal trusted transition, not proof of a successful
response. Source dead-generation bulk clearing is deliberately unavailable until its
exact-match reconciliation parent is ported. Input occurrences must come from the
wire decoder's fresh occurrence assignment. Record errors use explicit TS kinds;
full native error-taxonomy/transport integration remain unfinished.

Evidence .runtime/cloud-server-requests-077: 10 new cases / 19 focused, full
**2,777 PASS, 0 fail/skip/cancel; strict TS exit 0**. Covers original source reuse,
indeterminate/stale rejection, capacity without eviction, ordered filtering, numeric
metadata distinction, immutable copies, single-event-loop claim races and forged
occurrence/accessor refusal. Initial alias-narrowing type error retained and corrected
using the existing validator's returned RequestId, with no runtime guard weakening.

## 2026-10-07 — Sequenced notification observations and settings

Ported notification recording/active-turn tracking, idle_observation.rs,
observation_window.rs and settings.rs into one transient notification owner. The
1,000-occurrence ring never substitutes payload equality for source sequence.
Legacy ACK must match the next exact item; skipped/evicted observations retain a gap.
Source windows keep fixed upper bounds, cap at 32 entries/2MiB and retain the exact
position of a payload that cannot fit. Settings expire on unload/close/eviction.

Windows remain identity-unbound (empty owner, generation zero), matching the lower
source layer: parent runtime must bind them before durable ledger use. Prefix
certification is a TRUSTED internal transition requiring proven journal evidence,
not permission provided by the window or raw input. Process lifecycle, exit proof,
server replacement and actual observer/ledger integration remain unfinished. The
ring count is not a total heap bound. Shared immutable Serde copies retain numeric
representation without JSON stringify/parse roundtrip.

Evidence .runtime/cloud-notification-state-078: 11 new cases / 21 focused, full
**2,788 PASS, 0 fail/skip/cancel; strict TS exit 0**. Ordered ACK/gaps, active turns,
fixed-window duplicate occurrences, eviction/oversize positions, settings invalidation,
immutable copies and getter refusal pass. u64 exhaustion is tested at the pure checked
increment boundary, not by generating 2^64 live events. No idle release or process action.

## 2026-10-07 — Composed client runtime state and dead-work snapshot

Added one client-state owner over notification and server-request state. Lifecycle
snapshots preserve initialized/PID/closed predicates and client generation 0→1 at a
TRUSTED startup commit, which still requires the future open-lifecycle/handshake parent.
Canonical close reason is first-wins. Pending approval/input selectors retain exact
method/MCP URL-mode rules and exclude claimed/deferred requests.

Closed-work snapshots sort active thread/turn pairs by UTF-8 and requests by typed ID
(integer before string) then occurrence bytes, including pending, responding,
indeterminate and deferred evidence. Snapshot creation does not clear anything.
Native exit proof, durable fence serialization/commit, exact-match clearing and
resident replacement remain unavailable; PID or closed status is not exit authority.
Unbound observation windows still require a parent identity binding.

Evidence .runtime/cloud-client-runtime-state-079: 6 new cases / 27 focused, full
**2,794 PASS, 0 fail/skip/cancel; strict TS exit 0**. Lifecycle predicates, canonical
reason, preserved uncertain work, deterministic ordering, pending-only selectors,
settings invalidation and immutable snapshots pass. No app-server process started.

## 2026-10-07 — Client lifecycle permits and close-signal primitive

Ported client/lifecycle.rs admission count, sealing, quiescent predicate, open-only
synchronous actions, first close intent and separate close publication/waiting.
Opaque permits are owner-bound and explicitly/idempotently released. Callback failure
poisons new admission while existing permits remain releasable, preserving the source
fail-closed intent with a TS error instead of a native poisoned Mutex panic. Promise
callbacks are unsupported and rejected/drained; this does not cancel arbitrary work
a caller may have launched. Callbacks must be trusted, synchronous and non-reentrant.

IMPORTANT publication reconciliation: staged 079 was not published separately.
Reading transport.rs showed actual closure also clears initialized and process_id.
Those flags and their regression oracle were corrected before this combined 079/080
publication; old candidate/source/test evidence remains retained. Generation and
unsettled work remain preserved. Clearing a PID field is not OS exit proof.

publishClosed requires a sealed gate and remains a TRUSTED winning-closer operation
AFTER pending-response cleanup. Winner coordination and pending registry integration
are not yet supplied. No live process, response or close signal outside tests.

Evidence .runtime/cloud-client-lifecycle-080: 9 new lifecycle cases / 15 focused with
reconciled runtime snapshot tests, full **2,803 PASS, 0 fail/skip/cancel; strict TS
exit 0**. Quiescence short-circuit, permit ownership/cleanup, poisoned admission,
reentry, intent/publication separation, waiter abort cleanup and unsupported async
checks pass. Native cross-thread lock and Rust Drop equivalence remain unverified.

## 2026-10-07 — Outgoing pending responses and deadline ownership

Ported client/pending.rs registration capacity 1024, exact internal occurrence cleanup,
response/transport-close/timeout outcomes and read-versus-mutation cancellation.
Read disposal removes its own entry immediately; mutation disposal retains the response
lease until response/deadline/transport closure. Old registration/deadline cleanup
cannot remove a newer same-ID entry. Producer must still use fresh wire IDs: replies
carry ID only, and this registry cannot identify a late reply to deliberately reused IDs.

JS ownership is explicit: registration transfers/revokes the caller's permit handle
without changing the count. Registration rejection releases only verified owned permits.
Deadline setup failure now rolls back both registry entry and lease (same-test RED/GREEN
and original source retained). Result disposal uses a typed receiver-closed rejection;
internal draining avoids unhandled rejection without hiding it from awaiting consumers.

This is integer milliseconds up to Node's native timer ceiling, with zero scheduled as
a microtask. Nanosecond timing, Rust weak/Drop lifetime and hard cancellation equivalence
are not certified. Timers own pending state until settlement; callers must perform
explicit lifecycle cleanup. finish() is trusted completed-operation cleanup, not a way
to declare an uncertain mutation successful. No wire I/O, retry or process operation.

Evidence .runtime/cloud-pending-responses-081: 11 pending cases plus one permit-transfer
case / 21 focused, full **2,815 PASS, 0 fail/skip/cancel; strict TS exit 0**. Uses real
Node timer mocks, exact occurrence races, capacity/duplicate rejection, cancelled-read
and retained-mutation leases, timer fault injection and no-getter response refusal.

## 2026-10-07 — Winning transport-close coordination

Connected transport.rs mark_closed ordering: seal/resolve close intent, publish logical
closed flag and runtime first-closer claim (initialized false/PID None), then only the
winner drains pending outgoing responses and publishes lifecycle close. A loser returns
without waiting on or bypassing that cleanup. Incoming approvals/active turns are not
settled. Cleanup failure leaves the close signal unpublished; a later loser cannot
fabricate a successful close or native exit.

Evidence .runtime/cloud-close-coordinator-082: 4 new cases / 21 focused, full
**2,819 PASS, 0 fail/skip/cancel; strict TS exit 0**. Real in-memory permit/response
owners and an explicit delayed-cleanup test barrier verify no early publication,
first intent/reason, response settlement, cleanup-failure conservatism and retained
dead-work evidence. This is a single execution-context coordinator, not a native
multi-thread/child-exit/kill test or full transport integration.

## 2026-10-07 — Central request profiles and literal app-server builders

Ported requests.rs exact nine-method observational allowlist and all supplied request
builders. Unknown methods/tool calls stay mutation-conservative. Pending registration
now offers registerForMethod so production cancellation behavior derives from one
profile instead of caller guesses. Settings preserve omission versus explicit null,
effort-clear precedence and unchanged/set/clear service tiers; prompts and expected
turn IDs remain exact. Constructed parameter graphs are immutable copies.

Evidence .runtime/cloud-app-requests-083: 7 new cases / 18 focused, full **2,826 PASS,
0 fail/skip/cancel; strict TS exit 0**. All supplied method/time defaults, readonly
allowlist negatives, settings tri-state, text_elements, immutable inputs and actual
pending read/mutation disposal are covered. Custom timeout API uses supported native
integer milliseconds; no nanosecond equivalence, model switch, API call or RPC dispatch.

## 2026-10-07 — Bounded diagnostics and explicit UTF-8 deviation

Ported diagnostic retention at 512 lines / 64KiB with old-line eviction and a bigint
drop count. Snapshots are immutable. Deliberate TS correction TS-PHASE2-DIAG-UTF8-001:
pinned Rust diagnostics.rs calls String::truncate(65536) on an oversized line. The
same file at recorded main ed47c482 is byte-identical (SHA256
 e6d5a1ed6fee40c5f875ec9275dd02944110e98a3bb37508223bf4be399e9e04).
For 21,846 repetitions of 한, length is 65,538 and offset 65,536 is a UTF-8 continuation
byte. Rust's documented truncate contract panics at a non-character boundary:
https://doc.rust-lang.org/std/string/struct.String.html#method.truncate
This is source/API-based static evidence, not a fresh Rust execution or live incident.

TS floors to a scalar boundary instead, retaining 65,535 valid bytes in that case.
Ordinary ASCII/aligned cases and retention policy remain the same; the panic edge is
NOT claimed as exact Rust parity. Rust source was not changed; the finding is retained
for rechecking/fixing against the final phase-2 Rust pin. Diagnostic text is not authority.

Evidence .runtime/cloud-diagnostics-084: 5 new cases, full **2,831 PASS,
0 fail/skip/cancel; strict TS exit 0**. Count/byte eviction, ASCII/emoji alignment,
un-aligned Korean, zero-byte lines and immutable snapshots pass. Initial test used a
runtime-supported String method absent from the configured TS library; corrected the
test assertion without changing target settings. No diagnostic stream or process ran.

## 2026-10-07 — Detached pending response ownership

Added takeResponse to preserve transport.rs's take-under-open-gate, respond-after-gate
ordering. The immutable claim retains its admission permit until explicit respond or
dispose; registry closure, deadlines, and older caller cleanup cannot consume it or a
new same-ID occurrence. Malformed DTO copy failure leaves the claim owned and explicitly
disposable, with no getter invocation. Duplicate respond fails; dispose is idempotent.

Evidence .runtime/cloud-response-claim-085: focused 17 PASS (6 new), full **2,837 PASS,
0 fail/skip/cancel; strict TS exit 0**. Tests cover gate non-reentry/quiescence, response
winning after seal, explicit sender drop, ID reuse, zero deadline and rejected DTOs.
This is explicit JS ownership, not Rust automatic Drop. A caller abandoning a detached
claim without disposal remains a leak; the upcoming transport dispatcher must always
settle/dispose it. No stdout reader, process, or external RPC is integrated by this slice.

## 2026-10-07 — Lifecycle-gated stdout line dispatch

Connected the existing lossless RPC classifier, client state, detached response sender
and diagnostics for one already-decoded stdout line. Server-request canonical duplicate,
conflict/deferred and capacity behavior precedes queued publication. Notifications record
state before immutable queued publication; responses settle only outside the lifecycle
gate with finally disposal. Sealed incoming messages do not consume pending response
cleanup ownership. Adapter errors remain visible/poisoned rather than being mislabeled
as seal rejection. Queue ports must be synchronous insertion, not subscriber execution.

Evidence .runtime/cloud-transport-dispatch-086: 10 focused PASS, full **2,847 PASS,
0 fail/skip/cancel; strict TS exit 0**. Covered whitespace (NEL vs BOM), malformed JSON
vs RPC, 200-scalar preview, lossless response values, seal exclusion, duplicate/conflict/
deferred requests, 500-entry saturation, notification ordering, throwing/async queue
ports and diagnostic-renderer noncoercion. Parsing error rendering is a required trusted
public-safe adapter; exact Rust parser Display text is not claimed. UTF-8 byte framing,
pipe reads/EOF, real broadcasters and native process ownership remain unimplemented.

## 2026-10-07 — Owned logical stdout/stderr drain integration

Ported transport.rs drain ordering over a required owned line-reader adapter. Stdout
EOF/read failure awaits canonical logical close and pending cleanup. Stderr EOF/error
ends only its diagnostics drain. Dispatch/close exceptions are not swallowed or
misclassified as pipe I/O errors. The integration test processes one response and closes
another pending request at EOF, clearing logical process flags and publishing closure.

Evidence .runtime/cloud-transport-drain-087: 7 focused PASS, full **2,854 PASS,
0 fail/skip/cancel; strict TS exit 0**. Empty lines, diagnostic routing, exact read error
identity, close cleanup ordering and failure propagation covered. No real pipe/process
ran. Reader cancellation/disposal and fatal UTF-8 LF/CRLF decoding remain explicit adapter
requirements. Cargo.lock pins Tokio 1.53.1; its exact line-reader dependency source was
not locally available and versioned docs retrieval failed, so latest Tokio docs were
not substituted as frozen source proof. No byte-framing parity claim is made here.

## 2026-10-07 — Exact current-turn response claim ownership

Centralized current-turn validation plus claim mutation in ClientRuntimeState. It checks
canonical occurrence/state first, then the source's direct turnId field, Rust trim and
exact active turn before claiming. Added explicit response claim resolution/disposal:
unresolved disposal remains indeterminate, successful resolution promotes at most one
deferred occurrence, and a queue adapter failure cannot replay an already committed
resolution. Current-turn claims must begin inside serialized writer preflight; this
helper alone does not provide write permission or confirm a wire response.

Evidence .runtime/cloud-server-response-claim-088: 6 focused PASS, full **2,860 PASS,
0 fail/skip/cancel; strict TS exit 0**. Stale IDs/turns, direct-vs-nested turn field,
NEL/BOM, already-claimed error precedence, indeterminate disposal and promotion failure
covered. Explicit JS finally-disposal remains required instead of automatic Rust Drop.

## 2026-10-07 — Serialized writer ownership and cancellation

Ported source control/write.rs ordering: closed check, Serde encoding plus LF, exclusive
writer acquisition, second closed check, synchronous preflight, input presence, started
hook, write-all and flush. Failure after started guard closes as indeterminate before
releasing the writer. Explicit AbortSignal substitutes for future cancellation: queued
cancellation removes only its waiter; active cancellation closes promptly but retains
the writer until the required adapter stops/joins the owned operation. Abandoning the
returned Promise alone does not cancel it. Preflight resources have explicit failure
cleanup and successful ownership transfer. No native pipe implementation supplied.

Moved the existing TargetLocks implementation byte-identically into core/keyed-locks.ts;
the old queue-runner path re-exports it. No duplicate lock implementation or registry
sharing between independent writer and queue owners. All existing FIFO/cancellation tests
still pass. During review, cleanup failures could hide the original write failure; now
AggregateError preserves primary plus cleanup/disposer identities. Same final test bytes
produce old 8 PASS/1 FAIL and fixed 9 PASS. First RED-stage attempt lacked protocol/ids.ts
and failed module loading; retained separately and not counted as behavioral evidence.

Evidence .runtime/cloud-serialized-writer-089: focused 18 PASS (9 writer + 9 lock), full
**2,869 PASS, 0 fail/skip/cancel; strict TS exit 0**. Exact source adapters, real native
write cancellation and OS integration remain unverified. Adapter native errors propagate
without claiming Rust Io Display parity. Caller must still hold the outer admission
permit; this internal writer does not create new dispatch authority.

## 2026-10-07 — Request/notify client composition

Connected request UUID creation, outer admission plus independent pending-response permit,
central observational-method profile, serialized write, preflight deadline checks before
and after durable hooks, and typed response/remote/timeout/transport-close outcomes.
Notifications use one permit and no response registration. Explicit caller cancellation
after write removes observational entries but retains mutation response ownership until
reply/deadline/close. Hooks are synchronous, and cancellation reasons are preserved.

Review caught three TS boundary mistakes before publication: invalid initial clock left
an unsent mutation lease, async preflight could execute before rejection, and an abort
reason resembling the receiver-close class was misclassified. Frozen 10-test SHA
 a715d8072e7e32b95e1541637c6939438a6ef1534714506d992710c10b34a239
reproduces old 7 PASS/3 FAIL and corrected 10 PASS; separate final 13-test suite adds
post-write timeout, actual write-error cleanup and invalid-deadline cleanup. The caller
cancellation test waits for writeComplete explicitly (no conditional/vacuous assertion).

Evidence .runtime/cloud-request-client-090: focused 13 PASS, full **2,882 PASS,
0 fail/skip/cancel; strict TS exit 0**. No external request or process was started.
Clock/deadline precision is the documented finite millisecond profile. Native I/O errors
and JS cleanup aggregates still need the complete central public-safe error dispatcher;
these composed helpers are not full startup, native transport or runtime integration.

## 2026-10-07 — Serialized response controls

Connected normal/error/current incoming-request responses to outer lifecycle admission,
owned writer and exact occurrence claims. Normal responses claim before writer wait;
current responses run custom preflight then claim/check current turn only after acquiring
the writer. Write failure explicitly disposes the claim into indeterminate state; only
successful write+flush resolves and promotes deferred work. The shared synchronous-void
hook validator was extracted without changing request-client behavior.

Evidence .runtime/cloud-response-client-091: focused 21 PASS (8 response + 13 request),
full **2,890 PASS, 0 fail/skip/cancel; strict TS exit 0**. Exact claim retention during
write, typed error frames, current-turn change while queued, normal queued cancellation,
post-success promotion and distinct normal/current preflight-failure ordering covered.
This preserves the source's conservative normal-response indeterminate state even when
its later preflight fails before any bytes. Required native ports remain unimplemented;
these controlled adapters are integration evidence, not a live Codex session.

## 2026-10-07 — Observed initialization handshake

Ported startup.rs handshake AFTER an already-owned spawn: install observer, initialize
with experimental API capability and 30s request budget, send initialized, then commit
generation one only inside the open lifecycle gate. Failure/cancellation awaits the
required owned process/task cleanup and disposes observer resources; original and cleanup
errors are retained together. The outer 45s startup budget is exported but not enforced
by this handshake-only unit, and cannot justify abandoning cleanup. Explicit signal
cancellation is supported; abandoning a Promise is not automatic Rust task cancellation.

Review corrected metadata changing through an observer callback, invalid observer results
reaching initialization, and a disposer being replaced during initialization. Metadata and
the validated synchronous disposer are captured before later callbacks. Identical final
9-test bytes yield old 6 PASS/3 FAIL and corrected 9 PASS. Evidence
.runtime/cloud-startup-handshake-092: full **2,899 PASS, 0 fail/skip/cancel; strict TS exit 0**.
Also covered close-after-initialized-before-commit, observer installation failure, explicit
cancellation, cleanup/disposer failures and already-aborted ownership cleanup. No child
process or actual pipe was spawned; cleanupOwned remains a mandatory native-owner contract,
not a stubbed proof of process reaping or native background task termination.

## 2026-10-07 — Frozen Tokio authority recovered and fatal UTF-8 line reader

Resolved the earlier dependency-source limitation through the official tokio 1.53.1 crate,
without installing/running it. Archive SHA256 exactly matches frozen Cargo.lock:
202caea871b69668250d242070849eb495be178ed697a3e98aebce5bc81a0bed.
Read exact lines.rs, read_line.rs and read_until.rs; binding and archive retained under
.runtime/authority-tokio-1.53.1. Official source:
https://static.crates.io/crates/tokio/tokio-1.53.1.crate

Ported LF/CRLF framing, EOF tail handling, BOM preservation and fatal UTF-8 decoding over
borrowed byte input. Decode each complete line, not a whole incoming chunk, so invalid
later bytes do not erase an earlier valid line. I/O error takes precedence over invalid
incomplete buffered bytes. Captured chunks are owned copies. Concurrent reads reject.
Error-terminal behavior is scoped to transport drains (which stop on first error), not
generic Tokio Lines recovery/cancellation parity. No new per-line size cap was invented.

Evidence .runtime/cloud-line-reader-093: 10 focused PASS, full **2,909 PASS,
0 fail/skip/cancel; strict TS exit 0**. Every byte split of Korean/emoji/BOM, overlong and
surrogate/out-of-range/truncated UTF-8, CRLF vs lone EOF CR, I/O precedence, buffer reuse,
empty/long input and an actual Node Readable stream covered. No child process or live
pipe ran; native byte-source ownership/cancellation remains to be wired and tested.

## 2026-10-07 — Node stream input/output adapters

Added concrete Node stream adapters for the writer and byte reader. Writes wait their
callback/backpressure, copy input bytes, preserve native errors and join actual close
when interrupted. Owned read destruction settles pending iterator reads; string-mode
output is rejected. Shutdown uses stream.finished with cleanup:true. These adapters
require exclusive ordinary native stdio streams with close events; caller must not
share consumers or disable emitClose. No child process is spawned by this unit.

Exact Node v24.21.0 official API documents were retrieved read-only and relevant sections
read under .runtime/authority-node-24.21.0 (stream.md and child_process.md). This resolved
web-reader retrieval errors without installing or running another package. The installed
Node version remains unchanged.

Evidence .runtime/cloud-node-streams-094: 7 focused PASS, full **2,916 PASS,
0 fail/skip/cancel; strict TS exit 0**. Actual Node Writable/Readable/PassThrough streams
exercise callback and close joining, write/read error identity, byte ownership, fatal
UTF-8 connection, pending read destruction and already-aborted no-write behavior. Parent
process lifecycle and serialized stdin take/shutdown integration remain separate work.

## 2026-10-07 — Portable owned child process and real pipe verification

Added a non-Windows direct-child Node profile matching the frozen portable spawn shape:
no shell, explicit argv/environment snapshot, required piped stdio, spawn confirmation,
separate process-exit vs stdio-close facts, owned SIGKILL and bounded explicit force
cleanup. Canceling a wait does not kill the process. Nonzero exit confirms termination,
not protocol success. An exit hook is best effort only and removed when owned children
exit; explicit forceDispose must be awaited. It is not Windows Job Object/window parity,
process-group/descendant termination, automatic Rust Drop, or the full graceful close API.

Actual isolated local Node helper processes now test UTF-8 echo over native pipes, stdin
shutdown, exit/pipe close, owned kill, missing executable, canceled wait, late output and
exit-listener cleanup. No Codex/model CLI, network service, live bridge or user PC ran.
Review reproduced Node's exit-time flushStdio resuming unread output before lazy async
iterator consumption, losing stderr/stdout. A public readable-mode hold now protects the
stream until its iterator installs its own listener. Exact Node v24.21.0 internal source
was read; no private flags were modified. Final identical 15-test bytes produce old
13 PASS/2 FAIL and fixed 15 PASS. Readable holds are removed on disposal, including
already-closed streams; pre-construction stream errors retain their identity.

Evidence .runtime/cloud-portable-process-095: full **2,924 PASS, 0 fail/skip/cancel;
strict TS exit 0**. A separate injected-control-error case confirms later pipe cleanup
timeout cannot replace the first error. Initial TS Record name collision and a test mock
restore API error were retained separately; the latter's invalid RED run is not behavioral
regression evidence. Real-process tests ran on this Linux VM only. Native graceful-close,
complete session construction and Windows remain unfinished; force-cleanup timeout/error
must not be treated as confirmed exit or successful recovery.

## 2026-10-08 — Serialized graceful/forced process close

Ported close.rs ordering across the same writer lock and an owned child slot. Admission
is sealed/flagged first; stdin is taken once under the writer lock and passed to required
shutdown+disposal. Graceful wait defaults to 1,500ms, then owned kill and forced wait to
5,000ms. The first error is retained. Exit confirmation is a separate internal fact;
unknown exit retains the child for an explicit later close, not automatic success.
Logical close/pending cleanup still publishes after child handling, preserving canonical
close intent. Existing snapshot fields and dead-generation incoming work are unchanged.

Evidence .runtime/cloud-process-close-096: focused 20 PASS (7 new + existing close/writer),
full **2,931 PASS, 0 fail/skip/cancel; strict TS exit 0**. Tests cover ordered close,
shutdown/wait/kill error precedence, forced timeout and retained-child retry, writer-lock
exclusion, concurrent close, and an actual owned Node helper exiting gracefully after
stdin shutdown without a kill. Wait adapters must honor cancellation of the observation;
this does not certify arbitrary adapters, descendant termination, Windows or full session
startup/cleanup integration. Native shutdown/disposal callbacks remain explicit ownership
contracts, and no Codex/model or operating bridge was launched.

## 2026-10-08 — Native protocol-session integration evidence

Added tests-only composition of the existing lifecycle/state, native process/streams,
reader/drains, request/response clients, startup handshake and graceful closer. An actual
isolated local Node helper speaks the bounded JSON-RPC fixture over real stdio. Verified:
initialize/initialized and generation commit, thread/read round trip, incoming current-turn
approval response observed by the helper, graceful close and retained final stderr; native
initialize error cleanup; explicit cancellation after the helper receives initialize; and
invalid UTF-8 closing transport, rejecting pending work and preventing subsequent reuse.
Observer resources and caller/response permits are checked after cleanup.

Evidence .runtime/cloud-native-session-097: 4 native integration PASS, full **2,935 PASS,
0 fail/skip/cancel; strict TS exit 0**. This is stronger than isolated fake-port evidence,
but the peer is generated test code, NOT Codex or Discord. No authentication/model calls,
live bridge, services or user PC were used. Production session factory/runtime wiring,
Windows/descendants, end-to-end Discord/store effects and phase-2 operational validation
remain unfinished. No deployment or complete migration claim follows from this test count.

## 2026-10-08 — Bounded owned event subscriptions

Ported the required single-sender broadcast subset from exact Tokio 1.53.1 broadcast.rs
(official crate checksum already verified). App-server capacities round 1000 to 1024 and
500 to 512. New subscribers see future events; no receivers means no retained message;
slow receivers report explicit missed counts then resume at the oldest retained event.
Every subscriber has independent progress, and last consumption/disposal releases the
slot. Sender close drains buffered events before Closed. Canceled receives unlink their
waiter without stealing an event; explicit disposal replaces receiver Drop.

Evidence .runtime/cloud-broadcast-098: 12 focused PASS, full **2,947 PASS,
0 fail/skip/cancel; strict TS exit 0**. Includes three deterministic 1,200-operation
schedules checked against an independent per-receiver queue model, lifecycle-gate callback
non-reentry, lag, cancellation, disposal and capacity behavior. This is not a generic full
Tokio channel: no sender cloning/weak senders, capacities above 2^20, u64 rollover, or
Rust Clone/allocation parity. DTOs are shared immutable references; root freezing is only
a guard and deep data validity remains the producer decoder's responsibility. Broadcast
subscriptions are client-wide; routing by Codex/Discord thread remains a separate layer.

## 2026-10-08 — Poisoned admission cannot block owned cleanup

Found a TS-specific ownership gap: a callback failure permanently poisoned admission,
but also prevented the close coordinator from sealing and releasing already-owned
responses/process resources. Added a cleanup-only seal primitive. It never clears poison,
reopens the gate, admits work, or reenters an active critical callback. Normal admission
continues to reject the poisoned lifecycle after cleanup. This is an explicit JS ownership/
unwind adaptation, not a claim of identical Rust Mutex panic/automatic Drop mechanics.
No hook, permission, authorization or operating-system security setting was changed.

Identical final test SHA 2c35f5ce6f4f856aae90489370937984fc814a75e7df1a107899dfd4ae8842bc:
old 1 PASS/3 FAIL -> fixed 4 PASS, including actual owned local Node helper reaping. Also
verified pending-response draining, logical failure publication, unchanged poison and
critical-section reentry rejection. Evidence .runtime/cloud-poisoned-cleanup-099:
full **2,951 PASS, 0 fail/skip/cancel; strict TS exit 0**. Rust/native-Windows sources and
live services remain unchanged; this does not authorize recovery of unknown user work.

## 2026-10-08 — Single owned portable session factory

Added PortableAppServerSession: one private lifecycle/state/pending/writer/response owner,
owned native child, fatal line readers and supervised drains, bounded event subscriptions,
startup handshake and explicit disposal. Callers cannot cross-wire raw state or lifecycle
owners. Startup cleanup that remains unconfirmed returns the session owner for explicit
reconciliation; it is not discarded or treated as a successful startup. Unexpected drain
handler errors seal transport and remain visible after cleanup. Disposal joins direct-child
drains before closing producers and does not erase unknown incoming work.

Evidence .runtime/cloud-portable-session-100: 6 actual native helper scenarios PASS,
full **2,957 PASS, 0 fail/skip/cancel; strict TS exit 0**. Covers successful owned startup,
subscriptions/request/current-response/close, native initialization failure, invalid UTF-8,
diagnostic-renderer failure supervision, startup cancellation through observer+process
cleanup, and two independent sessions with identical incoming IDs rejecting each other's
occurrence tokens. Closing one session leaves the other healthy and operational.

This is a non-Windows direct-child library session using generated local peers, not Codex
or Discord. Descendant-inherited pipe cleanup and the outer 45s startup envelope remain
unsupported: drain joining can wait on an inherited open pipe. No generic resident manager,
end-to-end Discord/store scheduling, Windows/native-window parity, sustained operation or
deployment claim is made. Diagnostic rendering remains a required public-safe adapter.

## 2026-10-08 — Resident lifecycle generation watch foundation

Added the required one-sender watch<Option<u64>> subset from checksum-pinned Tokio 1.53.1
watch.rs: equal-value replace still notifies, latest values coalesce, each receiver has
an independent seen cursor, clone preserves unseen state, and an unseen final value is
observed before sender-close error. Cancellation/disposal unlinks only its own waiter;
subscribe-before-snapshot ordering can avoid missed lifecycle transitions.

Evidence .runtime/cloud-generation-watch-101: 9 focused PASS, full **2,966 PASS,
0 fail/skip/cancel; strict TS exit 0**. Tests cover same-value None publication, coalescing,
borrow vs borrowAndUpdate, fresh subscriber vs clone, close, cancellation, receiver
concurrency and optional u64 boundaries. Publication version exhaustion fails closed
before native wrap; no generic multi-sender/RwLock/rollover parity claim. This is a
foundation for resident-generation/restart state, not an implemented restart controller.

## 2026-10-08 — Exact pre-admitted client paths

Refactored public request/notify/response calls to delegate through internal admitted
paths using the same gate's verified live permit. A resident caller can retain one outer
lease across its full durable workflow without allocating a duplicate outer admission
inside the client. Requests still own an independent response lease; admitted methods
never release the caller's permit. Foreign/released handles fail before dispatch or
incoming-response claim mutation. Public APIs retain their existing finally-release.

Evidence .runtime/cloud-admitted-client-102: focused 27 PASS (6 new + existing clients),
full **2,972 PASS, 0 fail/skip/cancel; strict TS exit 0**. Covers exact permit counts,
foreign/released refusal, admitted notification/normal/error/current response ownership,
and canceled mutation response custody surviving caller release. These remain internal
explicit-lifetime contracts: caller must release after its durable workflow, not early.
Resident state, durable restart fencing and production manager integration remain pending.

## 2026-10-08 — Resident admission and replacement state subset

Added one synchronous resident state owner for exact generation admission, timeout/cancel
quarantine, response draining while quarantined, restart requests, quiescent sealing,
replacement cleanup debt, exact client identity and terminal close. Authority is frozen
manager/admission.rs, admission_restart.rs, admission_replacement.rs,
admission_terminal.rs and death.rs. Failed replacement installation retains cleanup
debt; stale death/timeout from an old generation cannot disable its successor.

Review caught async installation executing before refusal and Promise-shaped quiescence
being treated as permission. The identical final 15-test file gives old source 13 PASS /
2 FAIL, corrected source 15 PASS. Evidence .runtime/cloud-resident-state-103; full
**2,987 PASS, 0 fail/skip/cancel; strict TS exit 0**. Callback failures are retained
without poisoning the candidate; JavaScript callback errors do not distinguish Rust
panics from Result errors, so native panic/unwind equivalence is not claimed.

The frozen client port is a trusted owned capability requirement, not ownership proof
from object shape. Native session binding, written-request guards, durable dead-generation
settlement, restart orchestration and full manager integration remain unfinished.

## 2026-10-08 — Owned native resident-client binding

PortableAppServerSession now creates one stable frozen resident capability against its
private lifecycle, runtime state, writer and admitted clients. Quiescent sealing requires
zero permits, no active turns and no unsettled incoming requests; the binding never
substitutes a lifecycle snapshot or process ID for actual owner identity. Sealing does
not invent a close intent. Existing cleanup-only poisoning handling is preserved.

Evidence .runtime/cloud-resident-binding-104: 11 focused PASS (5 new native helper tests
plus the 6 existing session tests); full **2,992 PASS, 0 fail/skip/cancel; strict TS exit 0**.
New cases cover exact outer/response permit counts, foreign and released permit refusal
before native write or response claim, separate active-turn and unresolved-request
quiescence, current responses while quarantined, replacement generation 2 with native
client generation 1, old-generation isolation, and cleanup after a poisoned callback.
Initial test-only type errors were corrected without weakening production checks.

This exposes an internal owning capability, not a DTO-derived grant. The replacement
fixture explicitly closes the old native peer first; no automated resident supervisor,
written-request guard, durable restart settlement or full bridge runtime is claimed.
The existing portable-only/startup-budget/descendant-pipe limitations still apply.

## 2026-10-08 — Explicit written-request ambiguity guard

Ported the bounded WrittenRequestGuard state machine from manager/admission.rs. An
uncompleted started write quarantines its captured generation on explicit disposal;
confirmed isolated flush suppresses only that unfinished path. Explicit Io/Closed/
TransportClosed/ResponseChannelClosed results still quarantine after isolated flush.
Success, Timeout and other completed failures do not themselves quarantine, matching
the guard; dispatch's separate timeout/mutation policy is not replaced by this leaf.

The trusted caller supplies a closed completion classification. No arbitrary raw error
message/shape or passive diagnostic classification grants authority. The future central
error-to-completion adapter and durable mutation coordinator must provide that contract.
This guard does not allocate or release the caller's admission lease. Explicit finally-
dispose is required; abandoning a JS Promise does not implement Rust Drop.

Evidence .runtime/cloud-written-guard-105: 9 focused PASS, full **3,001 PASS,
0 fail/skip/cancel; strict TS exit 0**. Tests cover each completion before/after start,
isolated transport failure, replaced flush flags, disposal, retained caller lease,
old-generation/terminal protection and retry after failed cancellation publication.
No native dispatch integration, durable restart fence or whole-resident completion claim.

## 2026-10-08 — Exact dead-generation capture and settlement binding

Connected the source-backed resident dead-work sequence to private native/runtime owners:
actual owned exit observation, final transport closure and zero admitted operations are
required before the normal fence path invokes its mandatory synchronous persistence port.
Live timeout quarantine may drain; EOF alone is not native-exit evidence. Empty work is
still captured on the fence path. Exact immutable work is compared again before clearing
active turns and all pending/claimed/indeterminate/deferred incoming occurrences.
Notification history is preserved. Stored exact settlement is idempotent even after a
later generation, while changed old work cannot settle a new generation.

The persistence callback remains a REQUIRED trusted adapter: it must return only after
durable capture. Tests use in-memory receipts, not a real durable store. Internal explicit
settlement APIs are not proof of persistence. The native port adds fail-closed exit/sealed/
zero-admission checks to explicit settlement. It retains the exact owned process object
and confirmed-exit observation even after disposal; an arbitrary missing handle/PID is
never accepted as death. The encompassing restart workflow still needs serialization.

Evidence .runtime/cloud-dead-generation-106: 40 focused PASS (14 new + existing state/native
cases), full **3,015 PASS, 0 fail/skip/cancel; strict TS exit 0**. Includes actual local
helper exit with unresolved work, failed/async persistence, mutation or terminal close
during capture, wrong occurrence/method/payload/order, exact empty/idempotent capture,
closed-but-live refusal, preserved history, hostile snapshot getters/proxies, and u64
payload preservation. Review aligned the failure discriminator and display prefix with
source DeadGenerationFence. Five complete frozen Rust authority hashes are recorded.

This is a bounded library fence with native observation, not an installed production DB
fence or complete restart supervisor. Automatic replacement/forwarder activation, durable
mutation dispatch, Windows, sustained operation and deployment remain unfinished.

## 2026-10-08 — Generation-scoped event forwarders and death monitoring

Implemented the manager/events.rs, events/activation.rs and death.rs forwarding subset:
subscribe before activation, no pre-activation event/death publication, explicit lag gaps,
old-generation queued-event drain before exit, same-generation notifications, and owned
death-monitor joins. Native helper integration proves forwarding activates only after
resident ownership and a closed current client publishes its exact-generation restart.

JS receive and generation-change operations are both canceled/joined before the next
iteration. If a losing receive already consumed a value, that value is forwarded once
before draining, rather than discarded by Promise.race. This deterministic tie handling
does not claim Tokio select randomized fairness. Active join requires generation change
or closure of all watched sources; joining alone never kills the client.

Review found mutable death-monitor callback identity and late async callback rejection.
Callbacks are now captured and validated before subscription acquisition. Same 11-test
file: original 9 PASS / 2 FAIL, corrected 11 PASS. Evidence
.runtime/cloud-resident-forwarders-107: focused 18 PASS including 7 native binding cases;
full **3,027 PASS, 0 fail/skip/cancel; strict TS exit 0**. Includes 40 co-ready race
iterations, gap draining, stale monitor cleanup, partial-construction cleanup, target
closure, and unchanged callback identity. Unexpected task errors remain observable.

These are explicit-lifetime library components. Whole replacement orchestration, durable
idle/dead-work store bindings, mutation dispatch and automatic supervisor remain pending.

## 2026-10-08 — Portable resident restart and terminal-close orchestration

Added PortableResidentLifecycle: one restart/close mutex, stable resident instance ID,
owned session registry, quiescent replacement, old forwarder stop/join, exact child
cleanup, exit journaling, observed replacement startup, cleanup debt and atomic
generation/forwarder installation. Concurrent force requests captured for one generation
create only one replacement. Terminal close retains the exact owner until cleanup and
exit journaling both succeed; it cannot revive admission or spawn a replacement.

Dead-work persistence and old-child-exit journaling are mandatory pinned synchronous
trusted adapters, with no default no-op. They must be durable and idempotent by exact
instance/generation; tests deliberately use memory receipts. Raw admission capabilities
are internal only and do NOT replace durable queue/stop/target mutation authorization.
Active cancellation joins startup cleanup and keeps retry state. Signals are also checked
after startup before owner/installation publication; this is explicit JS cancellation,
not automatic Rust future Drop. Multiple cleanup errors are retained in AggregateError
rather than discarded; exact multi-error Rust display behavior is not claimed.

Native testing found a real retry defect: a first shutdown error after confirmed exit
was permanently memoized by the session, preventing ordinary cleanup/restart retry.
The first error is still returned, but failed disposal now permits explicit same-owner
reconciliation without reusing already-taken stdin/child slots. Review also closed
lifecycle watch senders only after terminal cleanup has released every owned client.
The same final 11-test file gives old code 8 PASS / 3 FAIL and corrected 11 PASS.

Evidence .runtime/cloud-resident-lifecycle-108: focused 17 PASS including existing native
session coverage; full **3,038 PASS, 0 fail/skip/cancel; strict TS exit 0**. Covers actual
replacement, force concurrency, busy deferral, child death capture, journal failure and
retry, replacement observer failure, startup cancellation, terminal close retry, pinned
adapters, reaped-session retry and lifecycle-watch completion.

No automatic restart supervisor/backoff, durable DB implementation, mutation dispatch,
full Discord bridge, Windows, outer startup envelope or descendant-pipe cleanup is
complete. Unknown-cleanup startup errors retain the concrete session owner; end-to-end
production recovery and sustained operation remain unverified.

## 2026-10-08 — Owned restart supervisor and bounded retry schedule

Added supervisor.rs control flow and bound it to PortableResidentLifecycle through an
explicit owner-started/joined Promise. It subscribes before reading, coalesces duplicate
requests, maintains a settled-generation watermark, resets on a different/cleared
request and uses exact 250/500/1000/2000/4000/5000ms capped backoff. Same-generation
notifications cannot reset, shorten or extend the absolute retry deadline. The native
timer rounds upward and rechecks monotonic time before reporting a reached deadline.

AbortSignal is the one-way true/closed shutdown subset of the Rust bool watch. Shutdown
wakes an idle/backoff wait, but deliberately joins an already-running restart attempt
instead of dropping native cleanup. False shutdown-watch updates are not exposed.
Failure reporting is a required synchronous public-safe adapter receiving the original
error reference; invalid truthy attempt results cannot mark a generation settled.

Evidence .runtime/cloud-restart-supervisor-109: focused 23 PASS, full **3,050 PASS,
0 fail/skip/cancel; strict TS exit 0**. Includes deterministic virtual-clock deadline
checks, stale/duplicate/new-generation behavior, shutdown during backoff and active
attempt, preserved reporting failure, invalid clock/result refusal, a real >=250ms
native timer test, and actual native replacement driven by the supervisor. Stopping
that supervisor leaves its healthy successor running until explicit owner disposal.

This is library integration, not a started production service. Actual durable store
ports, guarded mutation dispatch, Discord runtime, Windows, startup/descendant cleanup
limits, performance and sustained-operation certification remain outstanding.

## 2026-10-08 — Idle-release target mutation/exclusive gate

Implemented idle_release.rs journal/token contracts and idle_release/gate.rs state:
counted ordinary mutations, target-specific exclusive subscription work, global mutation
conflicts, before-mutation resubscription admission, exact Candidate idle verification,
preflight durable hold checks and explicit permit release. Unrelated targets continue
while one target is exclusively maintained. Journal installation is once with no active
gate work, matching the source's actual condition rather than inventing a history flag.

Own-data journal callbacks are pinned synchronous adapters. Tokens are immutable copies
with exact fields/u64 generation/i64 revision. Observation defaults return false or held
errors. Gap epochs use the source odd/even protocol, reject stale proofs, saturate without
ABA and latch unattributed loss permanently; that gap does not stop ordinary admission.
The existing IdleObservationError is reused for the same Rust IdleRelease discriminator
and display prefix rather than introducing another duplicate error kind.

Evidence .runtime/cloud-idle-target-gate-110: 14 focused PASS; full **3,064 PASS,
0 fail/skip/cancel; strict TS exit 0**. Includes independent/global targets, multiple
leases, stale release, resubscription conflict, immutable tokens, journal errors, pinned
callbacks, async/getter refusal, malformed outputs, scope boundaries and sticky gaps.
Synchronous callback reentry is rejected rather than emulating native deadlock/panic;
explicit release replaces Drop and the counter fails before u64 overflow.

No actual database journal adapter or idle unsubscribe/resubscribe RPC sequence is
installed by this change. This gate remains distinct from the queue's FIFO target lock;
durable dispatch/maintenance integration is still required before production use.

## 2026-10-08 — Durable observation-range ledger and central store scopes

Added source observation_gap ledger activation, finite original-range discovery, unknown
loss preservation, persisted keyset cycle selection and positive complete-range checking.
Activation cannot erase an old unsealed tail; ignored INSERT/UPDATE or changed range
identity rolls the whole transaction back. Scope verification reads one transaction and
rejects any old unsealed stream, global unresolved gap, missing positive range or incomplete
span evidence. Five owned-path APIs are exposed through StateAccessFacade.

Owned open/close and commit/rollback cleanup are centralized in owned-scope.ts. Caller
transactions are never rolled back by nested scope refusal; an owned callback leaving a
transaction open or closing its own handle cannot return false success. Added typed
Vec<struct> decoding to the existing Serde helper, preserving duplicate recognized-field
rejection, ignored fields and struct sequence forms instead of JSON.parse last-wins.

Evidence .runtime/cloud-observation-ledger-111: focused 28 PASS (20 new + existing facade
coverage); full **3,084 PASS, 0 fail/skip/cancel; strict TS exit 0**. Includes UTF-8/UTF-16,
actual temporary-file reopen/persistence/close checks, IDs above 2^53, original unknown
evidence, rollback sabotage, incomplete/missing coverage, typed JSON corruption, owned
scope failures and explicit public API identity/allowlist checks. An initial fixture
inserted a duplicate sqlite_sequence row; its corrected UPDATE and the expanded facade
allowlist/count are test corrections, not product-check weakening or code-defect RED/GREEN.

At exhausted signed cursor revision, reset fails closed before changing the row; native
Rust build-profile-dependent arithmetic overflow is not claimed equivalent. The 4096
merged-span limit is preserved but is not a general heap/input-size bound. Proof-effect
certification and scan-page commit still need their source-backed implementation before
this ledger can drive production idle-release decisions. No live DB was used.

## 2026-10-08 — Required-effect observation proofs and exact scan-page commits

Added observation_gap/proof.rs certification for NoRequiredStore, Unconfirmed, Started,
Terminal, Final and Question effects. Required-effect checks and span persistence share
one IMMEDIATE transaction; even an already-proven sequence must recheck all supplied
effects. Terminal identity includes resident and raw payload; question inbox proof
compares the complete queue binding including nullable execution generation. Source
Final proof's generation/content rule and completed-origin marker are preserved.

Scan-page progress compares the whole captured gap before CAS and never substitutes
scanning for verified effects. Newer ranges cannot indefinitely postpone the original
finite range with a middle hole. The two owned APIs join StateAccessFacade; explicit
allowlist/reference checks now include them. Owned-store tests reuse the existing
identity-guarded temporary fixture rather than duplicating cleanup logic.

Evidence .runtime/cloud-observation-proof-112: focused 40 PASS (12 new + related tests);
full **3,096 PASS, 0 fail/skip/cancel; strict TS exit 0**. Uses actual full initialized
temporary SQLite stores for every proof variant, both question proof branches, failed
or ignored writes, stale page snapshots, changed queue identities, input snapshotting,
unknown effect refusal and the source G1/G2/G3 progress scenario.

Effect inputs are trusted owned-producer instructions, never user-selected proof: this
API cannot authenticate an arbitrary caller's NoRequiredStore assertion. Production
notification-to-effect binding, durable idle journal integration and complete bridge
operation are still unfinished. No live store or external transport was touched.


## 2026-10-08 — Durable idle intent state transitions

Centralized idle intent selection/decoding and added owner/generation/revision-bound
mutation, transition, verification, pending and exited-owner operations. AwaitUnload
permits exactly one matching-owner resubscription; uncertain states never auto-resume.
The source distinction between returned prior detail and updated stored detail is
preserved. Transition CAS includes every identity plus state; diagnostic text is not
an authority field. Diagnostics retain at most 512 Unicode scalars.

Observation-aware verification reads the token, bot obligations and durable coverage
in one deferred transaction. Borrowed cleanup preserves the caller transaction and
cancels only unsent candidates. StateAccessFacade is the owned-path entry point; its
explicit API allowlist/reference assertions now cover 122 methods.

Evidence .runtime/cloud-idle-release-store-113: focused 36 PASS (13 new), full
**3,109 PASS, 0 fail/skip/cancel; strict TS exit 0**. Actual isolated SQLite tests
cover UTF-8/UTF-16, large exact generations, stale identity CAS, trigger-induced
ignored/deleted writes, pending capacity/order, transaction rollback, owner isolation,
input snapshotting and unresolved observation coverage.

Exited-owner storage requires upstream proof from the exact old child; this leaf
cannot establish native exit. Revision arithmetic exhaustion fails closed in the
returned-value path; equivalence with native build-dependent Rust overflow is not
claimed. The synchronous app-server journal still needs a source-backed adapter to
the asynchronous initialized-store owner, and complete runtime/Discord/Windows
integration and performance qualification remain unfinished. No live DB was used.


## 2026-10-08 — Managed idle release/resubscribe state coordinator

Added the source-backed maintenance Work sequence: exact locally witnessed terminal,
explicit goal absence/completion, fresh exact latest terminal turn, stable observation
watermark, committed Dispatching permission, then unsubscribe. All three accepted ACK
statuses remain AwaitUnload until a separate fresh exact-thread notLoaded read.
Resubscribe settlement requires an exact returned thread and unchanged generation.

NotStarted errors cancel release or restore AwaitUnload for resume; partial/flushed
uncertainty becomes Unknown. Recording failures preserve a durable hold and report
both causes. Missing transport phase or unexpected adapter rejection cannot be
classified as not sent. Port callbacks are pinned before asynchronous work, supplied
JSON is isolated, and a consumed work object cannot replay. Target exclusion remains
held until the owning coordinator releases its existing exclusive permit.

Evidence .runtime/cloud-idle-maintenance-114: 16 new coordinator tests PASS; full
**3,125 PASS, 0 fail/skip/cancel; strict TS exit 0**. Tests include blocked goals,
latest-turn/identity mismatch, watermark races, persistence failures, each write phase,
late completion while caller stops observing, duplicate invocation and callback mutation.
An initial contextual return-type widening diagnostic was corrected before execution.

This is the state coordinator with controlled RPC/journal ports, not a completed native
maintenance transport. The caller must retain resident admission, actual write hooks,
durable Attempt fencing and target permit ownership through task completion. Its ports
are trusted owned capabilities, not evidence that arbitrary supplied callbacks performed
those actions. Native wiring, synchronous durable adapter and production loop remain
incomplete; no live Codex or Discord calls were made.


## 2026-10-08 — Durable maintenance wire-attempt ownership

Added a single-use maintenance attempt with frozen original owner/generation, method,
params, captured origin, fresh attempt UUID and exact wire ID. Observational methods
skip mutation claims. A committed non-observational claim can finish only as not_sent,
reply_ok or an actual owned Remote request failure; partial/flushed unknown errors
retain the attempt and produce MutationOutcomeUnknown with no replay permission.
A failed completion commit overrides even a successful server reply with an unknown
outcome. Explicit false legacy-fence results never invent durable isolation.

Request error discrimination now uses module-owned immutable construction metadata,
not name/message/prototype or mutable public detail fields. Existing request behavior
is preserved. Required synchronous fence methods are pinned and promise-returning
adapters cannot claim completion. Callback/JSON snapshots prevent changed inputs.

Evidence .runtime/cloud-maintenance-attempt-115: 10 new tests, focused 23 PASS; full
**3,135 PASS, 0 fail/skip/cancel; strict TS exit 0**. Includes real request error variants,
forged prototypes/proxies/accessors, commit errors, all result dispositions, repeated
attempt rejection, invalid phases and callback mutation. Persistence is a controlled
port in this suite; durable SQL adapter, actual writer-hook composition and complete
resident/Discord integration remain unfinished. No live service was called.


## 2026-10-08 — Native maintenance request-writer binding

Bound maintenance RPCs to one existing resident admission and the exact session's
serialized native writer. Preflight preserves dispatch check, resident generation/
identity/health, exclusive target and journal verification, durable fence check,
local-idle checks and exact wire claim ordering before bytes. Actual write hooks
supply NotStarted/Partial/Flushed; no caller cancellation is passed to the managed RPC.

Central ClientRuntimeState now produces a synchronous read-only maintenance snapshot
for notification progress, exact terminal witness, active turn and blocking requests.
The session's frozen internal capability binds that snapshot to its private lifecycle
gate. Unattributed and responding requests block; unrelated thread requests do not.
Maintenance transport accepts only the four source maintenance method names.

Evidence .runtime/cloud-maintenance-transport-116: 10 new tests, full **3,145 PASS,
0 fail/skip/cancel; strict TS exit 0**. Actual locally spawned Node helper children and
stdio test resume settlement, fresh unload read, Remote replies, fully-flushed timeout,
transport loss, poisoned generation, released admission, no bytes after denied preflight
and missing terminal witness. These are real local pipes, not a live Codex service.

Healthy fully-flushed owned Timeout does not quarantine. Unknown native/adapter failures
after write start conservatively trigger unfinished-guard quarantine, without guessing
an error kind from its message. Complete native error taxonomy equivalence is still
unverified. Durable fence/journal are controlled synchronous ports here; owned resident
entry points, real SQL adapters and complete production lifecycle remain unfinished.
Initial contextual function typing and fixture occurrence-constructor diagnostics were
corrected before tests; no product assertions were weakened.


## 2026-10-08 — Native resident observation ownership and journal lifecycle

Connected install-once idle journals to the native resident owner. Tracked installation
requires the existing client's durable observation ledger. Observation windows carry
that resident UUID/generation; stale generations cannot read or certify another stream.
Prefix reconciliation first verifies the exact durable scope and then conditionally
clears the captured gap epoch. Unattributed gaps remain sticky. Source-discovery failure
records the conservative fallback and reports errors through the supplied central handler.

Native cleanup now invokes an installed idle journal only after the exact session's
wait/reap confirms child exit. Failed journal completion retains that sealed owner for
explicit cleanup retry. Existing required resident persistence runs before the idle
journal; both adapters must tolerate repeated exact-owner exit reconciliation.

Evidence .runtime/cloud-resident-observations-117: 7 new native-owner tests, full
**3,152 PASS, 0 fail/skip/cancel; strict TS exit 0**. Real helper children exercise
installation, prefix/gap races, source-discovery failure, generation isolation and
exit-journal retry. No live service or store was used.

A source behavior was exposed by one incorrect initial test expectation: frozen Rust
sets idle_ledger_required only on the client present at installation; replacement
RuntimeState defaults to legacy acknowledgement mode. Certifying a prefix alone does
not advance that mode's idle_observed_revision. The corrected test preserves this
behavior and explicitly requires the current-generation legacy acknowledgement after
replacement. This is NOT a fresh Rust executable differential test or a confirmed
production vulnerability. Track whether mode transfer should change in phase 2; do not
silently claim every replacement requires the same ledger mode as initial installation.
Durable SQL adapters, full maintenance owner entry points and production remain pending.


## 2026-10-08 — Owned resident idle-release entry point and managed shutdown

The native resident now owns releaseIdleSubscription end-to-end: original stop-origin
capture, target reservation, exact resident UUID/generation admission, maintenance
transport and Work, and deterministic release of both permits. Maintenance options
and fence callbacks are pinned at resident creation. An unconfigured owner refuses
maintenance rather than creating an implicit permissive adapter. Managed promises
remain owned when the original caller stops observing them; terminal close joins
native-request completion before committing exact-child idle exit settlement.

Evidence .runtime/cloud-resident-idle-work-118: 5 new combined tests; full **3,157 PASS,
0 fail/skip/cancel; strict TS exit 0**. Full initialized isolated SQLite stores use the
actual idle-intent store transitions together with locally spawned helper child/stdio.
Tests cover candidate/ACK/fresh unload, foreign owner and generation, pending admission
preventing restart, terminal shutdown during in-flight unsubscribe and pinned options.

SQLite journal callbacks in these tests borrow the fixture-owned initialized handle
and intentionally use legacy (untracked) observation mode. They are not the production
fresh-open durable adapter, nor full observation-effect certification. Mutation fence
claims are controlled test ports. Ordinary mutation preparation/resubscription, real
runtime store binding, Windows, Discord and operational qualification remain incomplete.
The extra shutdown join is explicit JavaScript ownership; it does not certify all Rust
Tokio cancellation/drop timing or inherited-descendant-pipe behavior.


## 2026-10-08 — Existing-target preparation and managed resubscription

Added the source target-mutation preparation path to the same resident owner. Its exact
read-only/new-thread allowlist bypasses existing-target maintenance; unknown methods
remain conservative. An AwaitUnload target commits Resubscribing, performs exactly one
native resume under managed ownership, then reacquires ordinary target admission.
An original thread/resume returns Completed instead of being replayed. A second
resubscription is refused and its temporary exclusive permit is deterministically freed.

Original parameters and explicitly supplied first stop-origin snapshot are frozen before
waits. Eligibility runs before preparation and again in actual maintenance preflight.
The actual-mutation check preserves generation, target permit and durable fence order.
Both release and resume use one shared managed-work owner; terminal close joins them.

Evidence .runtime/cloud-target-mutation-preparation-119: 8 new tests, focused 13 PASS;
full **3,165 PASS, 0 fail/skip/cancel; strict TS exit 0**. Combined real temporary SQLite
and local child pipes cover original settings/origin, exactly-one resume, wrong reply
identity, held unknown methods, concurrency, generation change and trigger-induced
second-resubscription refusal without a leaked target reservation.

These are internal preparation capabilities. The caller still must own ordinary resident
admission, use the actual-write check and release Ready.permit. The public full dispatch
coordinator, task-local original-origin scope, queue/stop claim adapters and native
response authority binding remain unfinished. No live Codex, Discord or production DB
was accessed. Initial return-literal typing was corrected before test execution.


## 2026-10-08 — First-origin async request scopes and archive subtree binding

Added request-local original stop scopes with immutable first-snapshot semantics.
Explicit null is a set scope and cannot be refreshed by nested calls. Concurrent
requests remain isolated. Target preparation uses an existing task scope rather than
newer explicit metadata, and managed release/resume tasks leave the inherited ambient
scope while carrying the already captured origin as owned data.

Validated Archive expansion preserves the root/revision, accepts at most 100 unique
children, rejects root inclusion/empty/trimmed IDs, and writes UTF-8 BTreeSet-ordered
archiveTargets. Strict non-negative i64 parsing rejects floating/exponent JSON values.
Nested archive expansion cannot reinterpret an already expanded scope as a fresh one.
No scope creates no archive authority, preserving the source's explicit distinction.

Evidence .runtime/cloud-dispatch-origin-120: 10 new tests (9 pure scope/archive and
1 SQLite/native resubscription integration), full **3,175 PASS, 0 fail/skip/cancel;
strict TS exit 0**. Tests include async isolation, exceptions, ignored nested refresh,
null scopes, numeric boundaries, Unicode ordering/whitespace and original metadata
preserved through actual native resume.

Node AsyncLocalStorage propagates to newly created async resources unlike unrelated
Tokio spawned tasks. withoutStopOriginScope is therefore explicit and used at the
managed-work boundary; arbitrary external task schedulers are not certified. These
scopes carry trusted server metadata, not user-supplied execution authority. Archive
adapter subtree validation and full ordinary dispatch/queue/stop composition still
must be implemented before treating this as end-to-end permission enforcement.


## 2026-10-08 — Ordinary dispatch intent and original queue/stop claim selection

Added ordinary DispatchAttempt with exact owner, generation, attempt UUID, wire,
original metadata and write-start evidence. Only identified known operations (or the
source's explicit repair/control cases) can claim target isolation, and only after
successful durable commit. Observations and ordinary unclaimed interrupt do not create
new mutation claims. Original stop claims take precedence, queue claims retain their
own callback, and installed legacy adapters fail closed when those APIs are absent.

Completion writes not_sent, reply_ok or owned Remote reply_error to the exact appropriate
adapter; a stop completion cannot fall back to generic finish. Ambiguous started results
and failed evidence commits retain the intent as MutationOutcomeUnknown. Original input
snapshots and callback pins prevent later caller mutation, and attempts are single-use.

Evidence .runtime/cloud-dispatch-attempt-121: 11 new tests; focused 21 PASS; full
**3,186 PASS, 0 fail/skip/cancel; strict TS exit 0**. Before publication, direct review
found that a missing own ownerId could read an inherited Object.prototype getter.
The same test SHA fails old staged source (10 pass/1 fail, getter count 1) and passes
the corrected exact-own-field gate (11 pass). Raw logs, source hashes and isolated old
stage are retained in review-red-green.json and its named artifacts. No accessor code
runs for missing own identity after the correction.

These are durable intent/coordinator primitives with controlled fence adapters, not
completed queue/stop production dispatch. Outer claim validation, actual ordinary
request/response wiring and the real SQL fence remain necessary. The shared mutation
claim type now permits boolean scoped for ordinary operations; maintenance still
always emits scoped:true as before. No live network service was called.


## 2026-10-08 — Native ordinary resident request, queue and stop dispatch

Connected ordinary resident requests to original stop scope, exact native admission,
managed target preparation, actual writer checks, durable wire-attempt selection and
owned completion. Queue/stop claims are validated locally and never copied into RPC
params. Installed legacy adapters retain fail-closed queue/stop defaults; all optional
methods are pinned when the owner is created. Mutation-unknown classification uses
owned construction metadata, without arbitrary error prototype inspection.

Caller cancellation abandons its wait without writing a fabricated completion. Managed
resume still finishes; any late Ready target permit is released. Fully flushed scoped
committed mutations remain target-isolated, while unscoped uncertain work quarantines
its generation. A later native round-trip on the same serialized writer proves flush
before the cancellation tests. No origin capture occurs for an already-aborted call.

Evidence .runtime/cloud-resident-dispatch-122: 12 new tests, focused 33 PASS; full
**3,198 PASS, 0 fail/skip/cancel; strict TS exit 0**. Real local child stdio plus temporary
SQLite test ordinary requests, queue and stop metadata, unsupported legacy methods,
Remote replies, timeout isolation, resume exactly once, early/late cancellation and
resource cleanup. This implementation accepts native millisecond timeouts only within
its existing safe-integer/2^31-1 bound, rejected before preparation effects.

Direct review found repeated reads of a request DTO could change its method after queue
validation. The identical regression test failed old isolated source (expected rejection
missing) and passes after whole DTO snapshotting, with zero getter calls and no origin/
claim effects. cloneAppRequest is the shared strict boundary for execute/queue/stop;
raw logs, test/source SHA and old stage remain in review-red-green.json.

The SQL idle journal is fixture-owned and mutation fences are controlled adapters here.
Real fresh-open runtime adapters, exact response custody, repair/recovery entry points,
Windows, Discord, process descendants and production/performance validation remain
unfinished. JavaScript AbortSignal ownership is explicitly tested, not blanket Tokio
future-drop equivalence. No live Codex/Discord or production database was used.


## 2026-10-08 — Exact original response authority and native response completion

Resident respond/respondError now capture the exact pending occurrence, original params
and durable authority before target/resume waits. Actual writer preflight checks the
original target and commits response admission; confirmed flush records completion.
Started ambiguity or failed final commit retains original response admission with no
automatic replay. Shared immutable pending-request copies prevent caller metadata drift.

Response authority uses an explicit optional wrapper: null means absent, {value:null}
means present JSON null. It therefore cannot silently drop Some(null) admission. Installed
legacy callbacks default to no authority, but a declared authority with unsupported
begin/finish methods fails closed. Captured payloads remain exact for success/error replies.

Evidence .runtime/cloud-resident-response-123: 14 new tests, focused 46 PASS; full
**3,212 PASS, 0 fail/skip/cancel; strict TS exit 0**. Local native helper pipes and full
temporary SQLite fixtures cover original occurrence, stale/crossed custody during waits,
resubscription payload freeze, explicit nullable authority, legacy refusal and failed
commit after actual flush. ResponseResult getters are never used as success authority.

A real Result-vs-panic translation defect was caught: expected stale-response and invalid
observation-window errors thrown inside withOpen poisoned the healthy client gate.
Identical tests fail old isolated source (2/2) and pass the corrected state-read Result
boundary (2/2); unexpected exceptions still poison. Raw source/test hashes and logs are
in review-red-green.json. This is executable TS/native-helper evidence plus frozen Rust
mutex/Result source reading, not a new Rust executable oracle.

Durable response fence callbacks remain controlled test adapters; production SQL custody
binding, repair/recovery APIs, native Windows, Discord and operational/performance
qualification are not complete. No live approval, Codex request or production store was
used. Existing JavaScript cancellation/drop and inherited-pipe limitations remain.


## 2026-10-08 — Scoped repair dispatch and pinned native recovery reads

Added source-bounded node_repl repair dispatch and recovery-observation request entry
points. Repairs allow only exact scoped read/status requests or node_repl js/js_reset;
original custody is rechecked around actual preflight and the durable wire claim.
Fully flushed repair timeout remains target-isolated under the existing caller contract.

Recovery reads accept only exact read/turn-list/goal requests with a nonempty target,
a genuine native-session client capability and its still-live owned admission. The
same client identity, generation, healthy/open state and absence of pending restart
are checked through the existing resident guard, including actual writer preflight.
Native client provenance uses a private WeakSet; copying a port shape or proxying it
cannot turn injected methods into recovery authority.

Evidence .runtime/cloud-repair-recovery-dispatch-124: 5 new native/SQLite fixture tests,
focused 39 PASS; full **3,217 PASS, 0 fail/skip/cancel; strict TS exit 0**. Covers bounded
repair methods, custody denial after claim but before bytes, exact not_sent completion,
released pins, cross-owner pins, pending restart and zero proxy/injected method calls.

Repair callers still must retain their target queue lock through uncertain outcomes;
this entry point does not acquire that higher-level lock. Bounded recovery collection,
opaque observation lifetime/publication, actual SQL adapters, native Windows, Discord
and production/performance qualification remain pending. Tests never execute a live
node_repl tool; local helper children only exchange controlled protocol fixtures.


## 2026-10-08 — Bounded native recovery observation and one-use lifetime

Implemented the source recovery collector: exact initial/final idle thread probes,
ended Goal, at most eight 16-turn history pages, duplicate/cursor rejection, original
owner-set completeness and separate explicit history-exhaustion status. Both aggregate
returned JSON and combined observation obey the 1 MiB logical byte bound. Owners/target
respect source UTF-8 byte limits; native requests use a 10-second total lifetime and a
maximum two-second individual budget within supported integer-millisecond resolution.

The returned NativeRecoveryObservation can only be constructed with its owning resident's
private key. It retains the exact live native admission, rechecks generation/currentness/
deadline, and consumes once around a pre-acquired synchronous final commit. dispose is
explicit Drop-equivalent cleanup. Copies/JSON/prototype-shaped objects cannot manufacture
its private lifetime. Publication is not user consent or permission to execute a turn.

Evidence .runtime/cloud-native-recovery-observation-125: 17 new tests, focused 17 PASS;
full **3,234 PASS, 0 fail/skip/cancel; strict TS exit 0**. Includes actual helper-client
collection, SQLite final commit, restart invalidation, cancellation, real ten-second
expiry, proof forgery, history/Goal/target/cursor failures, eight-page edge and input/
combined JSON byte boundaries. An initial fixture delimiter was corrected before tests.

Direct review also found a consumed proof could receive an own method shadow. The same
regression fails old isolated source and passes after freezing the instance, prototype
and constructor; actual private lifetime state remains internally consumable. Evidence
and hashes are in review-red-green.json. This is JS capability hardening rather than a
new Rust executable differential test.

The collector's public JSON helper alone confers no native proof. The JSON byte limit
is not a process heap budget; decoded transport values may already be allocated. No
nanosecond/Tokio scheduling equivalence, durable release-consent implementation, live
production SQL binding, Windows or Discord validation is claimed. Production execution
must still validate its original durable record at the actual writer after invalidation.


## 2026-10-08 — Atomic dead-generation capture and durable notice deduplication

Added active-runtime publication and the owned IMMEDIATE capture transaction. It checks
current runtime before an exact receipt retry, decodes all queue jobs before selecting
Starting/Running jobs of the incident generation, stores their existing source-shaped
serialization, and stages the UTF-8 ordered target union with holds and notices atomically.
Existing target holds are preserved. Duplicate exact snapshots return false before queue/
mapping reads and cannot restage delivered notices; changed snapshot bytes are refused.

Channel precedence is first matching queue row, then mirror, then startup; positivity
is checked only after selection. The mirror query still executes when a queue channel
exists, preserving source errors. Unscoped requests add one separately indexed notice.
Activation and capture are exposed through the central StateAccessFacade (124 methods).

Evidence .runtime/cloud-dead-generation-capture-126: 13 new capture tests; focused21 PASS,
full **3,247 PASS, zero fail/skip/cancel; strict TS exit0**. Actual initialized SQLite
fixtures exercise transaction rollback, preserved caller transaction, exact replay after
queue/mapping tables disappear, stale runtime, quarantine exclusion, multi-job ordering,
recipient failure, async input snapshot, and UTF-8/UTF-16 receipt reads. No live DB used.

The existing queue reader and serializer are reused, not newly certified for every Rust
numeric/driver boundary. Native error classes remain TS/SQLite-specific. This owned async
store path is not yet installed as the synchronous native resident persistence callback;
production adapter and offload decisions remain pending. No automatic replay is added.
