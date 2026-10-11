# Compiled worker execution profile

This bridge remains incomplete and is not approved for production or Windows deployment.

## Why this profile exists

On pinned Node 24.21.0 / V8 13.6.233.17-node.53, the 601 full source-test run ended with 7258/7259 passing and a native SIGTRAP in diagnostic-report.test.ts. TAP captured `jit_page_->allocations_.erase(addr) == 1` and `ThreadIsolation::UnregisterWasmAllocation`. A similar upstream issue exists at https://github.com/nodejs/node/issues/66366. Twelve unchanged diagnostic runs passed; this does not establish that the intermittent failure is fixed or identify its precise local cause. The older checkpoint570 failure lacked a native stack and cannot retrospectively be assigned this cause.

Node's built-in TypeScript type stripping uses Amaro. Compiling before execution removes the need to type-strip TS modules inside the runtime workers. This is a reduction in runtime dependencies, not proof that all V8 native failures have been eliminated. No JIT/memory protection flags are disabled and no Node version is changed.

## Build and execute

- `npm run typecheck` checks the full source/test graph.
- `npm run build` compiles production sources with pinned TypeScript and rewrites relative imports from `.ts` to `.js` into `dist/src`.
- The centralized OwnedWorkerSlot maps local `.ts` worker URL suffixes to `.js` only when that owner itself executes as compiled `.js`. It never falls back to source when compiled output is missing. Data URLs and other protocols/suffixes are unchanged.
- Run qualified compiled entry points with `node --no-strip-types ...`. This makes an accidental TS dependency fail rather than silently reintroduce runtime stripping.
- Keep the repository package manifest and locked dependencies beside `dist`; the build is not a standalone bundle, executable or installer. There is no completed main bridge entry point yet.

## Validation boundaries

Source and compiled tests are separate execution profiles. Record both, preserve failed runs, and do not call a later pass a repair of a native engine crash. Literal worker module URLs inside data-URL test fixtures must use the same graph-selection helper; TypeScript does not rewrite arbitrary string values. Test expectations and worker ownership/budget assertions are unchanged.

Native diagnostic, worker cancellation/timeout/exit and reserved control capacity tests must pass with type stripping disabled. Broader compiled graph integration, native Windows behavior, whole-runtime startup/shutdown, 24-hour operation and production deployment remain pending.

## Complete compiled test profile

`npm run build:test` creates a fresh `.runtime/compiled-tests-*` directory and prints its output/fixture-manifest paths as JSON. It compiles all source and tests, copies explicit read-only fixtures, and preserves each earlier build. Run its generated test files with `NODE_OPTIONS=--no-strip-types` so spawned child processes inherit the same restriction. The instrumentation fixture verifies the original source hashes and compiles its unchanged inserted code with the existing compiler; it does not enable runtime TS fallback.

The initial608 compiled run had7253 passes,8 failures and12 cancelled tests caused by absent fixture source/data or literal TS child module URLs. The fixed609 staged compiled run passed all7273, with no failures/cancellations/skips. This is one complete run under that profile, not a proof of24-hour engine stability. Initial failures and unchanged source-profile results remain preserved.
