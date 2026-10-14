# Checkpoint 869: DB-bound read-only startup recovery

2026-10-14 UTC. Recovery reads the persisted pending packet itself, reconstructs context strictly before the original cutoff, and reopens/rechecks the complete pending packet and cursor absence. Private evidence is tied to its native database identity and owner. Forged/foreign/stale observations, replaced databases, incomplete boundaries and file changes hold; no EOF resampling or empty fallback.

Verified Node 24.21.0 strict typecheck, production build, compiled test build and 93 focused compiled tests across eight test files, zero failures/cancellations/skips. Exact facade-export expectations were updated for the added verifier. Independent read-only review found no concrete P1/P2 in this recovery slice.

Verification is sampled read-only evidence, never atomic cursor-write authority. No schema repair, pending retirement, context-to-bound commit, runtime profile enablement or deployment. No full suite or live service test. Overall migration remains WIP.
