import {test} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';
import {beginIngressThreadStartExisting,recordIngressCreatedThreadExisting,recordIngressNewCreationExisting} from '../../src/store/ingress-lifecycle.ts';import {getIngressExisting} from '../../src/store/ingress-read.ts';import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
async function admit(path:string){await state.admitIngress(path,{ingressId:'i',kind:'action',eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:3n,payload:{command:'new',prompt:'raw'},targetThreadId:null,canonicalOwner:null,now:1});}
function edit<T>(path:string,fn:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}}
test('existing attempt entrypoints cannot create or repair missing or incomplete store',async()=>storeFixture(async path=>{
 for(const run of [()=>beginIngressThreadStartExisting(path,'i',1n,1),()=>recordIngressCreatedThreadExisting(path,'i',1n,'target',1),()=>recordIngressNewCreationExisting(path,'i',1n,null,1n,1),()=>getIngressExisting(path,'i')])assert.throws(run);
 assert.equal(existsSync(path),false);edit(path,db=>db.exec('CREATE TABLE sentinel(value)'));
 assert.throws(()=>beginIngressThreadStartExisting(path,'i',1n,1));assert.equal(edit(path,db=>db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='discord_ingress_journal'").get()?.n),0);
}));
test('creation boundary retains exact winner generation, original channel, one-time context and returned ID',async()=>storeFixture(async path=>{
 await admit(path);assert.equal(beginIngressThreadStartExisting(path,'i',7n,2),true);assert.equal(beginIngressThreadStartExisting(path,'i',7n,2),false);
 assert.throws(()=>recordIngressNewCreationExisting(path,'i',8n,null,1n,3),/matching unwritten/);recordIngressNewCreationExisting(path,'i',7n,null,1n,3);assert.throws(()=>recordIngressNewCreationExisting(path,'i',7n,null,1n,4),/matching unwritten/);
 assert.throws(()=>recordIngressCreatedThreadExisting(path,'i',8n,'created',4),/matching generation/);recordIngressCreatedThreadExisting(path,'i',7n,'created',4);assert.equal(getIngressExisting(path,'i')?.targetThreadId,'created');assert.deepEqual(getIngressExisting(path,'i'),await state.getIngress(path,'i'));
}));
test('creation writer failure rolls back original phase and incomplete creation evidence',async()=>storeFixture(async path=>{
 await admit(path);beginIngressThreadStartExisting(path,'i',7n,2);const before=getIngressExisting(path,'i');edit(path,db=>db.exec("CREATE TRIGGER reject_creation BEFORE UPDATE OF outcome_json ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'fixture'); END"));
 assert.throws(()=>recordIngressNewCreationExisting(path,'i',7n,null,1n,3),/fixture/);assert.deepEqual(getIngressExisting(path,'i'),before);
}));
test('existing full-record reader keeps JSON null and rejects malformed unused outcome',async()=>storeFixture(async path=>{
 await admit(path);assert.equal(getIngressExisting(path,'i')?.outcome,undefined);edit(path,db=>db.exec("UPDATE discord_ingress_journal SET outcome_json='null',created_at=1e999"));assert.equal(getIngressExisting(path,'i')?.outcome,null);assert.equal(getIngressExisting(path,'i')?.createdAt,Infinity);edit(path,db=>db.exec("UPDATE discord_ingress_journal SET outcome_json='{'"));assert.throws(()=>getIngressExisting(path,'i'));assert.equal(getIngressExisting(path,'missing'),null);
}));
test('pure argument errors occur before a missing store can be created',async()=>storeFixture(async path=>{
 assert.throws(()=>beginIngressThreadStartExisting(path,'i',0n,1),/invalid thread/);assert.throws(()=>recordIngressCreatedThreadExisting(path,'i',1n,' bad ',1));assert.throws(()=>recordIngressNewCreationExisting(path,'i',1n,'\u0085',1n,1),/invalid new creation/);assert.throws(()=>getIngressExisting(path,'\ud800'),TypeError);assert.equal(existsSync(path),false);
}));

test('catalog read snapshot ends before the original single created-thread UPDATE',async t=>storeFixture(async path=>{
 await admit(path);beginIngressThreadStartExisting(path,'i',7n,2);const states:boolean[]=[],prepare=DatabaseSync.prototype.prepare;
 t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,...args:Parameters<typeof prepare>){if(args[0].startsWith("UPDATE discord_ingress_journal SET phase='thread/created'"))states.push(this.isTransaction);return Reflect.apply(prepare,this,args);});
 recordIngressCreatedThreadExisting(path,'i',7n,'created',3);assert.deepEqual(states,[false]);assert.equal(getIngressExisting(path,'i')?.targetThreadId,'created');
}));
