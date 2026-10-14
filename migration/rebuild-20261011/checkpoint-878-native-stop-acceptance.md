# Checkpoint 878: bounded native Stop acceptance

2026-10-14 UTC. Running and Unresolved Stop acceptance now use an actual-command-injected, pinned Control1 native writer with zero waiting queue. This is a scoped migration checkpoint, not full runtime or deployment PASS.

The Selected route acquires an opaque owner-minted lease authenticated by private identity from the original epoch token. Original prototype methods avoid override substitution. Captured bounded input precedes lease acquisition; acquisition, proof extraction and ordinary Control submission have no intervening await. The shared proof transports liveness only. The same Bridge owner rejects operations while held, and the lease lasts through actual native exit, final validation and exception-safe release, including capacity refusal and abort/deadline cases.

This preserves the existing single shared native Bridge owner/no mixed writers contract. It does not detect a different owner or external/legacy writer changing selection between captures. Explicit and Mapped routes retain their SQL fences. Running generation mismatch retains can_settle:false rather than claiming settlement.

Store acceptance keeps its atomic transaction and custody/revision postconditions, while preflighting row, storage-byte and cumulative evidence before decoding and bounding generated serialization. Oversized evidence fails closed. Infinity timestamps retain the existing serializer/typed-scalar semantics; revisions remain exact above 2^53. A private cancellation signal avoids caller method-hook stranding, and native source-state checks preserve cancellation when ordinary abort propagation is suppressed.

Every unconfirmed submitted acceptance remains Unknown with original ingress/operation retained. No success acknowledgement, second acceptance or inline interrupt fallback is performed. Abort/deadline waits for actual native exit rather than terminating SQLite.

## Verification

Pinned Node 24.21.0, emitted JavaScript with --no-strip-types: 195/195 tests passed across 14 affected files, zero failed/cancelled/skipped. After two further Selected lifecycle tests were appended without production changes, the latest native suite passed 21/21. These selections overlap and are not cumulative coverage totals. Latest emitted profile QeF2Kb. Strict typecheck, production build and diff checks passed. Independent frozen source review found no remaining confirmed P1/P2.

Coverage includes actual command routing, no synchronous acceptance/fallback, postcommit acknowledgement loss, SQLite lock/event-loop progress, opaque lease forgery/staleness/lifetime, Control saturation, cancellation/deadline join, transaction rollback, byte/row/UTF-16/BLOB limits, generated budgets, actor/ingress/route custody and original semantics.

StopControlWorker claim/error writes, other deferred command paths, generic OwnedWorkerSlot hostile-signal hardening, Windows, whole-runtime launch/live integration and performance/long-duration qualification remain outside this checkpoint. No real DB, secrets, raw logs, protected fixtures or generated outputs are included; no main merge or deployment.
