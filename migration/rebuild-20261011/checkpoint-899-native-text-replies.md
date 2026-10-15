# Checkpoint 899: Native pending text-reply reads and confirmation receipts

2026-10-15 UTC. Baseline: ee029dc4cf3e609d4d62025c9b9fc596e2705c6c. Local changes only; no Git writes, publication, deployment, operational databases or live services.

## Installed scope

- The existing installed `PromptAuthorityReads` port now reaches `handlePendingTextReply` from the message processor. Native completion evidence, unfiltered allJobs queue evidence and original-channel mapping remain three fresh, separately joined reads in the original order.
- The existing installed receipt flag now opts in only the processor's `PendingConfirmation` delivery. Native storage accepts exactly `message/reply/v1`, canonical `inbound-message/<positive-u64>/pending-confirmation`, null guard and index zero. The helper rejects other kinds and multipart text before any receipt or HTTP attempt. Its fixed approval/input confirmations are one part.
- Normal gateway, sealed-drain pending reply, history gap and history poll composition retain their already captured immutable read port and receipt flag. No additional environment or context-copy API was introduced.
- Ordinary action/planned/saved replies and `message/error/v1` stay on their existing receipt path. Direct helpers keep compatibility defaults unless explicitly opted in. Installed paths never fall back to the facade when a native operation is unavailable.

## Original identity and authority

The text path has no component claim or component ready marker. Its source execution claim is the message ingress journal: admission, begin execution, response, saved pending-reply result, pending-confirmation receipt, then ingress confirmation. Reusing the standard component owner would fabricate a component-click identity and change this transaction sequence, so no component claim owner or new text claim transaction was added.

The already decoded original message still supplies its exact ingress ID, message ID, actor, channel and reply receipt identity. The text helper captures the supplied own-data port and the exact selected request ID, occurrence, method/params, generation and answer before its authority awaits. It never refreshes the selected request from a later snapshot. Answer parsing still happens only after original actor/channel verification and uses the captured request and answer; approval grammar, input assignments, multi-answer handling and quoted text are unchanged.

The same borrowed `PortableResidentLifecycle.respond` call retains final request/occurrence/generation/turn checks, response authority, target admission and synchronous response journal guards. Checkpoint 893 WIP remains inactive. No preliminary read result is promoted into an enduring mutation grant.

The saved `pending_reply: handled` outcome still precedes the confirmation receipt. Known accepted HTTP is committed despite cancellation; 429 keeps the original release behavior; definite rejection is blocked; unknown send or failed confirmation remains held without an automatic resend. A receipt-only replay after the original request disappears can confirm the already delivered chunk without selecting or submitting another response. A repeated ordinary message is still deduplicated by its original ingress, including after a response/result/receipt failure. This does not add an automatic recovery or re-execution path.

## Source drain behavior and bounded ownership

A successful pending reply may drain through a sealed gate. A second copy while that gate remains sealed and the pending request is gone reaches the existing Restarting/error-report path before durable deduplication. That source ordering remains unchanged. The native profile deliberately does not include ErrorReport receipts; tests preserve and explicitly assert the sealed-drain behavior rather than broadening the profile.

Native authority uses existing zero-queue Control owners; receipt Begin uses zero-queue Control admission and accepted completion uses the existing finite completion FIFO. Actual native exit is joined before slot/caller settlement. Cancellation tests hold a real SQLite lock and establish that the original gateway admission and custody remain owned until the read exits, with no response or confirmation send. Accepted HTTP with a locked native receipt commit also stays owned until actual exit.

The existing authority port does not take the outer cancellation signal. A cancellation therefore waits for the bounded in-flight native read sequence to settle, then the existing outer boundary observes cancellation. No early cancellation, worker termination, cached authority or detached work is introduced. Transfer/deadline/capacity bounds are not a bound on SQL work, native memory or wall-clock latency.

## Verification

Pinned Node 24.21.0 and TypeScript 7.0.2. All execution uses emitted JavaScript with `NODE_OPTIONS=--no-strip-types`.

- Strict source/test typecheck: passed.
- Production build and whitespace check: passed.
- All 933 production JavaScript modules are byte-identical to the final emitted test graph.
- Final focused suite: 45/45 passed, zero failures, cancellations or skips.
- Bounded affected suite: 1,111/1,111 passed across 111 files, zero failures, cancellations or skips (502.751 seconds).
- Independent read-only review: no actionable production finding; 72/72 compatibility/final-response tests passed. These overlapping checks are not added to the aggregate counts.

Focused coverage includes installed gateway/drain/gap/poll Approval and Input replies with poisoned compatibility authority/receipt methods; exact large message ingress IDs and original receipt keys; original request ID/occurrence/generation arguments at the resident boundary; quoted multi-answer payloads through an actual child response; wrong actors/channels; immutable request/port capture; ID/occurrence/method/params drift after each awaited read; malformed unrelated queue rows; Control saturation; joined cancellation and retained admission; no repeat after an uncertain resident response, failed result write or failed receipt confirmation; confirmed receipt-only recovery after the pending request is gone; strict receipt scope; rejection/release/unknown outcomes; accepted receipt commit despite cancellation; and compatibility defaults.

Initial test evidence is retained. The first run passed 35/45: tests incorrectly omitted native target-selection mapping reads and expected global budget refusal from a reused per-owner read slot. The second run passed 43/45: its remaining assertions incorrectly expected no diagnostic from a repeated message while the gate remained sealed. Tests were corrected to assert the original source behavior. Production did not change after its initial freeze.

Evidence prefix: `.runtime/text-reply-`. The final emitted graph is recorded by `build-final.json`; source/test hashes by `final-sha256.txt`; explicit focused/affected selections by `focused-tests.txt` and `affected-tests.txt`; final TAP/exit results, strict/build/whitespace logs, production parity and post-run hashes are kept under that prefix.

## Explicit limits

The known UNIX-root fixture `test/runtime/discord-runtime/store-authority-profile.test.ts` is explicitly excluded from the bounded affected selection. It was not retried or escalated. This is not full-suite, Windows, load, performance, crash/restart or live-runtime qualification.

Message ingress admission/begin/result/confirm/hold persistence, other message receipts, final resident response/mutation guards, startup/restart reconciliation and whole-runtime/question migration remain outside this checkpoint. No schema, SQL transaction body, claim key, receipt domain, response payload or ingress format is changed. No protected fixture contents, credentials or operational raw logs were used.
