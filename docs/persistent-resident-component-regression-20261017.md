# Persistent resident shared-source regression after checkpoint 962

Date: 2026-10-17 UTC. **All twelve normal scenarios and three protocol-invariant wrappers passed again. Overall component cleanup qualification remains FAIL.**

## Why this run was needed

Checkpoint 962 added the fixed negative mutation-cancellation scenario and a distinct assertion-only report across five shared disposable fixture/protocol sources. Checkpoint 959's normal-component qualification predates those shared changes. The 962 standalone negative run did not re-execute the existing normal inventory or protocol-negative wrappers.

This regression uses checkpoint 962 local base `db622373ef364ab3095c4a44cee79d8777cf713d`. No `src` file, operational startup, owner, lifecycle, native transport, responder, deadline, close/release predicate or normal scenario inventory changes in this increment.

The only test change extends `persistent-resident-component-report.test.ts`: the new negative report joins the existing ordinary/null-prototype and every-field passive-descriptor checks, and one additional case rejects incorrect scenario/constants, type substitutions, shape confusion and success upgrades. The parser suite now contains twelve tests. The existing normal-component file is unchanged.

## Exact scope and result

Only these two emitted roots ran, serially and without test-name filtering:

- `test/runtime/persistent-resident-normal-component.test.js`
- `test/runtime/persistent-resident-component-report.test.js`

The author and independent reviewer each observed **40 tests: 39 passed, one failed, zero cancelled/skipped/todo**:

- Twelve pure component-report parser/diagnostic tests passed, including the added negative schema coverage.
- Twelve existing response-release, fixture-command, passive-input and accounting-contract tests passed.
- All twelve actual normal scenarios passed: startup/close, ordinary/queue/stop, large and concurrent response, cancellation before and after response post, begin refusal, unknown response completion, observation gap, idle transition, replacement and final-row change.
- All three isolated protocol-only wrappers passed their original exact child-exit, TAP and nonce-bound retained-debt witness checks: duplicate bootstrap, duplicate initialized and unrelated frame after ready.
- The mandatory protocol-negative cleanup/component qualification failed because retained cleanup debt remains unqualified. This expected failure is preserved in the exact aggregate argv and actual exit code; it is not filtered, skipped or reported as component PASS.

The normal cases retain their existing debt-free close/join and directory-removal predicates. Each run leaves exactly three protocol-negative roots and no normal roots. The wrappers' invariant success does not authorize deleting their retained roots. The replacement case retains its existing conservative direct-child diagnostic of unknown. Concurrent response still covers child-reply wait only, not occupied native-status credit or same-target held-service liveness.

These results apply to the current shared source bytes. They do not replace or add to checkpoint 959's different four-file 59-test selection, and the checkpoint 962 mutation-cancellation negative scenario was not repeated in this two-file regression.

## Build, containment and identity evidence

Both independent freezes used pinned Node 24.21.0, direct TypeScript 7.0.2, guarded explicit source closure and strict NodeNext/ES2023 compilation. Actual compiler lists contained 315 selected / 312 production project sources, each plus 178 allowed declarations. Both compilers exited 0 and all 312 production JavaScript files matched their selected-build counterparts. The production emitted map also matches checkpoint 962's map; application sources did not change.

Each runtime used its own frozen source/output tree, sanitized environment, private HOME and private temporary directory. The unchanged reviewed pidfd/subreaper supervisor retained its 300-second execution bound, seven-second cleanup window and eight-MiB output cap. Node ran with `--no-strip-types --test --test-concurrency=1 --test-reporter=tap` and the two explicit nonempty paths.

The author Node process exited 1 naturally after approximately 21.641 seconds; the independent Node process exited 1 naturally after approximately 21.317 seconds. Each supervisor confirmed all owned processes exited, ECHILD and both output EOFs, with no signals, deadline or errors. Process closure is separate from logical cleanup debt and does not repair the old v4 UNKNOWN descendant record.

Author post-verification matched all 568 frozen inputs (570 physical copies), 315 current project sources, 315 selected and 312 production emitted files, and the pinned Node binary. Its HOME was empty and only the three new protocol-negative roots remained. Independent post-verification matched all 568 frozen/current inputs, both emission maps and pinned Node, and recorded its three separate retained roots with no normal roots remaining.

SHA-256 values:

- Updated pure parser test: `aa20803bbdcb63c51f9fce8c1b5dff2bc1b554c7e1d900d7be4cb9d44c455bff`
- Source graph, sorted compact JSON: `304bb57b96ee6045aff5e19ff61ace28c5eace082824606d8ae789856a97d76f`
- Selected emission map, sorted compact JSON: `3fed41dd117e3c5a9e4a6cf0953d7b3c2dac379162586b43973e62a52675a059`
- Production emission map, sorted compact JSON: `6a26ea4633e75da8aeb96257b87bbcb59f702e330b2ae9fd484733056b032250`
- Reviewed supervisor: `5300f8782a9be6806e2c7f1fc9e3f06743d6de5ca6d7f788da59d126f8fa6f2e`
- Author result receipt: `08e6e014df75c6372d3db5a380136beb4fb1e2048e220cbe4b2b6f967deb13f9`
- Author process receipt: `f562a5ec167d9484e52ed9d893f26e0831accf4f44529ef4413062ad4848be07`
- Independent post-verification: `212e7ec201341db34a0bab2ea3e38d1d5cbba6b6047fd76d5f6cc20c728e0e1f`
- Independent process receipt: `777d87972801f32d2dfadf1c6eb61e57959679ccad2a3566775ddbcfe21dc03c`

## Limits

This closes the selected current-source regression gap after checkpoint 962; it supplies no new installed ownership or release authority. Authentic singleton/root qualification remains BLOCKED / NOT RUN after Unix socket EPERM. No socket retry, alternate primitive, escalation, recursive store-authority coverage scan, protected-path access, old-root cleanup, production activation or ref update occurred. Existing protocol and mutation-cancellation debt, Windows, provider, cutover, performance/endurance and overall migration gates remain separate and unqualified.
