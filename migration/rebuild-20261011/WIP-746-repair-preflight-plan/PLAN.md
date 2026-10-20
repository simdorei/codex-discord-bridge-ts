# Repair preflight native-read wiring only

Product checkpoint744 plus tests-only745 is preserved. Next unit does not redesign Repair or its synchronous mutation guard.

The actual Repair path still directly awaits listFiltered(path, originalTarget, null), then only if empty calls listPromptIntakes(path) and checks original target. Reuse already-qualified native queue read and native intake list adapters. Capture a two-function own-data typed port in AdmittedRepairExecutor; keep default original state for existing direct helper contract and inject native readers from RuntimeCommandExecutor. Preserve exact OR short-circuit, target lock scope, total deadline, post-read cancellation, generation health checks, original custody and checked RPC order. Native errors or busy capacity reject before reset; no fallback to empty or extra retry/pool.

RecoveryGuard.check/checkIn/rpcCheck remain synchronous at exact writer boundaries. Moving those awaits would widen authorization race windows and needs a separate design. Claim/lifecycle admission and other custody calls also remain outside this unit. Native preflight wiring is not entire Repair offload or runtime approval.

Tests: paired original Repair scenarios through native readers, exact reset/init/probe count with no turn/restart; queued branch skips intake; empty queue calls intake; failed first/second read sends no RPC; mutation/selection drift while read is pending rejected by original subsequent guard; cancellation waits the admitted native read to join before target-lock release. Existing native read fixtures already cover invalid/late/complete row semantics. Paired native fixture may use production total25s while retaining exact call/lock fault budgets; original tighter direct fixtures are unchanged. Strict/type/focused/full, then exact applied hashes and bounded publication evidence.

Current-main test reconciliation: repair_custody_tests.rs differs only by adding #[cfg(windows)] to enqueue/fake_controller test helpers. Current full test and exact diff are separately retained. Five other bounded files match; no complete closure claim.
