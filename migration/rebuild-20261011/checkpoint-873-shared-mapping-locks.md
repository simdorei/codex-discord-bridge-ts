# Checkpoint 873: shared mapping ownership

2026-10-14 UTC. Bound mirror work receives the actual runtime queue separately from passive configuration, validates its private brand/original registry/exact database, and holds target then mirror-sync-operation leases across bootstrap, polling and joined cleanup. Core/prepared startup passes the original queue before worker allocation. Existing mirror admission remains intact; actual polling is conservatively serialized by the shared mapping lock, not performance-qualified.

Fixed review findings: base acquisition bypasses subclass tryAcquire overrides; reserved internal-key identities are rejected across mirror, generic pairs, fork and nested archive scopes to avoid lock inversion. Staged fork evidence is preserved.

Verified Node 24.21.0 typecheck/build, 563 selected emitted-JS tests and two additional final edge tests, zero failures/cancellations/skips. Edge tests exercise real fork retargeting waiting for receipt/cursor cleanup and changed mapping rejection after lock waiting. Independent scoped review closed both P2 findings with no additional P1/P2.

No CLI enablement, implicit schema preparation, live DB/service testing or deployment. External database ownership and append-only producer qualification remain application prerequisites. Overall migration remains WIP.
