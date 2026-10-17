# Checkpoint 903: Native prepared-New attachment persistence

2026-10-15 UTC. Local baseline `b644e70f6374ea9ebf1ff834d30de5e8170d3240`; preceding published checkpoint 902 `f2a74ed0b8ec2332113429e42da475b9ade773e0`, tree `00bb975563305dffe5d0f7a93f4b915222c9461e`. This checkpoint contains local implementation and verification only. No commit, push, deployment, operational database or live-service work was performed by the implementation worker.

## Installed scope

Prepared New attachment persistence in the message processor now runs through its original `MessageCustody`, captured `MessageJournal` and existing native journal worker. The installed gateway, gap-recovery and history-poll paths use the same admission-owned port. The remaining direct processor call to `StateAccessFacade.recordNewInput` is removed; compatibility callers retain their original entrypoint.

`recordNewInputExisting` uses an existing-only connection and current-catalog validation. It shares the original preparation body with `recordNewInput`: original raw prompt and attachment checks, the exact serialized envelope digest, prompt SHA256, immutable saved-input equality, executing/processing preconditions, and the same outcome update. The equal-existing branch still ends by rolling back its read transaction without changing `updated_at`, even after phase advancement. Missing or incompatible stores are neither created nor repaired.

The processor continues to pass the original raw New action to command execution. The prepared text is durable evidence in `outcome.new_input`, not a replacement command plan. No schema, receipt domain, classification, history policy, gateway policy, or final resident response authority changes are included.

## Ownership, acknowledgements and cancellation

NewInput is zero-queue Control work for both public and original-custody calls. It cannot enter the completion FIFO. Only an original custody's subsequent required result, confirmation or hold retains its existing finite completion privilege. No worker pool, fallback executor or retry loop is added.

The new operation's acknowledgement must match the operation, pinned database path, exact ingress key, captured native-port origin, original owner key and unique request identity, with an exact completed-mutation value. Malformed, crossed, missing, duplicate or lost acknowledgement remains unconfirmed; a possibly committed preparation is never treated as permission to replay the command.

Custody joins every accepted NewInput operation through actual worker exit. Disposal cannot submit its required hold or release the outer message/history permit while the write is still running. Deadline and cancellation do not release a blocked SQLite writer. The existing cancellation recheck immediately before command execution prevents thread/start after a cancelled preparation, including when the preparation committed before actual exit. Unknown and failed preparation paths are held without a command replay.

Original decoded message identity, immutable admission payload and captured port functions are retained across awaits. Equal-input idempotence remains a store property; it does not authorize automatic command replay after uncertainty.

Sealed-drain policy is unchanged: an attached New command is refused or deferred before attachment preparation. The existing allowed pending-reply drain path still uses its native lifecycle and cannot reach the legacy NewInput facade.

These are bounded queue, packet and operation-deadline policies, not throughput, memory, SQL-work, latency or crash-recovery guarantees.

## Verification and frozen candidate

Pinned Node 24.21.0 and TypeScript 7.0.2. Tests are emitted using `tools/build-test-profile.mjs` and executed as JavaScript with `NODE_OPTIONS=--no-strip-types` and test concurrency one.

- Strict source/test typecheck: passed.
- Production build and whitespace check: passed.
- All 937 production JavaScript modules match the emitted test graph byte-for-byte.
- Focused suite: 84/84 passed, zero failures, cancellations or skips.
- Bounded affected suite: 1,254/1,254 passed across 86 selected files, zero failures, cancellations or skips (375.88 seconds).
- Independent read-only review: the same focused suite passed 84/84, plus four additional adversarial checks passed, with no scoped blocker identified. The reviewer also rechecked all ten source/test hashes and all 937 production-module matches.

The emitted graph is `.runtime/compiled-tests-T5V44P`. The ten-file source/test candidate is frozen by `.runtime/checkpoint-903-source.sha256`; SHA256 of that standard checksum manifest is `348d78951cf06012699cd5ef56fdfaf6450b471267ae9f1bfb08f8dff7912319`. This checkpoint document is added separately after source/test freeze.

Coverage includes exact hash parity with the original entrypoint; equal-existing rollback and phase precedence; changed source/prompt refusal; missing-store and incompatible-schema refusal; update rollback; passive input and captured-method mutation; exact large message/actor identities; unchanged raw New plans; poisoned installed facade paths; zero-queue saturation; required hold completion; malformed/crossed/lost acknowledgements; actual locked native exit and deadline ownership; cancellation retaining the outer permit through native exit and hold; no command execution after failed/cancelled preparation; original-message dedup after uncertainty; and gateway/gap/poll/sealed-drain routing.

Evidence is retained under `.runtime/checkpoint-903-*`, including graph metadata, source and deliverable manifests, selected test files, strict/build/whitespace logs, production parity and implementation-worker test output. The independent read-only reviewer retained results in its tool outputs, not local log files: 84 tests in session 19576 (41.27 seconds), and four adversarial tests in session 45655 (2.95 seconds), both exiting zero. Those additional checks exercised actual stale same-owner ACK replay, duplicate real-worker ACK, wrong installation/owner/accessor rejection, and oversized/active timestamp rejection. Overlapping focused, affected and independent checks must not be added as distinct test totals.

## Explicit exclusions and limits

The protected redaction fixture was not read, reconstructed, executed or uploaded. The known UNIX-root `test/runtime/discord-runtime/store-authority-profile.test.ts` fixture is explicitly excluded from bounded affected validation because of its previously established `listen EPERM` environment failure. It was not retried or escalated.

This is not full-suite, Windows, load, performance, crash/restart or live-runtime qualification. Checkpoint 893 accounting WIP is not activated as an exclusion mechanism. Broader TypeScript migration work remains incomplete.
