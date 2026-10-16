# Persistent resident execution contract — inactive proposal

Status: independently reviewed inactive preparatory contract. Not an implementation, execution authority, activation approval, test result, or migration gate closure.

## 1. Scope and prerequisite boundary

The proposed owner is persistent and owns the resident, its child stdin, resident/session/generation lifecycle, target admission/leases, original request and occurrence, original mutation/response authority, and final database validation. The entire original-state graph must originate and remain there. Moving only final SQL into a worker and sending a permission ACK to a main-thread writer is forbidden. Synchronous check closures do not serialize; replacing them with booleans, DTO claims, registered main-thread callbacks, or recently checked timestamps is forbidden.

No database transaction remains open across IPC, child-pipe write, flush, or network work. After any asynchronous preparation, the owner performs the existing final synchronous predicate immediately before actual local write-start dispatch, in the same owner and without an inserted await, callback, IPC exchange, queue hop, or external ACK. This preserves local order only; it does not prove physical-store exclusivity or that the child cannot outlive its owner.

Physical-store binding/external-writer exclusion and independent child containment/reaping remain missing prerequisites. Checkpoint 893 is inactive accounting WIP, not proof of either. Worker exit is not child exit. If an authoritative original worker-local intent cannot be created from a qualified owner, execution is unavailable; the protocol must not manufacture it from a request envelope. No physical-root workaround, new native backend, guard relaxation, 893 activation, listener retry, denied-path inspection, or abrupt-death qualification is proposed.

## 2. Closed data model

This is a versioned protocol proposal, not a description of a currently installed wire format. The public decoder accepts bounded UTF-8 JSON text/bytes, checks byte size before parsing, rejects invalid UTF-8 and duplicate object keys, and never walks caller-provided arbitrary objects or invokes their getters/proxy traps. Values below are JSON-compatible closed records: exact keys, no additional properties, getters, prototypes, accessors, functions, symbols, undefined, NaN/infinity, sparse arrays, cycles, binary objects, or coercions. All identifiers are ASCII `[A-Za-z0-9_-]+`; lengths are construction-limited UTF-8 bytes. Sequence/revision fields are canonical unsigned decimal strings (`0` or `[1-9][0-9]*`), compared as bounded integers, never JavaScript floating point. Request sequences start at `1`. `null` is permitted only where explicitly shown. Strings are not paths, serialized SQL, scripts, or capabilities.

```
Address = { ownerEpoch: Id, sessionId: Id }
CommandKey = { ownerEpoch: Id, sessionId: Id, sequence: UInt }
Common = { protocol: "persistent-resident-v1", address: Address,
           messageId: Id, body: Body }
Body =
  { kind: "submit", sequence: UInt, intentId: UInt,
    intentKind: "response" | "mutation", observedIntentRevision: UInt }
| { kind: "reconcile", command: CommandKey }
| { kind: "cancel", command: CommandKey }
| { kind: "release-terminal-prefix", throughSequence: UInt }
| { kind: "close", mode: "drain" | "cancel-pending" }
| { kind: "inspect" }
```

These are the complete client commands. There is no `open`, `spawn`, `restart`, `force`, `write`, generic `call`, SQL, path, callback, payload bytes, arbitrary metadata map, remote-agent operation, or command that installs authority. Trusted construction supplies the address/session; transport cannot create or replace them. `intentId`, kind and revision name a worker-local intent, and are compared against it. Matching them never suffices to execute. Intent contents, request ID/occurrence, response Value/mutation parameters, targets and authority are not supplied or patched by this protocol. Ordinary intent-creation APIs remain a separate design gate; until that gate is resolved, live submissions cannot resolve to executable intents.

All responses use this exact outer shape:

```
Reply = { protocol: "persistent-resident-v1", address: Address,
          inReplyTo: Id, body: ReplyBody }
ReplyBody =
  { kind: "protocol-rejected", reason: ProtocolReason }
| { kind: "submission", command: CommandKey, disposition: Submission }
| { kind: "observation", command: CommandKey, observation: Observation }
| { kind: "cancel-result", command: CommandKey,
    status: "recorded" | "already-terminal" | "not-accepted" | "not-seen" | "retired-no-replay",
    observation: Observation }
| { kind: "release-result", throughSequence: UInt,
    status: "released" | "blocked" }
| { kind: "owner-status", status: OwnerStatus }
Submission =
  { kind: "accepted", observation: AcceptedObservation }
| { kind: "not-accepted", reason: NonAcceptanceReason }
| { kind: "identity-conflict" }
| { kind: "retired-no-replay" }
Observation = AcceptedObservation
| { kind: "not-accepted" }
| { kind: "not-seen" }
| { kind: "retired-no-replay" }
AcceptedObservation =
  { kind: "pending", revision: UInt,
    phase: "queued" | "preparing" | "write-started" | "settling",
    cancellationRequested: boolean }
| { kind: "definitely-unsent", revision: UInt,
    reason: "cancelled-before-start" | "closed-before-start" |
            "authority-invalid-before-start" | "preparation-failed-before-start",
    custody: "confirmed" | "unknown", ownership: Ownership }
| { kind: "flushed", revision: UInt,
    custody: "confirmed" | "unknown", ownership: Ownership }
| { kind: "unknown", revision: UInt,
    boundary: "write" | "custody" | "owner-loss", ownership: Ownership }
Ownership = "retained" | "joined"
OwnerStatus = { admission: "inactive" | "open" | "closing" | "closed",
                transportHealth: "connected" | "disconnected",
                acceptedCount: UInt, unresolvedCount: UInt,
                retainedMetadataBytes: UInt, retainedLogicalBytes: UInt,
                lastSeenSequence: UInt, retiredThroughSequence: UInt }
ProtocolReason = "malformed" | "unsupported-version" | "oversize" |
                 "wrong-address" | "sequence-gap" | "rate-limited"
NonAcceptanceReason = "inactive" | "closing" | "capacity" |
                      "intent-unavailable" | "intent-mismatch" |
                      "intent-already-bound" | "previously-rejected"
```

Malformed input with no valid bounded message ID receives no correlated reply; the transport reports a local protocol error and may close. No input strings are reflected in diagnostic errors. `inspect` reports only bounded scalar observations; no identities, payloads or authority objects leak. No `ACK` field is accepted. Reply size is checked against the same construction reply budget before emission; a bounded protocol failure/disconnection cannot imply business success.

## 3. Construction configuration and accounting

The inactive profile requires explicit validated configuration; there are no numeric production defaults:

```
Limits = {
  maxEnvelopeBytes, maxReplyBytes, maxIdentifierBytes, maxSequenceDigits,
  maxAcceptedCommands, maxQueuedCommands, maxActiveCommands, maxRegisteredIntents,
  maxRetainedMetadataBytes, maxRetainedLogicalBytes,
  maxSingleIntentLogicalBytes, maxControlMessagesInFlight,
  maxQueuedReplyBytes, maxProtocolMessagesPerWindow, protocolWindowMs
}
```

Every field is a positive safe integer supplied once by trusted construction, frozen thereafter. Validate `maxIdentifierBytes <= maxEnvelopeBytes`, `maxActiveCommands <= maxAcceptedCommands`, `maxAcceptedCommands <= maxRegisteredIntents`, `maxQueuedCommands <= maxAcceptedCommands`, `maxSingleIntentLogicalBytes <= maxRetainedLogicalBytes`, and that the fixed largest minimal control/rejection reply and identifier-bearing envelope fit their budgets. All additions use checked arithmetic and fail closed. A constructor must reject internally inconsistent configurations. The pure test profile must label its small values as fixtures, not recommended production thresholds. Timing policy and shutdown deadlines also require explicit construction values before a live adapter exists; this document does not invent those decisions.

Canonical encoding is UTF-8 of the exact schema's fixed field order, no whitespace, standard JSON string escaping. Retained metadata charge is the encoded size of the retained submission body plus key and bounded current observation, including per-record scalar fields, plus every registered-intent descriptor, intent-to-command mapping, consumed marker and encoded owner scalar state. None of these records is an uncharged side registry. It is a logical encoded-byte metric, not object-heap size. Reserve the schema's maximum possible bounded observation bytes for every accepted record at admission so terminal/cancellation/Unknown transitions cannot fail for lack of registry metadata. Identifiers and revisions must fit the reservation throughout the epoch; sequence/revision overflow closes new admission instead of wrapping.

Logical bytes include every owner-retained intent payload's declared canonical encoded bytes, generated JSON-line write buffer including newline, queued reply bytes, and any intentionally retained duplicate buffers. Each live allocation/reference ownership scope must be identified before a production binding is approved. Shared backing storage is not deducted merely because two owners share a reference. Input decode/transient-copy/native stream/heap/RSS costs require separate evidence; these budgets are not a whole-runtime memory claim. The inactive pure model uses injected numeric charges and asserts arithmetic only. It cannot certify actual allocation or native submission limits.

Admission reserves accepted-record metadata, logical intent/write budget and queue/active slot before binding the intent. Failed reservation binds nothing and returns `not-accepted: capacity`. Control handling has separately reserved bounded capacity and reply budget; overload rejects/disconnects rather than building an unbounded error queue. No capacity relief may evict ambiguous work. Exhaustion remains unavailable until exact safe release or a separately qualified custody transfer. No TTL converts Unknown to success, definitely-unsent, released ownership or retry permission.

## 4. Identity registry and linearization

One authenticated construction-bound session owns the monotonically increasing submission sequence in one owner epoch. `messageId` is correlation only, never command identity. The owner maintains bounded accepted entries, `lastSeenSequence`, `retiredThroughSequence`, and exact worker-local intent-to-command bindings, and a monotonic `lastMintedIntentSequence`. Numbers refer to one epoch/session; there is no cross-epoch deduplication claim.

For a fresh valid addressed `submit`, require `sequence = lastSeenSequence + 1`. Reject a larger sequence as `sequence-gap` without advancing. At the same synchronous admission step, advance last-seen and either reserve/bind/register exactly once or declare nonacceptance. The accepted entry stores immutable canonical submission content and original intent binding before returning acceptance or enqueueing work. Rejection consumes that sequence but binds no intent and causes no execution. A client may issue a new sequence after observed nonacceptance; it must not do so after an uncertain submission.

For `sequence <= retiredThroughSequence`, return `retired-no-replay` and do nothing. For an accepted retained sequence, compare exact canonical immutable submission contents: equal returns its current observation without adding a queue item; changed contents return `identity-conflict`, preserving the original. For an already seen unretired sequence without an accepted entry, return `not-accepted: previously-rejected`. It is never admitted later with changed content. Absent records are meaningful only inside this exact still-live registry/session: before any request was processed, sequence greater than last-seen yields `not-seen`; after restart or loss, absence proves nothing.

Worker-local intent registration uses an epoch-local positive UInt `intentId = lastMintedIntentSequence + 1`; construction validates its bounded digits and increments this scalar only when a bounded record is reserved and registered. Every registered intent, bound or unbound, consumes maxRegisteredIntents and its metadata/logical-byte charges. Removed IDs can never be registered again: the high-water scalar survives record deletion for the entire epoch and never wraps. A failed registration produces no usable intent ID. Unbound intent destruction is an owner-local lifecycle operation, not a transport command. The future authoritative intent factory must independently enforce original request/occurrence single-use; minting a fresh numeric ID does not authorize cloning a consumed original. This factory is unavailable pending the complete ownership design.

An intent bound to any accepted command cannot be rebound under a different command key, including after cancellation, Unknown or flush. Eligible command compaction must destroy its consumed worker-local intent and release its mapping/descriptor/payload charges together; monotonic non-reuse survives in the single retained high-water scalar. No per-retired-intent tombstone is needed or allowed outside the configured budget. No sequence wrap, alias session, epoch reuse, token clone or freshly generated key unlocks replay.

Acceptance means responsibility has been retained and capacity charged, not that the final predicate passed, a write began, custody committed, or the child consumed anything. The local registry is not durable proof across owner loss. Any durability before acceptance remains a future integration obligation, with no fictitious durable-acceptance ACK in this contract.

## 5. Outcomes, transport and reconciliation

- `not-accepted` is exact-owner evidence that this command never acquired execution responsibility; its handling cannot initiate a write. Capacity, closing and unavailable intents are nonacceptance, not `definitely-unsent` for an accepted operation.
- `definitely-unsent` requires the owner to know no invocation of the actual write-start adapter occurred for the accepted command. A throw after adapter invocation is not enough to establish this. Custody may still be unknown; joined ownership is separate. This evidence is necessary, not sufficient to relax existing conservative attempted/writeStarted classification. Current writer.ts sets attempted before its writeStarted hook; a thrown hook or absence of successful Writable.write must not automatically be reclassified as definitely-unsent.
- `flushed` requires observed successful completion of the existing writer flush contract. It does not prove child parsing, provider/model completion, user-visible delivery or durable custody settlement. `custody: unknown` preserves failed/uncertain post-effect persistence without replaying the effect.
- `unknown` means the requested business evidence cannot be established. Owner/channel failure after an unconfirmed submission is caller-side Unknown even if the worker never accepted; it cannot be translated into nonacceptance. Pending/wire-started timeout or cancellation does not undo a write. Original intent/request/occurrence and all unjoined ownership remain held.

`postMessage` success, channel delivery, correlated receipt, acceptance, and business outcome are different events. A transport receipt grants no execution permission. Main-thread responses are for observation only. The main thread must have no child stdin/effect capability for this path.

A waiter's timeout/cancellation freezes that waiter's Unknown result; a late reply never silently upgrades the returned result. Explicit read-only reconciliation may reveal later evidence for the same original key without creating or rerunning work. Same-epoch `reconcile` yields a retained observation, exact nonacceptance, not-seen, or retired-no-replay. Both the outer address and every nested CommandKey must exactly match the construction-bound epoch/session before any lookup or mutation; otherwise reject wrong-address. `reconcile` never advances a sequence. For sequence greater than last-seen, `not-seen` is only a current observation: an already in-flight submit may arrive later, so it supplies no nonacceptance, definite-unsent or retry permission. After disconnection reconnect only to a demonstrably identical surviving owner/session; otherwise report Unknown. Worker loss cannot be reconciled by searching an empty new registry. A future durable reconciliation adapter must recover the original authority/outcome from a qualified durable source and cannot auto-replay. This contract provides no such adapter.

## 6. Cancellation, close, retirement and restart

Cancellation is a serialized owner event against the exact command key, not a signal that frees admission immediately. Before actual write-start, cancellation can transition an accepted command to definitely-unsent only after pending preparation is joined and no write-start can occur. During/after write-start, record cancellation and continue owned settlement; the result remains flushed if established, otherwise Unknown. A separate late cancel never overwrites a previously observed flush. For a retained accepted key, cancel-result is recorded or already-terminal with its exact accepted observation. For a seen rejected unretired sequence, it is not-accepted with observation not-accepted. For a retired sequence, it is retired-no-replay with observation retired-no-replay. For sequence greater than last-seen, it is not-seen with observation not-seen: cancellation does not reserve/consume that future sequence, and cannot exclude a delayed submit. The caller must reconcile the exact original key, never infer retry permission. CommandKey sequence zero is invalid. Duplicate cancels are idempotent. Control ordering and final check/write-start are owner-local; the cancellation-arrives-after-start race is classified at that actual boundary, not caller wall-clock time.

`close` first permanently closes submission admission for the epoch, then processes existing exact entries. Drain permits already accepted valid work to settle; cancel-pending prevents queued/unstarted work from beginning and requests cancellation of active work without releasing it. A subsequent cancel-pending can strengthen drain; drain cannot reopen or weaken cancellation. Pending reconciles/duplicate submissions can observe existing entries while transport remains available; they cannot enqueue new work. Child shutdown and writer closure are owner responsibilities with explicit joins. `admission: closed` is reported only after all accepted work, native work, actual child containment/reaping and owner resources have established their required terminal ownership state. Unresolved child proof means closing/unavailable, never fabricated closed.

`release-terminal-prefix` is explicit client acknowledgement of already observed terminal outcomes, not permission to execute. A throughSequence of zero or at/below the existing retired-through watermark succeeds idempotently without change; throughSequence greater than last-seen is blocked without change. Release only a contiguous prefix up to last-seen for which every accepted entry is either definitely-unsent or flushed, custody is confirmed and ownership joined. Unknown, pending, unjoined or uncertain custody blocks the entire requested advance. Rejected sequence gaps require no entry. Successful release deletes eligible full records and advances the monotonic retired-through watermark; all old keys remain permanently non-executable within the epoch. Compaction destroys the associated consumed intent records and mappings; the epoch-local intent high-water scalar permanently prevents ID reuse. The authoritative original request/occurrence custody must still reject cloning under a fresh ID, independently of this transport registry. This is record compaction within the same live epoch, not retirement of the owner, generation, child, durable custody or deduplication obligation. The retained watermark permanently rejects delayed old submissions. It does not prove no delayed delivery; it makes that delivery non-executable. Discarding the epoch/watermark or replacing the owner still requires the independent containment/cutover proof below. No age-based eviction. Without releases, bounded metadata fills and admission stops safely.

Restart is not a command in this protocol. A trusted lifecycle controller may construct a new epoch only after independently established old-child containment/reaping, store ownership/cutover exclusion and handling of original unresolved custody. A worker exit, lost port, elapsed grace period or process ID alone supplies none of that. Otherwise restart remains blocked. New epoch cannot auto-replay old keys or reconstruct authority from DTOs; old caller results remain Unknown unless independent qualified reconciliation proves otherwise.

## 7. Opaque worker-local authority boundary

A future live owner must use non-exported constructors and identity-checked private registries/brands for: resident ownership, session lifecycle, generation, target admission/lease, original request/occurrence custody, final-store authority, child stdin, and containment/reaping evidence. Structural TypeScript interfaces, casts, booleans, paths, hashes and DTO round-trips do not construct these objects. Reference equality plus private ownership checks must hold throughout admission, preparation, final predicate, write-start, completion and joins. Closed owner/foreign epoch/consumed handles fail closed.

The protocol model accepts only abstract observations and injected numeric charges. It has no API returning an executable capability or requesting SQL/pipe operations. Any future execution adapter must be private to the qualified resident owner; public `execute(callback)`, generic SQL, handler injection from protocol data, arbitrary path/byte writes and caller-supplied final-check callbacks are prohibited. Existing closures may move only with their complete owning graph; they cannot be faithfully serialized.

## 8. Preparatory implementation and exact pure-test scope

Permitted next candidate after separate approval: an unimported pure module containing only exact DTO types, strict byte/text decoder, canonicalizer, explicit limits validator, command-key comparison and checked numeric budget/reservation arithmetic. It must not import the production root, SQLite/native owners, writer/child process, filesystem, network, worker_threads, timers or real clocks; it must not export production activation hooks. Module comments and package inclusion must label it inactive. Its planned later consumer is the persistent resident proxy/owner protocol boundary, reusing the reviewed parser/limits rather than maintaining a second schema. That integration requires separate approval and remains blocked by the complete worker-local intent island and physical/child proofs.

The registry prose in sections 4–6 is a normative design constraint, not a fully specified executable reducer. No registry/reducer implementation is approved or claimed ready from this document. A further reviewed design must first specify the complete worker-local intent factory, private API and closed event union, exact legal transitions/revisions, queue-to-active reservations, close completion and permitted later-evidence reconciliation. Do not fill that gap with generic callbacks or test-only pretend authority. This explicit boundary keeps the immediate preparatory module useful without prematurely inventing the live execution lifecycle. This document records no implementation or executed test result.

Exact pure tests for that first module:

1. Decoder accepts only primitive text or an explicitly owned bounded byte input. Reject arbitrary objects, proxies and accessor-bearing objects at the API boundary without property traversal. Byte/text parsing rejects invalid UTF-8, duplicate keys, unknown keys, wrong discriminants/version, missing fields, invalid enum values, invalid ASCII IDs, negative/fractional/noncanonical/oversized decimal sequences, unsupported nulls and over-budget input before constructing a DTO. JSON cannot itself contain functions/getters/prototypes; do not claim byte parsing exercises their execution.
2. Every Body/ReplyBody/Submission/Observation variant has an exact valid fixture and single-field invalid mutations. Nested keys must match the expected construction address. CommandKey/submission sequences are positive; release-prefix accepts zero. Cancel-result status/observation pairs are constrained exactly as section 6, not arbitrary cross-products.
3. Canonical encoding has fixed field order, exact UTF-8 lengths including multibyte text when applicable, deterministic escapes and round-trip schema identity. Caller-owned mutable bytes cannot alter the retained parsed value. A schema-only fixture never contains request payload, authority, SQL, filesystem path or raw write bytes.
4. Every configuration field is required; zero, negative, fractional, unsafe integer and inconsistent capacities reject. Identifier/sequence maxima fit bounded envelope/reply formulas. The largest bounded control/rejection reply fits the reservation. Boundary-size inputs succeed only at their exact allowed byte/count limits.
5. Checked budget arithmetic reserves metadata, intent records/mappings, logical bytes and reply bytes independently and together, refuses overflow or capacity excess, and rejects underflow/double-release in the numeric helper API. Specify the exact helper API separately before coding its tests; these checks establish arithmetic only, never actual heap or stream allocation.
6. Key comparison includes exact epoch/session/positive sequence and never uses messageId as operation identity. Same canonical submission contents compare equal; one changed immutable field differs. Comparison returns data only and cannot return an executable capability.
7. Static review verifies the pure module's closed exports/import graph, no timers/I/O/runtime wiring, no callbacks/SQL/path/raw-byte execution API, and no conversion from parsed DTO to authority. Only frozen explicit test roots are eligible, not broad discovery or crash/kill/network qualification.

Deferred registry/lifecycle acceptance tests, only after that additional API/event design: one accepted enqueue per identity; consumed intent cannot rebind or remint; sequence gaps and future cancel do not imply nonacceptance; lost ACK/late outcome never authorizes replay; conservative start boundary preserves unsent versus Unknown; flush and custody are independent; close ordering and joins; bounded all-record retention; prefix compaction rejects stale delivery without discarding epoch protection; Unknown/unjoined custody blocks release; restart cannot use worker exit as child proof. These are required future cases, not an executable or passed test profile today.

Passing the first pure module's tests would establish only parsing, identity comparison and numeric-budget behavior. It cannot prove execution registry transitions, final DB-to-pipe order, physical identity/exclusivity, actual retained heap, real flush semantics, worker/child lifetime, cross-runtime exclusion, crash safety, performance or migration completion.

## 9. Source anchors and provenance

Frozen Rust source provenance: repository `simdorei/codex-discord-remote-rust`, commit `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`. The following source file and blob identities were verified at that commit. They are source evidence, not a Rust binary execution or parity result. Blob identities are exact anchors; line-number precision is not claimed for Rust.

- [control/write.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-app-server/src/control/write.rs), blob `a4e3ddf3e3635e68e948079561436076b9a71605`: stdin mutex, synchronous preflight, write_started, write_all.await, flush.await.
- [dispatch/mutation.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-app-server/src/manager/dispatch/mutation.rs), blob `6e14f0cfff472f0de1d5709762efcabfaca1ae2d`; [target_mutation/response.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-app-server/src/manager/target_mutation/response.rs), blob `ab64a4ec67b29996302af6f7f3bbf7a6304606b2`: original mutation/response ownership and writer composition.
- [mutation_attempt.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-store/src/mutation_attempt.rs), blob `73d560dd28c6e16f0f88252b479be72e9a9d6c51`; [mutation_attempt/response.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-store/src/mutation_attempt/response.rs), blob `2669f4817ca3fb313c71cda013aeb2dcee1d60cd`; [response/wire.rs](https://github.com/simdorei/codex-discord-remote-rust/blob/d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34/crates/cdr-store/src/mutation_attempt/response/wire.rs), blob `9a6b7bc5abf146aa50c25ff7d04f9230de3cba8d`: original checks around intent insertion in IMMEDIATE transaction, commit before pipe write. No transaction spans IPC/pipe and no atomic exclusion of arbitrary external writers is established by this order.

TS source anchors inspected in checkpoint 942 source tree `2efff991c734f025e8eafa3fc59385e6baae492d`, archive commit `2ea13b45e58d56b75a45e8038a227e6ff6eb71b6`:

- `src/app-server/writer.ts:73-104`: original owned preflight, synchronous validate at 91, write-start hook at 95, writeAll at 96 and flush at 97; cleanup retains admitted ownership.
- `src/app-server/node-streams.ts:26-35`: actual Writable.write occurs synchronously inside writeAll's Promise executor before its first await.
- `src/app-server/response-attempt.ts:31-53`: exact original occurrence/params/authority/payload; synchronous beginResponse at 46; separate finishOwned at 53.
- `src/store/prepared-mutation-validation.ts:13-39`: final synchronous original-intent read transaction and COMMIT before returning to the writer; no permission-producing IPC.
- `src/runtime/runtime-paths/path-text.ts:46-47`: path spelling explicitly is not secure file identity.
- `src/app-server/portable-process.ts:12,28-29,59-60`: parent-exit kill is best effort, not reaping proof; explicit force-dispose only establishes its declared direct-child/pipe scope, not descendant/platform containment.

Directly inspected scope documents:

- `docs/MIGRATION_COMPLETION_GATES_20261016_R2.md`, checkpoint 942 through 941: final-authority design is incomplete, 893 inactive, physical exclusion/child proof and original acceptance gates remain open.
- `docs/native-response-completion.md`, checkpoint 931 (`244b2c5ecaff63b418af5f3fecdbd4412d585642`): original opaque claim receipt, `not_sent`/`flushed` completion, started-wire uncertainty, correlation ACK not authority, actual native exit retained. Existing Control default 1, completion FIFO 128 and deadline 5,000 ms are contextual provenance only; they are not proposed resident-protocol limits.
- `docs/WRITER_RETAINED_WORK_ACCOUNTING.md`, checkpoint 939 (`048a5bb0b258133e017c71ee23e66b741427084e`): UTF-8 buffer bytes include newline, actual ownership survives asynchronous cleanup, local final validation/write ordering unchanged; logical gauges do not establish memory or admission caps.

## 10. Stages and stop conditions

A. Review this inactive contract and exact source provenance; resolve schema/semantic ambiguities before any implementation.
B. Separately approve the schema/limits-only preparatory module/test profile. No executable registry/reducer, production import, wiring or authority changes. The registry API/events require an additional reviewed design before implementation.
C. Design complete worker-local original-intent/resident/session ownership and prove physical-store/cutover and child-containment prerequisites on an authorized route. Missing proof blocks live adapter construction.
D. Independently review one concrete execution adapter preserving final local guard-to-write order and all old predicates. Only then authorize exact installed wiring and bounded non-denied qualification.
E. Qualify integrated installed behavior under the original acceptance contract. No stage here implies gate closure, deployment, live bot/DB activity or replay permission.
