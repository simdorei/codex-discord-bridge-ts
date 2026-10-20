# Persistent resident protocol text preparation — inactive

This module is an isolated, unimported codec preparation for the reviewed contract in `PERSISTENT_RESIDENT_EXECUTION_CONTRACT.md` (SHA-256 `741fd6e35cfa84c059fc170292fdc0e57bab98a326dcc9d7a7a7ca326407337c`). It does not activate a resident, create authority, implement a registry/reducer, reserve execution capacity, or close migration gates D/E. The eventual consumer would be a separately approved persistent resident owner/proxy boundary; no production root imports or export registration are added here.

## Explicit partial profile

Only primitive JavaScript string input is supported. Binary input, including ordinary typed arrays and shared buffers, is rejected without inspecting it. Owned-byte input and fatal UTF-8 byte decoding remain deferred. Consequently this is **not** completion of the full contract's text/bytes decoder acceptance profile. Raw and escaped lone UTF-16 surrogates are rejected; well-formed text's UTF-8 byte count is checked before parsing without allocating an encoded copy. Counting stops at the first excess. An oversize rejection can therefore precede a malformed suffix. Valid Unicode outside the closed ASCII identifiers and enum literals is still rejected by schema validation.

All 15 Limits fields are mandatory positive safe integers; there are no production numeric defaults. Construction takes primitive JSON text with unsigned decimal integer literals only (no exponent, fractional, signed or leading-zero spelling). Its maximum representation size is the exported `LIMITS_TEXT_MAX_BYTES`, derived from the exact 15 field names, punctuation, and 16 digits per safe integer. Whitespace is permitted only within that finite representation cap. This constructor-specific lexical restriction is deliberate and is not a protocol UInt numeric conversion.

## API

`createResidentProtocolCodec(limitsText, ownerEpoch, sessionId)` validates primitive configuration text and primitive bounded ASCII address strings, then returns a frozen codec:

- `limits`, `address`, `bounds`: fresh frozen construction observations.
- `decodeRequest(text)` / `decodeReply(text)`: bounded text to fresh recursively frozen null-prototype closed-schema data, with private per-codec identity brands.
- `encodeRequest(value)` / `encodeReply(value)`: only that codec's corresponding decoded values; fixed field order, no whitespace, standard JSON escaping, and a final actual-byte budget check.
- `commandKeyOf(value)`: only that codec's decoded request/reply; returns a privately branded frozen key for submit, reconcile, cancel, submission, observation or cancel-result. Other variants throw a generic error.
- `compareCommandKeys(left, right)`: only that codec's branded keys; returns -1, 0 or 1. All keys already match its epoch/session, and sequence ordering uses bounded canonical decimal length then lexical comparison without floating-point conversion.
- `sameSubmission(left, right)`: only that codec's decoded submit requests; compares sequence, intent ID, intent kind and observed revision, excluding correlation message ID. Non-submit values throw a generic error.

Exported structural TypeScript DTO types confer no runtime brand. Every object-taking API verifies private WeakSet membership before property access. Caller objects, accessors, proxies, revoked proxies and boxed strings cannot provide configuration, DTOs or keys. There are no user-provided schemas or callbacks.

## Closed schema and bounds

The scanner accepts only the grammar needed by the schema: object/string/boolean protocol values; no arrays, null or number literals. Construction has only one object level and unsigned safe-integer values. Protocol objects have at most four nested object levels. Decoded object keys are checked for duplicates before validation, including escape-equivalent keys. Exact required fields and enum alternatives are then checked and copied in canonical order. Outer addresses and every nested command key must match construction. Submit sequence, intent ID and command sequence are positive. Release-prefix sequence, revisions, counts and watermarks may be zero. Every UInt is canonical and bounded by `maxSequenceDigits`.

Cancel-result pairs are constrained: recorded accepts any accepted observation; already-terminal accepts definitely-unsent, flushed or unknown; not-accepted, not-seen and retired-no-replay each require their matching observation. These are DTO consistency checks, not evidence that any runtime transition occurred.

Schema sizes are computed symbolically. An ASCII ID occupies `2 + maxIdentifierBytes`, a UInt `2 + maxSequenceDigits`, a boolean at most 5, an enum its largest JSON-quoted literal, a record 2 plus its quoted names, colons, child sizes and commas, and a union its largest alternative. Every addition is checked for safe-integer overflow. No maximum-width synthetic strings are allocated by the codec.

The reviewed preparation-profile interpretation of minimum consistency is:

- Minimum envelope: every request alternative, including submit, with maximum identifier widths and one-digit UInt values.
- Minimum reply: every control/rejection alternative, including rejected submission dispositions but excluding accepted submission, with maximum identifier widths and one-digit UInt values. Owner-status accepted/unresolved counters instead use the decimal width of `maxAcceptedCommands`; retained byte counters use the widths of their configured respective caps. Sequence watermarks retain width one.
- `maxSequenceDigits` must accommodate the configured accepted-command and retained-byte caps. Existing capacity inequalities from the contract also apply.
- Full `maximumEnvelopeBytes` and `maximumReplyBytes` cover all alternatives at maximum identifier/UInt width and are informational. The constructor does not require these maxima to fit. Each actual decode/encode separately enforces its envelope/reply budget.

Minimum fit does not establish live-owner reservations, overflow policy, runtime readiness or any actual memory bound. Numeric reservation/release helpers are not implemented or tested here. Some maximum-width messages can be unavailable under an otherwise consistent configuration.

Validated records, derived keys and construction observations have null prototypes, so canonical encoding cannot consult an inherited `Object.prototype.toJSON` hook. Cancel-result bounds enumerate only valid status/observation pairs.

Errors are fixed, bounded and payload-free: `TypeError("Invalid resident protocol input")` or `RangeError("Resident protocol input exceeds limit")`. No malformed input is reflected in error text, correlated replies or diagnostic objects. The codec does not produce automatic protocol replies.

## Qualification scope

The explicit test file covers every schema variant, recursive missing/unknown/type-invalid mutations, duplicate escaped keys, invalid Unicode, closed enums, exact addresses, all cancel status/observation pairs, positive/zero UInt boundaries, lossless long sequences, private-brand/proxy rejection, construction requirements and inequalities, symbolic byte formulas, canonical ordering and bounded errors. Small test limits are fixtures, not deployment guidance.

The executed qualification below is limited to the independently reviewed frozen codec and its explicit test root. Pure codec tests cannot establish no-replay registry behavior, accepted-command ownership, original request/occurrence authority, database-to-pipe ordering, native allocations, physical-store exclusion, child containment/reaping, reconnect/cutover safety, or integrated migration acceptance. There are no timers, clocks, I/O, native modules, worker/child interfaces or production imports in the codec.


## Frozen qualification receipt — 2026-10-16 UTC

The source freeze qualified by both author and independent reviewer was:

- `src/runtime/resident-execution-protocol.ts`: SHA-256 `ed56eec1157fb9a4790f6c756c23f8b6bb4137546da365f4cc68ceaf50eeb2fa`.
- `test/runtime/resident-execution-protocol.test.ts`: SHA-256 `92c0f7ae557e00583eb585f7076f8e42eeb0c3c3f7ffa999d1148ae493bf546b`.

Both runs pinned Node **24.21.0** and TypeScript **7.0.2**, used `--ignoreConfig` with explicit guarded roots, and audited the actual compiler lists before compilation. The test profile had **180** inputs; the separate production-only profile had **179**. Only the explicit new project root(s) plus allowlisted TypeScript, Node and Undici declaration files were admitted. Both profile compiles succeeded in each run. The emitted codec JavaScript was byte-identical between profiles and between runs, SHA-256 `9ce82db8089a7d95c74681c856dac6a298ad4dabaedbd04f068cf7ffea05f90f`.

An immutable, nonempty, one-file test argv was executed with concurrency one and an unchanged 10,000 ms test timeout:

- Author run 2: **13/13 passed**, 0 failures, cancelled, skipped or todo; reported suite duration **185.674136 ms**.
- Independent reviewer run 1: **13/13 passed**, 0 failures, cancelled, skipped or todo; reported suite duration **168.935448 ms**.

Author run 1 is retained as a failed **pre-compilation compiler-input audit**, not a hidden successful test run: TypeScript 7's standard libraries resolved under `node_modules/@typescript/typescript-linux-x64/lib`, outside the first runner's anticipated stdlib allowlist. No compilation or tests ran in that attempt. The reviewer verified the actual pinned declaration prefix; the next runner added only that prefix to both declaration-only audits. The project roots and qualification scope did not expand. The successful author runner SHA-256 is `761a21ebf01cb08b482b16b6b387e949f2dbb11245278a01c2dfc677567841a9`; the independent runner SHA-256 is `8d0d50b0314b3ca977ea14a119c467acd69fc26cd01d4c9f430968214d424984`. Compiler lists, compile logs, frozen argv, emitted parity hashes, TAP output and the initial audit-stop receipt are retained with the qualification records.

Before any qualification execution, independent source review corrected two findings: ordinary record prototypes could expose canonical encoding to an inherited `toJSON` hook, and an unconstrained cancel status/observation size calculation overestimated a legal minimal reply by one byte. Null-prototype records and exact legal-pair sizing replaced those initial candidates; adversarial prototype-hook and exact-fit control fixtures were added. These were pre-run review findings, not observed runtime or test failures. The initial candidate is retained separately. This receipt does not qualify binary input, numeric reservations, registry transitions, authority construction, live resident execution, physical-store exclusion, child containment or migration gates D/E.
