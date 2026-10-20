# WIP785 pure Stop terminal observation predicate

Exact immutable Rust PR5 verify_observation predicate only. Focused19PASS and strict TypeScript/build0; full integration not run, unapplied. Accepts original exact thread and turn, explicit whole completeness, idle/notLoaded metadata, unarchived thread, absent-active/complete Goal, exactly one ended turn and <=1MiB full Serde serialization. Unknown fields follow source behavior. Accessors/Proxies refuse before hooks. Test includes exact byte boundary and one multibyte character beyond it.

This pure helper creates no native observation lifetime or authority. It deliberately does not validate can_settle, queue custody, resident/generation, transactions, fences, holds, publication policy or commit permission; those belong to the unimplemented recover_terminal_in caller. Test proves can_settle=false/empty jobs do not become a false whole-recovery claim. No queue cancellation or runtime recovery installed.
