# WIP 779: combined native Control read candidate

Combines immutable WIP777 and WIP778 source/test snapshots. The only additional file is the facade test: new hasObservedCompletionExisting exact function identities, explicit key list entry, and count 318 to 319. No production change beyond the already preserved two candidates.

Final focused 55/55 and strict TypeScript/build passed. Full 8259-test run is pending. Original777 whole result remains RED: 8253 passed, one facade inventory failure, two pipeline timeouts, no skips. Initial779 focused54/55 failed because the explicit count remained318; corrected to319 with exact-key equality retained. Same-byte isolated pipeline11 passed, but the full-run timeout cause is not proven. No deadline or pipeline assertion was relaxed.

Candidate remains unapplied. Runtime integration, Windows, live operations, performance and synchronous Stop-write offload remain unqualified. Sources from dependency WIP directories plus this exact test reconstruct the candidate; authored manifest binds all11 files.
