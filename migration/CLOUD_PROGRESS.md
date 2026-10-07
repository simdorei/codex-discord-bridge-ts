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
