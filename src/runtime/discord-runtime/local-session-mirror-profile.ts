import {lstat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import type {RuntimePaths} from '../runtime-paths/resolve.ts';
import {captureBoundMirrorWorkerConfig,type BoundMirrorWorkerConfig,type MirrorWorkerBootstrapPolicy} from '../session-mirror/bound-poll.ts';
import {prepareMirrorBootstrapSchemas} from '../session-mirror/bootstrap-schema.ts';

/** An explicit caller assertion, not a filesystem or producer certification.
 * The caller has qualified append-only history for every discovered rollout and
 * maintains stable DB identity with all writers cooperating in this root's
 * singleton scope until joined shutdown. Never derive this from environment
 * flags, sampled anchors, the qualification text, or successful fixture tests. */
export interface LocalSessionMirrorProfile {
 readonly kind:'RootOwnedAppendOnlyMirror';
 readonly ownership:'CooperatingSingletonRootWithStableDatabaseIdentity';
 readonly producer:{readonly kind:'CallerQualifiedAppendOnly';readonly qualification:string};
 readonly worker:BoundMirrorWorkerConfig&{readonly bootstrap:MirrorWorkerBootstrapPolicy};
 readonly schemaTimeoutMs:number;
}

/** Synchronous passive capture before any application startup effects. */
export function captureLocalSessionMirrorProfile(input:LocalSessionMirrorProfile):LocalSessionMirrorProfile {
 if(own(input,'kind')!=='RootOwnedAppendOnlyMirror'||own(input,'ownership')!=='CooperatingSingletonRootWithStableDatabaseIdentity')throw new TypeError('Expected explicit root-owned mirror ownership profile');
 const producer=own(input,'producer'),kind=own(producer,'kind'),qualification=own(producer,'qualification');
 requireDiscordText(qualification);
 if(kind!=='CallerQualifiedAppendOnly'||qualification.trim()===''||qualification.includes('\0')||Buffer.byteLength(qualification)>4096)throw new TypeError('Expected caller-qualified append-only producer policy');
 const worker=captureBoundMirrorWorkerConfig(own(input,'worker') as LocalSessionMirrorProfile['worker']),schemaTimeoutMs=own(input,'schemaTimeoutMs');
 if(worker.bootstrap===undefined)throw new TypeError('Local mirror profile requires explicit SkipExistingHistory bootstrap');
 if(typeof schemaTimeoutMs!=='number'||!Number.isSafeInteger(schemaTimeoutMs)||schemaTimeoutMs<1||schemaTimeoutMs>10000)throw new RangeError('Invalid local mirror schema budget');
 return Object.freeze({kind:'RootOwnedAppendOnlyMirror',ownership:'CooperatingSingletonRootWithStableDatabaseIdentity',producer:Object.freeze({kind,qualification}),worker:Object.freeze({...worker,bootstrap:worker.bootstrap}),schemaTimeoutMs});
}

/** Paths must describe this application's exact original state/bridge stores.
 * External bridge stores are intentionally unsupported by this local profile. */
export function requireLocalSessionMirrorPaths(profile:LocalSessionMirrorProfile,paths:Pick<RuntimePaths,'root'|'stateDb'|'mirrorDb'>):void {
 const root=pinNativeRuntimePath(own(paths,'root') as string),bridge=pinNativeRuntimePath(own(paths,'mirrorDb') as string),state=pinNativeRuntimePath(own(paths,'stateDb') as string);
 if(bridge!==join(root,'discord_mirror.sqlite'))throw new TypeError('Local mirror requires the singleton-root bridge database');
 if(profile.worker.bridgeDatabasePath!==bridge||profile.worker.stateDatabasePath!==state||bridge===state)throw new TypeError('Local mirror configuration differs from application database paths');
}

/** Read-only alias checks under the application's acquired singleton. They do
 * not prove absence of other writers or prevent later hostile replacement.
 * Checking SQLite sidecars also prevents a known alias before opening the DB. */
export async function requireLocalSessionMirrorDatabase(paths:Pick<RuntimePaths,'root'|'mirrorDb'>,signal?:AbortSignal):Promise<void> {
 signal?.throwIfAborted();const rootPath=pinNativeRuntimePath(own(paths,'root') as string),database=pinNativeRuntimePath(own(paths,'mirrorDb') as string),root=await realpath(rootPath);
 for(const suffix of ['', '-wal', '-shm', '-journal']){
  signal?.throwIfAborted();const path=database+suffix;let info;
  try{info=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
  if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||await realpath(path)!==join(root,'discord_mirror.sqlite')+suffix)throw new TypeError('Local mirror database or sidecar is not root-owned without aliases');
 }
 signal?.throwIfAborted();
}

/** Called after the existing context has prepared the base store, before the
 * application creates any gateway or typed worker. Never repeats base migrations.
 * Caller retains the real singleton and prepared resident on every failure. */
export async function prepareLocalSessionMirrorSchemas(profile:LocalSessionMirrorProfile,paths:Pick<RuntimePaths,'root'|'stateDb'|'mirrorDb'>,signal?:AbortSignal):Promise<void> {
 const captured=captureLocalSessionMirrorProfile(profile),pinned=Object.freeze({root:pinNativeRuntimePath(own(paths,'root') as string),stateDb:pinNativeRuntimePath(own(paths,'stateDb') as string),mirrorDb:pinNativeRuntimePath(own(paths,'mirrorDb') as string)});
 requireLocalSessionMirrorPaths(captured,pinned);
 await requireLocalSessionMirrorDatabase(pinned,signal);
 await prepareMirrorBootstrapSchemas(pinned.mirrorDb,captured.schemaTimeoutMs,signal);
 signal?.throwIfAborted();
}
