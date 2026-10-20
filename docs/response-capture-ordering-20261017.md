# Original response capture ordering — checkpoint 965

Status: test-only installed-resident-composition regression, independently repeated on 2026-10-17. Production source and runtime behavior are unchanged. No native authority-capture implementation or event-loop-isolation improvement is claimed.

## Preserved authority boundary

`PortableResidentLifecycle.#respondInner` obtains the original admission and pending request, then synchronously calls `responseAuthority` before its first target-preparation await (`portable-resident-lifecycle.ts:294–300`). The installed response fence calls `captureResponseCustody`, which captures the complete original queue job, mapping and stop sequence in one existing-store transaction. The later synchronous `beginResponseCustody` compares that original snapshot before wire admission (`response-custody.ts:55–87`).

A proposed worker-first capture was rejected during independent plan review before implementation. Pinning request occurrence, runtime, resident, generation and path would preserve scope, but would not preserve when the database baseline is captured. For example, a same-turn change from owner 3 to owner 99 after `respond()` returns its Promise is currently compared against the already captured owner 3. A later worker query could instead adopt owner 99 as its baseline; final revalidation would then miss the intervening change. Actual exit, immutable results and post-join admission checks do not repair that difference. No new snapshot token, authority enrollment, retry or synchronous fallback was introduced.

Existing store tests cover capture-then-mutate directly, and response-fence tests inject an `afterCapture` callback. The new test specifically covers the uninterrupted caller-turn boundary through the original installed composition, without those hooks.

## Exact test profile

The single new root, `test/runtime/discord-runtime/response-capture-ordering.test.ts`, uses `startRuntimeResident`, real disposable SQLite, the original native owners and a real owned child process. It has no mocks, replacement callbacks or fake authority capabilities.

Four cases cover result/error responses with unchanged and changed owners:

- Unchanged controls deliver the exact original response payload and persist `flushed`.
- Changed cases invoke `respond()` or `respondError()`, then immediately update exactly the original running job from owner 3 to owner 99, with no intervening await or callback barrier.
- Both changes must produce `ResidentStateError` / `MutationHeld` with the specific original-response-custody refusal. The child receives no response, no durable response admission or synthetic completion row exists, and owner 99 remains stored.
- Original resident disposal confirms child closure and zero occupancy in all native lanes. The outer supervisor separately confirms actual owned-process teardown.

This establishes the current caller-turn contract. It does not execute a proposed worker-first implementation or prove deterministic mutation sensitivity against every hypothetical worker scheduling arrangement.

## Independent qualification

Author and reviewer used separate fresh frozen graphs, private temporary roots, pinned Node 24.21.0 with `--no-strip-types`, and TypeScript 7.0.2. Each strict selected compile covered 316 project modules and 178 declarations; each production-only selection covered 313 project modules and the same declarations. All 313 production JavaScript emissions matched the selected build byte for byte.

Each run passed **4/4**, with zero failures, cancellations, skips or todos. Test processes exited naturally with code 0. Supervisor elapsed times were 4.213 seconds and 3.649 seconds, respectively; neither run used its 300-second safety deadline or forced signals. Both receipts confirm owned-process exit, no remaining children, stream EOF and no supervisor errors. Frozen inputs, current source bytes, emissions and pinned Node were unchanged afterward; private home and temporary directories were empty.

| Evidence | SHA-256 |
| --- | --- |
| Source graph, both runs | `06cd1729baa334067571caf5375f4b47be63e27629d0f57ddfd59b31f38b8c97` |
| Selected emitted map, both runs | `3ded7a3fd0584d2913e28b4bbc26d8e92a7b9af81d50dc4742048a0c7983d05f` |
| Production emitted map, both runs | `6340c8c1b010810ef8fb05f1d94de2be931de76b66192d415d3a63b946b56018` |
| Author post-run audit | `905c4c5247926f455fc3250d46d34453f03208a0abff34f3a526514a87f808fa` |
| Reviewer post-run audit | `8400ccfd9f2276720f9371e39da4e50b1dad2d73df724da02acbc744b33c16dd` |
| Author test-process receipt | `e14bda6dfb2e6cbe8dfa4aa98e73105b1f5ac1aead9004d1708e8bc7bdd0adc9` |
| Reviewer test-process receipt | `af5056e166ec66b1d5ddb881d912192bf0345ca1bc07035f1054628390c135fd` |

## Remaining scope

This is a disposable direct resident-composition test, not operational singleton/root qualification, full application startup, live provider/computer-use integration, deployment, native Windows qualification, performance acceptance or completion of migration gate D. The full `local-application.ts` dependency graph was not semantically compiled. Response capture and begin, mutation final revalidation and Repair final checks remain synchronous.

Future isolation work must preserve the earlier database authority baseline through an authentic supported ownership/snapshot mechanism, or qualify the original workflow together in its intended owner context. Moving first capture later solely because the result is still revalidated is insufficient. Authentic root qualification remains separately blocked by the established socket restriction; this test neither attempts nor substitutes for it.

The explicit graph excluded all remote-agent paths, the protected checkpoint-936/cursor review and the recursive store-authority coverage test before content reads. No socket attempt, protected-path access, Git ref update, production activation or old-root cleanup occurred. Historical v4 descendant state remains unknown and untouched; previous negative cleanup-debt results remain negative.
