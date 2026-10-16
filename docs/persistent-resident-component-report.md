# Persistent resident component report: pure extraction

## Current status

Author and independent reviewer each completed the exact pure graph: 11 tests passed, zero failures, skips, cancellations or todos. Qualification covers only the new report leaf and its explicit deterministic test root. Whole-owner/bootstrap integration is NOT COMPILED / NOT RUN / NOT PASS. The existing native fixture execution hold remains unchanged; this work neither retries that fixture nor establishes termination of its previous descendants.

## Boundary and compatibility

`persistent-resident-component-report.ts` imports only `node:util`. It contains the three existing frozen phase, fixture-failure-step and child-closure enum arrays and their types, re-exported by bootstrap as the same bindings. The existing parser body is extracted unchanged except for its exported function name.

The parser copies exact enumerable own data fields into a new mutable null-prototype record without invoking getters. It rejects proxies before reflection. Unknown generic string kinds still parse; the owner rejects inappropriate dispatch. Fixture scenario and passed fields remain unvalidated by this parser. Failed/closed phase labels remain parser enum members, although owner checks reject them for failed reports. Error strings and validation order are retained. The copy remains shallow; it is not a new provenance or immutable-payload guarantee.

Immutable diagnostic transitions record corruption, terminal kind, and direct-child closure label. Corruption is sticky; any repeated or conflicting terminal proposal corrupts the value and forces the diagnostic to unknown. There is no reset, release predicate or component method accepting caller evidence. These internal implementation exports are not certificates or authority.

## Owner integration

Only the owner closure creates and retains the evidence value. Its existing parser try/catch, post-capture precheck, orchestration-specific phase/closure checks and failure side effects remain in place. Normal-disposal notification precedes terminal diagnostic acceptance. Corruption is recorded before the original idempotent failure handler. Actual-exit checks and asynchronous post-join release checks read the latest retained value. Registration release still requires the original independent checks and joins; a confirmed diagnostic alone cannot release anything. Snapshot fields and existing error messages are preserved.

## Narrow qualification evidence

The exact pure test root imports only the leaf, `node:test` and `node:assert/strict`. Deterministic cases cover passive capture, enum labels, malformed descriptors, revoked proxies, unknown-kind compatibility, intentionally unvalidated fixture fields, immutable transitions, duplicates/conflicts and all diagnostic operation sequences through length five. These are parser and bookkeeping assertions, not actual child cleanup, process exit, root release or runtime qualification.

The source and exact two-file graph were frozen and independently reviewed before execution. Both qualification runs used actual pinned Node 24.21.0 and the installed direct TypeScript 7.0.2 compiler binary, with explicit arguments and `--ignoreConfig`. Calling that same compiler binary directly avoided its launcher wrapper, without changing compiler version. Actual compiler file-list audits found exactly two project files plus 178 allowed declaration files in the selected build, and the production leaf alone plus allowed declarations in the production-only build. Production and selected emitted leaf bytes matched in both runs.

Tests named one explicit emitted file and used the pinned Node's verified `--test-isolation=none` mode with sanitized environment. No application Workers, child responders, databases, ports or temporary fixture roots were created by this pure application graph. Compiler and test processes did run; their actual waits returned exit 0 and both output streams reached EOF. Those receipts concern these narrow runs only and do not establish termination of any prior native fixture descendants. The earlier v4 descendant state remains UNKNOWN and its execution hold is unchanged.

The first selected compilation (v2) failed with TS2367 at test line 99, column 67: a redundant corrupt-kind comparison after control-flow narrowing. Production compilation and tests did not run on that attempt. The correction removed only that redundant comparison, preserving the expected-closure assertion and sequence coverage. The failed attempt was retained; the corrected v3 test bytes were then independently qualified. No production source change was needed for this compiler failure.

Frozen production leaf SHA-256: `829ee121e3ab2b9542d02c51df212a7bf9d01544997a010c8c085620f27c3659`.
Corrected pure test SHA-256: `2878b03407f7c4264b79b45f583a7e1a696ad4519e6b23973d31a4c3fc7892c1`.
Emitted production leaf SHA-256 in both builds and runs: `509588d0134414e60d75baa04fb0c0aee51b2868fcd484c6dcd9880f14ae2205`.
Emitted test SHA-256 in both runs: `1d2648113bc9ca62bfe30722f19196928744dbd2b04343d0f689ef3ef085400e`.

This is dual pure parser/diagnostic-bookkeeping qualification only. It is not full component, process cleanup, root release, native fixture, Windows, performance or migration acceptance.
