# Accepted Gateway original custody

Checkpoint 905 is the anti-discard foundation for subsequent Gateway native-policy work. Gateway policy refresh, classification and handler retry behavior are unchanged. This checkpoint does not install native Gateway policy or claim general no-loss delivery.

## Ownership

Successful Gateway message publication synchronously retains the exact immutable `MessageIngress` envelope before returning. It preserves the existing process sequence, decoded message object, channel/message IDs and source timestamp. Normal and Emergency retain their existing queues and capacities. Scalar identity counts and weak exact-envelope receipts add no payload queue. At most one removed original per lane is active, so the live bound is configured Normal capacity plus four Emergency queued messages plus two active originals.

A message receiver cannot take a second original until its first is completed. Completion accepts only its exact active envelope and is idempotent for its own already-completed originals. An old completion cannot release a newer original, even when both messages have the same ID. Queued disposal releases only queued custody. Close keeps accepted queued values available for draining. Active custody survives disposal until its actual operation has joined.

The message consumer captures the removed envelope inside its guarded receive operation. If shutdown, force or identity conflict wins after the receive removes a value but before its handler starts, the consumer still completes that exact envelope after the receive is joined. Handler processing and cancellation remain guarded and joined before completion. Direct receiver owners must explicitly complete each removed original; merely closing the ingress or shutting down shard tasks does not settle a separately owned active message.

## Periodic discard veto

Installed typed history receives the read-only view of the same Gateway ingress owner. It gets no completion, admission or execution authority. Direct compatibility history callers may omit this view.

The existing guarded processed-marker claim checks the current exact channel/message membership after database opening and immediately before the synchronous gap fence and INSERT. Both cancellation and accepted-original deferral occur outside the gap-fenced action, so ordinary deferral does not poison the tracker. A private branded deferral stops that periodic channel without committing its cursor. The first Prime boundary remains fixed. Later periodic passes may continue after the original is settled.

History Process is unaffected and may win canonical durable admission and deduplication. Only processed-marker-only Discard is vetoed. No gap is synthesized, no source floor or revision is changed, and no new history authority for force restart is introduced. Overflow, Closed, Stopping and sequence-exhaustion publication behavior remain unchanged.

The shared final Discard guard also protects the Reprime branch. Current `HistoryPollState` public operations cannot create the null Active watermark that would enter Reprime, so verification exercises Prime and old Incremental plus the shared final guard; it does not claim an executed Reprime scenario using fabricated private state.

## Boundaries and verification

This is in-process anti-discard custody, not a durable queue. It does not survive process loss, retain deliberately disposed queued messages, or promise recovery of every original after an unrelated handler failure. Native Gateway policy and exact pre-submission capacity retries remain a separate next checkpoint. Existing native interaction/history policy, legacy same-page classification, final resident authority, store schema and inactive stage 893 remain unchanged.

Validation uses pinned Node 24.21.0, `tools/build-test-profile.mjs` and emitted JavaScript with `NODE_OPTIONS=--no-strip-types`. Focused tests cover large exact IDs, envelope/source identity, duplicate originals, queue bounds, both lanes, queued disposal, all shutdown/force/conflict receive and active-join races, final INSERT races before and after database opening, no poisoned gap state, no premature processed-only duplicate or cursor commit, retained Prime boundary, canonical History Process deduplication, original journal IDs/time/receipt order, and exact installed-root view wiring.

The protected remote-agent redaction test and known Unix root-store-authority EPERM fixture are excluded from bounded execution. These checks do not qualify a full-suite, live-service, crash/load, Windows or long-running deployment. No live database, secrets, external messages, publication or deployment is involved in writer validation.

### Checkpoint 905 writer validation

Final emitted profile: `.runtime/compiled-tests-TrP7I8`, Node 24.21.0, baseline `fcf0cffebec0a93e1ed469122181e1f5ea33d8c9`.

- Strict full source/test typecheck, production build and whitespace check passed.
- All 938 emitted production modules byte-match the production build. Their sorted SHA256/path graph digest is `dad4374a39ee85349efad73274f400e5403fc5ed42ea7a1fcd3e6d1d1d5f4635`.
- Focused validation: 104/104 passed across six selected files.
- Bounded affected validation: 333/333 passed across 25 additional selected files.
- Both final writer runs had zero failures, cancellations or skipped tests. Earlier candidate profiles are not counted as final passes.

The test selections cover the changed custody/history paths and affected Gateway, policy, typed bootstrap, identity, native journal, prompt, text reply and processed-marker boundaries. This is bounded verification, not a full-suite result.

Independent scoped review passed with no blocking finding. A final-profile independent run passed 437/437 across 31 selected files, with zero failures, cancellations or skips; this overlaps the writer coverage above and is not additional unique suite coverage. Eleven independently authored adversarial checks also passed. The reviewer reproduced the 938-module production graph and exact source/test hashes, including captured view/database mutation and force-restart history-exclusion checks. Review approval is limited to this offline anti-discard foundation.
