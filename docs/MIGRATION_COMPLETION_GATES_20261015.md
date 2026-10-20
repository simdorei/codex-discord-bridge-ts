Current status: see the [checkpoint 930 ledger through checkpoint 929](MIGRATION_COMPLETION_GATES_20261016.md). The checkpoint 914 body below is preserved as historical evidence.

# Migration completion gates — checkpoint 914

Documentation reconciliation, 2026-10-15 UTC. **The migration is substantially implemented in scoped paths, but remains incomplete and unqualified as a complete runtime.** This ledger replaces stale present-tense inventory claims; it does not promote a candidate, rerun verification, approve deployment, or assign a completion percentage.

## Frozen reporting basis

- Inspected local baseline: `543c09e22e720ac095967b5ae985e5aaac1a1a40`; tree: `7a7cda2d53c37d655287fda533c65168557156cb`.
- Corresponding published archive: [checkpoint 913, `ca6c8fdc9cc4aea3f6b28317385a967d33881a9a`](https://github.com/simdorei/codex-discord-bridge-ts/commit/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a), as verified in the parent preservation record. Local checkpoint SHAs and published archive SHAs are different histories; only published SHAs are used in web links below.
- Acceptance authority remains the unchanged [Pro-reviewed A–G contract](../migration/rebuild-20261010/requirements/ts-runtime-parity-pro-reviewed-20261007.md), reviewed body SHA-256 `b38ec59008b6a98955ca86b0e13034d05eda3b045152e8df1fa235e02c06f22a`. Its document/plan PASS is not implementation, QA, performance, operation or deployment PASS.
- Evidence here consists of permitted source inspection, checkpoint documents and existing frozen verification receipts. No source or test was changed, compiled or executed for 914. A test file's existence is not a passing result. Historical results remain bound to their original graph and profile.
- 913 is reported solely from its documentation and recorded evidence, not independently reviewed by this ledger. Its final independent review was blocked by a tool security restriction and remains **UNVERIFIED**; no retry, rephrasing, alternate reviewer or restricted-code approval was attempted.
- The protected `test/remote-agent/redaction.test.ts` was not read, compiled, run or reconstructed. Known UNIX-root `listen EPERM` cases were not retried. These omissions are not passes or skips. 893 remains inactive accounting WIP, not writer exclusion or wire authority.

### Status vocabulary

- **Implemented:** the named behavior has source and checkpoint evidence within the stated boundary.
- **Wired:** a named consumer installs that behavior; a programmatic/synthetic route is identified separately from the default CLI.
- **Scoped verification:** recorded tests/review apply to the identified frozen slice, platform and fixtures. This does not imply full-suite or end-to-end acceptance.
- **Unqualified / missing:** required implementation, installation, independent acceptance, platform or operational evidence is still absent or blocked.

Neither test totals, module counts, checkpoint numbers nor unequal obligation-group counts provide a migration percentage. No whole A–G gate is closed by this reconciliation.

## Major implemented paths and important gaps

Implemented and wired paths now include typed Gateway/message/history/interaction ingress; durable admission, original result/confirmation custody; New/Ask/Interview intake and first-reply handling; queue/resident supervision; Stop/Repair and explicitly configured Recover; component/async-question publication and replies; completion/receipt delivery; BridgeSync; and prepared startup/shutdown ownership. Many installed SQLite paths now use joined native workers. These are concrete implementation advances over the old helper-only inventory, with bounded offline evidence rather than operational approval.

The five principal remaining boundaries are:

1. **Complete executable/platform acceptance.** Maintenance and experimental local CLI entry points exist. The local application still rejects Windows, configured remote MCP and host commands. Session mirroring requires an explicit programmatic profile that the CLI does not supply. POSIX singleton/root qualification remains blocked; Windows singleton/process-tree ownership and release/install qualification are not complete. [Application gate][application], [CLI][cli], [package][package]
2. **Remaining command and effect integration.** `HostReboot`, `ForceRestartCodex` and `DeleteArchiveConfirm` still reach unsupported dispatch. `Recover` is wired only when an explicitly owned controller is installed; there is no default controller in the local CLI root. Archive backup/reservation/fence preparation is not exclusive source-file deletion or an enabled delete-confirm operation. [Command routing][commands], [fallback dispatch][basic], [executor construction][executor]
3. **Complete database isolation without weakening authority.** Checkpoint 909 offloads installed dead-generation snapshot persistence, but final mutation/wire revalidation, response capture/begin/finish, Repair final custody, startup activation/idle hooks and periodic processed-marker Discard still include synchronous store work. 893 accounting does not justify removing these guards. [Native revalidation][revalidation], [response custody][responses], [Repair custody][repair], [909](native-dead-generation-persistence.md), [905](gateway-accepted-message-custody.md)
4. **Real remote capabilities and protected handoff.** 910/911 provide scoped dispatcher/managed ownership; 912 wires them through an explicit loopback-only synthetic root. 913's real POSIX read/list factory is uninstalled WIP with final independent review unverified. Native protected persistence/binding authorization, write/checkpoint/Git/code/image/command, terminal and computer/UI backends remain unfinished. Synthetic success cannot qualify these boundaries. [910](remote-dispatcher-ownership.md), [911](managed-remote-ownership.md), [912](synthetic-remote-runtime.md), [913](native-remote-read-backend.md)
5. **Original G1–G7 acceptance.** Whole-runtime fault/saturation/restart evidence, actual Discord/Codex contracts, frozen numeric Rust/TS comparisons, deployment/install checks and 24-hour stability remain unqualified. Focused and bounded affected passes overlap and cannot be added into an end-to-end acceptance result.

## A–G gate ledger

### A. Preserve functional and durable-state meaning

**Implemented / wired.** Original message and interaction identities survive preparation, durable admission, execution, result, confirmation and hold through captured native journal ports. Private original custody distinguishes newly admitted work from compatibility callers and duplicate/uncertain outcomes. Message and interaction startup install these paths. Command execution includes the principal prompt, settings, archive/resume, Stop, Repair, Steer, Retract and selection routes; BridgeSync is configured by prepared worker startup. Recover is conditional on an explicit controller. [Message journal checkpoint 900](../migration/rebuild-20261011/checkpoint-900-native-message-journal.md), [interaction journal 901](../migration/rebuild-20261011/checkpoint-901-native-interaction-journal.md), [commands][commands], [prepared startup][prepared]

**Scoped verification.** 900/901 record compiled native/installed fixtures for exact large IDs, lost or crossed acknowledgments, held native work, admission/cancellation boundaries, result-before-success delivery and original custody. [903](../migration/rebuild-20261011/checkpoint-903-native-new-input.md) records prepared New input persistence. Confirmation retains its original separate receipt-validation and ingress-update connections; this is not newly atomic end-to-end acknowledgment.

**Open acceptance evidence.** Complete the unsupported command/effect paths above; qualify actual upstream ingress recovery and externally observed acceptance; execute G5/G6 at each durable/external boundary on one identified runtime graph; demonstrate compatible old request/run state and old-owner handoff. A process restart guarantee must not be extended to power-loss durability without fixed journal/synchronous/storage assumptions. Accepted Gateway custody from 905 is in-process anti-discard protection, not a durable queue or blanket no-loss guarantee. Automatic Reserve switching and replay of failed/started/unknown requests remain excluded.

### B. Separate optional reads and preserve bounded incremental custody

**Implemented / wired.** Display context has independent readers. Mirror reads bound window bytes, record bytes and record counts, join native decoding, recheck observed file identity, and retain complete-record prefix evidence. Bound polling holds invalid/oversize records rather than skipping them, verifies the persisted path/generation cursor and advances only through the receipt/cursor path. Native receipt storage and the shared receipt sender preserve unknown outcome holds. Startup bootstrap, shared mapping locks and real shared HTTP transport are connected through the explicit mirror profile. [Read windows][windows], [bound polling][poll], [cursor store][cursor], [receipt sender][receipts], [bootstrap contract](mirror-startup-bootstrap.md)

**Scoped verification.** 867–875 and the bootstrap document describe temporary SQLite, rollout files and loopback HTTP: skip existing history, first append delivery, receipt/cursor advancement, no-change polls, original startup-intent recovery and joined cancellation. Existing record/window/continuity fixtures cover parts of G1; the ledger does not claim they were rerun on 914.

**Open acceptance evidence.** Qualify the actual append-only rollout producer and stable database/mapping identity throughout the lifecycle; the caller's programmatic assertion is not that evidence. Run the complete G1 long-history/cold/backlog/rotation/truncation/partial UTF-8/JSONL/oversize/corruption matrix with measured bytes and records and restart custody checks. Verify live delivery contracts. The ordinary CLI remains gated. Global mapping ownership currently serializes mirror targets for correctness; it is not evidence of the required workload throughput/fairness. Optional stale context must never become execution permission.

### C. Bound concurrency, pending work and fairness

**Implemented / wired.** One shared native worker budget currently assigns Background 3, Control 1, Observation 2, Discovery 1 and Maintenance 1. Ordinary work refuses capacity; already-owned completions use finite Control/Observation FIFOs, and periodic Maintenance has a separate bounded FIFO. Queue/target locks, typed ingress ownership, bounded messages and explicit accepted-original custody are installed. 906/907 retry only privately proven unsubmitted capacity failures of the same retained immutable Gateway original; they do not replay an admitted effect. [Worker budget and exit custody][workers], [queue coordinator][queue], [905](gateway-accepted-message-custody.md), [906](live-gateway-message-policy-native.md), [907](native-message-classification.md)

**Scoped verification.** The journal, policy and native-owner records include saturation, queued cancellation, accepted work retention and cross-lane regressions. Remote 910–912 add bounded synthetic command/session/project ownership without a second worker pool.

**Open acceptance evidence.** Produce one end-to-end inventory of active and queued counts, retained bytes at every large-data boundary, subordinate SQLite/native submissions and release conditions. Run G2 with a slow target and all lanes saturated, proving ordinary target/control/heartbeat progress or explicit refusal under predeclared limits. Local transfer/count limits do not bound SQL scan work, native allocation, process RSS or total latency. Inspect correctness serialization and avoid treating configured capacity as measured fairness.

### D. Keep synchronous database/large CPU work off the event loop

**Implemented / wired.** Emitted JavaScript workers execute under pinned Node with type stripping disabled. Native adapters now cover many installed admission, queue, receipts, policy/classification, question, preparation, mirror and completion paths. 900–908 move the documented installed message/interaction/policy/proposal work; 909 adds native dead-generation capture before replacement under the original restart lock. [Resident installation][resident], [909](native-dead-generation-persistence.md), [native message journal 900](../migration/rebuild-20261011/checkpoint-900-native-message-journal.md), [native interaction journal 901](../migration/rebuild-20261011/checkpoint-901-native-interaction-journal.md), [908](native-abandonment-proposal.md)

**Scoped verification.** Recorded native fixtures exercise poisoned compatibility adapters, SQLite stalls, ACK loss and actual-exit ownership; compiled production parity is recorded per checkpoint. 909's native capture is independently scoped-verified. It does not replace the synchronous `persistDeadWork` compatibility contract with a Promise.

**Open implementation and evidence.** Final wire and response guards remain synchronous: `NativeMutationOwner.validateForDispatch` calls the retained synchronous revalidator; response custody captures/begins/finishes synchronously; Repair checks current custody synchronously. Startup activation, idle/old-child hooks and processed-marker Discard are not all offloaded. Do not remove a correctness guard or widen an asynchronous gap merely to claim isolation. 893 is unenrolled by default, lacks external-writer/alias exclusion, and cannot supply authority-to-wire proof. Any further design must preserve final freshness and ownership, followed by G3/G4 event-loop measurements. [Revalidation][revalidation], [response custody][responses], [Repair custody][repair], [startup custody][custody], [893](../migration/rebuild-20261011/checkpoint-893-store-authority-enrollment.md)

### E. Preserve database concurrency and compatibility

**Implemented / wired.** Central state-facade leaves, owned initialized/existing-only connections, short store operations, atomic claims/CAS, backup and lossless bigint/string ID serialization exist and are consumed by native runtime adapters. The existing-only connection opens read-write without creating/repairing, with a bounded SQLite busy timeout; calling it a semantic read does not make the handle read-only. 900–909 reuse original store bodies rather than changing schema or transaction meaning. [Existing connection][existing], [owned driver][driver], [native journal 900](../migration/rebuild-20261011/checkpoint-900-native-message-journal.md), [909](native-dead-generation-persistence.md)

**Scoped verification.** Temporary-store fixtures in the cited checkpoints include existing-only failures, malformed/foreign rows, exact large IDs, concurrent claims, locks and commit-before-ACK loss. The runtime/package pin is Node 24.21.0 and TypeScript 7.0.2. The connection's 0–5000 ms busy-timeout bound is not a request completion guarantee. [Package pins][package], [existing connection][existing]

**Open acceptance evidence.** Freeze actual Node/driver/SQLite versions, compile options, journal/synchronous/foreign-key options, busy/retry/whole-request deadlines and storage assumptions for the acceptance environment. Audit remaining semantic reads/transactions, statement lifetimes and no-network-in-transaction behavior across installed paths. Execute G3/G6 on original-state fixtures and actual cooperating runtime ownership, including alias/external-writer limits, lock recovery and WAL/long-reader behavior where applicable. Do not infer physical store exclusion from 893's path-keyed accounting or from adding workers/WAL. No production database setting is changed by this ledger.

### F. Separate waiting, resource reclamation and external result certainty

**Implemented / wired.** `OwnedWorkerSlot` retains capacity and writer registration until actual native exit. Submitted SQLite failure/timeout/abort remains uncertain; receipt and journal owners join and retain original responsibility. Resident dead-generation replacement in 909 requires actual old-child/transport closure, exact retained work, confirmed native capture and post-await revalidation. Prepared shutdown retains owners if cleanup is unconfirmed. 910/911/912 provide synthetic remote connection/session retirement, reconnect ordering and joined root cleanup. [Worker exit handling][workers], [native mutation uncertainty][mutation], [909](native-dead-generation-persistence.md), [912](synthetic-remote-runtime.md)

**Scoped verification.** Existing records cover late/crossed ACKs, retained worker slots, cancellation while locked, old-generation mismatch, exact snapshot reconciliation and failed cleanup. Synthetic remote tests verify binding/session ownership and loopback reconnect; they do not qualify physical resources or a durable exactly-once external contract.

**Open acceptance evidence.** Complete G4–G6 with repeated timeouts and stuck workers, expired queued work, old process survival, late results, crash boundaries and actual external outcome reconciliation. Qualify Rust-to-TS single-owner cutover and native Windows process-tree termination. Protected handoff must establish real durable protection/envelope/fingerprint/resume-window/claim-by-rename semantics before remote restore parity is claimed. 913's local read/list WIP cannot close any of those gates. A volatile mutation cache or a new request ID is not durable idempotency proof; unknown/started user work never gains automatic replay permission.

### G. Minimum validation and predeclared acceptance

**Current status: open.** Many G scenarios have scoped fixtures, but no complete identified A–G acceptance run or measured migration percentage exists. The matrix below describes outstanding evidence, not permission to run restricted or live tests.

| Original gate | Existing scoped evidence to reuse | Evidence still needed to close the original gate |
| --- | --- | --- |
| G1: incremental/cold/backlog/file changes | Bounded mirror windows, generation-bound cursor/receipts, startup/bootstrap records | One frozen long-history/no-change/backlog/rotation/truncation/partial UTF-8/JSONL/oversize/corruption matrix; measured bytes/records/work; cursor plus delivery responsibility through restart; actual producer contract |
| G2: slow target and full saturation | Shared budgets, ingress custody, native journal overlap and capacity-refusal tests, target locks | Installed-runtime counts/bytes/submissions and measured ordinary/control/heartbeat progress or explicit refusal under full saturation, including mirror serialization |
| G3: separate SQLite lock and lost commit response | Native journal/mutation/dead-generation lock and ACK-loss fixtures | End-to-end lock hold/release and commit-reply-loss at each relevant installed boundary; independent loop-delay evidence, no false success, same-ID reconciliation, recovery and atomic claims |
| G4: repeated timeout/expired queue/late work | Worker exit accounting, joined owners, cancellation and stale-generation tests | Repeated workload over the full installed graph; bounded live work/queues/bytes, no late start/overwrite, explicit unreclaimed state and recovery, without extending thresholds after failure |
| G5: process death at four responsibility boundaries | Durable journal/receipt/startup-intent recovery and scoped fault fixtures | Process-kill/restart matrix at admission, external send, external success-before-local-record and cursor handoff; actual provider idempotency/outcome evidence; distinguish reconciliation holds from delivery success |
| G6: old state/large IDs/old owner | Lossless IDs, existing-state helpers, generation guards and scoped replacement tests | Representative old cursor/request/run import and real old-process survival/late-completion cutover; single execution owner; no reset hiding an impossible handoff; supported platforms |
| G7: comparable Rust/TS measurements | Versioned source/artifacts and scoped graph-parity records | Same frozen fixtures/load/settings and identifiable Rust/TS binaries; predeclared numeric absolute latency, allowed regression, capacity, failure/sample and recovery thresholds; latency distributions/maxima, live work, queue bytes, memory and post-load recovery |

Before G7 execution, fix the numeric thresholds and aggregation rules. Include controlled input injection and independent event-loop observation so pre-callback delay is visible. Observe receipt, durable acceptance, notice send/confirmation, start request/actual start and result readiness/delivery separately; separate model/external latency from bridge latency. Failures and reconciliation holds belong in the results. Do not increase deadlines or thresholds after seeing failures. Small local passes do not close 24-hour stability, real Discord/Codex compatibility, platform installation or deployment approval.

## Checkpoints 909–913: exact reconciliation

| Checkpoint | Published archive and local commit | Implemented/installed boundary | Recorded verification and current disposition |
| --- | --- | --- | --- |
| 909 | [Published `cfc8f59579d42f2511e8ed504b8aaab622f2b86a`](https://github.com/simdorei/codex-discord-bridge-ts/commit/cfc8f59579d42f2511e8ed504b8aaab622f2b86a); local `f3f651c7a8636954a0c799de8084e2056002dfb8` | Installed native dead-generation capture before replacement; original synchronous compatibility hook and final guards retained | Scoped native/fault/regression evidence plus independent review; no full D/E/F/platform qualification. [Details](native-dead-generation-persistence.md) |
| 910 | [Published `9ad7cc6525a9d26c8235f1a22399b2d1e05239fa`](https://github.com/simdorei/codex-discord-bridge-ts/commit/9ad7cc6525a9d26c8235f1a22399b2d1e05239fa); local `0839fe76745f8cb659a1447f233950878660dc3d` | Bounded typed dispatcher/project/session foundation; originally uninstalled, later composed only through 911/912 synthetic profile | Offline scoped ownership review/tests; trusted backend contracts are not native implementation or permissions. [Details](remote-dispatcher-ownership.md) |
| 911 | [Published `4ae20bb6b92e37771e6b62bcdc173e6b7348eef5`](https://github.com/simdorei/codex-discord-bridge-ts/commit/4ae20bb6b92e37771e6b62bcdc173e6b7348eef5); local `87fc88e76e3d96f0fc04f6cd806bde2252f7544d` | Managed dispatcher/connection/reconnect/retirement with synthetic binding restore/protect | Scoped synthetic resources and real loopback evidence; protected durable handoff absent. [Details](managed-remote-ownership.md) |
| 912 | [Published `9172f1b20f5e85fc5af952fa4b8e5a8eb6b4bac1`](https://github.com/simdorei/codex-discord-bridge-ts/commit/9172f1b20f5e85fc5af952fa4b8e5a8eb6b4bac1); local `f2bfc856700cfda84772b6933a806446b10f663f` | Authentic explicit programmatic synthetic remote profile in prepared startup, Pro readiness and joined runtime shutdown | Final scoped independent verification recorded; actual root-composition tests use a synthetic singleton seam. CLI configured remote still rejects; no native singleton/Windows/production approval. [Details](synthetic-remote-runtime.md) |
| 913 | [Published `ca6c8fdc9cc4aea3f6b28317385a967d33881a9a`](https://github.com/simdorei/codex-discord-bridge-ts/commit/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a); local `543c09e22e720ac095967b5ae985e5aaac1a1a40` | Documentation reports a bounded actual POSIX read/list factory with transferred pre-bound owners; **uninstalled WIP** | Writer records final local checks, but final independent review is **UNVERIFIED** after a tool restriction. Earlier independent evidence belongs to an earlier graph. No promotion approval. Linux temporary fixtures only, with documented non-atomic hostile-rename limitations. [Status record](native-remote-read-backend.md) |

Existing local receipts (not newly executed): `.runtime/dead-generation-909/final-freeze.json`, `.runtime/dispatcher-910/final-freeze.json`, `.runtime/managed-911/final-freeze.json`, `.runtime/remote-runtime-912/final-freeze.json`, `.runtime/native-read-913/final-freeze.json`. These bind the individual evidence graphs; no combined full-suite total is inferred. The 913 receipt explicitly records `WIP_FINAL_INDEPENDENT_REVIEW_UNVERIFIED` and `promotionApproved: false`.

## Reconciliation of the historical 18-group inventory

The old [Markdown inventory](../migration/completion-inventory.md) and [JSON inventory](../migration/completion-inventory.json) describe an early 2026-10-06 snapshot. Their retained status/count fields are historical, not current completion measurements. The table below corrects implementation claims without declaring these unequal groups qualified end to end. Gate closure follows A–G above.

| Historical group | Current implemented/wired scope | Remaining boundary |
| --- | --- | --- |
| 01 Protocol/value codecs | Existing standalone codecs plus runtime consumers | Historical diagnostic/domain exceptions and actual protocol compatibility; no codec-only runtime PASS |
| 02 Startup/configuration | Maintenance CLI, experimental local root, prepared ingress/core/shutdown composition | Restricted CLI profiles, native singleton/platform and install/live qualification |
| 03 Store schema/open/backup/read ownership | Central facade, existing/initialized drivers, native adapters and backup helpers | Full concurrency/compatibility/physical-ownership and platform qualification; 893 is accounting only |
| 04 Mutation authority/journal | Native installed message/interaction lifecycle, mutation begin/finish, original receipt/custody integration | Final wire/response guards still synchronous; full fault/cutover acceptance |
| 05 Queue/admission/retry/goals | Queue coordinator, native claim/submission/state and supervised runtime paths | Whole-runtime boundedness/fairness and terminal/restart evidence; no unknown-effect replay |
| 06 New first-reply identity/intent | Intake and native first-reply store/checkpoint consumers | External creation/receipt and process-restart acceptance across every boundary |
| 07 Gateway/input/durable acknowledgement | Typed Gateway/history/message/interaction entry points, native journals and accepted-original custody | Live upstream recovery, complete crash/no-loss boundaries and measured ACK/receive behavior |
| 08 Resident RPC/writer/process/deadlines | Non-Windows native direct-child lifecycle, supervision, generation fencing and 909 capture | Windows process-tree ownership, final synchronous guards and full old-owner cutover |
| 09 Stop/cancel/late ACK/holds | Native Stop acceptance/dispatch/recovery and original custody in installed command paths | Actual external termination/late-result semantics and platform/fault qualification |
| 10 Repair/recover/tray/watchdog | Repair route and conditional Recover executor/controller interface; runtime supervision | Default OS recovery controller, remaining native host/tray/watchdog parity and platform acceptance |
| 11 New thread/prompt intake/attachments | Installed New/Ask/Interview intake/preparation, native state and joined attachment client | Full original-state/creation/attachment/live outcome and restart acceptance |
| 12 Async-question ownership/disposition | Native prompt authority, async choice/recovery decisions, question publication/receipts and text replies | Actual provider request/occurrence/revision behavior and all crash/late-response boundaries |
| 13 Mirror/history/cursor/archive | Bounded mirror, native receipts/cursor/bootstrap, BridgeSync; archive preparation/fences | CLI mirror producer qualification; exclusive source deletion and DeleteArchiveConfirm; full G1/G2/G5 |
| 14 Manual Reserve | Manual settings/catalog behavior and native startup retirement exist | Real runtime/provider compatibility; automatic switching/replay deliberately remains excluded |
| 15 Remote MCP/OAuth/Windows | Protocol/connection plus 910–912 scoped synthetic composition; 913 uninstalled read/list WIP | Real authorized binding/protected persistence, remaining native capabilities, operational remote/Windows acceptance |
| 16 Pro conversation/plugins | Inventory/fingerprint/manifest/preflight/project prompt adapters installed in Pro executor; 912 shared synthetic readiness | Live plugin/conversation identity and remote contract qualification; default CLI has no configured remote readiness |
| 17 Fresh DB/import/install portability | Store creation/migration/backup primitives and emitted maintenance/local entry points | Representative original-state import, installer/portable distribution, backup restore and platform release acceptance |
| 18 Output delivery/receipts/Unicode | Shared guarded receipt sender, native persistence, completion/question/mirror consumers | Real delivery/idempotency/outcome contracts and process-death/unknown-hold acceptance |

Additional inspected anchors: [first-reply native store][firstreply], [question publication][questions], [manual Reserve settings][reserve], [startup Reserve retirement][retirement], [Pro executor][executor], [Pro preflight/runtime][pro]. These establish implementation presence, not that every legacy Rust leaf or all named group obligations have been independently mapped and qualified.

## Next independent, unblocked work

Prepare an original-contract acceptance packet for G1–G7: map each required scenario to an existing permitted fixture and exact source/artifact identity; list missing cases, observables, platform prerequisites and the numerical thresholds that must be approved before measurement. Keep the packet bounded to existing migration obligations. Its completion condition is a reviewable matrix with no unexplained coverage claim and an explicit accepted-or-pending threshold decision, not a new implementation or a benchmark PASS.

This can proceed independently of restricted 913 review and 893/root qualification. It does not authorize rerunning a denied review, inspecting the protected fixture, bypassing UNIX `EPERM`, enabling Windows/remote CLI, changing final guards, touching a live bot/database, or executing a cutover. Implementation of an unblocked original missing path should be separately scoped from this documentation checkpoint; final blocked review remains blocked until a permitted route is explicitly available.

## Documentation validation and preservation

914 changes only this ledger and navigation/status notices in older inventories. Historical checkpoint records and immutable handoffs remain intact. Validation checks Markdown/local source targets and frozen line anchors, JSON parseability, preservation of prior document bytes/JSON values, whitespace and the exact documentation-only diff. No claim is made that web publication or CI occurred as part of this writing task. The parent may preserve the frozen documentation as its next authorized archive checkpoint.

### Frozen source anchors

All web source anchors below refer to the published 913 archive corresponding to the inspected baseline. They are references to existing permitted source, not an independent approval of 913's changed backend code.

[application]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/discord-runtime/local-application.ts#L38-L95
[cli]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/cli/local-runtime-main.ts#L6-L21
[package]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/package.json#L1-L25
[commands]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/action-executor/command-executor.ts#L133-L186
[basic]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/action-executor/basic-dispatcher.ts#L39-L64
[executor]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/discord-runtime/executor-bootstrap.ts#L57-L84
[prepared]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/discord-runtime/prepared-workers.ts#L38-L89
[revalidation]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/mutation-custody-fence.ts#L26-L81
[responses]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/response-custody-fence.ts#L14-L34
[repair]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/action-executor/recovery-custody.ts#L19-L46
[windows]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/session-mirror/read-window.ts#L5-L38
[poll]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/session-mirror/bound-poll.ts#L27-L91
[cursor]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/session-mirror/cursor-store.ts#L29-L72
[receipts]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/completion/receipt-sender.ts#L30-L89
[workers]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/owned-worker-slot.ts#L14-L113
[queue]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/queue-runner/start-coordinator.ts
[resident]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/discord-runtime/resident-startup.ts#L21-L58
[custody]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/runtime-custody.ts#L9-L25
[existing]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/store/existing-store.ts#L8-L25
[driver]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/store/owned-driver.ts
[mutation]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/native-mutation-owner.ts#L52-L124
[firstreply]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/new-reply/native-store.ts
[questions]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/async-question-publication-native.ts
[reserve]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/action-executor/settings-action.ts#L54-L73
[retirement]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/runtime/discord-runtime/reserve-retirement.ts#L20-L36
[pro]: https://github.com/simdorei/codex-discord-bridge-ts/blob/ca6c8fdc9cc4aea3f6b28317385a967d33881a9a/src/pro/runtime.ts#L19-L50
