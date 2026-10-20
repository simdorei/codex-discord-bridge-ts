# WIP 807: mirror store worker and exact mapping cleanup

Overlay these 13 files only on the exact applied-804 tree named in manifest.json to reconstruct this candidate. It includes the unapplied 805 cleanup storage, native worker transport from 806, and exact thread mapping commit/stale retirement from 807.

Strict TypeScript and compiled build exit 0. Latest focused replay: 57/57 PASS. Separate native worker tests: 10/10 PASS. Earlier 805 focused replay: 58/58 PASS. These runs overlap and must not be summed as independent tests or a final full suite.

The 805 whole suite remains running and has a recorded failure: startup-context gateway/core shutdown test exceeded its 15-second deadline. The same test passed on 804, but the failure's cause is unverified. No timeout was increased and the failing result is retained. This candidate is WIP and not applied.

BridgeSync command, complete Discord inventory/delete transport and operational validation remain unfinished. Native worker tests use generated SQLite fixtures only. No live Discord, live DB, main merge, force push or deployment occurred.
