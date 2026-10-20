# Checkpoint 868: immutable pending mirror startup intent

2026-10-14 UTC. Separate opt-in journal preserves the original cutoff, operation identity and timestamp. Only genuinely absent targets can create an intent. Exact retries reconcile unchanged packets; legacy/bound/pending conflicts are held without adoption, overwrite or reset. Existing cursor APIs reject conflicting pending intent. Native creation requires authentic captured cutoff; descriptive reads do not restore authority. Pending rows remain durable; no completion or retirement is wired yet.

Verified final Node 24.21.0 strict typecheck, compiled emission and 97 compiled focused tests: 27 new and 70 adjacent, no failures/cancellations/skips. Initial typecheck/facade expectation failures were corrected before this final run. Independent review identified a timestamp projection allocation issue, now fixed with numeric-only SQL projection and explicit 4 MiB TEXT/BLOB regression; focused review closed it with no remaining P1/P2.

No full suite/live DB/live Discord/Codex test, runtime enablement, legacy migration or deployment. Durable-intent rehydration, context-to-bound atomic completion and full startup integration remain WIP. No secrets, actual DBs, raw logs or protected fixtures are included.
