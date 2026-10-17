# Checkpoint 870: atomic startup intent completion

2026-10-14 UTC. Explicit same-owner completion accepts privately authenticated recovery evidence. It revalidates database identity, exact pending packet and file observations before a DB-only IMMEDIATE transaction installs both cursor rows and retires only the exact pending row. Exact already-committed results reconcile without resampling the original cutoff; changed cursor revisions and conflicts hold.

Postconditions and an exact three-write total_changes delta reject trigger side effects, including transient rewrite/restore and unrelated writes. Lost or malformed worker replies, aborts and deadlines after submission remain uncertain until native exit; exact-result reconciliation is supported.

Verified Node 24.21.0 typecheck/build and 171 focused emitted-JS tests with --no-strip-types: zero failures/cancellations/skips. Includes native completion faults and 25 store completion tests. Independent final read-only review found no concrete P1/P2. Source-mode and earlier subset results are not additional test counts.

No full runtime enablement, live-service/production-DB qualification or deployment. File verification is sampled and not atomic with SQLite; independent append-only producer/ownership assumptions still apply. Overall migration remains WIP.
