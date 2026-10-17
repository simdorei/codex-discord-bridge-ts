# Bounded remote native codec owners (918)

This correction addresses the local codec-slot collision exposed by [917's unchanged synthetic measurement](synthetic-runtime-measurement.md). It does not raise a queue, worker, byte, timeout or acceptance threshold, enable an operational remote root, or qualify G2/G4/G7 as a whole.

## Observed failure and bounded correction

The original module-global `OwnedWorkerSlot` was used by wire parsing/serialization and dispatcher mutation-cache fingerprinting, serialization and cached-result decoding. The dispatcher lock only serialized its own codec callers. A ready result could therefore select wire serialization while another dispatcher completion owned the same slot; local `OwnedWorkerBusyError` escaped the command loop and triggered connection drain.

The frozen 917 record has a direct `OwnedWorkerBusyError` after held-leaf release, but no saved stack identifying the exact competing call pair. That pair remains a strong source-supported inference about that historical run. The new deterministic regression independently reproduces a cache `remember` fingerprint overlapping compatibility wire serialization and its direct same-slot refusal. It then verifies that the explicit-owner arrangement completes overlapping operations.

`RemoteNativeCodecOwner` now owns exactly one native slot, refuses same-owner reentry without queueing, and waits for actual native exit on success, abort and timeout. It exposes no worker factory or arbitrary module URL. Instances have a private identity brand, frozen own properties and a frozen prototype. The two public injection boundaries reject copies, forged/proxied objects and subclass overrides before invoking their methods.

The installed synthetic/managed route uses two sequential ownership domains:

- One connection wire owner, created before hello and reused for hello serialization, acknowledgment decoding, command parsing, admission-refusal serialization and ordinary result serialization. The command loop never runs two of these concurrently. Lifecycle retirement joins this owner.
- One dispatcher owner, retained across reconnects and shared by every project's cache and nonmutating-result validation. The existing dispatcher codec lock serializes its operations. Accepted-operation drain joins this owner before resource closure. Cache keys, original IDs, session identities and uncertainty/replay behavior are unchanged.

Standalone compatibility helpers and default standalone caches retain their previous singleton semantics. The live connection and dispatcher paths do not use that singleton. No per-request/per-project native owner, worker pool, generic Promise-tail queue, retry, replay, synchronous CPU fallback or swallowed failure is added. Control completion FIFOs are untouched.

Global native capacity remains Background 3, Control 1, Observation 2, Discovery 1, Maintenance 1, eight total. Wire and dispatcher owners can occupy at most two Background slots concurrently on this route. Real global Background exhaustion still returns `OwnedWorkerBudgetError`; it can prevent even a wire refusal from being serialized and is not solved by this change. Tests distinguish that refusal from local same-owner `OwnedWorkerBusyError`.

Outer remote admission remains four active, sixteen total retained commands and 4,194,304 wire bytes. Dispatcher direct calls remain bounded to four and 4 MiB with already-charged lock waiters. The existing deadlines and cancellation paths remain in force. Taking a ready result releases its outer accounting just before the sequential write; the loop admits no additional command while that write is awaited.

## Verification and before/after evidence

Pinned Node 24.21.0 and TypeScript 7.0.2 execute emitted JavaScript/native workers with `NODE_OPTIONS=--no-strip-types`. The private selected compiler profile starts from an explicit test-root list, rejects forbidden paths before reading, follows static imports/literal worker URLs, and verifies the compiler's actual source graph. The protected test, restricted native-read 913 graph and reserved Windows paths are excluded, without broad test-tree enumeration or full-suite commands.

Seven new deterministic tests cover:

1. Cache remember and retained lookup overlapping wire parse, exact-ID refusal and ordinary result output; both native slots are observed active synchronously.
2. Independent fingerprint/result serialization overlap, plus unchanged compatibility same-owner refusal.
3. The old compatibility-cache/wire collision with original native settlement retained.
4. Real dispatcher remember/read validation and cache lookup after reconnect overlapping wire output, with one backend invocation for the retained same-ID mutation.
5. Abort and timeout receipts pending through actual native exit and joined ownership release.
6. All three Background slots held by unrelated workers, explicit global-budget refusal, unchanged limits and actual joined release.
7. Foreign, copied, proxied and subclass-overridden codecs rejected without getter, trap or port execution.

The unchanged actual measurement command is:

    NODE_OPTIONS=--no-strip-types .runtime/node24/node_modules/node-linux-x64/bin/node --no-strip-types tools/run-runtime-measurement.mjs

Fresh before/after runs use identical offered wire IDs, UTF-8 byte counts and hashes. The new [bounded 918 evidence summary](../test/fixtures/runtime-measurement-918-summary.json) preserves both outcomes; the [917 failure fixture](../test/fixtures/runtime-measurement-917-summary.json), measurement tool, helper/driver, recorder and workload tests remain byte-for-byte unchanged.

- Before: strict selected compilation and 8 accounting tests completed. Two scenarios completed; count recovery failed with direct `OwnedWorkerBusyError`. Four held leaves settled, twelve queued candidates never started, and all sixteen accepted workload results remained missing. The original overflow ID alone received `bridge_busy`. All roots joined.
- After: strict selected compilation and 8 accounting tests completed. All three scenarios completed their unchanged structural checks. Count recovery produced exactly sixteen successful workload results, sixteen leaf starts/settlements and one overflow refusal, with no disconnect or missing result. Held-versus-unrelated progress and byte-saturation cancellation/drain remained intact. All roots joined with no retained ownership.
- The byte-cancellation scenario deliberately leaves nine wire results unobserved, including five queued commands that never reach the leaf. These are not invented cancellation receipts or delivery successes.

Final independent affected verification completed **169/169 tests** from 17 explicit roots and 83 selected/emitted modules, including all seven new cases. Its source graph is `5e581fb05600d7ac2dc60d310f8b8c96c9b467dcce1c672ccd20e594caeef2dd`; emitted graph `7efad1e71a17e8904a4aad524dc6ff8ec2edb220cfa236bd5193c2ef5968265e`; profile `4837548c47da3daae808c3c9a7b3413464140b50c27fd001f110eb96e7aa2673`. This bounded affected run is separate from the measurement and is not a full suite. An independent rerun of the unchanged measurement also completed 8/8 accounting tests and all 3 structural scenarios on the same production graph; its full private structured report hash is `2df49f8967c7d708616f472ad83baf5c5c03a2b55c3ebf53fb100535533c6714`.

The author measurement's source graph is `e252c9baafea0fa96e116ca38b90ce0bbf5a4082fb1c2a60da1fad24f0111bc4`; emitted graph `167821c82f084865621549aee27cca4fcacf34e957a8ce9bb4edca421c503d68`; profile `93d3eb07b8567e01daf5647c35243d29e02fd22a0f0222d7bc7fc9b657e03573`. The unchanged measurement tool hash is `1c15d5f8ab3e91278ce09761c67dbf0b2f7c9312163f135505526620e2b1da67`.

These are structural bug-fix and scoped regression results. Numeric observations remain unqualified: no predeclared latency threshold or matched frozen Rust experiment exists. All-lane fairness, native singleton exclusion, real remote backends, protected handoff, 913 qualification, inactive 893 and remaining migration gates are unchanged. There is no whole-runtime PASS, performance SLA, operational or deployment approval.
