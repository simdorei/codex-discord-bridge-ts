# Bounded static review

Root read original Rust project/store query paths, current original TS project/store reader and candidate extraction/worker/parent composition. Scope: POSIX CWD selection offload. No Windows claim.

Confirmed: target-first selection and loadRecentThreads(0) complete row decoding retained; direct project and null branches avoid Codex database access. The native filesystem lookup uses captured cwd plus original path spelling without lexical normalization, retaining symlink-parent behavior. Return spelling remains the original stripped cwd. Existing project-key comparisons and generation-bound mapping recheck are outside the worker and unchanged. Input is passively bounded/captured, full typed origin serialized losslessly, acknowledgement bound to path/base/origin. All actual production NewThreadExecutor construction occurs in RuntimeCommandExecutor, which injects the native resolver; paired direct constructors keep original helper for comparison.

Discovery capacity1/zeroqueue unchanged. Native result deadline joins the actual worker before release; cancellation never authorizes creation. Missing files remain missing. Expected nominal invalid-project failures are reconstituted; other errors are unavailable. No broad exception-to-success fallback. Original full inventory materialization remains an explicit memory/performance limitation.

Focused first555/554PASS/1FAIL was only URL observer expecting .js before the slot's internal worker resolution. Test-only .ts suffix correction; product bytes unchanged. Corrected focused555PASS, TS/build0. Actual SQLite corrupt unrelated row, precedence, missing DB, symlink-parent, cancellation and actual-join capacity cases passed. Complete regression is currently running; no product application yet.
