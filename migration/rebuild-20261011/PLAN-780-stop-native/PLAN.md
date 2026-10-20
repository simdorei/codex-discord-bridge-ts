# Stop native follow-on: bounded plan, not implementation approval

Actual baseline remains775; combined Control read779 is staged, not applied.

## First independent leaf
Native pendingStopControlsAfter read can preserve existing collect-then-map decoding, signed i64 cursor, sequence ordering, accepted-only predicate and LIMIT16. It must use fixed native database path, Control lane without waiting queue, bounded request/response, and join native exit before returning. A malformed/oversize reply must refuse the cycle, never return an empty page that resets the cursor. Native transport/read error must not create claim/retry authority. Empty pages alone reset cursor; stale owner/generation and busy-target handling stay in the original serial worker. Runtime Store type currently requires a synchronous method, so an explicit native port needs an awaited read plus immediate signal check before cursor changes. Existing synchronous test adapters need a deliberate compatibility contract.

## Writes must remain gated
acceptRunningStop and acceptUnresolvedStop invoke selected checks within BEGIN IMMEDIATE both before changes and immediately before commit. claimStopControl validates original record, jobs, holds, terminal/archive fences, then selected check before UPDATE and again before commit. Do not serialize callbacks, replace them with booleans, move them outside the transaction, or authorize an RPC after an unknown write.

A possible worker-local typed selection check must use the exact pinned Bridge path and admitted binding, while the same global Control permit excludes all runtime Bridge mutations for the entire native transaction. Parent private epoch check and owner identity must remain valid. This is a design condition, not yet demonstrated; foreign writers/restart remain out of scope and cannot be advertised as covered. Route Explicit/Mapped must preserve no selected-file read, with DB binding checks unchanged. Two-key completion evidence remains distinct from resident evidence.

## Required verification before write implementation
Map all original Rust closure sites and current runtime callers; verify lane permit is held through actual native exit. Exercise selected mutation before admission, during blocked native transaction, and after commit before RPC; cancellation/timeout after possible commit must remain Unknown with no success acknowledgement or automatic redispatch. Preserve target locks through joined work and original claim/wire tokens. No schema creation, rollback inference, pool growth or deadline widening.

The current Stop cycle has cooperative2s cancellation; existing synchronous writes and query interfaces prevent hard real-time guarantees. Native reads must not be used to claim hard2s completion.
