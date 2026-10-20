import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,symlinkSync,unlinkSync} from 'node:fs';
import {symlink,unlink} from 'node:fs/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {getIngress} from '../../../src/store/ingress-read.ts';
import {createNativeInteractionJournal,captureInteractionJournal,captureInteractionJournalIdentity,admitOriginalInteractionJournal,NativeInteractionJournalUnavailableError,OriginalInteractionJournal} from '../../../src/runtime/interaction-worker/journal.ts';
import {ExecutionCustody} from '../../../src/runtime/interaction-worker/execution-custody.ts';
import {stageOrdinaryInteraction} from '../../../src/runtime/discord-dispatch/stage-ordinary.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage,OWNED_COMPLETION_QUEUE_LIMIT} from '../../../src/runtime/owned-worker-slot.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
import {routeGatewayCommand,routeGatewayComponent} from '../../../src/discord/interaction-routing.ts';
import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';
import {serializeBusyChoice} from '../../../src/store/busy-choice.ts';
import {cleanupNotificationFailureInfo} from '../../../src/runtime/cleanup-notification-failure.ts';
const eventId=9007199254740993n,key=`interaction:${eventId}`,choiceId='a'.repeat(24);
const identity=captureInteractionJournalIdentity({ingressId:key,eventId,applicationId:4n,channelId:1n,ownerUserId:2n,sourceMessageId:null});
function work(name='help',custom?:string){const event=decodeGatewayInteraction(JSON.stringify({application_id:'4',authorizing_integration_owners:{},channel_id:'1',id:String(eventId),token:'fixture',type:custom?3:2,data:custom?{custom_id:custom,component_type:2}:{id:'9',name,type:1,options:name==='ask'?[{name:'prompt',type:3,value:'hello'}]:[]}}));return custom?routeGatewayComponent(event).work:routeGatewayCommand(event,false).work;}
const input=()=>({...identity,kind:'interaction' as const,payload:{version:1n,work:work(),processing_mode:'normal',request_rejection:null},targetThreadId:null,canonicalOwner:key,now:1});
async function init(path:string){(await openInitialized(path)).close();}
function edit(path:string,sql:string){const db=new DatabaseSync(path);try{db.exec(sql);}finally{db.close();}}
const request=(routed=work(),id=eventId)=>({applicationId:4n,interactionId:id,channelId:1n,userId:2n,sourceMessageId:null,work:routed});
const stage=(path:string,routed=work(),id=eventId,now=1)=>stageOrdinaryInteraction(path,request(routed,id),{interactionJournal:createNativeInteractionJournal(path),settingsResolver:null,cleanup:{now:()=>now,report:()=>assert.fail('cleanup failed')}});
async function custody(path:string,timeout=5000){const port=createNativeInteractionJournal(path,timeout),admitted=await admitOriginalInteractionJournal(path,input(),{kind:'Ordinary'},port);assert.ok(admitted.owner);await admitted.owner.acknowledge(2);return ExecutionCustody.begin(path,path,key,'Execute',{interactionJournal:port,identity,now:()=>3,report:()=>assert.fail('cleanup failed')});}
const sleep=new URL('data:text/javascript,'+encodeURIComponent("import {parentPort} from 'node:worker_threads';setTimeout(()=>parentPort.postMessage(true),250);"));
test('native stage, execution, read, result and confirmation preserve large identity and immutable outcome',()=>storeFixture(async path=>{
 await init(path);const port=createNativeInteractionJournal(path),q=input(),pending=admitOriginalInteractionJournal(path,q,{kind:'Ordinary'},port);q.payload.request_rejection='changed' as never;q.ownerUserId=9n;const {owner,admission}=await pending;assert.ok(owner);assert.equal(admission.record!.ownerUserId,2n);assert.equal((admission.record!.payload as any).request_rejection,null);await owner.acknowledge(2);
 const c=await ExecutionCustody.begin(path,path,key,'Execute',{interactionJournal:port,identity,now:()=>3,report:()=>{}}),value={answer:'original',large:eventId};try{const result=c.recordResult(value);value.answer='changed';await result;await c.finishSuccess({ignored:true});}finally{await c.dispose();}
 const row=(await getIngress(path,key))!;assert.equal(row.confirmationDelivered,true);assert.deepEqual(row.outcome,{answer:'original',large:eventId});assert.equal((await admitOriginalInteractionJournal(path,input(),{kind:'Ordinary'},port)).owner,null);
}));
test('existing native boundaries never initialize missing stores',()=>storeFixture(async path=>{
 await assert.rejects(stage(path),NativeInteractionJournalUnavailableError);assert.equal(existsSync(path),false);
}));
test('native mapped admission freezes mapping inside original transaction and remap blocks begin',()=>storeFixture(async path=>{
 await init(path);edit(path,"INSERT INTO mirror_threads VALUES ('original','p','title',99,1,1)");const staged=await stage(path,work('ask'));assert.equal(staged.kind,'Created');if(staged.kind!=='Created')throw Error('fixture');await staged.custody.acknowledge();staged.custody.intoReceipt();edit(path,"UPDATE mirror_threads SET codex_thread_id='replacement'");
 await assert.rejects(ExecutionCustody.begin(path,path,key,'Execute',{interactionJournal:createNativeInteractionJournal(path),identity,report:()=>{}}),NativeInteractionJournalUnavailableError);assert.equal((await getIngress(path,key))!.targetThreadId,'original');
}));
test('busy native admission keeps frozen choice, canonical ingress manual review and prompt confirmation retry',()=>storeFixture(async path=>{
 await init(path);edit(path,`INSERT INTO busy_choices VALUES ('${choiceId}',2,1,'target','original',0,0,10,NULL,0)`);const routed=work('help','codex_busy:'+choiceId+':queue'),first=await stage(path,routed);assert.equal(first.kind,'Created');if(first.kind!=='Created')throw Error('fixture');first.custody.intoReceipt();edit(path,'DELETE FROM busy_choices');
 const repeat=await stage(path,routed,eventId+1n,50);assert.equal(repeat.kind,'CanonicalRepeat');if(repeat.kind!=='CanonicalRepeat')throw Error('fixture');assert.equal(repeat.confirmationReady,false);assert.equal(repeat.receipt.busyChoice!.prompt,'original');
 const db=new DatabaseSync(path);try{db.prepare("INSERT INTO discord_ingress_owner_receipts VALUES (?,'prompt','job','target',1,2,?,1)").run('busy-choice:'+choiceId,serializeBusyChoice({...repeat.receipt.busyChoice!,prompt:'receipt'}));}finally{db.close();}
 const prompt=await stage(path,routed,eventId+2n,50);assert.equal(prompt.kind,'CanonicalRepeat');if(prompt.kind!=='CanonicalRepeat')throw Error('fixture');assert.equal(prompt.confirmationReady,true);assert.equal(prompt.receipt.busyChoice!.prompt,'receipt');
 const id={...identity,ingressId:`interaction:${eventId+2n}`,eventId:eventId+2n},c=await ExecutionCustody.begin(path,path,id.ingressId,'ConfirmationOnly',{interactionJournal:createNativeInteractionJournal(path),identity:id,now:()=>51,report:()=>{}});await c.finishSuccess({confirmed:true});await c.dispose();assert.equal((await getIngress(path,id.ingressId))!.confirmationDelivered,true);
 const unavailable=await stage(path,work('help','codex_busy:'+'b'.repeat(24)+':queue'),eventId+3n);assert.deepEqual(unavailable,{kind:'BusyChoiceUnavailable'});
}));
test('public stages, reads, begins and completions refuse saturation; original owners wait in bounded FIFO',()=>storeFixture(async path=>{
 await init(path);const c=await custody(path),port=createNativeInteractionJournal(path),blocker=new OwnedWorkerSlot('Control'),pending=blocker.run(sleep,{},1000);
 await assert.rejects(port.admit(path,{...input(),ingressId:`interaction:${eventId+1n}`,eventId:eventId+1n},{kind:'Ordinary'}),OwnedWorkerBudgetError);
 await assert.rejects(port.read(path,key,identity),OwnedWorkerBudgetError);await assert.rejects(port.begin(path,key,identity,'Execute',3),OwnedWorkerBudgetError);await assert.rejects(port.result(path,key,identity,{},3),OwnedWorkerBudgetError);
 const saved=c.recordResult({saved:true});let settled=false;void saved.then(()=>settled=true);await new Promise(r=>setTimeout(r,30));assert.equal(settled,false);await pending;await blocker.join();await saved;await c.finishSuccess({ignored:true});await c.dispose();assert.equal(ownedWorkerUsage().Control,0);
}));
test('staged ACK and cancellation hold alone may wait behind occupied Control',()=>storeFixture(async path=>{
 await init(path);const s=await stage(path);if(s.kind!=='Created')throw Error('fixture');const blocker=new OwnedWorkerSlot('Control'),blocked=blocker.run(sleep,{},1000),ack=s.custody.acknowledge(),disposed=s.custody.dispose();await new Promise(r=>setTimeout(r,30));assert.equal((await getIngress(path,key))!.state,'staged');await blocked;await blocker.join();await ack;await disposed;assert.equal((await getIngress(path,key))!.holdReason,'interaction_dispatch_cancelled');
}));
test('finite completion FIFO refuses without submitting a replacement result',()=>storeFixture(async path=>{
 await init(path);const c=await custody(path),blocker=new OwnedWorkerSlot('Control'),active=blocker.run(sleep,{},1000),abort=new AbortController(),waiters=Array.from({length:OWNED_COMPLETION_QUEUE_LIMIT},()=>new OwnedWorkerSlot('Control')),pending=waiters.map(slot=>slot.runControlCompletion(sleep,{},1000,abort.signal).catch(e=>e));
 try{await assert.rejects(c.recordResult({notSubmitted:true}),NativeInteractionJournalUnavailableError);assert.equal((await getIngress(path,key))!.outcome,undefined);}finally{abort.abort(Error('fixture'));await Promise.all(pending);await Promise.all(waiters.map(s=>s.join()));await active;await blocker.join();await c.dispose();}assert.equal(ownedWorkerUsage().Control,0);
}));
for(const operation of ['Admit','Result','Confirm'] as const)test(`lost ${operation} ACK joins actual exit and cannot authorize replay`,()=>storeFixture(async path=>{
 await init(path);const c=operation==='Admit'?null:await custody(path);if(operation==='Confirm')await c!.recordResult({saved:true});const trace=new SharedArrayBuffer(8),extension=import.meta.url.endsWith('.js')?'.js':'.ts',restore=instrumentStoreWorker({match:'interaction-worker/native-journal-worker'+extension,trace,ack:'drop'});
 const pending=operation==='Admit'?stage(path):operation==='Result'?c!.recordResult({saved:true}):c!.finishSuccess({ignored:true}),rejected=assert.rejects(pending,NativeInteractionJournalUnavailableError);
 try{await waitTrace(trace);assert.equal(ownedWorkerUsage().Control,1);releaseTrace(trace);await rejected;}finally{restore();releaseTrace(trace);await pending.catch(()=>{});}
 if(c!==null)await c.dispose();assert.deepEqual(await stage(path),{kind:'Duplicate'});assert.equal(ownedWorkerUsage().Control,0);
}));
test('late committed result is joined before cancellation disposal, preserves outcome and never replays',()=>storeFixture(async path=>{
 await init(path);const c=await custody(path,400),db=new DatabaseSync(path);db.exec('BEGIN IMMEDIATE');const pending=c.recordResult({late:true}),rejects=assert.rejects(pending,NativeInteractionJournalUnavailableError),disposed=c.dispose();let settled=false;void disposed.then(()=>settled=true);
 try{await new Promise(r=>setTimeout(r,550));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Control,1);db.exec('ROLLBACK');await rejects;await disposed;const row=(await getIngress(path,key))!;assert.equal(row.state,'held');assert.deepEqual(row.outcome,{late:true});assert.deepEqual(await stage(path),{kind:'Duplicate'});}finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();await pending.catch(()=>{});await disposed;}
}));
test('crossed operation, path, original identity, owner origin and malformed ACK are rejected',async t=>storeFixture(async path=>{
 await init(path);const run=OwnedWorkerSlot.prototype.run;let corrupt:(raw:any)=>void=()=>{};t.mock.method(OwnedWorkerSlot.prototype,'run',async function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const raw=await run.apply(this,args);corrupt(raw);return raw;});
 const port=createNativeInteractionJournal(path);await port.admit(path,input(),{kind:'Ordinary'});
 for(corrupt of [(r:any)=>r.operation='Confirm', (r:any)=>r.path='elsewhere', (r:any)=>r.identity.applicationId=8n, (r:any)=>r.identity.eventId=8n, (r:any)=>r.origin='other', (r:any)=>r.ownerKind='execution', (r:any)=>r.requestId='old', (r:any)=>r.value=1,(r:any)=>{r.value.ownerUserId=99n;r.value.payloadJson='{"request_rejection":null}';},(r:any)=>{r.value.ingressId='interaction:99';r.value.eventId=99n;},(r:any)=>r.value.kind='message'])await assert.rejects(port.read(path,key,identity),NativeInteractionJournalUnavailableError);
}));
test('same-file symlink is accepted; different stores cannot begin or mint execution custody',()=>storeFixture(async path=>storeFixture(async other=>{
 await init(path);await init(other);const port=createNativeInteractionJournal(path);await port.admit(path,input(),{kind:'Ordinary'});const alias=path+'.alias';await symlink(path,alias);
 try{await assert.rejects(ExecutionCustody.begin(other,path,key,'Execute',{interactionJournal:createNativeInteractionJournal(other),identity,report:()=>{}}),/different worker database/);const c=await ExecutionCustody.begin(path,alias,key,'Execute',{interactionJournal:port,identity,report:()=>{}});await c.dispose();}finally{await unlink(alias);}
})));
test('known cleanup confirmation failure preserves outcome through original native hold',()=>storeFixture(async path=>{
 await init(path);const c=await custody(path),outcome={kind:'mirror_cleanup_refused',version:1n,sync_completed:false,delete_dispatched:false,earlier_changes_possible:true,blocked_room_id:9n,protection_reason:'queued requests'};await c.recordResult(outcome);edit(path,"CREATE TRIGGER deny_confirm BEFORE UPDATE OF confirmation_delivered ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'fixture'); END");
 await assert.rejects(c.finishNotification({ignored:true}),e=>cleanupNotificationFailureInfo(e)?.holdSaved===true);await c.dispose();const row=(await getIngress(path,key))!;assert.equal(row.state,'held');assert.deepEqual(row.outcome,outcome);assert.match(row.holdReason,/Recovery boundary: notification delivery confirmed; ingress confirmation write failed$/);
}));
test('captured functions and original owner cannot be replaced by foreign ports or forged owners',()=>storeFixture(async path=>{
 await init(path);const source=createNativeInteractionJournal(path),port=captureInteractionJournal(path,source),{owner}=await admitOriginalInteractionJournal(path,input(),{kind:'Ordinary'},port);assert.ok(owner);assert.throws(()=>owner.require(path,key,captureInteractionJournal(path)),/differs/);assert.throws(()=>new OriginalInteractionJournal(Symbol(),path,key,identity,port,'staged'),TypeError);assert.throws(()=>captureInteractionJournal('elsewhere',port),/another database/);await owner.hold('fixture',true,2);
}));

test('native rejection read preserves exact actor/work checks only when rejection is present',()=>storeFixture(async path=>{
 await init(path);const c=await custody(path),envelope={channelId:1n,userId:2n,work:work()};try{
  edit(path,"UPDATE discord_ingress_journal SET payload_json=json_set(payload_json,'$.request_rejection','original rejection')");assert.equal(await c.requestRejection(envelope as never),'original rejection');await assert.rejects(c.requestRejection({...envelope,userId:9n} as never),/identity changed/);
  edit(path,"UPDATE discord_ingress_journal SET payload_json=json_set(payload_json,'$.work.Slash.name','where')");await assert.rejects(c.requestRejection(envelope as never),/identity changed/);edit(path,"UPDATE discord_ingress_journal SET payload_json=json_remove(payload_json,'$.request_rejection')");assert.equal(await c.requestRejection({...envelope,userId:9n} as never),null);
 }finally{await c.dispose();}
}));
test('native result retains Stop and New evidence, and cancellation defeats late replacement',()=>storeFixture(async path=>{
 await init(path);const c=await custody(path);edit(path,`UPDATE discord_ingress_journal SET target_thread_id='target',phase='stop_accepted',outcome_json='{"accepted":true,"new_creation":{"version":1},"new_input":{"prompt":"original"}}'`);
 await c.recordResult({response:'done',stop_receipt:'replace',new_creation:'replace'});const saved=(await getIngress(path,key))!.outcome as any;assert.equal(saved.stop_receipt.accepted,true);assert.deepEqual(saved.new_creation,{version:1n});assert.deepEqual(saved.new_input,{prompt:'original'});
 edit(path,"UPDATE discord_ingress_journal SET state='owned',phase='cancelled',owner_kind='prompt',owner_id='job'; INSERT INTO codex_request_cancellations VALUES ('job','target',1,2,3,3)");await assert.rejects(c.recordResult({response:'late'}),NativeInteractionJournalUnavailableError);assert.deepEqual((await getIngress(path,key))!.outcome,saved);await c.dispose();
}));
test('malformed admission ACK never mints staged custody or replays a committed admission',async t=>storeFixture(async path=>{
 await init(path);const run=OwnedWorkerSlot.prototype.run;let corrupt=true;t.mock.method(OwnedWorkerSlot.prototype,'run',async function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const raw=await run.apply(this,args) as any;if(corrupt&&String(args[0]).endsWith('/interaction-worker/native-journal-worker.ts')&&(args[1] as any).operation==='Admit'){corrupt=false;raw.value.record.applicationId=99n;}return raw;});
 await assert.rejects(stage(path),NativeInteractionJournalUnavailableError);assert.equal((await getIngress(path,key))!.state,'staged');assert.deepEqual(await stage(path),{kind:'Duplicate'});
}));

test('validated execution canonical path survives worker-path symlink retargeting before native submission',async t=>storeFixture(async path=>storeFixture(async other=>{
 await init(path);await init(other);await createNativeInteractionJournal(path).admit(path,input(),{kind:'Ordinary'});await createNativeInteractionJournal(other).admit(other,input(),{kind:'Ordinary'});const alias=path+'.worker-alias';await symlink(path,alias);const port=createNativeInteractionJournal(alias),run=OwnedWorkerSlot.prototype.run;let changed=false;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(!changed&&String(args[0]).endsWith('/interaction-worker/native-journal-worker.ts')&&(args[1] as any).operation==='Begin'){changed=true;unlinkSync(alias);symlinkSync(other,alias);}return run.apply(this,args);});
 try{const c=await ExecutionCustody.begin(alias,path,key,'Execute',{interactionJournal:port,identity,report:()=>{}});assert.equal((await getIngress(path,key))!.state,'executing');assert.equal((await getIngress(other,key))!.state,'staged');await c.dispose();assert.equal((await getIngress(path,key))!.state,'held');assert.equal((await getIngress(other,key))!.state,'staged');}finally{await unlink(alias);}
})));
