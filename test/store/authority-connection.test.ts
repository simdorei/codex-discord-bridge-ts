import {mkdirSync} from 'node:fs';import {dirname,join} from 'node:path';
import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {openInitialized,initialize} from '../../src/store/owned-driver.ts';import {openExisting} from '../../src/store/existing-store.ts';import {StoreAuthorityDomain} from '../../src/store/store-authority-domain.ts';
import {storeFixture} from '../helpers/store-fixture.ts';

test('registration spans initialize await, original native handle lifetime and Symbol.dispose',async()=>storeFixture(async path=>{
 const domain=StoreAuthorityDomain.enroll(path),owner={},r=domain.reserveInert(owner)!;
 try{
  const pending=openInitialized(path);assert.equal(domain.snapshot().writers,1);assert.throws(()=>domain.assertInertCurrent(r,owner));assert.throws(()=>domain.closeAfterOwnersJoined(),/not joined/);
  const db=await pending;assert.ok(db instanceof DatabaseSync);assert.equal(domain.snapshot().writers,1);assert.ok(DatabaseSync.prototype.prepare.call(db,'SELECT 1').get());
  db[Symbol.dispose]();assert.equal(db.isOpen,false);assert.equal(domain.snapshot().writers,0);db[Symbol.dispose]();assert.equal(domain.snapshot().writers,0);
 }finally{domain.closeAfterOwnersJoined();}
}));
test('connection close failure retains ownership until actual close, including exception after successful close',async t=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path),db=openExisting(path),original=DatabaseSync.prototype.close,sentinel=new Error('fixture close failed');
 try{
  DatabaseSync.prototype.close=function(this:DatabaseSync){throw sentinel;};assert.throws(()=>db.close(),e=>e===sentinel);assert.equal(db.isOpen,true);assert.equal(domain.snapshot().writers,1);assert.throws(()=>domain.closeAfterOwnersJoined(),/not joined/);
  DatabaseSync.prototype.close=function(this:DatabaseSync){original.call(this);throw sentinel;};assert.throws(()=>db.close(),e=>e===sentinel);assert.equal(db.isOpen,false);assert.equal(domain.snapshot().writers,0);
 }finally{DatabaseSync.prototype.close=original;if(db.isOpen)db.close();domain.closeAfterOwnersJoined();}
}));
test('reopen registers before native open and cannot escape a closed original domain',async()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const domain=StoreAuthorityDomain.enroll(path),db=openExisting(path);db.close();const owner={},r=domain.reserveInert(owner)!;
 db.open();assert.equal(db.isOpen,true);assert.equal(domain.snapshot().writers,1);assert.throws(()=>domain.assertInertCurrent(r,owner));assert.throws(()=>db.open());assert.equal(domain.snapshot().writers,1);
 assert.throws(()=>Object.defineProperty(db,'close',{value:()=>{}}));db.close();domain.closeAfterOwnersJoined();assert.throws(()=>db.open(),/closed/);assert.equal(db.isOpen,false);
}));
test('enrolled borrowed initialize rejects forged and cross-store handles before catalog or backup work',async()=>storeFixture(async path=>{
 (await openInitialized(path)).close();const foreign=await openInitialized(path+'.other'),raw=new DatabaseSync(path),domain=StoreAuthorityDomain.enroll(path),db=openExisting(path);
 try{
  assert.throws(()=>Reflect.construct(db.constructor,[{},path,path+'.other',{}]),/private authority connection/);await assert.rejects(initialize(Object.create(Object.getPrototypeOf(db)),path),/branded/);
  await assert.rejects(initialize(raw,path),/branded/);await assert.rejects(initialize(foreign,path),/branded/);await assert.rejects(initialize(db,path+'.other'),/branded/);
  assert.equal(await initialize(db,path),null);assert.equal(domain.snapshot().writers,1);
 }finally{db.close();raw.close();foreign.close();domain.closeAfterOwnersJoined();}
}));
test('open and initialization failures release only confirmed closed handles; preexisting handles block enrollment',async()=>storeFixture(async path=>{
 const existing=await openInitialized(path);assert.throws(()=>StoreAuthorityDomain.enroll(path),/existing/);existing.close();
 const domain=StoreAuthorityDomain.enroll(path+'.missing');try{assert.throws(()=>openExisting(path+'.missing'));assert.equal(domain.snapshot().writers,0);}finally{domain.closeAfterOwnersJoined();}
 const raw=new DatabaseSync(path);raw.exec('PRAGMA user_version=999');raw.close();const bad=StoreAuthorityDomain.enroll(path);try{await assert.rejects(openInitialized(path));assert.equal(bad.snapshot().writers,0);}finally{bad.closeAfterOwnersJoined();}
}));

test('relative initialized handle cannot reopen against a changed cwd under the old ticket',async()=>storeFixture(async path=>{
 const cwd=process.cwd(),root=dirname(path),a=join(root,'a'),b=join(root,'b');mkdirSync(a);mkdirSync(b);let db:DatabaseSync|undefined,domain:StoreAuthorityDomain|undefined;
 try{process.chdir(a);db=await openInitialized('same.sqlite');db.close();const raw=new DatabaseSync(join(b,'same.sqlite'));raw.close();domain=StoreAuthorityDomain.enroll(join(b,'same.sqlite'));process.chdir(b);assert.throws(()=>db!.open(),/original store path binding/);assert.equal(db.isOpen,false);assert.equal(domain.snapshot().writers,0);}finally{process.chdir(cwd);if(db?.isOpen)db.close();domain?.closeAfterOwnersJoined();}
}));

test('initialization failure plus failed close retains the exact unreturned native handle until reconciliation',async()=>storeFixture(async path=>{
 const raw=new DatabaseSync(path);raw.exec('PRAGMA user_version=999');raw.close();const domain=StoreAuthorityDomain.enroll(path),close=DatabaseSync.prototype.close;let held:DatabaseSync|undefined;
 DatabaseSync.prototype.close=function(this:DatabaseSync){held=this;throw new Error('fixture cleanup failure');};
 try{await assert.rejects(openInitialized(path));assert.ok(held?.isOpen);assert.equal(domain.snapshot().writers,1);assert.throws(()=>domain.closeAfterOwnersJoined(),/not joined/);}finally{DatabaseSync.prototype.close=close;held?.close();domain.closeAfterOwnersJoined();}
}));
