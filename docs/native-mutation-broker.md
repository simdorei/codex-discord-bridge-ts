# Fixed mutation persistence broker (production-unwired)

## Scope and authority

This component carries one ordinary mutation begin and, at most, one matching completion from a trusted requester to the original main-owned native persistence transport. It is preparatory code, not an installed resident, persistent store role, dispatch receipt, physical-store exclusion mechanism, or permission to write a child pipe. The synchronous final revalidator, existing owner receipt registry, lane capacities, native store-worker registration, catalog and production consumers are unchanged.

Main construction pins the initialized store path and runtime identity. Neither appears in the IPC schema. The private endpoint binds once to the original Worker supplied by trusted construction. Defensive prototype/data-property checks do not prove Worker provenance against hostile same-isolate symbol copying. The fixed client keeps its transferred port private and permits only one outstanding exchange. Node MessagePort is not itself a bounded hostile-sender queue.

The claim is checked iteratively before cloning or freezing: passive exact records, dense arrays, primitive Serde values, signed generation and original RequestId, bounded bytes, aggregate string/key units, expanded nodes, edges, container entries and depth. Aliases count per expanded occurrence; ancestry rejects cycles. Proxy and accessor rejection precedes property evaluation. Out-of-range bigints are rejected before serializer diagnostics could stringify them.

A successful begin observation means only that the original fixed native begin returned exact bounded `{ok:true}` after actual exit. The distinct begin ACK permits the single finish protocol transition; it does not release the retained original claim or confer wire permission. Finish accepts only the original begin exchange and an explicit outcome, deriving all completion identity from that claim. Fixture-supplied outcomes demonstrate transport mechanics, not truthful real-workflow provenance.

Every failure after calling the original transport is unknown, including immediate Control saturation, SQL rollback and a failed completion. No `wasAdmitted` or error-class inference certifies non-submission. Finish rights are consumed before submission and never retried. Cancel, close, prepared expiry and endpoint loss never write `not_sent`, delete intent, or manufacture cleanup completion.

Begin confirmation and final terminal observation are each delivered only once through status, with separate ACKs. Lost observations do not reconnect or replay. Observed local close suppresses later success publication; a response received before a close notification remains only the fact actually observed. No cross-thread clock-order guarantee is claimed.

## Lifetime and accounting

One module root and one lifecycle are retained. Close returns the original join promise on repeated calls. Local port disposal, original requester actual Worker exit, and actual native join must all finish before the root can be replaced; a timeout never substitutes for exit. Prepared-row preservation survives transport disposal and does not authorize replay.

All caller limits are mandatory. Timers exceeding Node's supported range are rejected, not clamped. The schema-derived minimal claim is checked during construction. Every legal reply variant, including maximum safe integer sequence widths, is checked against the fixed 512-byte envelope ceiling.

For configured claim bytes B, aggregate UTF-16 units S, expanded nodes N and edges E, and native result byte limit D:

- C = 2*S + B + 8*N; R = 3*D + 32.
- Lifecycle logical bytes = 6*C + 4*R + 16*2048.
- Lifecycle nodes = 6*N + 4*4 + 16*16.
- Lifecycle edges = 6*E + 4*3 + 16*16.
- Separate root metadata reservation = 3*16384 bytes, 3*64 nodes and 3*64 edges.

Snapshots expose root and lifecycle charges separately. The full lifecycle reservation is acquired at construction, before any bootstrap or requester capture, and remains through begin ACK, finish, terminal delivery and all three disposal/join boundaries. A live original requester prevents root replacement even after local port closure; no forced termination or timer substitutes for its actual exit. An unbound root can dispose without a requester. Claim allowances cover requester private capture and outbound snapshot, main received and retained immutable copies, adapter envelope/handoff overlap; derived finish identity is a subset carried in that handoff allowance. Four native-result allowances are conservative: the implementation retains only fixed classification rather than forwarding diagnostics. Sixteen fixed metadata slots account control/reply/latch overlap. Root descriptor validation does not allocate another limits copy; the main descriptor, received bootstrap and client private limits representation fit the three declared representations. Port and Worker references have fixed counts but unmeasured engine/OS sizes.

These are logical broker-owned representation allowances. They do not measure V8 heap, object headers, GC, serializer internals, SQLite buffers, native worker memory, caller-preexisting inputs, or implementation-private copies in the unchanged adapter. Path spelling is not physical identity. StoreAuthorityDomain remains uncertified and is not activated by this component.

## Verification record

Final candidate v3 passed separate author and independent runs: 108/108 tests each, zero failures, skips or cancellations. Both used pinned Node 24.21.0 and TypeScript 7.0.2 on Linux x64, strict compilation of 317 explicit project sources, actual compiler-input audits, and byte equality for all 305 separately compiled production JavaScript modules. The independent run took 45.899 seconds. The requester emitted runtime graph excludes DB, mutation fence, writer and store-registration modules. This is scoped component qualification, not whole-migration or deployment PASS.

Source graph SHA-256: 92eb790a7295f22033070faaac946f29d07a04cb9ce0675e1968bc66054b9274. Emitted graph SHA-256: 368ca6e41eb82816ae4dd14b46a6051500898ac385b13e3fa349f33f11dfae9f.

Candidate v2 passed the author’s guarded 107-test run, but independent static review required full lifecycle reservation before sender capture and retention through actual requester exit, plus narrowing one SQLite-entry claim. Those findings were corrected in v3 and independently closed. The new gated requester test confirms that local port closure and joined native work cannot release the root while the original requester remains alive. No timing or capacity was increased to obtain these results.

The first guarded candidate compiled with strict TypeScript and matched separate production-only JavaScript bytes. Its explicit test run had 107 tests: 105 passed, 2 failed, 0 skipped. The two fixed raw-negative requester fixtures exited normally before reporting port close because their last one-shot message listener no longer retained port liveness. The next candidate explicitly references the fixture port while awaiting close. No timing or limit was increased. The first candidate's sources, compile results and test failure logs are retained separately.

A separate, unqualified ad hoc command was mistakenly run while preparing the protocol: `npx tsc --noEmit --pretty false 2>&1 | head -50`. It used the broad repository tsconfig rather than an explicit guarded graph. Its pipeline status does not establish compiler success, and its actual source traversal was not captured. Protected/denied-path exclusion cannot be claimed for that command. It is excluded from all qualification claims, was not repeated, and no lingering compiler process was observed in the subsequent process-metadata check.

The replacement qualification workflow rejects protected/denied paths before reading graph inputs, freezes exact source hashes and explicit test argv, requires direct compiler exit success, audits actual compiler inputs, and separately compiles production sources to compare emitted bytes. It never uses no-argument test discovery.

Tests exercise real temporary SQLite persistence, captured-claim mutation, duplicate/early/foreign/injected frames, original Control saturation and completion FIFO, prepared close/cancel/TTL preservation, rollback and failed-completion uncertainty, and retained root/reservations after native submission while a SQLite lock is held (native SQL entry before release is not established). Three fixed fixture cases suppress one selected correlated reply to simulate lost begin ACK, finish acceptance observation or terminal ACK, with unchanged posting/native execution and a predeclared 100ms exchange deadline. These are simulated observation-loss cases, not real network failure or a complete loss/crash matrix.

Remaining qualification excludes actual persistent-role enrollment, original local receipt/workflow integration, genuine production outcome provenance, installed runtime composition, hostile requester isolation, abrupt-child containment, native Windows, physical-store/cutover behavior, matched Rust/TS performance and whole migration completion.
