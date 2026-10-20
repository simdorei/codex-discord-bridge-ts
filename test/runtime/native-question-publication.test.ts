import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {seedPublication,editPublication,publicationReceipts,questionDiagnostic as render} from '../helpers/question-publication-fixture.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {getAsyncQuestionExisting} from '../../src/store/async-question-delivery-state.ts';
import type {StoredAsyncQuestion} from '../../src/store/async-question-read.ts';
import {deliverCheckedAsyncQuestion} from '../../src/runtime/async-question-delivery.ts';
import {NativeQuestionPublicationOwner,NativeQuestionPublicationUnconfirmedError} from '../../src/runtime/async-question-publication-native.ts';
import {NativeCompletionReceiptStore,CompletionReceiptUnconfirmedError} from '../../src/runtime/completion/native-receipt-store.ts';
import {sendReceiptChunk,DiscordTransportFault,type DiscordReceiptTransport} from '../../src/runtime/completion/receipt-sender.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {serializeSerdeValue as json} from '../../src/core/serde-json.ts';
import {parseSerdeValue} from '../../src/core/serde-json-parse.ts';
import {receiptHash} from '../../src/store/delivery-receipt-key.ts';
import type {IdempotentMessageRequest} from '../../src/discord/idempotent-message.ts';
const domains=['async-question-item-text-v1','async-question-body-v1','async-question-v1'] as const;
const key=(domain:string,index=0n,channel=1n)=>json([channel,domain,'original',index]),hash=receiptHash('body'),guard={jobId:'job',threadId:'target',turnId:'turn'};
function poison(t:TestContext){for(const name of ['beginDeliveryReceipt','confirmDeliveryReceipt','releaseRejectedDelivery','blockRejectedDelivery','requireCurrentAsyncQuestionMapping','confirmAsyncQuestionOwner','bindAsyncQuestionReceipt','recordAsyncQuestionError','getAsyncQuestion','loadCompletionPayload'] as const)t.mock.method(state,name,()=>assert.fail(`compatibility ${name}`));}
function transport(seen:IdempotentMessageRequest[]):DiscordReceiptTransport{return {sendValidated:async request=>{seen.push(request);return BigInt(100+seen.length);}};}
async function pendingPass(path:string,qs:readonly StoredAsyncQuestion[],http:DiscordReceiptTransport,native=true){let failed=false,first:unknown;for(const q of qs)try{await deliverCheckedAsyncQuestion(path,1n,http,q,render,native);}catch(error){if(!failed){failed=true;first=error;}}if(failed)throw first;}
for(const domain of domains)test(`${domain}: exact null guard/part profile rejects before creating a store`,async()=>storeFixture(async path=>{
 for(const [k,g] of [[key(domain),guard],[key(domain,-1n),null],[key(domain,0n,0n),null],[key(domain,0n,1n<<63n),null]] as const)assert.throws(()=>new NativeCompletionReceiptStore(path,k,hash,g),TypeError);
 for(const bad of [domain+'/',domain.replace('-v1','-v2'),'async-question/v1'])assert.throws(()=>new NativeCompletionReceiptStore(path,key(bad),hash,null),TypeError);
 if(domain==='async-question-v1')assert.throws(()=>new NativeCompletionReceiptStore(path,key(domain,1n),hash,null),TypeError);
 const k=key(domain,domain==='async-question-v1'?0n:(1n<<64n)-1n),owner=new NativeCompletionReceiptStore(path,k,hash,null);
 try{await assert.rejects(owner.begin(k,hash,null),CompletionReceiptUnconfirmedError);assert.equal(existsSync(path),false);new DatabaseSync(path).close();await assert.rejects(owner.begin(k,hash,null),CompletionReceiptUnconfirmedError);const empty=new DatabaseSync(path);try{assert.deepEqual(empty.prepare('SELECT name FROM sqlite_master').all(),[]);}finally{empty.close();}}finally{await owner.close();}assert.equal(ownedWorkerUsage().Control,0);
}));
test('native multipart/shared context preserves compatibility bytes, hashes, nonce and exact control IDs',async t=>storeFixture(async path=>{
 const qs=await seedPublication(path,{context:'😀 context '.repeat(300),questions:[{title:'A '.repeat(1500),options:['yes']},{title:'B '.repeat(1500),options:['no']}]});
 const seen:IdempotentMessageRequest[]=[];await pendingPass(path,qs,transport(seen),false);const expected=seen.splice(0),receipts=await publicationReceipts(path);
 await editPublication(path,db=>db.exec("DELETE FROM codex_delivery_receipts;UPDATE cdr_async_questions SET state='observed',message_id=NULL,owner_confirmed=0"));poison(t);
 await pendingPass(path,qs,transport(seen));assert.deepEqual(seen,expected);assert.deepEqual(await publicationReceipts(path),receipts);const count=seen.length;await pendingPass(path,await state.pendingAsyncQuestions(path,'runtime'),transport(seen));assert.equal(seen.length,count);
 const rows=qs.map(q=>getAsyncQuestionExisting(path,q.id));for(const q of rows){const receipt=receipts.find(r=>r.receipt_key===json([q.channelId,domains[2],q.id,0n]));assert.equal(q.messageId,receipt!.message_id);assert.equal(q.state,'open');}
 const contexts=receipts.filter(r=>(parseSerdeValue(r.receipt_key as string) as unknown[])[1]===domains[0]);assert.ok(contexts.length>1);for(const row of contexts)assert.equal((parseSerdeValue(row.receipt_key as string) as unknown[])[2],json(['target','turn','item']));assert.equal(seen.filter(r=>JSON.parse(r.body).components).length,2);assert.equal(ownedWorkerUsage().Control,0);
}));
for(const status of [400,429,503])test(`native multipart ${status} preserves prefix and lets a later question progress`,async t=>storeFixture(async path=>{
 const qs=await seedPublication(path,{questions:[{title:'A '.repeat(1500),options:['yes']},{title:'B',options:['no']}]});poison(t);const seen:IdempotentMessageRequest[]=[];
 const http={sendValidated:async(request:IdempotentMessageRequest)=>{seen.push(request);if(seen.length===3)throw new DiscordTransportFault('Response','fixture',status);return BigInt(100+seen.length);}};
 await assert.rejects(pendingPass(path,qs,http));const firstCount=seen.length;assert.equal(getAsyncQuestionExisting(path,qs[1]!.id).state,'open');assert.equal(getAsyncQuestionExisting(path,qs[0]!.id).error,render());
 assert.equal(seen.filter(r=>JSON.parse(r.body).content==='shared context').length,1);
 if(status===429){await deliverCheckedAsyncQuestion(path,1n,http,qs[0]!,render,true);assert.equal(seen[2]!.body,seen[firstCount]!.body);assert.equal(getAsyncQuestionExisting(path,qs[0]!.id).state,'open');}
 else{await assert.rejects(deliverCheckedAsyncQuestion(path,1n,http,qs[0]!,render,true),status===400?/requires correction/:/unknown/);assert.equal(seen.length,firstCount);}
 assert.equal(seen.filter(r=>r.body===seen[1]!.body).length,1);assert.equal(ownedWorkerUsage().Control,0);
}));
test('unsupported controls and bind-only recovery never use a body receipt as the message binding',async t=>storeFixture(async path=>{
 const [q]=await seedPublication(path,{questions:[{title:'free text',options:[]}]});poison(t);const seen:IdempotentMessageRequest[]=[];await editPublication(path,db=>db.exec("CREATE TRIGGER deny_bind BEFORE UPDATE OF message_id ON cdr_async_questions BEGIN SELECT RAISE(ABORT,'bind');END"));
 await assert.rejects(deliverCheckedAsyncQuestion(path,1n,transport(seen),q!,render,true),NativeQuestionPublicationUnconfirmedError);assert.equal(seen.length,3);const before=await publicationReceipts(path);assert.ok(before.every(r=>r.message_id!==null));assert.equal(getAsyncQuestionExisting(path,q!.id).state,'observed');
 await editPublication(path,db=>db.exec('DROP TRIGGER deny_bind'));await deliverCheckedAsyncQuestion(path,1n,transport(seen),q!,render,true);assert.equal(seen.length,3);const current=getAsyncQuestionExisting(path,q!.id);assert.equal(current.messageId,'103');assert.equal(current.state,'unsupported');assert.match(JSON.parse(seen.at(-1)!.body).content,/선택 버튼을 만들 수 없습니다/);assert.equal(JSON.parse(seen.at(-1)!.body).components,undefined);
}));
test('accepted receipt confirmation failure remains unknown with no replay',async t=>storeFixture(async path=>{
 const [q]=await seedPublication(path);poison(t);await editPublication(path,db=>db.exec("CREATE TRIGGER deny_receipt BEFORE UPDATE OF message_id ON codex_delivery_receipts BEGIN SELECT RAISE(ABORT,'receipt');END"));const seen:IdempotentMessageRequest[]=[];
 await assert.rejects(deliverCheckedAsyncQuestion(path,1n,transport(seen),q!,render,true),CompletionReceiptUnconfirmedError);await assert.rejects(deliverCheckedAsyncQuestion(path,1n,transport(seen),q!,render,true),/unknown/);assert.equal(seen.length,1);assert.equal(getAsyncQuestionExisting(path,q!.id).messageId,null);
}));
test('capture precedes native await, so caller mutation cannot retarget content or control binding',async t=>storeFixture(async path=>{
 const [q]=await seedPublication(path);poison(t);const seen:IdempotentMessageRequest[]=[],id=q!.id,pending=deliverCheckedAsyncQuestion(path,1n,transport(seen),q!,render,true);
 Object.assign(q!,{id:'other',runtimeId:'other',generation:2n,threadId:'other',turnId:'other',itemId:'other',originJobId:'other',channelId:99n,ownerUserId:99n});q!.body.title='retarget';q!.body.options[0]='retarget';await pending;
 assert.equal(getAsyncQuestionExisting(path,id).state,'open');assert.equal(seen.every(r=>r.path==='channels/1/messages'),true);assert.equal(seen.some(r=>r.body.includes('retarget')),false);
}));
test('changed original row before Prepare and after accepted controls cannot bind a fresh occurrence',async t=>{
 poison(t);for(const phase of ['before','controls'])await storeFixture(async path=>{
  const [q]=await seedPublication(path),seen:IdempotentMessageRequest[]=[];if(phase==='before')await editPublication(path,db=>db.exec("UPDATE cdr_async_questions SET runtime_id='replacement'"));
  const http={sendValidated:async(request:IdempotentMessageRequest)=>{seen.push(request);if(JSON.parse(request.body).components)await editPublication(path,db=>db.exec("UPDATE cdr_async_questions SET runtime_id='replacement'"));return BigInt(100+seen.length);}};
  await assert.rejects(deliverCheckedAsyncQuestion(path,1n,http,q!,render,true),NativeQuestionPublicationUnconfirmedError);assert.equal(seen.length,phase==='before'?0:3);const current=getAsyncQuestionExisting(path,q!.id);assert.equal(current.runtimeId,'replacement');assert.equal(current.messageId,null);assert.equal(current.error,'');if(phase==='controls')assert.equal((await publicationReceipts(path)).find(r=>r.receipt_key===json([1n,domains[2],q!.id,0n]))!.message_id,'103');
 });
});
for(const at of ['context','controls'])test(`accepted ${at} cancellation joins receipt and only final controls bind`,async t=>storeFixture(async path=>{
 const [q]=await seedPublication(path);poison(t);const c=new AbortController(),seen:IdempotentMessageRequest[]=[];const http={sendValidated:async(request:IdempotentMessageRequest,signal?:AbortSignal)=>{assert.equal(signal,c.signal);seen.push(request);if(at==='context'||JSON.parse(request.body).components)c.abort(Error('stop accepted'));return BigInt(100+seen.length);}};
 const pending=deliverCheckedAsyncQuestion(path,1n,http,q!,render,true,c.signal);if(at==='context')await assert.rejects(pending,e=>e===c.signal.reason);else await pending;
 const current=getAsyncQuestionExisting(path,q!.id);assert.equal(current.state,at==='context'?'observed':'open');assert.equal(seen.length,at==='context'?1:3);assert.ok((await publicationReceipts(path)).every(r=>r.message_id!==null));assert.equal(ownedWorkerUsage().Control,0);
}));
test('crossed Prepare acknowledgement never grants publication or a repeat on the same owner',async t=>storeFixture(async path=>{
 const [q]=await seedPublication(path),owner=new NativeQuestionPublicationOwner(path,q!),run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);return /async-question-publication-native-worker\.(ts|js)$/.test(args[0].pathname)?pending.then(raw=>({...raw as object,questionJson:'{}'})):pending;});
 try{await assert.rejects(owner.prepare(),NativeQuestionPublicationUnconfirmedError);await assert.rejects(owner.prepare(),/already prepared or unconfirmed/);await assert.rejects(owner.bind(true),/confirmed original/);assert.deepEqual(await publicationReceipts(path),[]);}finally{await owner.close();}
}));
for(const operation of ['Prepare','Bind'] as const)test(`${operation} timeout retains owner and Control until locked SQLite actually exits`,async()=>storeFixture(async path=>{
 const [q]=await seedPublication(path),owner=new NativeQuestionPublicationOwner(path,q!,operation==='Bind'?500:30);if(operation==='Bind'){await owner.prepare();await sendReceiptChunk(path,{sendValidated:async()=>91n},1n,{domain:domains[2],logicalKey:q!.id,chunkIndex:0n,content:'controls'},[],null,undefined,true);}
 const blocker=new DatabaseSync(path);blocker.exec('BEGIN IMMEDIATE');let settled=false,ticks=0;const timer=setInterval(()=>ticks++,5),pending=operation==='Prepare'?owner.prepare():owner.bind(true),failed=assert.rejects(pending,NativeQuestionPublicationUnconfirmedError);void pending.then(()=>settled=true,()=>settled=true);
 try{await new Promise(r=>setTimeout(r,operation==='Bind'?650:150));assert.equal(settled,false);assert.equal(owner.busy,true);assert.equal(ownedWorkerUsage().Control,1);assert.ok(ticks>3);let closed=false;const closing=owner.close().then(()=>closed=true);await new Promise(r=>setTimeout(r,20));assert.equal(closed,false);blocker.exec('ROLLBACK');await failed;await closing;assert.equal(ownedWorkerUsage().Control,0);if(operation==='Bind')assert.equal(getAsyncQuestionExisting(path,q!.id).state,'open');}finally{clearInterval(timer);if(blocker.isTransaction)blocker.exec('ROLLBACK');await pending.catch(()=>{});await owner.close();blocker.close();}
}));
test('Control saturation refuses fresh Prepare while original Bind completions retain FIFO',async()=>storeFixture(async path=>{
 const qs=await seedPublication(path),a=new NativeQuestionPublicationOwner(path,qs[0]!),b=new NativeQuestionPublicationOwner(path,qs[1]!),fresh=new NativeQuestionPublicationOwner(path,qs[0]!);await a.prepare();await b.prepare();for(const q of qs)await sendReceiptChunk(path,{sendValidated:async()=>91n},1n,{domain:domains[2],logicalKey:q.id,chunkIndex:0n,content:'controls'},[],null,undefined,true);
 const k=key(domains[1]),occupant=new NativeCompletionReceiptStore(path,k,hash,null),blocker=new DatabaseSync(path);blocker.exec('BEGIN IMMEDIATE');const occupying=occupant.begin(k,hash,null),order:number[]=[],one=a.bind(true).then(()=>order.push(1)),two=b.bind(true).then(()=>order.push(2));
 try{await assert.rejects(fresh.prepare(),OwnedWorkerBudgetError);await new Promise(r=>setTimeout(r,60));assert.deepEqual(order,[]);assert.equal(ownedWorkerUsage().Control,1);blocker.exec('ROLLBACK');await Promise.all([occupying,one,two]);assert.deepEqual(order,[1,2]);}finally{if(blocker.isTransaction)blocker.exec('ROLLBACK');await Promise.allSettled([occupying,one,two]);await Promise.all([a.close(),b.close(),fresh.close(),occupant.close()]);blocker.close();}assert.equal(ownedWorkerUsage().Control,0);
}));

test('HTTP lane cancellation retains channel ownership through locked accepted receipt and final binding',async t=>storeFixture(async path=>{
 const {NativeHttpPayloadReader}=await import('../../src/runtime/completion/native-http-payload.ts'),{deliverCompletionEntry}=await import('../../src/runtime/completion/scheduler/http-work.ts'),{CompletionReady}=await import('../../src/runtime/completion/scheduler/ready.ts'),{CompletionExecution}=await import('../../src/runtime/completion/scheduler/execution.ts'),{initialCompletionCursor}=await import('../../src/store/completion-metadata.ts');
 const [q]=await seedPublication(path),entry=(await state.completionPage(path,'Question',initialCompletionCursor(),'runtime',1n)).page.entries[0]!,reader=new NativeHttpPayloadReader(path),blocker=new DatabaseSync(path);poison(t);
 const ready=new CompletionReady<import('../../src/runtime/completion/scheduler/envelope.ts').CompletionNotification>();ready.durable(entry,new Set());let accepted!:()=>void;const observed=new Promise<void>(r=>accepted=r),seen:IdempotentMessageRequest[]=[];
 const http={sendValidated:async(request:IdempotentMessageRequest,signal?:AbortSignal)=>{assert.ok(signal);seen.push(request);if(JSON.parse(request.body).components){blocker.exec('BEGIN IMMEDIATE');accepted();}return BigInt(100+seen.length);}};
 const execution=new CompletionExecution(ready,{prepare:()=>null,state:async()=>assert.fail('unexpected state lane'),prepareFailed:()=>assert.fail('unexpected preparation failure'),http:(current,signal)=>deliverCompletionEntry(path,current,{instanceId:()=> 'runtime',generation:()=>1n},{transport:http,failures:{render},now:()=>1},{deliverChecked:(p,g,t,q,cancel)=>deliverCheckedAsyncQuestion(p,g,t,q,render,true,cancel)},reader,signal)});
 let closing:Promise<void>|undefined;try{execution.launch();await observed;let closed=false;closing=execution.close(Error('stop accepted controls')).then(()=>{closed=true;});await new Promise(r=>setTimeout(r,150));assert.equal(closed,false);assert.equal(execution.httpCount,1);assert.equal(execution.activeChannels().size,1);assert.equal(ownedWorkerUsage().Control,1);blocker.exec('ROLLBACK');await closing;assert.equal(execution.httpCount,0);assert.equal(execution.activeChannels().size,0);assert.equal(getAsyncQuestionExisting(path,q!.id).state,'open');assert.equal(getAsyncQuestionExisting(path,q!.id).messageId,'103');assert.equal(seen.length,3);assert.equal(ownedWorkerUsage().Control,0);}finally{if(blocker.isTransaction)blocker.exec('ROLLBACK');await closing;await execution.close();await reader.close();blocker.close();}
}));
