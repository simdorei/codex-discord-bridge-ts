# Mapping-only candidate review

Three production files change: ActionThreadSelection captures an optional typed mapping function, BasicActionDispatcher forwards an optional function, and RuntimeCommandExecutor shares its existing native intake MirrorTarget function with both selection objects. Original direct defaults remain unchanged. No new operation or worker budget. Channel validation and mirror-before-selected ordering are intact. Native errors propagate; only actual null permits selected fallback. Callback must be a passive function returning an actual Promise, and non-null target text is checked.

Reference resolution, CodexThreadStore, bridge selected reads/writes and all mutation guards are unchanged, including synchronous limitations. Existing native worker binding, complete reply and exit-join checks are reused, not newly certified here. No native cancellation interruption claim. Root target lookup checks cancellation around the awaited selection.

Focused45/45 PASS under Node24.21, strict TS0. Includes original tests plus native paired scenarios, invalid selected JSON with valid mirror, stale target refusal, null/absent selection, explicit-reference bypass, original reference formatting, zero channel, read failure no fallback, real concrete Basic and command-selection native dispatch. Whole regression pending. Product unapplied; no runtime/live/Windows approval.
