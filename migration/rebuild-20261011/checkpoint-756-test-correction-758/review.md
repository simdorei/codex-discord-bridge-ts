# Test-only fixture correction

First actual focused183:182PASS/1FAIL. Same compiled isolated test failed again at different preflight position. Diagnostic copy with unchanged production, fixture2s budget and assertions captured InvalidActionRequestError: archive operation timed out; no archive was sent. No candidate product defect established; integration test incorrectly assumed four native reads plus admission complete within its fixture2s budget on this VM.

Correction touches this test file only. Existing fixture default2000ms remains for every previous caller. One operation-order test explicitly uses20000ms to observe its intended later inventory refusal, and now requires exact unsupported fixture call instead of any rejection. Production timeouts/worker capacity unchanged. Existing archive deadline/cancellation tests unchanged. This does not certify2s performance or solve the prior latency limit. Test helper signature default and executor argument changed only to allow that one explicit budget.

Prior whole8165 run and product source remain valid old-test evidence, not a fresh single final full-suite pass. Corrected complete focused183 rerun will replace affected coverage; exact source/test delta retained. Raw first failure, isolated failure and diagnostic log preserved. No product source change.
