import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker,getEnvironmentData,setEnvironmentData} from 'node:worker_threads';
import {PERSISTENT_RESIDENT_ROLE_KEY,persistentResidentEntryUrl,capturePersistentResidentDescriptor,capturePersistentResidentBootstrapData,persistentResidentFrame} from '../../src/runtime/persistent-resident-bootstrap.ts';
import {createPersistentResidentRegistration,constructPersistentResidentWorker} from '../../src/runtime/persistent-resident-store-role.ts';
import {preparePersistentResident} from '../../src/runtime/persistent-resident-supervisor.ts';
import {requiredStoreWorkerRole,storeWorkerClassification} from '../../src/runtime/store-worker-manifest.ts';
import {anyStoreAuthorityEnrolled} from '../../src/store/store-authority-domain.ts';
import {storeFixture} from '../helpers/store-fixture.ts';

const data={version:1,kind:'persistent-resident-bootstrap',runtimeId:'role-preparation'};
function descriptor(path:string):Record<string,unknown>{const live=new SharedArrayBuffer(4);Atomics.store(new Int32Array(live),0,1);return {version:1,role:'persistent-resident-v1',module:persistentResidentEntryUrl().href,path,live};}
function actualEntry(raw:unknown,input:unknown=data):Promise<{reports:unknown[];errors:Error[];code:number}>{
 const prior=getEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY);let worker:Worker;
 try{setEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY,raw as Parameters<typeof setEnvironmentData>[1]);worker=new Worker(persistentResidentEntryUrl(),{workerData:input});}finally{setEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY,prior);}
 return new Promise(resolve=>{const reports:unknown[]=[],errors:Error[]=[];
  worker.on('error',error=>errors.push(error));worker.on('message',message=>{reports.push(message);if(persistentResidentFrame(message,'role-ready'))worker.postMessage({version:1,kind:'close-unstarted'});});
  worker.once('exit',code=>resolve({reports,errors,code}));
 });
}

test('fixed production entry prepares without enrollment and retains registration until actual normal exit',{timeout:10000},async()=>storeFixture(async path=>{
 assert.equal(anyStoreAuthorityEnrolled(),false);const prior={sentinel:true};setEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY,prior);
 try{
  const owner=preparePersistentResident(path,'preparation');assert.equal(getEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY),prior);
  assert.deepEqual(owner.snapshot(),{state:'bootstrapping',submitted:true,exited:false,registrationLive:true,rootDebt:true,runtimeStarted:false});
  await owner.ready;assert.equal(anyStoreAuthorityEnrolled(),false);assert.equal(owner.snapshot().state,'role-ready');assert.equal(owner.snapshot().registrationLive,true);
  const closing=owner.closeUnstarted();assert.equal(owner.snapshot().registrationLive,true);assert.equal(owner.snapshot().rootDebt,true);
  await closing;await owner.join();assert.deepEqual(owner.snapshot(),{state:'joined',submitted:true,exited:true,registrationLive:false,rootDebt:false,runtimeStarted:false});assert.equal(anyStoreAuthorityEnrolled(),false);
 }finally{setEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY,undefined);}
}));

test('required production classification is independent of any descriptor and optional legacy inventory',()=>{
 assert.equal(requiredStoreWorkerRole(persistentResidentEntryUrl()),'persistent-resident-v1');assert.equal(storeWorkerClassification(persistentResidentEntryUrl()),undefined);assert.equal(requiredStoreWorkerRole(new URL('./foreign-worker.ts',persistentResidentEntryUrl())),undefined);
});

for(const mode of ['missing','wrong-role','wrong-module','relative-path','dead','wrong-size','extra','wrong-version'] as const)test(`actual fixed production entry rejects ${mode} descriptor before role-ready`,{timeout:10000},async()=>storeFixture(async path=>{
 const raw=descriptor(path);switch(mode){case 'wrong-role':raw.role='native';break;case 'wrong-module':raw.module=new URL('./foreign-worker.ts',persistentResidentEntryUrl()).href;break;case 'relative-path':raw.path='store.sqlite';break;case 'dead':Atomics.store(new Int32Array(raw.live as SharedArrayBuffer),0,0);break;case 'wrong-size':raw.live=new SharedArrayBuffer(8);break;case 'extra':raw.extra=true;break;case 'wrong-version':raw.version=2;break;}
 const result=await actualEntry(mode==='missing'?undefined:raw);assert.notEqual(result.code,0);assert.equal(result.errors.length,1);assert.deepEqual(result.reports,[]);assert.equal(anyStoreAuthorityEnrolled(),false);
}));

test('actual production bootstrap accepts only exact workerData',{timeout:10000},async()=>storeFixture(async path=>{
 const result=await actualEntry(descriptor(path),{...data,operation:'start'});assert.notEqual(result.code,0);assert.deepEqual(result.reports,[]);
 const valid=await actualEntry(descriptor(path));assert.equal(valid.code,0);assert.deepEqual(valid.errors,[]);assert.deepEqual(valid.reports,[{version:1,kind:'role-ready'},{version:1,kind:'unstarted-closed'}]);
}));

test('descriptor capture rejects nonpassive input without invoking getters',async()=>storeFixture(async path=>{
 let gets=0;const getter=Object.defineProperty(descriptor(path),'path',{enumerable:true,get(){gets++;return path;}});
 for(const value of [getter,new Proxy(descriptor(path),{}),Object.assign(Object.create({}),descriptor(path)),{...descriptor(path),[Symbol('extra')]:true},{...descriptor(path),path:path+'\0'},Object.defineProperty(descriptor(path),'hidden',{value:1})])assert.throws(()=>capturePersistentResidentDescriptor(value));
 assert.equal(gets,0);const raw=descriptor(path);const captured=capturePersistentResidentDescriptor(raw);Atomics.store(new Int32Array(raw.live as SharedArrayBuffer),0,0);assert.throws(()=>capturePersistentResidentDescriptor(captured));
 assert.throws(()=>capturePersistentResidentBootstrapData({...data,runtimeId:'\ud800'}));assert.throws(()=>capturePersistentResidentBootstrapData({...data,runtimeId:'x'.repeat(4097)}));
}));

test('synchronous invalid-input and environment clone failures release unsubmitted registration and restore environment',async()=>storeFixture(async path=>{
 const prior={sentinel:true},badKey='persistent-role-test:uncloneable',old=getEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY),oldBad=getEnvironmentData(badKey);setEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY,prior);
 try{
  const invalid=createPersistentResidentRegistration(path);assert.throws(()=>constructPersistentResidentWorker(invalid,''));assert.equal(getEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY),prior);assert.throws(()=>constructPersistentResidentWorker(invalid,'again'),/live private/);
  setEnvironmentData(badKey,()=>{});const clone=createPersistentResidentRegistration(path);assert.throws(()=>constructPersistentResidentWorker(clone,'valid'));assert.equal(getEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY),prior);assert.throws(()=>constructPersistentResidentWorker(clone,'again'),/live private/);
 }finally{setEnvironmentData(badKey,oldBad);setEnvironmentData(PERSISTENT_RESIDENT_ROLE_KEY,old);}
}));

test('submitted bootstrap timeout retains ownership through actual exit and quarantine debt afterward',{timeout:10000},async()=>storeFixture(async path=>{
 const owner=preparePersistentResident(path,'retention');await owner.ready;
 assert.equal(owner.snapshot().exited,false);assert.equal(owner.snapshot().registrationLive,true);
 // The fixed production entry's original 5000ms deadline expires; no terminate
 // call or synthetic exit is used as a cleanup certificate.
 await owner.join();assert.equal(owner.snapshot().state,'quarantined');assert.equal(owner.snapshot().exited,true);assert.equal(owner.snapshot().registrationLive,false);assert.equal(owner.snapshot().rootDebt,true);assert.equal(owner.snapshot().runtimeStarted,false);
 await assert.rejects(owner.closeUnstarted());
}));
