import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createNativePromptIntakeState,NativePromptIntakeUnavailableError} from '../../../src/runtime/prompt-intake/native-state.ts';import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
function edit(path:string,sql:string){const db=new DatabaseSync(path);try{db.exec(sql);}finally{db.close();}}
async function seed(path:string,id:string,target:string|null,now:number){await state.admitIngress(path,{ingressId:id,kind:'message',eventId:BigInt(now+100),applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:BigInt(now+100),payload:{version:1n},targetThreadId:target,canonicalOwner:null,now});}
test('native archive journal shares exact target/null/own exclusion and state predicate',async()=>storeFixture(async path=>{
 await seed(path,'own','target',1);await seed(path,'unbound',null,2);await seed(path,'foreign','other',3);const native=createNativePromptIntakeState(path);
 const pair=async(target:string,own:string|null,expected:string|null)=>{assert.equal(await native.unfinishedArchiveRequest(path,target,own),expected);assert.equal(state.unfinishedArchiveRequestExisting(path,target,own),expected);assert.equal(await state.unfinishedArchiveRequest(path,target,own),expected);};
 await pair('target',null,'own');await pair('target','own','unbound');await pair('missing',null,'unbound');edit(path,"UPDATE discord_ingress_journal SET state='completed' WHERE ingress_id='unbound'");await pair('target','own',null);
 edit(path,"UPDATE discord_ingress_journal SET state='owned',owner_id='j',owner_kind='queue',confirmation_delivered=0 WHERE ingress_id='own'");await pair('target',null,'own');edit(path,"UPDATE discord_ingress_journal SET confirmation_delivered=1 WHERE ingress_id='own'");await pair('target',null,null);await pair('other',null,'foreign');assert.equal(ownedWorkerUsage().Control,0);
}));
test('native archive journal orders by timestamp then identity and accepts empty/Unicode exact fields',async()=>storeFixture(async path=>{
 await seed(path,'z','',1);await seed(path,'a','',2);await seed(path,'한글😀','한국😀',3);edit(path,"UPDATE discord_ingress_journal SET created_at=1 WHERE ingress_id='a'");const native=createNativePromptIntakeState(path);
 assert.equal(await native.unfinishedArchiveRequest(path,'',null),'a');assert.equal(await native.unfinishedArchiveRequest(path,'','a'),'z');assert.equal(await native.unfinishedArchiveRequest(path,'한국😀',''),'한글😀');assert.equal(await native.unfinishedArchiveRequest(path,'한국😀','한글😀'),null);
}));
test('native archive journal does not decode unrelated payload or invent missing store',async()=>storeFixture(async path=>{
 const native=createNativePromptIntakeState(path);await assert.rejects(native.unfinishedArchiveRequest(path,'target',null),NativePromptIntakeUnavailableError);assert.equal(existsSync(path),false);
 await seed(path,'good','target',1);await seed(path,'foreign','other',2);edit(path,"UPDATE discord_ingress_journal SET payload_json='{' WHERE ingress_id='foreign'");assert.equal(await native.unfinishedArchiveRequest(path,'target',null),'good');
}));
test('native archive journal rejects invalid scalar input without coercion or worker admission',async()=>storeFixture(async path=>{
 const native=createNativePromptIntakeState(path);let hooks=0;const bad={toString(){hooks++;return 'target';}};
 for(const v of [bad,new Proxy({}, {get(){hooks++;throw Error('trap');}}),'\ud800'])await assert.rejects(native.unfinishedArchiveRequest(path,v as string,null),TypeError);
 await assert.rejects(native.unfinishedArchiveRequest('other','target',null),TypeError);await assert.rejects(native.unfinishedArchiveRequest(path,'target','\ud800'),TypeError);assert.equal(hooks,0);assert.equal(existsSync(path),false);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native archive journal verifies operation target own request and complete text/null reply',async t=>{
 let raw:unknown;t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>raw);const native=createNativePromptIntakeState('db'),good={ok:true,operation:'ArchiveUnfinished',value:{target:'target',ownRequest:'own',request:null}};
 for(raw of [{ok:false},{...good,operation:'Get'},{...good,value:{...good.value,target:'other'}},{...good,value:{...good.value,ownRequest:null}},{...good,value:{...good.value,request:1}},{...good,value:{...good.value,request:'\ud800'}}])await assert.rejects(native.unfinishedArchiveRequest('db','target','own'),NativePromptIntakeUnavailableError);
 raw=good;assert.equal(await native.unfinishedArchiveRequest('db','target','own'),null);raw={...good,value:{...good.value,request:''}};assert.equal(await native.unfinishedArchiveRequest('db','target','own'),'');
});
test('native archive journal timeout retains Control capacity until actual read exit and never returns late null',async()=>storeFixture(async path=>{
 const setup=await openInitialized(path);setup.close();const db=new DatabaseSync(path);db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const native=createNativePromptIntakeState(path,30),pending=native.unfinishedArchiveRequest(path,'target',null),rejected=assert.rejects(pending,NativePromptIntakeUnavailableError);let finished=false;void pending.then(()=>finished=true,()=>finished=true);
 try{await new Promise(r=>setTimeout(r,200));assert.equal(finished,false);assert.equal(ownedWorkerUsage().Control,1);await assert.rejects(native.unfinishedArchiveRequest(path,'target',null),OwnedWorkerBudgetError);db.exec('ROLLBACK');await rejected;assert.equal(ownedWorkerUsage().Control,0);assert.equal(await state.unfinishedArchiveRequest(path,'target',null),null);}finally{if(db.isTransaction)db.exec('ROLLBACK');await pending.catch(()=>{});db.close();}
}));
test('native archive journal missing schema and malformed selected identity fail without repairing',async()=>{
 for(const value of ['NULL',"x'ff'","CAST(x'ff' AS TEXT)"])await storeFixture(async path=>{const db=new DatabaseSync(path);try{db.exec('CREATE TABLE discord_ingress_journal(ingress_id,target_thread_id,state,confirmation_delivered,created_at)');db.exec(`INSERT INTO discord_ingress_journal VALUES(${value},'target','staged',0,1)`);}finally{db.close();}const native=createNativePromptIntakeState(path);await assert.rejects(native.unfinishedArchiveRequest(path,'target',null),NativePromptIntakeUnavailableError);assert.equal(await native.unfinishedArchiveRequest(path,'other',null),null);});
 await storeFixture(async path=>{const db=new DatabaseSync(path);db.close();await assert.rejects(createNativePromptIntakeState(path).unfinishedArchiveRequest(path,'target',null),NativePromptIntakeUnavailableError);const read=new DatabaseSync(path);try{assert.equal(read.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get()?.n,0);}finally{read.close();}});
});
