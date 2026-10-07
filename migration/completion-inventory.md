# Completion inventory

Denominator: 18 named obligation groups, with unequal size. **1 completed within standalone scope, 10 partial, 7 not started; zero end-to-end runtime groups complete.** No completion percentage follows from these counts. Earlier rough percentage estimates were unmeasured and are superseded.

A group is complete only after frozen Rust call-path mapping, AGY implementation, independent review, meaningful fixtures, runtime wiring, relevant platform evidence and explicit limitation review. Shared schemas and passing helper tests do not count as runtime completion.

| Group | Status | Applied scope | Remaining obligations |
|---|---|---|---|
| 01 Pure protocol/value codecs | completed-scoped | Reviewed standalone wire IDs/occurrences, scalar JSON/value boundaries and Rust Debug rendering | No runtime dispatch claim; exact Rust diagnostic positions and exhaustive all-f64 parity excluded from completion |
| 02 Startup/configuration | partial | Pure parser and branch-selection contracts | Effectful main/bootstrap, environment acquisition, readiness/admin/config checks and shutdown |
| 03 Store schema/open/backup/read ownership | partial | Applied migrations, catalog validation, owned initialized driver/backup, existing-only and CheckedRead helpers with owned SQLite fixtures | Deterministic three-boundary concurrent initializer parity; backup cleanup/symlink replacement cases; all runtime entrypoints; platform lifecycle |
| 04 Mutation authority/journal | partial | Begin/check/owner/finish helper contracts, prepared/unknown retention and native fixture claim race | Gateway/resident response integration, every runtime completion/cancellation branch and exact clock precision domain |
| 05 Queue/admission/retry/goals | partial | Queue read/serialization/admission, guarded enqueue/remove, borrowed idle/fork/dead-generation gates | Claims/leases, runner dispatch, retry taxonomy, terminal reconciliation and goal completion; documented timestamp/schema-bypassed gaps |
| 06 New first-reply identity/intent | partial | Standalone Identity plus borrowed get/bind/promote independently reviewed and applied | Seed/native path, public wrappers, identity validation/claim, notice release, checkpoint/warnings/delivery and runtime integration; dedicated promotion UTF16 DB/concurrency/IGNORE fixtures absent |
| 07 Gateway/input/durable acknowledgement | not-started | Schema/codec prerequisites only; no translated runtime | Typed routing custody, message/interaction/history entrypoints, event dedupe, ACK deadlines and durable confirmation |
| 08 Resident RPC/writer/process/deadlines | partial | Pure RPC codec prerequisites | Resident transport, writer lock revalidation, partial-write/drop sealing, generation quarantine, monotonic deadline ownership, Windows suspended-create/job-assign/resume process trees |
| 09 Stop/cancel/late ACK/holds | partial | Borrowed execution hold helpers and related schemas | Stop claim/cancel workers, late ACK fences, unresolved running admission and owned cancellation RPC cleanup |
| 10 Repair/recover/tray/watchdog | not-started | No translated runtime | Scoped repair capabilities, original revision checks, recover cutover, startup holds, tray/watchdog lifecycle |
| 11 New thread/prompt intake/attachments | not-started | Store intent/schema prerequisites only | Creation evidence, atomic immediate intake/ingress transfer, claim renewal, target preparation, attachment bounded download and model submission |
| 12 Async-question owner/revision/disposition | not-started | Async resolution/publication/abandonment schema prerequisites only | Question routing, occurrence/revision ownership, async UI disposition, orphan recovery and response acknowledgement |
| 13 Mirror/history/cursor/archive | partial | Exact origin marker records and borrowed start-notice staging | Mirror workers/history polling/cursor custody, backlog/fairness/byte budgets, archive/delete/admission safeguards and backup evidence |
| 14 Manual Reserve operations | not-started | Configuration parser and retirement schema prerequisites only | Explicit manual switching, history boundary/custody, retirement integration and reserve lifecycle; automatic switching/replay excluded |
| 15 Remote MCP/OAuth/Windows interfaces | partial | Remote configuration parser only | Protocol/server HTTP/WebSocket/MCP routes, OAuth owner approval/token lifecycle, remote files/images/computer/terminal and native ownership adapters |
| 16 Pro conversation leases/plugins | not-started | No translated integration | Conversation scoped creation/restart leases, plugins/connectors, exact conversation identity and no unsafe request replay |
| 17 Fresh DB/import/install portability | partial | Fresh owned SQLite creation/migration and existing-only primitives | Original data import compatibility, install profiles, portable paths/config, entrypoint packaging, backup/restore across schemas and platform release checks |
| 18 Output delivery/receipt/Unicode chunking | not-started | Schemas/identity prerequisites only | Guarded exact content receipts, nonce/hash, accepted-but-unconfirmed unknown hold, rejection release taxonomy and Unicode chunking |

Machine-readable module mappings and evidence paths: completion-inventory.json. Current applied checks: slice-007-new-reply-promotion/applied-promotion (1022 isolated tests, strict TS exit0); verification counts are evidence, not completion denominator.

Completed capabilities within partial groups include schema/driver/backup primitives, journal authority helpers, guarded queue primitives, hold helpers, origin/notice staging, and Identity/get/bind/promote. Their runtime consumers remain incomplete. Historical top-level ledger statements claiming owned driver or mutation journal entirely unimplemented are stale; current module exports and applied receipts above take precedence.

Uncertainty: this is an obligation-based planning inventory, not an exhaustive function-level mapping of all eleven Rust workspace crates. Outstanding runtime audits may split/extend groups. Platform/network adapters carry different effort and evidence burdens; do not weight all groups equally.

Automatic Reserve switching/replay is deliberately excluded. Started/unknown effects must never gain replay permission. Exact identity/revision/generation fences remain acceptance conditions across groups. No live bridge, model/Discord, OAuth/native runtime or deployment checks were run for this inventory.

Update: pure Windows native lossiness helper applied and actualtarget1029testsPASS strictTS0;32RustWindowsobservations/11Unixunobserved. Group06 remainspartial; no seed/runtime/filesystem acquisition completion.

Update: borrowed Windows seedIn now independently reviewed/applied; actual1058 tests PASS strictTS0. Group06 remains partial: caller/claim/delivery/native acquisition/Unix/runtime unfinished. Next queue baseline prerequisite is plan-only.

Update: borrowed matchingBaselineJsonIn independently reviewed/applied, actual1091PASS/strictTS0. Raw baseline fence prerequisite completed within group05; claims/dispatch/retry/runtime remain unfinished. Nextbegin_attempt visibleownedtransition is plan-only; not guarded dispatch claim.
