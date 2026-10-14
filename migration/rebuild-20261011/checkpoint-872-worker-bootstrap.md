# Checkpoint 872: opt-in bootstrap inside owned mirror worker

2026-10-14 UTC. Optional explicit bootstrap policy now runs inside the existing thread/channel-owned mirror poll callback, retaining ownership through bootstrap, polling and joined cleanup. Schema preparation is a separate explicit abortable operation; ordinary reads never perform DDL. Default bound-only behavior and CLI sessionMirror rejection remain.

Unconfirmed startup writes stop the worker with exact reconciliation evidence rather than retrying an epoch or recapturing EOF. Harvested evidence survives report/render/abort-and-throw failures; WeakSet classification does not invoke hooks on opaque errors. Frozen reconciliation errors retain their original packets.

Verified Node 24.21.0 production build and 114 focused emitted-JS tests across 13 affected files with type stripping disabled, including 18 new integration cases. Final independent review closed two P2 evidence-loss/classification findings with no remaining P1/P2. No full suite or live-service test.

Application-wide mapping/database ownership and independent append-only producer guarantees remain prerequisites; process-local mirror ownership alone does not establish them. No runtime CLI enablement or production deployment. Overall migration remains WIP.
