import {PosixRuntimeInstance} from '../../src/runtime/runtime-instance.ts';
import {enrollLocalStoreAuthority,requireLocalStoreAuthorityPaths} from '../../src/runtime/discord-runtime/store-authority-profile.ts';
import test from 'node:test';import assert from 'node:assert/strict';
import {StoreAuthorityDomain,requireStoreAuthorityPath,registerStoreWriter,releaseStoreWriter,markStoreWorkerSubmitted,type StoreWriterTicket,type InertStoreReservation} from '../../src/store/store-authority-domain.ts';
import {storeFixture} from '../helpers/store-fixture.ts';

test('private domains and inert reservations cannot be forged, crossed or refreshed after a writer rolls back',async()=>storeFixture(async path=>{
 const a=StoreAuthorityDomain.enroll(path),b=StoreAuthorityDomain.enroll(path+'.other'),owner={},reservation=a.reserveInert(owner)!;
 try{
  assert.equal(a.snapshot().certified,false);assert.equal(a.reserveInert({}),null);
  for(const fake of [{},Object.create(StoreAuthorityDomain.prototype)])assert.throws(()=>StoreAuthorityDomain.prototype.snapshot.call(fake));
  assert.throws(()=>new (StoreAuthorityDomain as any)({},{}));assert.throws(()=>a.assertInertCurrent({} as InertStoreReservation,owner));
  assert.throws(()=>a.assertInertCurrent(reservation,{}));assert.throws(()=>b.assertInertCurrent(reservation,owner));assert.throws(()=>b.releaseInert(reservation));
  const other=registerStoreWriter(path+'.other','Connection');a.assertInertCurrent(reservation,owner);releaseStoreWriter(other,'ConnectionClosed');
  const first=registerStoreWriter(path,'Connection'),second=registerStoreWriter(path,'Connection');assert.equal(a.snapshot().writers,2);
  assert.throws(()=>a.assertInertCurrent(reservation,owner));releaseStoreWriter(first,'ConnectionClosed');releaseStoreWriter(second,'ConnectionClosed');
  assert.equal(a.snapshot().writers,0);assert.throws(()=>a.assertInertCurrent(reservation,owner));a.releaseInert(reservation);assert.throws(()=>a.releaseInert(reservation));
  const fresh=a.reserveInert(owner)!;a.assertInertCurrent(fresh,owner);a.releaseInert(fresh);
 }finally{a.closeAfterOwnersJoined();b.closeAfterOwnersJoined();}
}));
test('private worker tickets require exact submission/exit lifetime; sealed completion writes remain accounted',async()=>storeFixture(async path=>{
 const domain=StoreAuthorityDomain.enroll(path),owner={},reservation=domain.reserveInert(owner)!;
 assert.throws(()=>releaseStoreWriter({} as StoreWriterTicket,'Unsubmitted'));
 const ticket=registerStoreWriter(path,'Worker');assert.throws(()=>releaseStoreWriter(ticket,'WorkerExited'));markStoreWorkerSubmitted(ticket);assert.throws(()=>markStoreWorkerSubmitted(ticket));
 assert.throws(()=>releaseStoreWriter(ticket,'Unsubmitted'));assert.throws(()=>releaseStoreWriter(ticket,'ConnectionClosed'));
 domain.seal();assert.equal(domain.reserveInert(owner),null);assert.throws(()=>domain.assertInertCurrent(reservation,owner));assert.throws(()=>domain.closeAfterOwnersJoined(),/not joined/);
 const completion=registerStoreWriter(path,'Connection');releaseStoreWriter(completion,'ConnectionClosed');releaseStoreWriter(ticket,'WorkerExited');assert.throws(()=>releaseStoreWriter(ticket,'WorkerExited'));
 domain.closeAfterOwnersJoined();assert.equal(domain.snapshot().closed,true);assert.equal(domain.snapshot().certified,false);
}));

test('profile path capture is passive and TypeScript-private singleton construction cannot forge held ownership',async()=>storeFixture(async path=>{
 const fake=Object.create(PosixRuntimeInstance.prototype);let getters=0;
 const paths=Object.defineProperties({}, {root:{enumerable:true,get(){getters++;return '/wrong';}},mirrorDb:{enumerable:true,get(){getters++;return path;}}}) as {root:string;mirrorDb:string};
 assert.throws(()=>requireLocalStoreAuthorityPaths(paths),TypeError);assert.throws(()=>enrollLocalStoreAuthority(fake,paths,{kind:'StoreAuthorityAccountingOnly'}),TypeError);assert.equal(getters,0);
 assert.throws(()=>new (PosixRuntimeInstance as any)({}, {listening:true},'marker','text','/root'),/acquired runtime singleton/);
 const domain=StoreAuthorityDomain.enroll(path);try{requireStoreAuthorityPath(domain,path);assert.throws(()=>requireStoreAuthorityPath(domain,path+'.foreign'),/another path/);}finally{domain.closeAfterOwnersJoined();}assert.throws(()=>requireStoreAuthorityPath(domain,path),/closed/);
}));
