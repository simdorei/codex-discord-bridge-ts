# WIP 737: existing-store journal foundation

Unapplied candidate. Strict TypeScript/build and 116 focused tests passed. Full regression, native-worker wire and actual runtime injection have not been verified for this candidate. The applied product remains qualified checkpoint 735 (8,007 tests). This is preservation, not complete migration approval.

Existing-only foundation for reviewed736 journal scope. Three shared-body wrappers and paired original tests; native wire and actual runtime injection remain pending. Source admitIngressRecordedIn/holdIngressIn/ingressByOriginIn bodies remain byte-identical. Central existing-store transaction helper handles cleanup, so combined cleanup errors may be AggregateError; initialized APIs are unchanged. No independent full suite claim at this foundation step.
