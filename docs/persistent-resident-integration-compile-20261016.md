# Persistent resident integration: compile-only qualification

Date: 2026-10-16 UTC. Status: **dual compile-only qualification passed** for the exact frozen graph below. Application execution and native component qualification remain **NOT RUN / NOT PASS** for this snapshot.

## Snapshot and scope

The source baseline is checkpoint 955, remote commit [`7cc31e1be3c87acaa83ad2b2e81b8566ac0ee8b1`](https://github.com/simdorei/codex-discord-bridge-ts/commit/7cc31e1be3c87acaa83ad2b2e81b8566ac0ee8b1), tree `b5eb93de4fb3bb377e96b6fa33c4cb082fb0a24e`. No application or test source changed for this qualification.

The guarded graph includes the persistent resident worker, store role, bootstrap, composition, local custody and component-report modules; the explicit normal-component, component-report and response-attempt test roots; the fixed inline responder; and the fixed native worker roots discovered through their literal URLs. Static and dynamic dependencies were enumerated before compilation. Protected and previously excluded paths remain excluded; this is not a repository-wide build.

- Exact selected project source files: 316, plus 178 explicit allowed declarations.
- Separate production-only source files: 312, plus the same 178 declarations.
- Source graph SHA-256: `00045ca976e4920fbfb71810a496e754439f427314191cf4581961909b793120`.
- Frozen v2 manifest SHA-256: `edd13c89e5f48798d8608eb3c553e2b592124e02f2a8467cadf4d4dc6282fe29`.

## Independent compile results

The author and independent reviewer each invoked the frozen copy of the installed direct TypeScript 7.0.2 compiler binary with explicit inputs and configuration bypass. The compiler executable SHA-256 was `4f2de678286401759b3fb4475bafe35b8f32b4b3a07d92642bbf37eadc9b34a4`.

In both runs, selected and production-only compilations returned actual exit 0, with stdout and stderr EOF observed. Compiler file-list audits matched exactly the source and declaration sets above. Post-run frozen-file verification succeeded. All 312 emitted production JavaScript files were byte-identical between selected and production-only builds, and their complete hash maps also agreed between the author and reviewer.

The canonical production JavaScript hash-map SHA-256 (sorted keys, compact JSON) is `893fb46ac1c944c870783375f86c2e43e65e404fbef54e14cc6853ea07fc4e2f`. The matching sanitized result receipt SHA-256 is `8e91d32b03e684b727573ae6bd1d86e4c2ec51e42581b742c752661a10369019`. Matching result contents do not replace the separate actual process-exit and stream-closure receipts retained for each run.

The compiler processes ran. None of the emitted application, test or fixture code was executed. No application Worker, native fixture, responder, database operation, process-control operation, fixture-directory cleanup or deployment was performed by this qualification.

## Preserved failed attempt

The first author attempt, v1, failed at compiler startup with actual exit 2 because the frozen compiler layout omitted its official sibling `lib.d.ts` startup sentinel. Its failure and exit/EOF receipts remain retained; it is not counted as a successful compilation.

V2 added only that hash-verified official support file, SHA-256 `0e6477e5049e579cc5de741a70ac91235252edc0468b2e569f22de9db3357786`. It did not change project sources or expand parsed declaration inputs. `noLib` remained enabled, and both actual file-list audits still contained exactly the original 178 declarations. The sentinel's own library-reference directives did not become an additional parsed library set.

## What this closes, and what it does not

This establishes current compile compatibility for the frozen local-custody extraction, direct-child diagnostic and component-report owner/bootstrap integration. Historical source-only statements in their original checkpoint records describe those earlier executions and remain preserved. The dated addenda below point to this later compile evidence.

The [checkpoint 955 pure report-leaf qualification](persistent-resident-component-report.md) remains a separate dual 11/11 deterministic test result. This larger compile-only graph does not rerun those tests or extend their behavioral coverage to the owner, lifecycle, bootstrap, child closure or root release.

The previous v4 native run's descendant state remains **UNKNOWN**. Compiler termination receipts concern only these compiler processes; they neither establish previous descendant exit nor repair lost containment evidence. The native fixture execution hold remains unchanged. A new snapshot or later successful compilation is not a cleanup certificate.

Pending startup/disposal races, malformed or conflicting terminal reports, replacement failure, complete normal-component scenarios and physical descendant cleanup remain unqualified at runtime. No installed CLI activation, operational root, Windows, Rust cutover, performance, 24-hour operation or overall migration acceptance is claimed. Prior failures and WIP records are not erased by this compile-only result.
