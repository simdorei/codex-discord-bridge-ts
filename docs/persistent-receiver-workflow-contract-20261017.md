# Disposable persistent receiver workflow: review candidate

Status: proposed implementation contract, pending independent review. No adapter implementation or runtime qualification is claimed. The scope is one complete server-request workflow in the existing disposable persistent component. Installed startup, authentic-root qualification, physical-store exclusion, independent child containment, and the existing failed component cleanup gate remain unchanged.

## 1. Original workflow and owner

Rust baseline: `simdorei/codex-discord-remote-rust` at `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`, `crates/cdr-runtime/src/server_request_worker.rs`, blob `5173d828b261f9f0d0429b75a6dbb09d76410707`. Its one receiver/recovery loop, authority-first local response, and per-chunk recorded delivery are the model, not a new generic execution registry.

The existing persistent component retains the actual resident, child, generation, pending occurrence, target preparation, response custody and final synchronous writer boundary. One original server-request subscription is created before the new scenario can emit requests or enter recovery. The original `ServerRequestDelivery` and `runServerRequestWorker` run in that same owner. Do not create a second business subscriber or transfer resident response authority to main.

Keep the existing three-attempt recovery snapshot, attempt-all/first-error behavior, one retained receive, gap handling, retry schedule, sent cache and shutdown semantics. After preliminary observations and local-tool classification, directly call the original resident `respond`; no IPC or new await is inserted at its capture boundary. The generic inactive intent protocol is not used by this automatic branch.

The fixed new scenarios must establish an actual resident active turn through the original child notification flow; a seeded running database row is insufficient. Fixture observations use notifications and durable assertions, not the existing temporary business subscriber helper. Local acceptance, unsupported-form cancellation and ordinary non-form prompt delivery remain distinct.

## 2. Construction and closed public surface

One main-owned receiver-services owner is constructed for each existing disposable component, before its worker receives the final initialized frame. It captures the original pinned database and its exact original requester Worker. A fresh data MessageChannel and independent stop/join MessageChannel are transferred once in that frame, with a random 32-hex epoch. No business message carries a path, SQL, worker URL, executable, callback, token, receipt-store object, arbitrary HTTP method/path/body, or executable response claim.

The worker client validates that exact construction inventory and original persistent role. Its three read methods implement the already existing `PromptAuthorityReads` shape; they check the locally pinned path before posting. Its concrete chunk sender is privately bound to this client. `ServerRequestDelivery` gains a captured concrete persistent-sender mode that is immediately used by this component; its existing direct/native callers remain unchanged. An arbitrary callback/structural object cannot construct the new persistent sender.

The fixed disposable main transport is constructed inside component composition, not supplied by a business message or caller callback. Its bounded private scenario enum is selected once by the original main `runFixture` before that function posts the existing fixed scenario command; no service operation can select or change it. It only observes exact validated requests and returns fixture identities or fixed fixture failures. It performs no HTTP. There is no new production transport/startup API in this increment.

Data operations are exactly:

- `observed-completion { thread, turn }`
- `all-jobs {}`
- `channel-mapping { channel }`
- `server-prompt-chunk { channel, logicalKey, chunkIndex, content, components }`

The chunk domain is fixed to `server-request/prompt/v1`; the guard is always the existing null guard. Main calls the original `sendReceiptChunk` with native receipts enabled, its construction-bound database and fixed validated transport. This preserves the original per-chunk native owner, shared receipt outcome reducer and final native close. There are no separate remote begin/confirm/release/block operations.

Each operation record contains its exact `op` discriminant and only the fields listed above. Read field types/limits are exactly the existing `PersistentPromptReadRequest` codec, including signed i64-or-null mapping channels. For chunks, channel is the original positive receipt-channel i64, chunkIndex is an unsigned u64 bigint, logicalKey/content are original well-formed strings, and components is a canonical JSON-array string, not an arbitrary object graph. No additional restriction is placed on the request-ID material inside logicalKey; the unchanged serialized receipt-key limit applies. Components are the empty-array string or one exact allowed row. The string byte cap is checked before parsing, and reconstruction must reserialize to the identical string, rejecting duplicate/extra keys and alternate noncanonical encodings.

## 3. Component value transfer

The current helper-produced component brand is a local implementation detail, not a Rust identity requirement. A structured clone must not be cast back into that brand.

The worker serializes only its original helper-produced server-prompt components. A closed reconstruction inside the component module accepts either an empty array or the exact one-row profile produced by `buildServerPrompt`:

- Four bound approval buttons with the existing fixed labels, styles, answers and common 16/32-hex fingerprints.
- One through five bound input buttons, with the existing style, common fingerprints, option numbers in original order, and original nonempty labels of at most 80 Unicode scalar values. There is no leading source-trim whitespace. Trailing whitespace is permitted at exactly 80 scalars: the original helper trims before truncation and does not trim again.

It rejects additional fields, row types, nesting, arbitrary custom IDs, styles, duplicate IDs/option positions and malformed strings. Duplicate label text remains valid. Reconstructed values use the original private `button`/`row` constructors directly after validation, never the public input helper that would trim a second time. Their canonical serialized bytes must exactly equal the worker's captured component bytes. An explicit `a` repeated 79 times followed by a space and `b` fixture must retain the truncated final space and exact receipt hash. This creates output representation only; it does not create an actor, occurrence, response permission or native admission proof.

Main recomputes the unchanged idempotent request, nonce, receipt key and component-sensitive content hash through the original helpers. The component integration assertions compare those bytes/hashes with the original worker-side rendering, including the final-chunk-only component rule. No generic prepared HTTP request is accepted.

## 4. Read results and failures

Main invokes `createNativePromptAuthorityReads` at the original path. Preserve its conditional sequence, separate joins and native deadlines: observed completion 6,000 ms; complete queue and mapping observations 5,000 ms. Do not add an AbortSignal parameter to this read port. Stop waits for the original read and then the existing delivery cancellation check runs.

The existing successful-value codec preserves every queue row, field, signed integer, numeric timestamp and original order. No combined snapshot, filtered list, truncation or cache is introduced. Original full native-envelope checks still run in main, including the path and generated request identity; transport validation cannot replace them.

Terminal read failures carry a closed operation-bound classification:

- `store`, with the existing at-most-512-byte `NativeStoreReadDiagnostic` (including Json, Integrity, InvalidQueueState, UnsupportedVersion, Database and supported ScopeCleanup).
- `admission-unavailable`, only for the original main adapter's actual pre-submission busy/budget failure; this is diagnostic, not a recreated private admission-refusal proof.
- `native-unavailable`, with the exact read operation and original native wrapper family.
- `unclassified-read-failure` for an otherwise unprojectable failure, without raw text or guessed Store category.

Worker-local authority, generation, prompt rendering and resident failures remain local and unchanged. Cross-isolate reconstructed errors preserve category and behavior, not arbitrary JavaScript reference identity. No raw exception, SQL, row, message or stack is transmitted as a diagnostic.

Chunk failures preserve the original semantic categories: held, delivery, receipt-unconfirmed with Begin/Confirm/Release/Block, actual pre-admission busy/budget, and unclassified failure. A main cancellation matching its own original chunk signal is represented separately and maps to the caller's original local signal reason only for that same pending operation. Known successful completion is never replaced merely because cancellation was requested.

Exact wire failure records and reconstruction:

| Exact record | Original main provenance | Worker reconstruction |
| --- | --- | --- |
| `{kind:'store', diagnostic}` | Genuine `NativeStoreReadError` returned by the original bound read; capture its diagnostic with the original diagnostic decoder | `new NativeStoreReadError(diagnostic)` |
| `{kind:'admission-unavailable', reason:'Busy'|'Budget'}` | Exact original `OwnedWorkerBusyError` or `OwnedWorkerBudgetError` caught from this original operation; no name/string matching | Same diagnostic error class; never insert into any private admission-refusal map |
| `{kind:'native-unavailable', source:'Observed'|'List'|'MirrorTarget'}` | Respectively genuine `NativeControlEvidenceUnavailable`, `NativeQueueReadUnavailableError` for List, or `NativePromptIntakeUnavailableError` for MirrorTarget | Same original wrapper class and operation with fixed safe cause text where required |
| `{kind:'unclassified-read-failure'}` | Any other error after invoking the original read | New fixed `PersistentPromptReadUnclassifiedError` bound to the client's original operation |
| `{kind:'held'}` | `isCompletionHeld(error)` from the original sender | `new CompletionHeldError` with a fixed non-sensitive reason, preserving `isCompletionHeld` |
| `{kind:'delivery'}` | Genuine `CompletionDeliveryError` | Same class with fixed non-sensitive detail |
| `{kind:'receipt-unconfirmed', operation:'Begin'|'Confirm'|'Release'|'Block'}` | Genuine `CompletionReceiptUnconfirmedError` with its exact valid own operation field | Same original class/operation with a fixed safe cause |
| `{kind:'cancelled'}` | This chunk's main controller is aborted and original sender threw that exact controller reason | The exact caller-local signal reason, only if its same operation's signal is aborted; otherwise protocol fault |
| `{kind:'unclassified-chunk-failure'}` | Any other error from the complete original sender | Fixed `PersistentPromptChunkUnclassifiedError`, without replay permission |

Failure unions are operation-specific. Read tags cannot appear for a chunk, nor chunk tags for a read. The matching native source tag is fixed by the original read operation. Admission projection is diagnostic only and cannot reconstruct native non-submission authority. Boundary validation is separate: client capture failures throw locally before posting or reserving an ID; a malformed main frame quarantines the bridge. A TypeError/RangeError thrown by an invoked original adapter remains unclassified, never reclassified as a pre-admission boundary refusal. Raw receipt/Held/error text is not transmitted. All validated business terminals, including failures, survive retirement loss without changing category.

## 5. One serial slot and transport bounds

The client and main each retain at most one operation across all four operations. No waiter queue exists. IDs increase from 1 through 2,147,483,647 without wrap, reset or reuse. A single retired-through scalar rejects stale frames; no unbounded per-operation history is kept. Epoch and ID are correlation, not business authority.

Each operation reserves one request, one result and one terminal acknowledgement. At most one cancellation frame exists for a chunk operation; reads have none. Close is one final fixed exchange. The independent control channel permits one permanent `stop-and-join` exchange for the whole owner lifetime, never an operation retry or reopen command.

Fixed representation limits:

- Request payload: 262,144 serialized bytes, with the original observed identity limits of 16,384 UTF-8 bytes each.
- Chunk payload: 131,072 serialized bytes. Its original serialized receipt key must already fit the native 65,536-byte key boundary, its bridge representation permits at most 2,000 content scalars, and the closed component representation is at most 8,192 bytes. The original sender separately preserves its unchanged 1,900-scalar content limit and typed delivery failure; the bridge does not raise that semantic limit. These caps cover the original accepted server-prompt profile rather than truncating it.
- Successful read payload: the original 16,777,216-byte native-equivalent envelope. The new transport wrapper is charged separately and cannot reduce that native limit.
- Failure payload: 2,048 serialized bytes, including its at-most-512-byte Store diagnostic.
- Each wrapper/control frame: 2,048 serialized bytes.
- Exact closed shape and dense arrays are checked before copies; no generic graph callbacks or coercions are allowed.

Queue success validation retains its exact 19-field job schema. With the success wrapper at depth zero, the deepest value is a baseline-turn string at depth four. Node/edge/container counts are each bounded by 16,777,216 after the original byte check; every accepted node/edge/container item has at least one serialized byte, so this does not lower the existing accepted byte domain. No arbitrary recursive object is accepted as a job field. Components have at most one row and five buttons, depth four including their array wrapper, and 64 value nodes/edges; their 8,192-byte string and rebuilt representation share the already charged main fixed-call reservation. Control/failure records have their exact fixed shape rather than a generic graph depth allowance.

The retention inventory is fixed before implementation:

1. Six request reservations: worker captured input, worker outgoing envelope, main incoming frame, main normalized input, main fixed-call/reconstructed-component view, and main active-slot input. Aliases are conservatively charged separately. Incoming/outgoing references are cleared after capture/post; slot and fixed-call references remain until actual settlement.
2. Six bridge reply reservations: main original returned value, main normalized value, main terminal envelope, worker incoming frame, worker validated value, and worker retained terminal observation while acknowledgement is pending. Terminal envelopes may alias their normalized values; polling or acknowledgement must not create a result history.
3. Two workflow reply reservations: the original verifier can retain its queue match while awaiting the subsequent mapping result. Both are covered even though these returned values are outside the bridge's active slot. The fixed client is used only by this one serial original loop; it is not exposed as an arbitrary read/caching API. No whole-list cache is added.
4. Six small reservations: client outgoing cancellation, main incoming cancellation, client outgoing stop/join, main incoming stop/join, main joined-control reply, and worker joined-control reply. Each failure payload occupies its operation's already reserved reply site, not an additional history.

Thus the proposed conservative reservation is six request sites at 262,144 bytes, eight reply sites at 16,779,264 bytes, and six fixed 2,048-byte control sites: 135,819,264 logical serialized bytes. New retained representations beyond these sites require renewed review. This is not a physical heap/SQLite/native/MessagePort allocation bound. Opaque transport serialization/allocation and the pre-existing native/domain internal copies are expressly outside this logical accounting; no claim bounds those allocations or resident request/render/cache state.

No 5-/10-second generic service phase timer is substituted for original business work. Native deadlines remain as above. The existing disposable component observation deadline can quarantine the component, but cannot finish this operation, release its slot or prove native/HTTP exit. A result is retained in the one slot until exact acknowledgement; no age-based result eviction or timer-as-join is permitted.

## 6. Result, acknowledgement and loss of data port

Normal data exchange is `submit(id, operation)` then one `terminal(id, result)` then `ack-terminal(id)` and `retired(id)`. Main starts only the fixed operation associated with that slot. It publishes terminal only after the complete original Promise, including all native/receipt close work, settles. Client acknowledgement is bookkeeping and is not itself join evidence. The main task reference is not erased before its actual settlement.

All frames have exact own-data keys `{ version: 1, epoch, body }`. Epoch is the construction's 32 lowercase hexadecimal characters. Data bodies are exactly `{ kind: 'ready' }`, `{ kind: 'submit', id, operation }`, `{ kind: 'cancel', id }`, `{ kind: 'ack-terminal', id }`, `{ kind: 'close' }`, and `{kind:'ack-close'}`; replies are exactly `{ kind: 'ready' }`, `{ kind: 'terminal', id, operation, result }`, `{ kind: 'retired', id }`, and `{ kind: 'closed' }`. The terminal `operation` is its original fixed operation tag, not a repeated request graph. `result` is exactly `{ kind: 'ok', value }` or `{ kind: 'error', failure }`; successful chunk value is null, and successful read value must pass its operation-specific original-success decoder. Unknown fields/discriminants, extra operations, unsolicited/duplicate replies and wrong epochs quarantine the endpoint.

Each submit ID is exactly the prior accepted ID plus one; main cannot accept another submit until exact retirement. Cancellation is permitted only for the current chunk while its terminal has not been observed by the client. A queued cancellation received after main settlement is harmless for that same still-retained slot and cannot rewrite its terminal. The client removes the cancellation listener when it observes terminal, before acknowledging, so it cannot emit a cancellation for a retired slot. A duplicate submit/cancel/ack is a protocol fault, not a second effect.

Control bodies are exactly `{ kind: 'stop-and-join', id }` and `{ kind: 'joined', id }`, under the same version/epoch wrapper. Zero is allowed only to close a construction with no submitted operation and high-water zero. Other IDs use the positive operation range. The one control request and response have no payload/result graph and no release/retry consequence.

Legal normal states and transitions are:

| Side/state | Permitted event | Next state and retained responsibility |
| --- | --- | --- |
| Main Boot | One ready frame | Idle; reply ready |
| Client Boot | Exact ready reply | Idle |
| Client Idle | Capture valid original input, reserve next ID, post submit | WaitingTerminal; retain signal/input/slot |
| Main Idle | Submit with ID = high-water + 1 | Running; fix input and retain original task before invoking work |
| Main Running | One matching chunk cancel | Running; request original cancellation, retain task |
| Main Running | Complete original task settles | Terminal; retain exact typed result and post it once |
| Main Terminal | One matching late queued chunk cancel | Terminal unchanged; no outcome rewrite |
| Client WaitingTerminal | Exact matching terminal | WaitingRetired; retain known result, remove abort listener, post ack-terminal |
| Main Terminal | Exact ack-terminal | Idle; release operation payload references, advance retired-through and post retired |
| Client WaitingRetired | Exact retired | Idle; return retained business result/error, then clear its slot |
| Client Idle | Normal close requested | Closing; post close, no further submit |
| Main Idle | Normal close frame | Closing; all tasks already joined; post closed |
| Client Closing | Exact closed reply | ClosingAck; post ack-close and expect both original port closes |
| Main Closing | Exact ack-close | Closed; close both original ports, retain closure observations |
| Client ClosingAck | Both original port closes | Closed; fulfill service close |

Unexpected close/error in any other state is a fault, not a normal-close transition. Main normal `Closed` additionally requires both actual port close observations. A lost close acknowledgement can leave debt even when client saw closed; main eligibility still prevents a clean component release. Main uses one original task record so a cancel, data fault and task settlement cannot create parallel completion paths.

On any data-port fault, malformed frame or failed posted exchange, both sides permanently stop new receiver-service admission. The worker aborts its construction-local failure signal, which is included in the original loop's shutdown signal. It does not return an ordinary retryable read/send error while original work might remain unjoined.

The client uses the independent constructor-bound control port once: `stop-and-join { id }`. The main control handler first permanently seals data admission and ignores any delayed data submission. It retains and joins the exact active task if one was admitted. If the data submission was never admitted, sealing before replying guarantees no delayed submission can start. Only then does it send `joined { id }` on that original control port. The response establishes closure of service work for this exact failed exchange, not business success, no-send, replay permission or root release.

Control accepts only the exact current operation (Running or Terminal), the most recently retired ID when Idle, or high-water + 1 when Idle and the client submission was not admitted, plus the initial zero case above. It does not accept a previous retired ID while a newer operation is active. The handler seals data before checking/answering the never-admitted case; delayed queued data is ignored after sealing. It then joins the original Running task, or uses already established Terminal/retired settlement, before returning the one matching joined reply. Other IDs/epochs fail closed. One active slot and a monotonic high-water mark make these cases finite. No operation can be reissued under a new ID after a fault.

If the data terminal had already been validated, retain its known business result; loss of terminal retirement does not rewrite successful late acceptance into cancellation. Otherwise, after joined control evidence, return a distinct bridge-unconfirmed failure. The loop's failure signal prevents another recovery/live request. Main retains any uncertain terminal/retirement bookkeeping and component debt.

If the independent control path is also unavailable or its evidence is invalid, the waiter remains unconfirmed and the slot/debt is retained. Worker exit, port close, elapsed time or a current process listing cannot synthesize that join. This scope does not claim arbitrary simultaneous channel-loss liveness or overall component cleanup qualification.

The worker-side trigger is explicit: the client exposes one construction-local failure AbortSignal. Before starting any scenario/loop, the worker attaches one listener that immediately closes receiver admission, aborts its loop controller and enters the original component failure path. That path starts original resident disposal without awaiting an unconfirmable service/loop Promise, while retaining both pending obligations. The failure signal is triggered on either data or control error/unexpected closure, not only by parent quarantine. The data terminal may still supply actual joined evidence if control alone failed; if neither path can do so, no loop-joined report is emitted. Parent quarantine also seals the main receiver service and requests its owned chunk cancellation; it never manufactures the worker's child-disposal result.

## 7. Cancellation and shutdown

Ordinary shutdown does not close the endpoints first. It aborts the original loop, waits for its retained read/send and receive, then closes receiver services, then disposes the original resident and remaining service owners in their existing order. Main includes receiver-service task joins and both original port closures in component join and normal release eligibility.

For chunks, original signal cancellation is mirrored once to the main controller. The unchanged sender still confirms a validated late message ID, or records a definite rejection independently of cancellation. Data/control faults may request cancellation but cannot discard an already owned transport/receipt task. Reads keep their original uncancellable port semantics and join before settlement.

The chunk client first calls the original signal's `throwIfAborted`, before capture, ID reservation or posting. It then captures the fixed input, reserves its slot/ID, and installs the one abort listener before the original submit post. If cancellation occurs during that synchronous preparation, recheck before post and return the original reason without a submitted operation; do not consume an ID until the immediately following original post boundary. Once posting was attempted, never infer non-submission from a throw. An abort after successful post sends the one matching cancel frame; listener installation and a final aborted-state check prevent a missed cancellation. Terminal observation removes the listener before acknowledging and preserves its known success or failure.

A control-only fault seals admission and triggers abnormal shutdown, but does not disable the current data terminal handler. While sealed, that handler accepts only the exact already pending operation's valid terminal/retirement evidence, never another operation or an unsolicited frame. A valid terminal from the original main owner still establishes that operation's already completed join and preserves its exact business result; owner/component debt remains retained because control closure is abnormal. If data also fails before terminal, the operation remains unconfirmed.

After a permanent fault, the client physically closes its original ports only when its slot is empty and either exact control-joined evidence arrived, an actual terminal/control join settled its current slot, or control loss found no submitted task pending. Data-only loss with no slot still performs the one stop-and-join exchange before closure. Physical close retains sealed admission, does not set normal Closed, and cannot qualify the component or release its debt. This prevents a cycle in which a referenced control port waits for worker exit while worker exit waits for that port; a posted operation without terminal/control join remains pending instead.

On an abnormal failure where loop join cannot be established, first stop future work and retain the loop task. Attempt original resident/child disposal as failure cleanup without presenting that disposal as loop/native join. Record both obligations separately; failure cleanup cannot satisfy normal component release. No finally block clears a pending task, no new send is scheduled, and no retained temporary root is removed.

## 8. Cohesive implementation and qualification target

Expected implementation touches the existing component bootstrap/worker/store-role/composition, a dedicated fixed receiver-service protocol/client/main owner, the component output reconstruction, and a concrete delivery sender seam. The complete original loop is wired in the same package. A codec-only or unused adapter checkpoint is not the deliverable.

The fixed responder gains bounded original methods for computer-use form, browser form, unsupported form, approval prompt and input prompt while preserving all existing scenario behavior. Tests drive real turn start and actual child requests, retain original occurrences and compare durable response/receipt rows. The passive main transport has fixed bounded instrumentation; no live HTTP or external service starts.

Any transport-entry barrier is observation-only fixture instrumentation, never an extra business operation or proof of receipt/native join. The concrete fixture inventory and its scalar observation storage must receive source review before execution; no callback transport, arbitrary request payload or general fault-injection command may be exposed through the bridge API.

Required fresh bounded cases include initial recovery and live events, CUA/browser accept and unsupported cancel, approval/input component-byte fidelity, native read classification/conditional order, occupied native join, normal shutdown, cancellation with late accepted-ID confirmation, data-port failure before/after admission with held true join, and terminal-ACK loss retaining known outcome and debt. Malformed/control-path-loss accounting may use a socket-free protocol fixture without claiming actual child/root closure.

Run only independently reviewed explicit allowed graphs under the existing fresh 300-second supervisor, separate author/reviewer freezes, strict selected/production builds and emitted production parity. Existing normal scenarios need an exact affected regression selection because shared component sources change. The mandatory existing cleanup/component failure remains recorded; do not filter it into a whole-component PASS. Historical v4 process state remains UNKNOWN and untouched.

No adapter code is authorized by this candidate until independent review approves the exact schemas, retention inventory, error projection and join transitions. If a faithful bounded package cannot be reviewed, stop and report the concrete gap instead of creating another dormant abstraction.
