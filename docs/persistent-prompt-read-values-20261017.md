# Inactive prompt-read successful-value codec

Status: partial Stage C preparatory values only, 2026-10-17. This closes the successful-data schema question identified in [the automatic-response ownership decision](persistent-resident-automatic-response-boundary-20261017.md). It does not implement an endpoint, error transport, native submission, intent factory, receiver migration or installed adapter.

## Exact implemented scope

`src/runtime/persistent-prompt-read-values.ts` exports immutable request/success capture and their data types. Requests have exactly one of three shapes:

- `observed-completion`: `thread`, `turn`; success is a boolean.
- `all-jobs`: no business fields; success is the complete native `StoredQueueJob[]` representation.
- `channel-mapping`: `channel`, a signed i64 or null; success is text or null. Null/zero input requires null output, preserving the original no-open shortcut.

Every success carries the matching operation discriminant. The supplied request is revalidated before reading success data. These are data checks, not provenance or admission checks. A valid request/success pair neither proves a database observation happened nor grants response authority. Path, SQL, executable, callback, timeout, lane, AbortSignal and error outcomes are absent from messages.

Jobs preserve all 19 camelCase fields: `jobId`, `targetThreadId`, `channelId`, `ownerUserId`, `discordMessageId`, `appServerGeneration`, `executionGeneration`, `turnObservationGeneration`, `goalWaiting`, `prompt`, `queued`, `ackSent`, `state`, `attemptCount`, `turnId`, `baselineTurnIds`, `lastError`, `createdAt`, `updatedAt`. Integer fields remain signed i64, including generation and attempt count; optional fields retain null. All four original states, complete arrays/text, finite f64 timestamps and negative zero survive capture. Empty and NUL-containing well-formed text remain valid. Nonfinite timestamps are outside the existing successful native wire set.

The capture rejects unknown/missing keys, accessors, proxies, symbols, invalid prototypes, sparse arrays, cycles and malformed values. Plain and null-prototype records are accepted. Existing owned cloning produces immutable independent graphs. No field, row, baseline entry or unrelated malformed row is projected away.

## Original operations and bounds

The implementation does not execute these operations. Their original owners remain unchanged:

- `server-prompt-authority-reads.ts:42–46` binds the original path and combines the existing three native adapters without combining observations.
- `action-executor/control-evidence-native.ts:15–22`: observed identities are each at most 16,384 UTF-8 bytes; the original request/reply limit is 262,144 bytes. This path-free codec checks identities only. It cannot certify the original request budget, which also includes the pinned path and generated UUID; that check stays with the original owner.
- `queue-runner/native-read-state.ts:15–17,29–31` and its worker: the original result `{ok:true,value:jobs}` must fit 16,777,216 serialized bytes. The codec measures that exact native wrapper before cloning.
- `prompt-intake/native-state.ts`, `MirrorTarget`, and its worker: the original result `{ok:true,operation:'MirrorTarget',value:{channel,target}}` has the same 16,777,216-byte cap. The codec measures that wrapper, preserving the original channel.

The new operation/success wrapper is not charged inside an old native-envelope limit. Otherwise near-limit original successes would be newly rejected. Any future transport must separately reserve its own wrapper/copy/retention costs. There is no tighter row, text or baseline-count limit.

`store/queue-read.ts:227–232,256–270` still performs the complete original ordered `allJobs` query and decoding. It materializes SQL rows before the native result cap is checked. The codec establishes no native, SQLite, structured-clone or process heap bound. `store/busy-choice.ts:32–58` remains the mapping operation, including duplicate exact-room refusal and unique parent-channel fallback; this is not a simplified mirror lookup.

## Qualification

Final source/test SHA-256:

- Codec: `87fc6bcda08fa8853e17a4a0a4398d52436393d5d7849af76893569778b0a3e0`.
- Tests: `3bf3cf4066014ebbaade91e0c893c477c2b84ad89c4f58732af62f8874f5ab9c`.

The author used a fresh private frozen root, pinned Node 24.21.0 and TypeScript 7.0.2, strict explicit entry-root compilation and the established 300-second owned-process supervisor. Selected compilation contained 7 project modules and 178 declarations; production-only compilation contained 6 project modules and the same declarations. All 6 production emissions matched byte-for-byte. No broad test discovery or full-application semantic compile ran.

The final author run passed 10/10 passive cases, with no failures, cancellations, skips or todos. Coverage includes each operation, operation/result mismatch, all 19 required job fields and malformed field types, nullable/signed boundaries, all original states, text/UTF-8 boundaries, negative zero, immutable copies, null-prototype records, hostile request revalidation without invoking success getters, sparse/cyclic/proxy inputs, retained row/baseline ordering, and exact 16 MiB native-result boundaries plus one byte over. Round trips use structured cloning; no byte-stream parser or runtime observation is claimed.

Author evidence: `.runtime/prompt-read-values-967-author-final-20261017-DfbICXSf`. Test exit was natural code 0 in 4.583994 seconds. Actual owned processes exited, EOF and no remaining child were confirmed, with no deadline, forced signal or supervisor error. All 239 frozen inputs, 240 physical copies and emissions remained unchanged; private home/temp were empty. The prior preliminary 10/10 run remains separate evidence and predates two added assertions.

Source-graph hash: `3926fae6950481872898a1b8cd91db6272b8a2efe3cc09692825f6e2739d93d2`.
Production emission-map hash: `ba30ee9d0c4a3c06b412000cfc98fa8bcfde683799f6247e2d587a22b32170f5`.
Selected emission-map hash: `c49e2e1cec96481203de53a189921763c8c650dba62f4636ac980ba384c478b6`.
Author post-test audit hash: `41e5028678455f4a5ac8496d780a0785d1121b4e9fcaf42c28ec4f8423d3b93a`.

Independent exact-source review found no blocking issue. Separate fresh-root validation at `/tmp/cdr967-independent-review-20261017-ux5Rza9X` passed the same 10/10 tests and strict 7/6-module compilations with 178 declarations, matching source/emission hashes. Natural test exit was code 0 in 4.585937 seconds; owned-process exit, EOF, no remaining child, unchanged inputs/emissions and empty private home/temp were verified, without forced signals or supervisor errors. Independent post-test audit hash: `bb865c84b39b12005faa78beee59ba97a9a328fe4c6cc4df16aae56e247481d5`; process-receipt hash: `73ea5f774580e895e5efd9a77a88a653c9d3b004a520e236cb1108ed62518901`.

## Limits and next substantive gate

The existing helper closure includes value/ID/crypto utility definitions but performs no filesystem, network, native-worker or SQL work during codec execution. No existing operational source was changed or connected to the new module. This is effect-free value validation, not a literally dependency-free import graph.

The supervisor provides partial isolation: private environment/output roots and verified ownership of newly launched process identities, without a filesystem/network/cgroup/namespace sandbox claim. Process teardown is test-harness evidence only. No resident child/native owner was exercised. Historical unknown descendants and negative cleanup debt remain untouched. All protected-path exclusions and the established socket restriction remain in force.

Before any adapter, separately review a representable error/admission/join contract and the complete original receiver/caller graph. The current native owners propagate original pre-admission errors; admitted observed failures use `NativeControlEvidenceUnavailable`, while queue/mapping failures retain operation-specific errors and causes. Arbitrary JavaScript error identity/cause graphs cannot be preserved by this successful-value codec. Error names or tags cannot recreate original private admission-refusal proof. Existing generic service failure/cancellation handling is not an equivalent substitute.

The current prompt-read port has no AbortSignal: preserve conditional separately joined observations, observed's 6,000 ms and queue/mapping's 5,000 ms defaults, and existing caller cancellation boundaries. These are native-result deadlines, not actual-exit deadlines. The same serial server-request receiver also owns ordinary HTTP/receipt delivery and recovery; a form-only second consumer or main-thread response RPC remains invalid. Original pre-yield response capture and final synchronous begin/write ordering remain unchanged.

This checkpoint establishes no live adapter, performance claim, production PASS, complete Stage C, authentic-root qualification or migration completion. Actual root preparation, physical-store/cutover exclusion, child containment/reaping and separate Stage D adapter/wiring review remain open prerequisites.
