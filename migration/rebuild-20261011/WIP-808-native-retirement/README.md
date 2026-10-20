# WIP 808: native stale mapping and retirement

Unapplied delta over the WIP 807 overlay. Adds four fixed native worker operations for stale thread/project listing and exact identity/cutoff retirement, using the existing Control slot and central state facade. Replies validate exact record fields and bigint identities. Tests cover valid identity exclusions, strict cutoff, surviving-thread parent protection, passive malformed inputs/replies and lost acknowledgement after committed deletion.

Strict typecheck and compiled build pass; 22 focused tests pass without skips. The final 808 whole suite is running. Prior candidate805 whole suite remains RED: 8426 passes, two failures and one cancelled test. Serial replay passed those original three cases but exposed a different lifetime timeout followed by a worker-budget failure. No deadline or assertion was relaxed. These outcomes do not qualify the whole candidate.

Current product is still applied804. Full BridgeSync integration, Windows and operational acceptance remain incomplete. No production deployment.
