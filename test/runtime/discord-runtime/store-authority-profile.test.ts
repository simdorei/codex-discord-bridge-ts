import test from 'node:test';import assert from 'node:assert/strict';import {dirname,join} from 'node:path';import {existsSync} from 'node:fs';
import {loadRuntimeConfig} from '../../../src/config/runtime.ts';
import {PosixRuntimeInstance,RUNTIME_LOCK_NAME} from '../../../src/runtime/runtime-instance.ts';
import {StoreAuthorityDomain} from '../../../src/store/store-authority-domain.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {openExisting} from '../../../src/store/existing-store.ts';
import {captureLocalStoreAuthorityProfile,enrollLocalStoreAuthority} from '../../../src/runtime/discord-runtime/store-authority-profile.ts';
import {runLocalRuntimeApplication,LocalRuntimeOwnershipRetainedError} from '../../../src/runtime/discord-runtime/local-application.ts';
import {RuntimeStoragePreparationError} from '../../../src/runtime/discord-runtime/storage-preparation.ts';import {OwnedWorkerSlot} from '../../../src/runtime/owned-worker-slot.ts';
import {RuntimeStopSignal} from '../../../src/runtime/discord-runtime/stop-signal.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
const profile={kind:'StoreAuthorityAccountingOnly'} as const;
const config=()=>({...loadRuntimeConfig(new Map([['DISCORD_BOT_TOKEN','offline-fixture'],['DISCORD_ALLOW_ALL_CHANNELS','1']])),sessionMirror:false});
function fixturePaths(path:string){const root=dirname(path);return {root,mirrorDb:join(root,'discord_mirror.sqlite'),stateDb:join(root,'missing-state.sqlite')};}
function environment(paths:ReturnType<typeof fixturePaths>){return {HOME:paths.root,CODEX_HOME:paths.root,CODEX_STATE_DB:paths.stateDb,CODEX_EXE:process.execPath};}

test('accounting opt-in rejects active input and fake/released/wrong-root singletons',async()=>storeFixture(async path=>{
 let reads=0;assert.throws(()=>captureLocalStoreAuthorityProfile(Object.defineProperty({},'kind',{get(){reads++;return profile.kind;}}) as never));assert.equal(reads,0);assert.throws(()=>captureLocalStoreAuthorityProfile({...profile,certified:true} as never));
 const paths=fixturePaths(path);assert.throws(()=>enrollLocalStoreAuthority(Object.create(PosixRuntimeInstance.prototype),paths,profile));
 const instance=await PosixRuntimeInstance.acquire(paths.root);let domain:StoreAuthorityDomain|undefined;
 try{assert.throws(()=>enrollLocalStoreAuthority(instance,{...paths,root:paths.root+'.other',mirrorDb:join(paths.root+'.other','discord_mirror.sqlite')},profile));domain=enrollLocalStoreAuthority(instance,paths,profile);assert.equal(domain.snapshot().certified,false);assert.throws(()=>instance.release(),/must close/);domain.closeAfterOwnersJoined();await instance.release();assert.throws(()=>enrollLocalStoreAuthority(instance,paths,profile),/currently held/);}finally{domain?.closeAfterOwnersJoined();await instance.release();}
}));

test('actual local root enrolls only after held singleton and before storage; joined startup failure releases all ownership',async t=>storeFixture(async path=>{
 const paths=fixturePaths(path),original=StoreAuthorityDomain.enroll,run=OwnedWorkerSlot.prototype.run;let domain:StoreAuthorityDomain|undefined,sawStorage=false;
 t.mock.method(StoreAuthorityDomain,'enroll',function(p:string){assert.equal(existsSync(join(paths.root,RUNTIME_LOCK_NAME)),true);assert.equal(p,paths.mirrorDb);domain=original.call(StoreAuthorityDomain,p);return domain;});
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<OwnedWorkerSlot['run']>){if(args[0].pathname.includes('storage-preparation-worker')){sawStorage=true;assert.ok(domain);assert.equal(domain.snapshot().closed,false);}return run.apply(this,args);});
 try{await assert.rejects(runLocalRuntimeApplication(config(),environment(paths),paths.root,'fixture',undefined,profile),RuntimeStoragePreparationError);assert.equal(sawStorage,true);assert.equal(domain!.snapshot().writers,0);assert.equal(domain!.snapshot().closed,true);assert.equal(existsSync(join(paths.root,RUNTIME_LOCK_NAME)),false);const next=await PosixRuntimeInstance.acquire(paths.root);await next.release();}finally{t.mock.restoreAll();}
}));

test('actual local root retains sealed domain and singleton when startup cleanup cannot join a main handle',async t=>storeFixture(async path=>{
 const paths=fixturePaths(path);(await openInitialized(paths.mirrorDb)).close();const run=OwnedWorkerSlot.prototype.run;let leaked:ReturnType<typeof openExisting>|undefined,retained:LocalRuntimeOwnershipRetainedError|undefined;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<OwnedWorkerSlot['run']>){if(args[0].pathname.includes('storage-preparation-worker'))leaked=openExisting(paths.mirrorDb);return run.apply(this,args);});
 try{
  await assert.rejects(runLocalRuntimeApplication(config(),environment(paths),paths.root,'fixture',undefined,profile),error=>{assert.ok(error instanceof LocalRuntimeOwnershipRetainedError);retained=error;return true;});
  const owners=retained!.owners as {authority:StoreAuthorityDomain;instance:PosixRuntimeInstance;stop:RuntimeStopSignal};assert.equal(owners.authority.snapshot().writers,1);assert.equal(owners.authority.snapshot().sealed,true);assert.equal(owners.authority.snapshot().closed,false);assert.equal(existsSync(join(paths.root,RUNTIME_LOCK_NAME)),true);assert.throws(()=>owners.instance.release(),/must close/);await assert.rejects(PosixRuntimeInstance.acquire(paths.root));
 }finally{t.mock.restoreAll();leaked?.close();if(retained!==undefined){const owners=retained.owners as {authority:StoreAuthorityDomain;instance:PosixRuntimeInstance;stop:RuntimeStopSignal};owners.authority.closeAfterOwnersJoined();await owners.instance.release();owners.stop.dispose();}}
}));

test('default local root remains unenrolled and explicit path mismatch fails before singleton acquisition',async t=>storeFixture(async path=>{
 const paths=fixturePaths(path),original=StoreAuthorityDomain.enroll;let calls=0;t.mock.method(StoreAuthorityDomain,'enroll',function(p:string){calls++;return original.call(StoreAuthorityDomain,p);});
 try{await assert.rejects(runLocalRuntimeApplication(config(),environment(paths),paths.root,'fixture'),RuntimeStoragePreparationError);assert.equal(calls,0);await assert.rejects(runLocalRuntimeApplication(config(),{...environment(paths),CODEX_DISCORD_MIRROR_DB:path},paths.root,'fixture',undefined,profile),/singleton-root/);assert.equal(calls,0);assert.equal(existsSync(join(paths.root,RUNTIME_LOCK_NAME)),false);}finally{t.mock.restoreAll();}
}));
