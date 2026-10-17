# Checkpoint 867: bounded native startup context evidence

2026-10-14 UTC. Added separate authentic EOF cutoff capture and bounded owned-native context reconstruction. Retries retain the exact cutoff. Non-LF boundaries remain held even after append. Read/decode/budget/cancellation/observed-mutation failures are not converted to empty context. The historical Rust first-200-Unicode-scalar filter and last nonempty turn semantics are preserved in this standalone reader.

Verification: Node 24.21.0 strict typecheck, compiled emission and 67 focused compiled tests passed (21 new reader tests plus adjacent file-window, continuity, record-window, read-window and collector checks). Read-only independent review found no concrete P1/P2 in the six added files. No full suite, live-service or database integration test.

Limits: this is read-only evidence, not cursor-write authority. Sampled anchors still require the independent append-only producer contract and do not prove complete historical integrity. No durable pending startup/context-unknown state, legacy adoption, reset or sessionMirror enablement is introduced. Rust persist-EOF-before-lazy-context crash ordering remains unimplemented. Overall migration remains WIP.
