import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';
import {admitIngressExisting} from '../../src/store/ingress-admission.ts';import {ingressByOriginExisting} from '../../src/store/ingress-read.ts';import {holdIngressExisting} from '../../src/store/ingress-recovery.ts';
const request=()=>({ingressId:'original',kind:'action' as const,eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{command:'new',prompt:'raw'},targetThreadId:null,canonicalOwner:null,now:1});
function edit<T>(path:string,fn:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return fn(db);}finally{db.close();}}
async function init(path:string){const db=await openInitialized(path);db.close();}
test('existing journal wrappers never create or repair a missing/incomplete store',async()=>storeFixture(async path=>{
 for(const call of [()=>admitIngressExisting(path,request()),()=>ingressByOriginExisting(path,3n),()=>holdIngressExisting(path,'original','saved',true,2)]){assert.throws(call);assert.equal(existsSync(path),false);}
 edit(path,db=>db.exec('CREATE TABLE sentinel(value TEXT)'));
 for(const call of [()=>admitIngressExisting(path,request()),()=>ingressByOriginExisting(path,3n),()=>holdIngressExisting(path,'original','saved',true,2)])assert.throws(call);
 assert.deepEqual(edit(path,db=>db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all()).map(v=>v.name),['sentinel']);
}));
test('existing origin lookup uses complete record and rejects ambiguous origins',async()=>storeFixture(async path=>{
 await init(path);const a=admitIngressExisting(path,request());assert.equal(a.created,true);assert.deepEqual(ingressByOriginExisting(path,3n),a.record);assert.equal(ingressByOriginExisting(path,-(1n<<63n)),null);assert.throws(()=>ingressByOriginExisting(path,1n<<63n),TypeError);
 edit(path,db=>db.exec("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,created_at,updated_at) VALUES('other','message',3,1,2,'{}','staged','staged',1,1)"));assert.throws(()=>ingressByOriginExisting(path,3n),/ambiguous ingress origin/);assert.throws(()=>admitIngressExisting(path,request()),/ambiguous ingress origin/);
}));
test('existing admission rolls back journal and processed receipt when original proof insertion fails',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>db.exec("CREATE TRIGGER fail_order BEFORE INSERT ON cdr_recovery_ingress_order BEGIN SELECT RAISE(ABORT,'order failure');END"));assert.throws(()=>admitIngressExisting(path,{...request(),kind:'message'}),/order failure/);
 assert.equal(edit(path,db=>db.prepare('SELECT count(*) AS n FROM discord_ingress_journal').get()?.n),0);assert.equal(edit(path,db=>db.prepare('SELECT count(*) AS n FROM discord_processed_messages').get()?.n),0);
}));
test('existing hold rolls back original state if the one notice cannot be staged',async()=>storeFixture(async path=>{
 await init(path);const original=admitIngressExisting(path,request()).record;edit(path,db=>db.exec("CREATE TRIGGER fail_notice BEFORE INSERT ON codex_delivery_outbox BEGIN SELECT RAISE(ABORT,'notice failure');END"));assert.throws(()=>holdIngressExisting(path,'original','reason',false,2),/notice failure/);assert.deepEqual(ingressByOriginExisting(path,3n),original);
 edit(path,db=>db.exec('DROP TRIGGER fail_notice'));holdIngressExisting(path,'original','reason',false,2);holdIngressExisting(path,'original','later',false,3);assert.equal(edit(path,db=>db.prepare('SELECT count(*) AS n FROM codex_delivery_outbox').get()?.n),1);
}));
test('existing journal input validation is passive and precedes opening a missing database',async()=>storeFixture(async path=>{
 let calls=0;const bad=Object.defineProperty(request(),'payload',{get(){calls++;return {};}});assert.throws(()=>admitIngressExisting(path,bad),TypeError);assert.throws(()=>holdIngressExisting(path,'original','bad\ud800',true,1),TypeError);assert.throws(()=>ingressByOriginExisting(path,{} as bigint),TypeError);assert.equal(calls,0);assert.equal(existsSync(path),false);
}));
