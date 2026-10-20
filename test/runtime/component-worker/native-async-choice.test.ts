import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {NativeAsyncChoiceOwner,NativeAsyncChoiceUnknownError,NativeAsyncChoiceReadError} from '../../../src/runtime/component-worker/async-choice-native.ts';
import {OwnedWorkerSlot,ownedWorkerUsage,OwnedWorkerBudgetError} from '../../../src/runtime/owned-worker-slot.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {componentWorkerErrorInfo} from '../../../src/runtime/component-worker/errors.ts';
import {createInteractionProcessor} from '../../../src/runtime/interaction-worker/processor.ts';
import {runInteractionWorker} from '../../../src/runtime/interaction-worker/worker.ts';
import {createInteractionWorkQueue} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {parseSerdeValue} from '../../../src/core/serde-json-parse.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {nativeAsyncFixture,questionId,row,edit,mutations} from '../../helpers/native-async-choice-fixture.ts';
import {stage,enqueue,work} from '../../helpers/interaction-worker-fixture.ts';
const native=(url:URL)=>/\/async-choice-native-worker\.(?:ts|js)$/.test(String(url));
const kind=(name:string)=>(error:unknown)=>componentWorkerErrorInfo(error)?.kind===name;
const poison=(t:any)=>{for(const name of ['getAsyncQuestion','requireCurrentAsyncQuestionMapping','beginAsyncQuestionDispatch','confirmAsyncQuestionDispatch','rejectDefiniteAsyncQuestion','rejectUsageLimitAsyncQuestion','recordAsyncQuestionError','validateAsyncDispatchGuards','beginDeliveryReceipt','confirmDeliveryReceipt','releaseRejectedDelivery','blockRejectedDelivery'])t.mock.method(state,name,()=>assert.fail(`main-thread ${name}`));};
for(const active of ['v',null])test(`installed native AsyncChoice ${active===null?'Start':'Steer'} traverses real worker, custody, receipt and original PATCH with poisoned fallback`,async t=>nativeAsyncFixture({active},async f=>{
 poison(t);const operations:any[]=[],receipts:any[]=[],run=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion;
 for(const [name,original]of [['run',run],['runControlCompletion',complete]] as const)t.mock.method(OwnedWorkerSlot.prototype,name,function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(native(args[0]))operations.push({lane:name,...args[1] as any});if(String(args[0]).includes('native-receipt-store-worker'))receipts.push({lane:name,...args[1] as any});return original.apply(this,args);});
 const w=f.click(),q=createInteractionWorkQueue();await stage(w);enqueue(q,w);q.sender.dispose();
 const send=DiscordChannelClient.prototype.sendValidated;t.mock.method(DiscordChannelClient.prototype,'sendValidated',async function(this:DiscordChannelClient,...args:Parameters<typeof send>){assert.equal(row(f.database)!.state,'submitted');const ingress=row(f.database,'SELECT outcome_json FROM discord_ingress_journal WHERE ingress_id=?',w.custodyIngressId)!;assert.equal(JSON.parse(String(ingress.outcome_json)).action_completed,true);assert.equal(row(f.database,'SELECT message_id FROM codex_delivery_receipts')!.message_id,null);return send.apply(this,args);});
 const reports:string[]=[];await runInteractionWorker(q,f.database,f.http,{process:createInteractionProcessor(f.database,f.server,f.http,f.executor.interactionServices(f.http)),notifyDeliveryReady:()=>{},report:(_code,detail)=>reports.push(detail)});
 assert.deepEqual(reports,[]);assert.deepEqual(f.httpSeen,['POST','PATCH']);assert.equal((await state.getIngress(f.database,w.custodyIngressId))!.confirmationDelivered,true);assert.equal(row(f.database)!.state,'submitted');assert.equal(f.notifications(),1);
 assert.deepEqual(operations.map(x=>[x.lane,x.operation]),[['run','Get'],['run','Get'],['run','Mapping'],['run','Begin'],['run','Mapping'],['run','Guard'],['runControlCompletion','Confirm']]);assert.ok(operations.every(x=>x.interactionId===9007199254740993n&&x.interactionIngressId==='interaction:9007199254740993'&&x.applicationId===4n&&x.actorId===2n&&x.channelId===1n&&x.sourceMessageId===9n&&x.option===0n));
 assert.deepEqual(receipts.map(x=>[x.lane,x.operation]),[['run','Begin'],['runControlCompletion','Confirm']]);assert.deepEqual(parseSerdeValue(receipts[0].key),[1n,'async-question-confirmation-v1',questionId,0n]);assert.equal(receipts[0].guard,null);
 const sent=mutations(await f.seen());assert.equal(sent.length,1);assert.equal(sent[0].method,active===null?'turn/start':'turn/steer');const prompt=JSON.parse(sent[0].params.input[0].text.split('\n')[1]);assert.equal(prompt.question_title,'Choose 😀');assert.equal(prompt.selected_option,'yes 😀');
 if(active===null){const j=row(f.database,'SELECT state,turn_id,baseline_turn_ids FROM codex_turn_queue')!;assert.equal(j.state,'running');assert.equal(j.turn_id,'next');assert.deepEqual(JSON.parse(String(j.baseline_turn_ids)),['old','v']);}
 const repeat=await f.prepare({...w,processingMode:'ConfirmationOnly'});await repeat.deliver();assert.deepEqual(f.httpSeen,['POST','PATCH','PATCH']);assert.equal(mutations(await f.seen()).length,1);assert.equal(ownedWorkerUsage().Control,0);
}));
test('submitted same option is confirmation-only; another option is AlreadyHandled; open ConfirmationOnly never claims',async()=>nativeAsyncFixture({active:'v'},async f=>{
 const w=f.click();try{await assert.rejects(f.prepare({...w,processingMode:'ConfirmationOnly'}),kind('ActionUnconfirmed'));assert.deepEqual(await f.seen(),[]);await f.prepare(w);await f.prepare({...f.click(0n,51n),processingMode:'ConfirmationOnly'});await assert.rejects(f.prepare(f.click(1n,52n)),kind('AlreadyHandled'));assert.equal(mutations(await f.seen()).length,1);}finally{w.admissionPermit!.release();}
}));
test('native owner captures original actor, room, message, option and bigint click before first read await',async t=>nativeAsyncFixture({active:'v'},async f=>{
 const base=f.click(),w={...base},component=structuredClone(w.work.Component),run=OwnedWorkerSlot.prototype.run;let first:any;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(native(args[0])&&!first){first=args[1];w.userId=77n;w.channelId=88n;w.sourceMessageId=99n;w.interactionId=11n;w.custodyIngressId='interaction:11';component.AsyncChoice.option=1n;}return run.apply(this,args);});
 await f.executor.interactionServices(f.http).prepareComponent(w,component);assert.equal(first.actorId,2n);assert.equal(first.interactionId,9007199254740993n);assert.equal(row(f.database)!.chosen,0);assert.equal(mutations(await f.seen()).length,1);base.admissionPermit!.release();
}));
for(const sql of ["UPDATE cdr_async_questions SET generation=2","UPDATE cdr_async_questions SET item_id='changed'","UPDATE cdr_async_questions SET body=json_set(body,'$.title','changed')"])test(`original occurrence drift after first native Get is rejected: ${sql}`,async t=>nativeAsyncFixture({active:'v'},async f=>{
 const run=OwnedWorkerSlot.prototype.run;let changed=false;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(native(args[0])&&(args[1] as any).operation==='Get'&&!changed){changed=true;return task.then(raw=>{edit(f.database,sql);return raw;});}return task;});
 await assert.rejects(f.prepare(),kind('Store'));assert.deepEqual(await f.seen(),[]);assert.equal(row(f.database)!.state,'open');
}));
test('mapping drift after claim never reaches lifecycle execute and preserves sealed held state when rejection cannot verify',async t=>nativeAsyncFixture({active:'v'},async f=>{
 const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(native(args[0])&&(args[1] as any).operation==='Begin')return task.then(raw=>{edit(f.database,"UPDATE mirror_threads SET codex_thread_id='changed'");return raw;});return task;});
 await assert.rejects(f.prepare(),kind('Store'));assert.equal(mutations(await f.seen()).length,0);assert.equal(row(f.database)!.state,'dispatching');
}));
for(const dispatch of ['remote','usage','missing','wrong','close'] as const)test(`installed dispatch ${dispatch} keeps definite versus unknown semantics without Reserve or resend`,async t=>nativeAsyncFixture({dispatch},async f=>{
 poison(t);await assert.rejects(f.prepare());const saved=row(f.database)!;assert.equal(saved.state,dispatch==='remote'||dispatch==='usage'?'rejected':'dispatching');assert.equal(row(f.database,'SELECT COUNT(*) AS n FROM codex_turn_queue')!.n,dispatch==='remote'||dispatch==='usage'?0:1);await assert.rejects(f.prepare());if(dispatch!=='close')assert.equal(mutations(await f.seen()).length,1);assert.deepEqual(f.httpSeen,[]);
}));
for(const operation of ['Begin','Confirm','Reject','Error'] as const)test(`lost ${operation} acknowledgement bars fresh mutations and permits only same-original submitted confirmation`,async t=>nativeAsyncFixture(operation==='Reject'?{dispatch:'remote'}:operation==='Error'?{dispatch:'missing'}:{active:'v'},async f=>{
 const lane=operation==='Begin'?'run':'runControlCompletion',original=OwnedWorkerSlot.prototype[lane];let lost=false;
 t.mock.method(OwnedWorkerSlot.prototype,lane,function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){const pending=original.apply(this,args);if(native(args[0])&&(args[1] as any).operation===operation&&!lost){lost=true;return pending.then(()=>{throw Error('lost ACK');});}return pending;});
 await assert.rejects(f.prepare(),error=>componentWorkerErrorInfo(error)?.source instanceof NativeAsyncChoiceUnknownError);assert.equal(lost,true);
 if(operation==='Confirm')await f.prepare(f.click(0n,51n));else await assert.rejects(f.prepare(f.click(0n,51n)));
 await assert.rejects(f.prepare(f.click(1n,52n)),error=>componentWorkerErrorInfo(error)?.source instanceof NativeAsyncChoiceUnknownError);assert.equal(mutations(await f.seen()).length,operation==='Begin'?0:1);assert.deepEqual(f.httpSeen,[]);assert.equal(ownedWorkerUsage().Control,0);
}));
test('binding-matched malformed Begin value is unknown and cannot reclaim even after open state is restored',async t=>nativeAsyncFixture({active:'v'},async f=>{
 const run=OwnedWorkerSlot.prototype.run;let changed=false;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);if(native(args[0])&&(args[1] as any).operation==='Begin'&&!changed){changed=true;return pending.then(raw=>({...raw as any,value:'null'}));}return pending;});
 await assert.rejects(f.prepare(),error=>componentWorkerErrorInfo(error)?.source instanceof NativeAsyncChoiceUnknownError);edit(f.database,"UPDATE cdr_async_questions SET state='open',chosen=NULL");await assert.rejects(f.prepare(),error=>componentWorkerErrorInfo(error)?.source instanceof NativeAsyncChoiceUnknownError);assert.equal(mutations(await f.seen()).length,0);
}));
test('lost read ACK never creates a mutation barrier; explicit retry remains source ordered',async t=>nativeAsyncFixture({active:'v'},async f=>{
 const run=OwnedWorkerSlot.prototype.run;let lost=false;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);if(native(args[0])&&!lost){lost=true;return pending.then(()=>{throw Error('lost read ACK');});}return pending;});
 await assert.rejects(f.prepare(),error=>componentWorkerErrorInfo(error)?.source instanceof NativeAsyncChoiceReadError);await f.prepare();assert.equal(mutations(await f.seen()).length,1);
}));
test('simultaneous duplicate native choices never queue fresh claims or send twice',async()=>nativeAsyncFixture({active:'v'},async f=>{
 const results=await Promise.allSettled([f.prepare(),f.prepare()]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(mutations(await f.seen()).length,1);assert.equal(row(f.database)!.state,'submitted');
}));
test('existing-only Get rejects missing database and incomplete schema without creating or migrating',async()=>storeFixture(async path=>{
 const owner=new NativeAsyncChoiceOwner(path),w=work(path,8n,new AdmissionGate(),`codex_async:${questionId}:0`);assert.ok('Component'in w.work);
 try{await assert.rejects(owner.get(owner.capture(w,w.work.Component)),NativeAsyncChoiceReadError);assert.equal(existsSync(path),false);new DatabaseSync(path).close();await assert.rejects(owner.get(owner.capture(w,w.work.Component)),NativeAsyncChoiceReadError);assert.equal(row(path,'SELECT COUNT(*) AS n FROM sqlite_master')!.n,0);}finally{await owner.close();w.admissionPermit!.release();}
}));
for(const operation of ['Get','Begin','Confirm'] as const)for(const mode of ['deadline','cancel'] as const)test(`${operation} ${mode} retains target lock and Control slot until real native exit while timers progress`,async t=>nativeAsyncFixture({active:'v'},async f=>{
 const lane=operation==='Confirm'?'runControlCompletion':'run',original=OwnedWorkerSlot.prototype[lane],blocker=new DatabaseSync(f.database),cancel=new AbortController();let started!:()=>void;const start=new Promise<void>(r=>{started=r;});
 t.mock.method(OwnedWorkerSlot.prototype,lane,function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){if(native(args[0])&&(args[1] as any).operation===operation){blocker.exec(operation==='Get'?'BEGIN EXCLUSIVE':'BEGIN IMMEDIATE');const pending=original.call(this,args[0],args[1],mode==='deadline'?30:5000,mode==='cancel'?cancel.signal:args[3]);started();return pending;}return original.apply(this,args);});
 let settled=false,ticks=0;const timer=setInterval(()=>ticks++,5),task=f.prepare();void task.then(()=>settled=true,()=>settled=true);try{await start;if(mode==='cancel')cancel.abort(Error('fixture cancellation'));await new Promise(r=>setTimeout(r,150));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Control,1);assert.equal(f.queue.locks.activeTargetCount,operation==='Get'?0:1);assert.ok(ticks>3);blocker.exec('ROLLBACK');await assert.rejects(task);assert.equal(ownedWorkerUsage().Control,0);assert.equal(f.queue.locks.activeTargetCount,0);}finally{clearInterval(timer);if(blocker.isTransaction)blocker.exec('ROLLBACK');await task.catch(()=>{});blocker.close();}
}));

test('another unknown Begin blocks fresh work but cannot discard an already-owned accepted completion',async t=>nativeAsyncFixture({active:'v'},async f=>{
 const second='b'.repeat(64);edit(f.database,`INSERT INTO cdr_async_questions(id,runtime_id,generation,thread_id,turn_id,item_id,origin_job_id,channel_id,owner_user_id,body,state,message_id,owner_confirmed,chosen,dispatch_mode,reply_job_id,accepted_turn_id,error,preparation_json,created_at,updated_at) SELECT '${second}',runtime_id,generation,thread_id,turn_id,'second',origin_job_id,channel_id,owner_user_id,body,state,message_id,owner_confirmed,chosen,dispatch_mode,reply_job_id,accepted_turn_id,error,preparation_json,created_at,updated_at FROM cdr_async_questions`);
 const owner=new NativeAsyncChoiceOwner(f.database),a=f.click(),b=f.click(0n,53n,second);const ca=owner.capture(a,a.work.Component),cb=owner.capture(b,b.work.Component),qa=await owner.get(ca),qb=await owner.get(cb);
 const claim=(q:any)=>({id:q.id,runtime_id:q.runtimeId,generation:q.generation,channel:q.channelId,actor:q.ownerUserId,message:'9',option:0n,mode:'Steer' as const,baseline_turn_ids:[],prompt:'answer',now:10});await owner.begin(ca,claim(qa));
 const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(native(args[0])&&(args[1] as any).operation==='Begin')return task.then(()=>{throw Error('lost B ACK');});return task;});
 try{await assert.rejects(owner.begin(cb,claim(qb)),NativeAsyncChoiceUnknownError);await owner.confirm(ca,'v');assert.equal(row(f.database,'SELECT state FROM cdr_async_questions WHERE id=?',questionId)!.state,'submitted');assert.equal(row(f.database,'SELECT state FROM cdr_async_questions WHERE id=?',second)!.state,'dispatching');assert.throws(()=>owner.capture(a,a.work.Component),NativeAsyncChoiceUnknownError);}finally{await owner.close();a.admissionPermit!.release();b.admissionPermit!.release();}
}));
test('owned completion uses finite FIFO while new Get refuses occupied Control and original error is Unicode-scalar bounded',async()=>nativeAsyncFixture({active:'v'},async f=>{
 const owner=new NativeAsyncChoiceOwner(f.database),reader=new NativeAsyncChoiceOwner(f.database),w=f.click(),held=owner.capture(w,w.work.Component),q=await owner.get(held);await owner.begin(held,{id:q.id,runtime_id:q.runtimeId,generation:q.generation,channel:q.channelId,actor:q.ownerUserId,message:'9',option:0n,mode:'Steer',baseline_turn_ids:[],prompt:'answer',now:10});
 const blocker=new DatabaseSync(f.database);blocker.exec('BEGIN EXCLUSIVE');const read=reader.get(reader.capture(w,w.work.Component));let finished=false;const complete=owner.error(held,'😀'.repeat(1001)).then(()=>{finished=true;});
 try{await assert.rejects(reader.get(reader.capture(w,w.work.Component)));await new Promise(r=>setTimeout(r,100));assert.equal(finished,false);assert.equal(ownedWorkerUsage().Control,1);blocker.exec('ROLLBACK');await read;await complete;assert.equal(Array.from(String(row(f.database)!.error)).length,1000);assert.equal(String(row(f.database)!.error),'😀'.repeat(1000));assert.equal(ownedWorkerUsage().Control,0);}finally{if(blocker.isTransaction)blocker.exec('ROLLBACK');await Promise.allSettled([read,complete]);await Promise.all([owner.close(),reader.close()]);blocker.close();w.admissionPermit!.release();}
}));

for(const field of ['interactionIngressId','interactionId','applicationId','actorId','channelId','sourceMessageId','customId','questionId','option','processingMode','questionJson','claimJson','detail'] as const)test(`native Begin ACK is bound to exact original ${field}`,async t=>nativeAsyncFixture({active:'v'},async f=>{
 const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);if(native(args[0])&&(args[1] as any).operation==='Begin')return pending.then(raw=>({...raw as any,[field]:typeof (raw as any)[field]==='bigint'?(raw as any)[field]+1n:'crossed'}));return pending;});
 await assert.rejects(f.prepare(),error=>componentWorkerErrorInfo(error)?.source instanceof NativeAsyncChoiceUnknownError);assert.equal(mutations(await f.seen()).length,0);assert.equal(row(f.database)!.state,'dispatching');await assert.rejects(f.prepare());
}));
test('native boundaries reject hostile accessors, invalid scalars, excessive text and noncanonical question bytes before work',async()=>nativeAsyncFixture({active:'v'},async f=>{
 const {snapshotAsyncChoiceQuestion,parseAsyncChoiceQuestion,asyncChoiceBinding,captureAsyncChoiceClick}=await import('../../../src/runtime/component-worker/async-choice-native-snapshot.ts');const {getAsyncQuestionExisting}=await import('../../../src/store/async-question-delivery-state.ts');
 const q=getAsyncQuestionExisting(f.database,questionId);let hooks=0;assert.throws(()=>snapshotAsyncChoiceQuestion({...q,get runtimeId(){hooks++;return 'changed';}}));assert.equal(hooks,0);assert.throws(()=>snapshotAsyncChoiceQuestion({...q,generation:1}),TypeError);assert.throws(()=>snapshotAsyncChoiceQuestion({...q,error:'\ud800'}),TypeError);assert.throws(()=>snapshotAsyncChoiceQuestion({...q,error:'x'.repeat(393217)}),RangeError);assert.throws(()=>parseAsyncChoiceQuestion(' '+serializeSerdeValue(q)),TypeError);
 const click=captureAsyncChoiceClick({interactionIngressId:'interaction:9007199254740993',interactionId:9007199254740993n,applicationId:4n,actorId:2n,channelId:1n,sourceMessageId:9n,customId:`codex_async:${questionId}:0`,processingMode:'Execute'});assert.equal(click.interactionId,9007199254740993n);
 assert.throws(()=>asyncChoiceBinding('00000000-0000-0000-0000-000000000000',f.database,'Confirm',click,serializeSerdeValue(q),null,'x'.repeat(393217)),RangeError);assert.throws(()=>asyncChoiceBinding('00000000-0000-0000-0000-000000000000',f.database,'Error',click,serializeSerdeValue(q),null,'😀'.repeat(1001)),RangeError);assert.throws(()=>new NativeAsyncChoiceOwner('x'.repeat(32769)),TypeError);assert.throws(()=>new NativeAsyncChoiceOwner(f.database,0),RangeError);assert.equal(ownedWorkerUsage().Control,0);
}));
test('native Begin seal failure holds runtime unknown barrier without reserving or sending',async()=>nativeAsyncFixture({},async f=>{
 edit(f.database,"CREATE TRIGGER refuse_seal BEFORE UPDATE OF preparation_json ON cdr_async_questions BEGIN SELECT RAISE(ABORT,'seal refusal'); END");await assert.rejects(f.prepare(),error=>componentWorkerErrorInfo(error)?.source instanceof NativeAsyncChoiceUnknownError);assert.equal(row(f.database)!.state,'open');assert.equal(row(f.database,'SELECT COUNT(*) AS n FROM codex_turn_queue')!.n,0);edit(f.database,'DROP TRIGGER refuse_seal');await assert.rejects(f.prepare(),error=>componentWorkerErrorInfo(error)?.source instanceof NativeAsyncChoiceUnknownError);assert.equal(mutations(await f.seen()).length,0);
}));
test('second preflight drift rejects original Start reservation through owned completion before any lifecycle mutation',async()=>nativeAsyncFixture({changeSecondList:true},async f=>{
 await assert.rejects(f.prepare(),kind('AsyncQuestion'));assert.equal(row(f.database)!.state,'rejected');assert.equal(row(f.database,'SELECT COUNT(*) AS n FROM codex_turn_queue')!.n,0);assert.equal(mutations(await f.seen()).length,0);
}));
test('actor, channel, message and out-of-range option mismatch never reads app-server or claims',async()=>nativeAsyncFixture({},async f=>{
 const w=f.click();for(const changed of [{...w,userId:3n},{...w,channelId:3n},{...w,sourceMessageId:8n}])await assert.rejects(f.prepare(changed),kind('AsyncQuestion'));await assert.rejects(f.prepare({...w,sourceMessageId:null}),kind('MissingSourceMessage'));await assert.rejects(f.prepare(f.click(2n)),kind('AsyncQuestion'));assert.deepEqual(await f.seen(),[]);assert.equal(row(f.database)!.state,'open');w.admissionPermit!.release();
}));
test('owner close joins actual cancelled native exit and permanently refuses further work',async()=>nativeAsyncFixture({active:'v'},async f=>{
 const owner=new NativeAsyncChoiceOwner(f.database),w=f.click(),handle=owner.capture(w,w.work.Component),blocker=new DatabaseSync(f.database);blocker.exec('BEGIN EXCLUSIVE');const task=owner.get(handle);let closed=false;const closing=owner.close().then(()=>{closed=true;});const rejected=assert.rejects(task,NativeAsyncChoiceReadError);
 try{await new Promise(r=>setTimeout(r,100));assert.equal(closed,false);assert.equal(owner.busy,true);assert.equal(ownedWorkerUsage().Control,1);blocker.exec('ROLLBACK');await rejected;await closing;assert.equal(owner.busy,false);assert.equal(ownedWorkerUsage().Control,0);assert.throws(()=>owner.capture(w,w.work.Component),/closed/);}finally{if(blocker.isTransaction)blocker.exec('ROLLBACK');await Promise.allSettled([task,closing]);blocker.close();w.admissionPermit!.release();}
}));
test('handler pins original owner methods and cannot execute arbitrary subclass overrides',async()=>nativeAsyncFixture({active:'v'},async f=>{
 const {handleAsyncChoice}=await import('../../../src/runtime/component-worker/async-choice.ts'),{ControlTurnVerifier}=await import('../../../src/runtime/action-executor/control-turn.ts');let hooks=0;
 class Hostile extends NativeAsyncChoiceOwner{
  override async get(..._args:Parameters<NativeAsyncChoiceOwner['get']>):ReturnType<NativeAsyncChoiceOwner['get']>{hooks++;throw Error('override');}
  override requireExecutable(..._args:Parameters<NativeAsyncChoiceOwner['requireExecutable']>):void{hooks++;throw Error('override');}
 }
 const owner=new Hostile(f.database),w=f.click(),verifier=new ControlTurnVerifier(f.database,f.server,{selectedThreadId:()=>null},f.queue.locks);
 try{await handleAsyncChoice(w,questionId,0n,f.database,f.server,verifier,()=>{},()=>10,owner);assert.equal(hooks,0);assert.equal(row(f.database)!.state,'submitted');assert.equal(mutations(await f.seen()).length,1);}finally{await owner.close();w.admissionPermit!.release();}
}));
