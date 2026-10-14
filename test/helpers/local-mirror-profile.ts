import type {LocalSessionMirrorProfile} from '../../src/runtime/discord-runtime/local-session-mirror-profile.ts';
/** Explicit synthetic qualification only; never reused for live data. */
export function localMirrorProfile(stateDatabasePath:string,bridgeDatabasePath:string):LocalSessionMirrorProfile {
 return {kind:'RootOwnedAppendOnlyMirror',ownership:'CooperatingSingletonRootWithStableDatabaseIdentity',producer:{kind:'CallerQualifiedAppendOnly',qualification:'Synthetic fixture writer appends complete records to its own rollout; no live producer qualification.'},schemaTimeoutMs:5000,worker:{stateDatabasePath,bridgeDatabasePath,
  discovery:{threads:{maxRows:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000},store:{maxTargets:32n,maxJobs:32n,maxValueBytes:1048576n,maxOutputBytes:1048576,timeoutMs:5000}},ready:{maxTargets:32,maxBytes:1048576},
  poll:{read:{maxWindowBytes:65536,maxRecordBytes:32768,maxRecords:20,decodeTimeoutMs:5000},ownership:{maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000}},
  bootstrap:{kind:'SkipExistingHistory',totalTimeoutMs:10000,context:{maxBytes:1048576,maxRecords:10000,maxRecordBytes:262144,maxWindowBytes:65536,maxTurnBytes:16384,timeoutMs:5000}}}};
}
