# WIP 778: native Control read integration

Unapplied candidate. Focused 45/45 PASS, strict TypeScript and build exit 0. Full integration regression has not run. Depends on immutable WIP 777, whose full regression was still running at preservation.

Root and BasicDispatcher ControlTurnVerifier receive fixed-path native completion evidence and captured native mapping ports. Stop actions/workers retain original synchronous accept/claim functions. Original separate reads and final check ordering remain; this does not claim a combined database snapshot. Existing completion query matches thread/turn only, not resident/generation.

New tests exercise fixed path, native Promise requirement, and actual active-cache/SQLite evidence without RPC fallback. No service deployment or runtime performance approval.
