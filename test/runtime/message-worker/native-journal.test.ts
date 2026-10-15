import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {pinNativeRuntimePath} from '../../../src/runtime/runtime-paths/path-text.ts';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {createNativeMessageJournal,captureMessageJournal,admitOriginalMessageJournal,NativeMessageJournalUnavailableError,OriginalMessageJournal} from '../../../src/runtime/message-worker/journal.ts';
import {MessageCustody} from '../../../src/runtime/message-worker/custody.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage,OWNED_COMPLETION_QUEUE_LIMIT} from '../../../src/runtime/owned-worker-slot.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
const id=9007199254740993n,key=`message:${id}`;
const input=(event=id)=>({ingressId:`message:${event}`,kind:'message' as const,eventId:event,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:event,payload:{version:1n,content:'hello',plan:{Execute:{Ask:{prompt:'hello'}}},processing_mode:'normal'},targetThreadId:null,canonicalOwner:null,now:1});
async function init(path:string){(await openInitialized(path)).close();}
function poison(t:TestContext){for(const name of ['admitIngress','recordIngressProcessingMode','beginIngressExecution','recordIngressResult','confirmIngress','holdIngress'] as const)t.mock.method(state,name,()=>assert.fail(`compatibility ${name}`));}
async function custody(path:string){const port=createNativeMessageJournal(path),{owner,admission}=await admitOriginalMessageJournal(path,input(),port);assert.equal(admission.created,true);assert.ok(owner);return new MessageCustody(path,key,{messageJournal:port,now:()=>5,report:()=>assert.fail('hold failed')},owner);}
function edit(path:string,sql:string){const db=new DatabaseSync(path);try{db.exec(sql);}finally{db.close();}}
test('native journal retains exact large identity, frozen inputs, mode/result/confirm and processed-only dedup',async t=>storeFixture(async path=>{
 await init(path);poison(t);const port=createNativeMessageJournal(path),q=input(),pending=admitOriginalMessageJournal(path,q,port);q.payload.content='changed';q.ownerUserId=7n;const {owner,admission}=await pending;assert.ok(owner);assert.equal(admission.record?.ownerUserId,2n);assert.equal((admission.record?.payload as any).content,'hello');
 await owner.mode('pending_reply_only');assert.equal(await owner.begin('target',2),true);const outcome={response:'accepted',nested:{large:id}},result=owner.result(outcome,3);outcome.response='changed';outcome.nested.large=1n;await result;await owner.confirm(4);
 const row=(await state.getIngress(path,key))!;assert.equal(row.eventId,id);assert.equal(row.sourceMessageId,id);assert.equal(row.confirmationDelivered,true);assert.deepEqual(row.outcome,{response:'accepted',nested:{large:id}});assert.equal((row.payload as any).processing_mode,'pending_reply_only');
 assert.equal((await admitOriginalMessageJournal(path,input(),port)).owner,null);edit(path,`INSERT INTO discord_processed_messages(message_id,seen_at) VALUES (${id+1n},1)`);assert.equal((await port.admitIngress(path,input(id+1n))).record,null);assert.equal(ownedWorkerUsage().Control,0);
}));
test('capture rejects passive violations and fixes methods/path before an await',async()=>{
 let hooks=0;const original={...state,beginIngressExecution:async()=>true},port=captureMessageJournal('db',original),seen:string[]=[];
 original.beginIngressExecution=async()=>{hooks++;return false;};assert.throws(()=>port.beginIngressExecution('foreign','message:1','processing',null,1),/another database/);assert.equal(await port.beginIngressExecution('db','message:1','processing',null,1),true);assert.equal(hooks,0);
 for(const bad of [new Proxy(original,{}),Object.defineProperty({...state},'holdIngress',{get(){seen.push('getter');return state.holdIngress;}})])assert.throws(()=>captureMessageJournal('db',bad),TypeError);assert.deepEqual(seen,[]);
 assert.throws(()=>new OriginalMessageJournal(Symbol(),'db','message:1',port),TypeError);
});
test('missing native stores are never initialized or repaired',()=>storeFixture(async path=>{
 const port=createNativeMessageJournal(path);await assert.rejects(port.admitIngress(path,input()),NativeMessageJournalUnavailableError);assert.equal(existsSync(path),false);
}));
test('fresh work refuses saturation while only original result/confirm/hold custody may wait',async()=>storeFixture(async path=>{
 await init(path);const c=await custody(path);await c.begin(null);const blocker=new OwnedWorkerSlot('Control'),sleep=new URL('data:text/javascript,'+encodeURIComponent("import {parentPort} from 'node:worker_threads';setTimeout(()=>parentPort.postMessage(true),200);")),busy=blocker.run(sleep,{},1000);
 const port=createNativeMessageJournal(path);await assert.rejects(port.beginIngressExecution(path,key,'processing',null,2),OwnedWorkerBudgetError);await assert.rejects(port.recordIngressResult(path,key,{bad:true},2),OwnedWorkerBudgetError);
 const accepted=c.record({response:'saved'},3);let settled=false;void accepted.then(()=>settled=true);await new Promise(r=>setTimeout(r,30));assert.equal(settled,false);await busy;await blocker.join();await accepted;await c.finish();await c.dispose();assert.equal((await state.getIngress(path,key))!.confirmationDelivered,true);
}));
test('custody snapshots result before its deferred turn and captured source-port mutation',()=>storeFixture(async path=>{
 await init(path);const native=createNativeMessageJournal(path),source={...native},captured=captureMessageJournal(path,source),{owner}=await admitOriginalMessageJournal(path,input(),captured);assert.ok(owner);const c=new MessageCustody(path,key,{messageJournal:captured,now:()=>4,report:()=>{}},owner);await c.begin(null);
 const payload={response:'original'},pending=c.record(payload,3);payload.response='changed';source.recordIngressResult=async()=>assert.fail('replaced function');await pending;await c.finish();await c.dispose();assert.deepEqual((await state.getIngress(path,key))!.outcome,{response:'original'});
}));
for(const operation of ['Result','Confirm'] as const)test(`unconfirmed ${operation} ACK joins exit and never grants automatic replay`,async()=>storeFixture(async path=>{
 await init(path);const c=await custody(path);await c.begin(null);if(operation==='Confirm')await c.record({response:'accepted'},3);
 const trace=new SharedArrayBuffer(8),extension=import.meta.url.endsWith('.js')?'.js':'.ts',restore=instrumentStoreWorker({match:'native-journal-worker'+extension,trace,ack:'drop'});
 const pending=operation==='Result'?c.record({response:'accepted'},3):c.finish(),rejected=assert.rejects(pending,NativeMessageJournalUnavailableError);
 try{await waitTrace(trace);assert.equal(ownedWorkerUsage().Control,1);releaseTrace(trace);await rejected;}finally{restore();releaseTrace(trace);await pending.catch(()=>{});}
 await c.dispose();const row=(await state.getIngress(path,key))!;assert.equal(row.state,'held');assert.deepEqual(row.outcome,{response:'accepted'});assert.equal((await createNativeMessageJournal(path).admitIngress(path,input())).created,false);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native deadline joins blocked actual result write before disposal hold',()=>storeFixture(async path=>{
 await init(path);const port=createNativeMessageJournal(path,500),{owner}=await admitOriginalMessageJournal(path,input(),port);assert.ok(owner);await owner.begin(null,2);const db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');
 const pending=owner.result({response:'late'},3),rejected=assert.rejects(pending,NativeMessageJournalUnavailableError);let settled=false;void pending.then(()=>settled=true,()=>settled=true);
 try{await new Promise(r=>setTimeout(r,650));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');await rejected;assert.deepEqual((await state.getIngress(path,key))!.outcome,{response:'late'});}finally{if(db.isTransaction)db.exec('ROLLBACK');await pending.catch(()=>{});db.close();}
}));
test('malformed and unrelated native acknowledgement never fabricates lifecycle success',async t=>{
 let raw:unknown;t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>raw);const port=createNativeMessageJournal('db');
 for(raw of [{ok:true,operation:'Begin',path:pinNativeRuntimePath('db'),id:'message:other',value:true},{ok:true,operation:'Begin',path:pinNativeRuntimePath('db'),id:key,value:1},{ok:true,operation:'Result',path:pinNativeRuntimePath('db'),id:key,value:true},{ok:true,operation:'Begin',path:'other',id:key,value:true},{ok:true,operation:'Begin',id:key,value:true},{ok:false}])await assert.rejects(port.beginIngressExecution('db',key,'processing',null,1),NativeMessageJournalUnavailableError);
});
test('finite completion FIFO saturation refuses without submitting a replacement result',async()=>storeFixture(async path=>{
 await init(path);const c=await custody(path);await c.begin(null);const blocker=new OwnedWorkerSlot('Control'),url=new URL('data:text/javascript,'+encodeURIComponent("import {parentPort} from 'node:worker_threads';setTimeout(()=>parentPort.postMessage(true),300);")),active=blocker.run(url,{},1000),abort=new AbortController();
 const waiters=Array.from({length:OWNED_COMPLETION_QUEUE_LIMIT},()=>new OwnedWorkerSlot('Control')),pending=waiters.map(slot=>slot.runControlCompletion(url,{},1000,abort.signal).catch(e=>e));
 try{await assert.rejects(c.record({response:'not submitted'},3),NativeMessageJournalUnavailableError);assert.equal((await state.getIngress(path,key))!.outcome,undefined);}finally{abort.abort(Error('fixture cleanup'));await Promise.all(pending);await Promise.all(waiters.map(s=>s.join()));await active;await blocker.join();await c.dispose();}
 assert.equal(ownedWorkerUsage().Control,0);
}));
test('native admission freezes New reservation consumption and canonical duplicate decision',()=>storeFixture(async path=>{
 await init(path);const port=createNativeMessageJournal(path),arm={...input(),payload:{version:1n,content:'!new',author_is_bot:false,plan:{Execute:{New:{prompt:''}}}}};
 const first=await port.admitIngress(path,arm);assert.ok((first.record?.payload as any).plan.Respond);
 const request={...input(id+1n),payload:{...input().payload,author_is_bot:false}},pending=port.admitIngress(path,request);request.payload.plan.Execute.Ask.prompt='mutated';const next=await pending;
 assert.deepEqual((next.record?.payload as any).plan,{Execute:{New:{prompt:'hello'}}});assert.equal((next.record?.payload as any).new_prompt_arm_ref,key);
 const duplicate=await port.admitIngress(path,request);assert.equal(duplicate.created,false);assert.deepEqual(duplicate.record?.payload,next.record?.payload);assert.equal((await state.getIngress(path,key))!.payload!==undefined,true);
}));
test('custody rejects a compatibility owner paired with a native installation and foreign persistence keys',()=>storeFixture(async path=>{
 await init(path);const {owner}=await admitOriginalMessageJournal(path,input(),state),native=createNativeMessageJournal(path);assert.ok(owner);
 assert.throws(()=>new MessageCustody(path,key,{messageJournal:native,report:()=>{}},owner),/journal differs/);
 const c=new MessageCustody(path,key,{report:()=>{}},owner),effects=c.persistence();assert.throws(()=>effects.recordIngressResult(path,'message:other',{},2),/original message custody/);await c.dispose();
}));
test('native result retains stop/New evidence and original cancellation wins with rollback',()=>storeFixture(async path=>{
 await init(path);const c=await custody(path);await c.begin('target');edit(path,`UPDATE discord_ingress_journal SET phase='stop_accepted',outcome_json='{"accepted":true,"new_creation":{"version":1},"new_input":{"prompt":"original"}}'`);
 await c.record({response:'done',stop_receipt:'replace',new_creation:'replace'},3);const saved=(await state.getIngress(path,key))!.outcome as any;assert.equal(saved.stop_receipt.accepted,true);assert.deepEqual(saved.new_creation,{version:1n});assert.deepEqual(saved.new_input,{prompt:'original'});
 edit(path,"UPDATE discord_ingress_journal SET state='owned',phase='cancelled',owner_kind='prompt',owner_id='job'; INSERT INTO codex_request_cancellations VALUES ('job','target',1,2,3,3)");await assert.rejects(c.record({response:'late'},4),NativeMessageJournalUnavailableError);assert.deepEqual((await state.getIngress(path,key))!.outcome,saved);await c.dispose();
}));
test('native confirm preserves the separate first-reply receipt guard before updating ingress',()=>storeFixture(async path=>{
 await init(path);const c=await custody(path);await c.begin('target');await c.record({response:'accepted'},3);
 const identity={ingress_id:key,job_id:'job',thread_id:'target',cwd:'/work',state_db:'/state.db',channel_id:1n,origin_channel_id:1n,event_id:id,kind:'message',creation_generation:1n,prompt_sha256:'a'.repeat(64),acknowledgement:'ready'};
 const {serializeSerdeValue}=await import('../../../src/core/serde-json.ts');const db=new DatabaseSync(path);try{db.prepare('INSERT INTO codex_new_first_replies(job_id,ingress_id,identity_json) VALUES (?,?,?)').run('job',key,serializeSerdeValue(identity));}finally{db.close();}
 await assert.rejects(c.finish(),NativeMessageJournalUnavailableError);assert.equal((await state.getIngress(path,key))!.confirmationDelivered,false);edit(path,'UPDATE codex_new_first_replies SET confirmation_delivered=1');await c.finish();await c.dispose();assert.equal((await state.getIngress(path,key))!.confirmationDelivered,true);
}));
test('foreign application identity in admission ACK cannot mint custody or trigger replay',async t=>storeFixture(async path=>{
 await init(path);const run=OwnedWorkerSlot.prototype.run;let corrupt=true;
 t.mock.method(OwnedWorkerSlot.prototype,'run',async function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const raw=await run.apply(this,args) as any;if(corrupt&&String(args[0]).endsWith('/native-journal-worker.ts')&&(args[1] as any).operation==='Admit'){corrupt=false;raw.value.record.applicationId=9n;}return raw;});
 const journal=createNativeMessageJournal(path);await assert.rejects(admitOriginalMessageJournal(path,input(),journal),NativeMessageJournalUnavailableError);assert.equal((await state.getIngress(path,key))!.applicationId,null);const duplicate=await admitOriginalMessageJournal(path,input(),journal);assert.equal(duplicate.admission.created,false);assert.equal(duplicate.owner,null);
}));
