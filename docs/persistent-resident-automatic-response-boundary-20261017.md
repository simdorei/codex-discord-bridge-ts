# Worker-local automatic response boundary — partial Stage C

Status: inactive source-grounded design decision, 2026-10-17. This narrows one ownership question in [the persistent execution contract](PERSISTENT_RESIDENT_EXECUTION_CONTRACT.md), sections 1, 7, 8 and 10. It is not an executable intent factory, registry/reducer, adapter, activation approval or completion of Stage C. No runtime source or protocol changes, tests or live operations accompany this document.

## 1. Decision and precise scope

For the existing automatic local-tool form response, preserve the original caller and resident together in one future qualified persistent owner. Do not offload only authority capture, and do not replace a main-thread `respond()` call with IPC while claiming its existing synchronous capture-before-return semantics.

The relevant creation boundary already exists: the synchronous prefix of `PortableResidentLifecycle.#respondInner` captures the response scope and database custody. It returns no independently executable capability and does not yet consume the request occurrence. This design adds no wrapper, snapshot token, second registry or public creation API.

The scope includes both existing local-tool form acceptance and unsupported-form cancellation. Interactive responses, ordinary/queue/stop mutation, Repair, generic execution-protocol intents and their full ownership graphs remain separate design obligations. The inactive generic `submit` protocol is not used or self-submitted by this automatic branch. Do not add a main-thread submission round trip to an existing automatic response.

## 2. Original owner graph and capture order

The same worker-local owner must hold the genuine resident/session/client identities, generation, pending request and exact occurrence, target gate and leases, synchronous custody hooks, response attempt, writer/stdin and child lifecycle. Identity comes from the original private objects and their existing validation, never from paths, hashes, DTOs, structural casts or an ACK. Construction fixes the runtime and original database path; business messages cannot replace them.

Move the original serial `ServerRequestDelivery`/`runServerRequestWorker` ownership, including its pre-recovery subscription, pending receive, cache, retry schedule and shutdown responsibility, with that graph. A second automatic-response consumer alongside the original delivery/recovery worker is forbidden. The subscription currently originates in `discord-runtime/executor-bootstrap.ts:62–72` and is transferred through `server-request-start.ts:20–30`; there must be one owner, not a replacement subscription created during migration.

Preserve this source order (`server-request-delivery.ts:28–38`):

1. Check cancellation/generation and retain the exact decoded request.
2. Await `verifyPromptAuthority`, retaining its conditional sequence of up to three separately joined observations and all original early refusals: observed completion, queue jobs, then channel mapping. Its final generation/pending-request check remains. The returned `PromptAuthority` is preliminary observation, not durable response custody; do not substitute its earlier user/channel snapshot for the later response snapshot.
3. Check cancellation, apply the unchanged pure `localToolFormResponse`, and recheck generation for a local result.
4. Directly invoke the same owner's `respond`. No new await, scheduling hop, IPC or callback is inserted before its existing synchronous payload/occurrence clone, resident admission, original response candidate and `responseAuthority` capture (`portable-resident-lifecycle.ts:285–300`).
5. Only then enter existing asynchronous target preparation. Keep `ResponseAttempt` and native completion-receipt creation at their current post-preparation position. The original occurrence is claimed later by `AppServerResponseClient`, not at custody capture.

Capture must not move earlier to request receipt either. The original workflow permits asynchronous preliminary checks before response invocation; freezing a different earlier baseline would also change meaning. The [same-turn regression](response-capture-ordering-20261017.md) constrains the actual response invocation boundary, not all preceding delivery work.

At the writer, retain the synchronous target check and `beginResponseCustody` transaction, then the unchanged write-start/`writeAll` invocation in the same owner without a new hop. No transaction spans pipe/flush/IPC work. Final checks remain necessary even after a valid earlier snapshot; local ordering does not prove external-writer exclusion.

## 3. Original transitions and retained responsibility

The following is a closed vocabulary for reviewing this branch's source transitions, not a new runtime event union or complete reducer. Events are observations of original local code, not externally supplied commands. Implementation must preserve the existing distinct caller result, occurrence state, durable custody and resource lifetime rather than collapsing them into one success flag.

| Original boundary/event | Required consequence |
| --- | --- |
| Capture succeeds | Exact request/occurrence/payload, admission and database baseline remain local. Candidate lookup does not consume the occurrence. Continue to target preparation only with that snapshot. |
| Capture or pre-claim preparation fails | This invocation creates no new durable response admission. It may leave the occurrence pending. Target preparation is not asserted effect-free, nor is earlier debt erased. |
| Caller cancels during target preparation | Preserve its original cancellation result. `awaitPrepared` can abandon the wait while the managed preparation continues; retain that original work, dispose a late Ready permit and join managed preparation during shutdown. Caller return is not proof of native exit. |
| Target ready / attempt created | Preserve the original target permit, claim data and private native completion receipt. Do not create the receipt earlier or silently recapture database custody. |
| Original response claim begins | `response-client.ts:34` claims the exact occurrence after target preparation, before waiting for the writer. Subsequent claim disposal can mark it indeterminate. No early consumed mark is added at capture. |
| Synchronous durable begin refuses | Preserve the specific refusal. The already claimed occurrence can remain indeterminate even with no response bytes and no durable response row; do not convert it to replay permission. |
| Durable begin commits, then cancellation matches the original signal reason | Preserve the current direct cancellation bypass in `#respondInner`; an admitted row can remain unresolved. Do not synthesize `not_sent` or completion from close/dispose. |
| Write-start / failed write or flush | Preserve original conservative attempted/write-started classification and existing close/quarantine behavior. Absence of a successful write is not sufficient evidence of definitely-unsent. |
| Write and flush succeed | Preserve original claim resolution and promotion, including their possible errors after flush. The occurrence may resolve before native durable completion finishes; flush observation, correlation, ACK or occurrence resolution alone is not a successful response result or durable completion. |
| Completion is definitive or unknown | Submit through the original receipt only when unchanged `ResponseAttempt.#completion` returns a non-null completion: its existing `not_sent` or `flushed` outcome. `flushed` depends on the original successful response result, not flush observation alone. A null completion, including the started ambiguous-failure branch, submits nothing. Failed/ambiguous completion retains its existing uncertainty/debt and grants no replay. No new inference from timeout, worker exit or database absence is allowed. |
| Close / owner loss | Seal and join original work in the existing lifecycle order. Keep managed preparation/dispatch, native owners, child closure and exit-journal obligations distinct. Worker exit is not child exit or permission to release the root. |

Recovery remains the existing scheduler's recovery of still-pending exact occurrences, subject to its original checks and ownership. Consumed/indeterminate occurrences cannot be reminted or bypassed with a new numeric ID. This branch has no response-outcome reconciliation API; any such API requires separate design. The inactive protocol does not supply one.

## 4. App-server computer-use/browser behavior

Reuse `server-request-local-tools.ts:20–26` unchanged. Only `mcpServer/elicitation/request` with `form` or `openai/form` enters this local decision. Its existing exact `node_repl`, `mcp_tool_call`, `computer-use`/`browser`, low-risk and empty-schema conditions produce the existing accept response; other supported forms produce the existing cancel response. A null local decision continues the ordinary prompt path and must not be converted to cancellation.

Payload `action: 'cancel'` is an application response, distinct from cancelling the workflow's AbortSignal. Preserve both meanings. Keep original prompt ownership, active-turn, generation, pending-request and secret-input refusals. This design installs no tool/provider, grants no new tool permission and proves no configured or live computer-use connection.

## 5. Concrete dependencies that still block wiring

1. **Prompt-read mediation.** Installed `createNativePromptAuthorityReads` uses main-owned native Control adapters; `OwnedWorkerSlot` rejects worker-thread submissions. Existing persistent services contain only dead, idle, observation verification/gap and response completion, not these prompt reads. A separately reviewed fixed owner-mediated observation path must preserve the original path, conditional order, SQL/decoding, zero-queue Control admission, existing failures and actual joins. No combined snapshot, cache, filtered substitute, synchronous facade fallback or arbitrary SQL/callback service is implied. Numeric transport/retention bounds and effect-free observation semantics must be specified before implementation.
2. **Complete receiver/caller ownership.** The same serial delivery loop also sends ordinary prompts through HTTP/receipt ownership; interactive response and mutation/Repair callers still require their own original graphs. This partial local-form decision does not authorize splitting that loop, disabling other behavior or installing a partial replacement. Those ownership/transport dependencies must be resolved before fixture-free wiring.
3. **Single authentic root attachment.** `prepareRootBoundPersistentResident` privately enrolls accounting and supports unstarted preparation only. `local-application.ts` can separately enroll accounting, while `PosixRuntimeInstance.retainStoreAuthority` permits one attachment. The preparation is neither a promotable live owner nor a reusable preflight wrapper; layering both attachments is invalid. A future concrete construction design must choose one original attachment/lifetime rather than fabricate another guard.
4. **Qualification prerequisites.** The [actual-root preparation contract](persistent-resident-root-preparation-20261017.md) requires positive qualification using the original acquired POSIX instance before fixture-free composition or installed startup. The established socket `EPERM` remains a blocker; no retry, escalation or alternate primitive is authorized here. Physical-store/cutover exclusion and independent child containment/reaping remain separate prerequisites. An available environment or normal disposable-component pass does not discharge them.

## 6. Next decision and verification boundary

The next independent design task is the fixed mediation contract for the conditional prompt-authority observations and the rest of the original receiver/caller graph. This is required because the installed readers are genuinely main-only, not because a new abstraction is desirable. Keep it separate from execution authority and retain the capture boundary specified above. Do not implement an adapter until its exact closed API, capacity/retention and ownership proof receive review.

Actual-root preparation must then be qualified on an authorized environment that permits its unchanged operation, with original exclusion, release/reacquisition and retained-debt cases. Only after the ownership design and required proofs are complete may Stage D review one concrete adapter and separately authorize installed wiring. The existing migration request permits this design work; it does not itself satisfy those execution/activation gates.

Future qualification must exercise the original caller-turn custody boundary, pre-claim cancellation versus post-claim indeterminate refusal, definitive and unknown completion, late preparation/native exit, one receiver/recovery owner, and shutdown/root debt. Computer-use/browser accept, unsupported-form cancel and non-form prompt behavior must remain distinct. These are required future cases, not results from this design checkpoint. Historical failed/unknown cleanup evidence and all protected-path/socket restrictions remain unchanged.
