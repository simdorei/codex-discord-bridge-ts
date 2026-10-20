import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {prepareRootBoundPersistentResident} from '../../src/runtime/persistent-resident-root-preparation.ts';
import {PosixRuntimeInstance} from '../../src/runtime/runtime-instance.ts';
import {anyStoreAuthorityEnrolled} from '../../src/store/store-authority-domain.ts';
import {ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';

// Passive rejection only. No actual singleton, socket, Worker or DB is created.
// These tests cannot establish successful root binding or debt retention.
const root=join(process.cwd(),'unopened-root'),paths=Object.freeze({root,mirrorDb:join(root,'discord_mirror.sqlite')});
const emptyUsage=Object.freeze({Background:0,Control:0,Bridge:0,Observation:0,Discovery:0,Maintenance:0});
function clean():void{assert.equal(anyStoreAuthorityEnrolled(),false);assert.deepEqual(ownedWorkerUsage(),emptyUsage);}

test('root-bound preparation rejects structural, prototype-only and proxy singleton lookalikes without invoking caller methods',()=>{
 let calls=0;
 const fake={requireHeldRoot(){calls++;},retainStoreAuthority(){calls++;},release(){calls++;}};
 for(const owner of [fake,Object.create(PosixRuntimeInstance.prototype),new Proxy(fake,{get(){calls++;throw Error('active fake owner');}})]){
  assert.throws(()=>prepareRootBoundPersistentResident(owner as PosixRuntimeInstance,paths,'passive-root-probe'),TypeError);clean();
 }
 assert.equal(calls,0);
});

test('root-bound preparation captures passive own path fields and rejects mismatched or unpinned paths before enrollment',()=>{
 let calls=0;const owner=Object.create(PosixRuntimeInstance.prototype);
 const active=Object.defineProperty({...paths},'root',{enumerable:true,get(){calls++;throw Error('active root');}});
 const cases:readonly (readonly [unknown,string])[]=[
  [active,'Expected own gateway data field'],
  [new Proxy(paths,{get(){calls++;throw Error('proxy path');},getOwnPropertyDescriptor(){calls++;throw Error('proxy descriptor');}}),'Expected gateway data record'],
  [Object.create(paths),'Expected own gateway data field'],
  [{...paths,root:'relative'},'Expected exact pinned persistent store path'],
  [{...paths,mirrorDb:'relative'},'Expected exact pinned persistent store path'],
  [{...paths,mirrorDb:join(root,'another.sqlite')},'Store accounting requires the original singleton-root bridge path'],
  [{...paths,root:root+'\0'},'Invalid bounded persistent role text'],
  [{...paths,mirrorDb:paths.mirrorDb+'\ud800'},'Invalid bounded persistent role text'],
 ];
 for(const [input,message] of cases){
  assert.throws(()=>prepareRootBoundPersistentResident(owner,input as typeof paths,'passive-root-probe'),error=>error instanceof TypeError&&error.message===message);clean();
 }
 assert.equal(calls,0);
});

test('root-bound preparation validates bounded runtime identity before checking the original singleton',()=>{
 const owner=Object.create(PosixRuntimeInstance.prototype);
 for(const runtime of ['', 'bad\0runtime','\ud800','x'.repeat(4097)]){
  assert.throws(()=>prepareRootBoundPersistentResident(owner,paths,runtime),error=>error instanceof TypeError&&error.message==='Invalid bounded persistent role text');clean();
 }
});
