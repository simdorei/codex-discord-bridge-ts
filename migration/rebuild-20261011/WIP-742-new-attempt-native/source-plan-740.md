# 740: next bounded native New attempt lifecycle

Plan only. Candidate 739 is in full regression and remains unapplied.

## Exact remaining call path
NewThreadExecutor.execute -> beginNewThreadAttempt -> beginIngressThreadStart; winning attempt -> NewThreadProject.freeze -> recordIngressNewCreation; successful server thread/start -> recordIngressCreatedThread. Disposal joins pending operation before getIngress and possible holdIngress. Owner replay currently calls the default getPromptIntake even though the existing native facade already supplies it.

## Proposed bounded implementation
1. Extract and byte-compare the existing callback bodies of beginIngressThreadStart (IMMEDIATE transaction), recordIngressNewCreation (IMMEDIATE transaction), and recordIngressCreatedThread (single statement; preserve no added multi-statement transaction). Reuse callbacks in original initialized and new Existing entrypoints. Add existing full-record getIngress with CheckedRead and complete original decoder.
2. Pure validation must retain original ordering and nominal invalid-target/custody errors before worker admission. Capture timestamps using the existing closed f64 tags, signed i64 generations, original target/key strings.
3. Extend the same native intake worker by four operation tags, identity-bound results, existing 16 MiB limit and Control capacity one. No new pool, queue, fallback or retry. Reuse 738 full-record wire; do not project away ownership, outcome or custody fields.
4. Capture one typed state port in NewThreadExecutor, NewThreadProject and NewThreadAttempt. Reuse existing native getPromptIntake for owner replay and holdIngress for disposal. Validate functions with own-data descriptors and native Promise returns. Only a confirmed successful begin creates an attempt guard; false or unknown results never authorize thread/start.
5. Preserve actual-exit joining, one-use attempt guard, cancellation after winning admission, no hold of another winner, current original mapping recheck, generation and channel equality, one-time new_creation write, known remote ID before room creation and durable intake before selected-target change.

## Checks
Paired original lifecycle/new-creation tests; missing and incomplete stores never repaired; wrong generation/channel/mapping rejected; double begin and creation replay refused; single-statement recordCreated identity and row disappearance; hold after cancelled or failed won attempt; concurrent duplicate cannot hold winner; exact native binding and late commit never permission; actual RuntimeCommandExecutor New once-only thread/start and turn/start remain asserted.

## Explicit outstanding scope
NewThreadProject's CodexThreadStore lookup and statSync still require a separate bounded reader design. No claim that the whole New path is offloaded. Windows path/DPAPI, actual Discord/appserver transport, performance and 24-hour acceptance remain unverified. Full Rust child closure certification is not inferred from the seven pinned source files.
