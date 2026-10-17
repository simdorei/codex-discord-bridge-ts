import {boundedSerdeByteCount} from '../../../src/core/serde-byte-count.ts';
import {recoveryDecisionBinding,encodeRecoverySnapshot,parseRecoverySnapshot,RECOVERY_DECISION_REQUEST_BYTES,RECOVERY_DECISION_REPLY_BYTES} from '../../../src/runtime/component-worker/recovery-decision-native-snapshot.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {nativeRecoveryFixture,proposalId,interactionId,type Flow} from '../../helpers/native-recovery-decision-fixture.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {work,enqueue} from '../../helpers/interaction-worker-fixture.ts';
import {asyncChoiceServer} from '../../helpers/async-choice-server.ts';
import {AdmissionGate,AdmissionPermit,DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {OwnedWorkerSlot,ownedWorkerUsage,OwnedWorkerBudgetError} from '../../../src/runtime/owned-worker-slot.ts';
import {NativeRecoveryDecisionOwner,NativeRecoveryDecisionUnknownError,NativeRecoveryDecisionReadError} from '../../../src/runtime/component-worker/recovery-decision-native.ts';
import {captureRecoveryDecisionClick,recoverySnapshot} from '../../../src/store/recovery-decision-binding.ts';
import {componentWorkerErrorInfo} from '../../../src/runtime/component-worker/errors.ts';
import {RuntimeCommandExecutor} from '../../../src/runtime/action-executor/command-executor.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';
import {AppServerTurnBackend} from '../../../src/runtime/app-server-turn-backend.ts';
import {createInteractionProcessor} from '../../../src/runtime/interaction-worker/processor.ts';
import {ExecutionCustody} from '../../../src/runtime/interaction-worker/execution-custody.ts';
import {runInteractionWorker} from '../../../src/runtime/interaction-worker/worker.ts';
import {createInteractionWorkQueue} from '../../../src/runtime/discord-dispatch/interaction-work.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {parseSerdeValue} from '../../../src/core/serde-json-parse.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {parseStoredPublicationProposal,serializeStoredPublicationProposal,publicationDigest} from '../../../src/store/publication-codec.ts';
import {parseStoredAbandonmentProposal,serializeStoredAbandonmentProposal} from '../../../src/store/abandonment-codec.ts';
import {InteractionWorkerError,interactionErrorDisposition} from '../../../src/runtime/interaction-worker/errors.ts';
import {NativeCompletionReceiptStore} from '../../../src/runtime/completion/native-receipt-store.ts';
const native=(url:URL)=>/\/recovery-decision-native-worker\.(?:ts|js)$/.test(String(url));
const unknown=(error:unknown)=>componentWorkerErrorInfo(error)?.kind==='RecoveryDecisionUnconfirmed';
const flows:Flow[]=['Publication','Abandonment'];
const poison=(t:any)=>{for(const name of ['deliveredPublicationProposal','authorizeAbandonmentDecision','recordPublicationConsent','recordAbandonmentDecision','getIngress','beginDeliveryReceipt','confirmDeliveryReceipt','releaseRejectedDelivery','blockRejectedDelivery'])t.mock.method(state,name,()=>assert.fail(`main-thread fallback ${name}`));};
const installed=(f:any,server:any)=>{
 const codex=join(dirname(f.path),'codex.sqlite'),bridgePath=join(dirname(f.path),'bridge.json'),db=new DatabaseSync(codex);db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');db.close();
 const bridge=new BridgeState(bridgePath),backend=new AppServerTurnBackend(server,()=> 'fixture',{resumeTimeoutMs:1000,historyTimeoutMs:1000}),queue=new QueueStartCoordinator(f.path,backend,{notifyDeliveryReady:()=>assert.fail('no queue notification')});return new RuntimeCommandExecutor({paths:{state:codex,mirror:f.path,bridge:bridgePath},bridge,server,backend,queue,render:()=> 'fixture',preparePrompt:async p=>p,mirror:null,reportNewAttempt:()=>{},resumeTimeoutMs:1000});
};
for(const flow of flows)for(const choice of ['a','h'] as const)test(`installed ${flow} ${choice} records original decision before HTTP with native receipt and no live action`,async t=>nativeRecoveryFixture(flow,choice,async f=>asyncChoiceServer({},async(server,_q,seen)=>{
 poison(t);const operations:any[]=[],receipts:any[]=[],run=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion;
 for(const [name,original]of [['run',run],['runControlCompletion',complete]] as const)t.mock.method(OwnedWorkerSlot.prototype,name,function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(native(args[0]))operations.push({lane:name,...args[1] as any});if(String(args[0]).includes('native-receipt-store-worker'))receipts.push({lane:name,...args[1] as any});return original.apply(this,args);});
 const executor=installed(f,server);
 const send=DiscordChannelClient.prototype.sendValidated;t.mock.method(DiscordChannelClient.prototype,'sendValidated',async function(this:DiscordChannelClient,...args:Parameters<typeof send>){assert.equal(f.count(),1);const row=f.db.prepare('SELECT outcome_json FROM discord_ingress_journal WHERE ingress_id=?').get(f.w.custodyIngressId)!;assert.equal(JSON.parse(String(row.outcome_json)).action_completed,true);return send.apply(this,args);});
 const clear=DiscordChannelClient.prototype.clearMessageComponents;t.mock.method(DiscordChannelClient.prototype,'clearMessageComponents',async function(this:DiscordChannelClient,...args:Parameters<typeof clear>){assert.equal(f.db.prepare('SELECT count(*) AS n FROM codex_delivery_receipts WHERE message_id IS NOT NULL').get()!.n,1);return clear.apply(this,args);});
 f.db.prepare("UPDATE discord_ingress_journal SET state='acknowledged',phase='acknowledged' WHERE ingress_id=?").run(f.w.custodyIngressId);
 const q=createInteractionWorkQueue();enqueue(q,f.w);q.sender.dispose();const reports:string[]=[];
 await runInteractionWorker(q,f.path,f.http,{process:createInteractionProcessor(f.path,server,f.http,executor.interactionServices(f.http)),notifyDeliveryReady:()=>{},report:(_code,text)=>reports.push(text)});
 assert.deepEqual(reports,[]);assert.deepEqual(f.httpSeen,['POST','PATCH']);assert.deepEqual(await seen(),[]);assert.equal(f.count(),1);assert.equal(f.count('cdr_async_recovery_policies'),1);assert.equal(f.count('codex_turn_queue'),flow==='Abandonment'&&choice==='a'?0:1);assert.equal(f.count('codex_request_cancellations'),flow==='Abandonment'&&choice==='a'?1:0);
 assert.deepEqual(operations.map(x=>[x.lane,x.operation]),[['run','Read'],['run','Read'],['run','Ingress'],['run','Decide']]);assert.ok(operations.every(x=>x.interactionId===interactionId&&x.interactionIngressId===`interaction:${interactionId}`&&x.applicationId===4n&&x.actorId===2n&&x.channelId===1n&&x.sourceMessageId===9n&&x.proposalId===proposalId&&x.revision===1n&&x.processingMode==='Execute'));
 assert.deepEqual(receipts.map(x=>[x.lane,x.operation]),[['run','Begin'],['runControlCompletion','Confirm']]);assert.deepEqual(parseSerdeValue(receipts[0].key),[1n,flow==='Publication'?'recovery-publication-intent-confirmation-v1':'recovery-abandonment-confirmation-v1',proposalId+':1',0n]);assert.equal(receipts[0].guard,null);assert.equal(ownedWorkerUsage().Control,0);
})));
for(const flow of flows)test(`${flow} passive capture pins original click before await and ignores hostile owner overrides`,async t=>nativeRecoveryFixture(flow,'h',async f=>{
 let hooks=0;class Hostile extends NativeRecoveryDecisionOwner {override async read(..._args:Parameters<NativeRecoveryDecisionOwner['read']>):ReturnType<NativeRecoveryDecisionOwner['read']>{hooks++;throw Error('override');}override capture(..._args:Parameters<NativeRecoveryDecisionOwner['capture']>):ReturnType<NativeRecoveryDecisionOwner['capture']>{hooks++;throw Error('override');}}
 const owner=new Hostile(f.path),w={...f.w},run=OwnedWorkerSlot.prototype.run;let first:any;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(native(args[0])&&!first){first=args[1];w.userId=88n;w.interactionId=99n;w.custodyIngressId='interaction:99';}return run.apply(this,args);});
 try{await f.call(w,()=>f.now,owner);assert.equal(first.interactionId,interactionId);assert.equal(first.actorId,2n);assert.equal(hooks,0);assert.equal(f.count(),1);}finally{await owner.close();}
}));
for(const flow of flows)test(`${flow} exact replay after expiry differs from a new same-choice click`,async()=>nativeRecoveryFixture(flow,'h',async f=>{
 const first=await f.call();f.db.prepare("UPDATE discord_ingress_journal SET state='completed',phase='done' WHERE ingress_id=?").run(f.w.custodyIngressId);assert.deepEqual(await f.call(f.w,()=>f.now+1000),first);
 const w=f.click(interactionId+1n);f.insert(w);try{if(flow==='Publication'){assert.deepEqual(await f.call(w),first);await assert.rejects(f.call(w,()=>f.now+1000),unknown);}else await assert.rejects(f.call(w),NativeRecoveryDecisionReadError);assert.equal(f.count(),1);}finally{w.admissionPermit!.release();}
}));
for(const flow of flows)test(`${flow} original ingress change immediately before native transaction is rejected atomically`,async t=>nativeRecoveryFixture(flow,'h',async f=>{
 const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(native(args[0])&&(args[1] as any).operation==='Decide')f.db.prepare('UPDATE discord_ingress_journal SET event_id=? WHERE ingress_id=?').run(interactionId+2n,f.w.custodyIngressId);return run.apply(this,args);});
 await assert.rejects(f.call(),unknown);assert.equal(f.count(),0);assert.equal(f.count('codex_turn_queue'),1);assert.equal(f.count('codex_request_cancellations'),0);
}));
test('publication full canonical seal is compared inside mutation, not merely ACK echo',async t=>nativeRecoveryFixture('Publication','a',async f=>{
 const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(native(args[0])&&(args[1] as any).operation==='Decide'){
  const q=args[1] as any,stored=parseStoredPublicationProposal(q.sealJson),changed=serializeStoredPublicationProposal({...stored,review_context:{changed:true}});f.db.exec('DROP TRIGGER cdr_recovery_publication_proposal_immutable');f.db.prepare('UPDATE cdr_recovery_publication_proposals SET seal_json=?,seal_sha256=?').run(changed,publicationDigest(changed));f.db.exec("CREATE TRIGGER cdr_recovery_publication_proposal_immutable BEFORE UPDATE ON cdr_recovery_publication_proposals BEGIN SELECT RAISE(ABORT,'publication proposal is immutable'); END");
 }return run.apply(this,args);});await assert.rejects(f.call(),unknown);assert.equal(f.count(),0);
}));
for(const flow of flows)test(`${flow} evidence drift before mutation and trigger side effects roll back with no replay`,async t=>nativeRecoveryFixture(flow,'a',async f=>{
 f.db.exec(`CREATE TRIGGER sabotage AFTER INSERT ON ${f.table} BEGIN UPDATE codex_turn_queue SET last_error='changed'; END`);
 await assert.rejects(f.call(),unknown);assert.equal(f.count(),0);assert.equal(f.count('codex_turn_queue'),1);assert.equal(f.count('codex_request_cancellations'),0);assert.equal(f.db.prepare('SELECT last_error FROM codex_turn_queue').get()!.last_error,'');f.db.exec('DROP TRIGGER sabotage');await assert.rejects(f.call(),unknown);assert.equal(f.count(),0);
}));
for(const flow of flows)for(const operation of ['Read','Ingress','Decide'] as const)test(`${flow} lost ${operation} acknowledgement never implies success or automatic replay`,async t=>nativeRecoveryFixture(flow,'h',async f=>{
 const run=OwnedWorkerSlot.prototype.run;let lost=false;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);if(native(args[0])&&(args[1] as any).operation===operation&&!lost){lost=true;return pending.then(()=>{throw Error('lost ACK');});}return pending;});
 if(operation==='Decide'){let failure:any;try{await f.call();assert.fail('must be uncertain');}catch(error){assert.ok(unknown(error));assert.equal(interactionErrorDisposition(new InteractionWorkerError('Component',error)),'LogOnly');failure=componentWorkerErrorInfo(error)!.source;}assert.doesNotMatch(String(failure),/not recorded/);assert.equal(f.count(),1);const recovered=await f.owner.recover(failure.handle);assert.equal(recovered.decision,'KeepHeld');await f.call();await assert.rejects(f.owner.decide(failure.handle,f.now),NativeRecoveryDecisionUnknownError);assert.equal(f.count(),1);}
 else {await assert.rejects(f.call(),NativeRecoveryDecisionReadError);assert.equal(f.count(),0);await f.call();assert.equal(f.count(),1);}
 assert.deepEqual(f.httpSeen,[]);
}));
for(const field of ['id','path','operation','flow','decision','proposalId','revision','interactionIngressId','interactionId','applicationId','actorId','channelId','sourceMessageId','customId','processingMode','sealJson','displayedJson','now','value'])test(`decision ACK exact ${field} binding cannot mint confirmation`,async t=>nativeRecoveryFixture('Publication','a',async f=>{
 const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);return native(args[0])&&(args[1] as any).operation==='Decide'?pending.then(raw=>({...raw as any,[field]:typeof(raw as any)[field]==='bigint'?(raw as any)[field]+1n:'crossed'})):pending;});await assert.rejects(f.call(),unknown);assert.equal(f.count(),1);await f.call();assert.equal(f.count(),1);
}));
for(const flow of flows)test(`${flow} missing receipt remains unknown and recovery cannot authorize another handle or flow`,async t=>nativeRecoveryFixture(flow,'a',async f=>{
 f.db.exec(`CREATE TRIGGER refuse BEFORE INSERT ON ${f.table} BEGIN SELECT RAISE(IGNORE); END`);let failure:any;try{await f.call();assert.fail('expected uncertain result');}catch(error){failure=componentWorkerErrorInfo(error)!.source;assert.ok(failure instanceof NativeRecoveryDecisionUnknownError);}
 assert.equal(await f.owner.recover(failure.handle),null);f.db.exec('DROP TRIGGER refuse');assert.equal(await f.owner.recover(failure.handle),null);await assert.rejects(f.owner.recover({proposalId}));assert.throws(()=>f.owner.capture({...f.w,work:{Component:{RecoveryPublicationDecision:{proposal_id:'e'.repeat(32),revision:1n,decision:'KeepHeld'}}}}, {RecoveryPublicationDecision:{proposal_id:'e'.repeat(32),revision:1n,decision:'KeepHeld'}}),NativeRecoveryDecisionUnknownError);await assert.rejects(f.call(),unknown);assert.equal(f.count(),0);
}));
test('AbandonOnly recovery rechecks exact tombstone and queue absence',async t=>nativeRecoveryFixture('Abandonment','a',async f=>{
 const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);return native(args[0])&&(args[1] as any).operation==='Decide'?pending.then(()=>{throw Error('lost ACK');}):pending;});let failure:any;try{await f.call();assert.fail('expected uncertain');}catch(error){failure=componentWorkerErrorInfo(error)!.source;}
 assert.equal((await f.owner.recover(failure.handle)).decision,'AbandonOnly');const trigger=String(f.db.prepare("SELECT sql FROM sqlite_master WHERE name='cdr_recovery_abandonment_cancellation_no_delete'").get()!.sql);f.db.exec('DROP TRIGGER cdr_recovery_abandonment_cancellation_no_delete; DELETE FROM codex_request_cancellations');f.db.exec(trigger);await assert.rejects(f.owner.recover(failure.handle),NativeRecoveryDecisionReadError);assert.equal(f.count('codex_turn_queue'),0);await assert.rejects(f.call(),unknown);
}));
for(const flow of flows)test(`${flow} confirmed receipt retries only original button clear and no POST or decision`,async t=>nativeRecoveryFixture(flow,'h',async f=>{
 const clear=DiscordChannelClient.prototype.clearMessageComponents;let failed=false;t.mock.method(DiscordChannelClient.prototype,'clearMessageComponents',function(this:DiscordChannelClient,...args:Parameters<typeof clear>){if(!failed){failed=true;return Promise.reject(Error('clear failed'));}return clear.apply(this,args);});
 const prepared=await f.prepare(f.w,f.w.work.Component);await assert.rejects(prepared.deliver(),e=>componentWorkerErrorInfo(e)?.kind===(flow==='Abandonment'?'AbandonmentNotice':'Confirmation'));assert.deepEqual(f.httpSeen,['POST']);await prepared.deliver();assert.deepEqual(f.httpSeen,['POST','PATCH']);assert.equal(f.count(),1);
}));
for(const operation of ['Read','Ingress','Decide'] as const)for(const mode of ['deadline','cancel'] as const)test(`${operation} ${mode} joins native exit and retains cloned admission and target lease`,async t=>nativeRecoveryFixture('Publication','h',async f=>{
 const run=OwnedWorkerSlot.prototype.run,blocker=new DatabaseSync(f.path),cancel=new AbortController();let started!:()=>void;const start=new Promise<void>(r=>{started=r;});
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(native(args[0])&&(args[1] as any).operation===operation){blocker.exec(operation==='Decide'?'BEGIN IMMEDIATE':'BEGIN EXCLUSIVE');const pending=run.call(this,args[0],args[1],mode==='deadline'?10:5000,mode==='cancel'?cancel.signal:args[3]);started();return pending;}return run.apply(this,args);});
 let settled=false,ticks=0;const timer=setInterval(()=>ticks++,2),task=f.call();void task.then(()=>settled=true,()=>settled=true);try{await Promise.race([start,task]);if(mode==='cancel')cancel.abort(Error('cancelled'));const key=DrainFenceKey.create('app','1|2','test');f.gate.seal(key);f.w.admissionPermit!.release();await new Promise(r=>setTimeout(r,35));assert.equal(settled,false);assert.equal(f.gate.isDrainedFor(key),false);assert.equal(ownedWorkerUsage().Control,1);assert.equal(f.locks.activeTargetCount,operation==='Read'?0:1);assert.ok(ticks>3);blocker.exec('ROLLBACK');await assert.rejects(task);assert.equal(f.gate.isDrainedFor(key),true);assert.equal(ownedWorkerUsage().Control,0);}finally{clearInterval(timer);if(blocker.isTransaction)blocker.exec('ROLLBACK');await task.catch(()=>{});blocker.close();}
}));
test('a read handle never grants completion FIFO authority when Control is saturated',async()=>nativeRecoveryFixture('Publication','h',async f=>{
 const handle=f.owner.capture(f.w,f.w.work.Component);await f.owner.read(handle,f.now);await f.owner.ingress(handle);const other=new NativeRecoveryDecisionOwner(f.path),blocker=new DatabaseSync(f.path);blocker.exec('BEGIN EXCLUSIVE');const pending=other.read(other.capture(f.w,f.w.work.Component),f.now);
 try{await assert.rejects(f.owner.decide(handle,f.now),OwnedWorkerBudgetError);blocker.exec('ROLLBACK');await pending;assert.equal(f.count(),0);await f.owner.decide(handle,f.now);assert.equal(f.count(),1);}finally{if(blocker.isTransaction)blocker.exec('ROLLBACK');await Promise.allSettled([pending]);await other.close();blocker.close();}
}));
test('owner close joins cancellation through actual exit and permanently refuses new work',async()=>nativeRecoveryFixture('Publication','h',async f=>{
 const handle=f.owner.capture(f.w,f.w.work.Component),blocker=new DatabaseSync(f.path);blocker.exec('BEGIN EXCLUSIVE');const task=f.owner.read(handle,f.now);let closed=false;const closing=f.owner.close().then(()=>{closed=true;});const rejected=assert.rejects(task,NativeRecoveryDecisionReadError);
 try{await new Promise(r=>setTimeout(r,35));assert.equal(closed,false);assert.equal(f.owner.busy,true);blocker.exec('ROLLBACK');await rejected;await closing;assert.equal(ownedWorkerUsage().Control,0);assert.throws(()=>f.owner.capture(f.w,f.w.work.Component),/closed/);}finally{if(blocker.isTransaction)blocker.exec('ROLLBACK');await Promise.allSettled([task,closing]);blocker.close();}
}));
for(const flow of flows)test(`${flow} missing database and incomplete schema stay untouched; hostile identity and oversized seals fail passively`,async()=>storeFixture(async path=>{
 const owner=new NativeRecoveryDecisionOwner(path),w=work(path,interactionId,new AdmissionGate(),`codex_${flow==='Publication'?'pub':'discard'}:v1:${proposalId}:1:a`);assert.ok('Component'in w.work);
 try{await assert.rejects(owner.read(owner.capture(w,w.work.Component),1),NativeRecoveryDecisionReadError);assert.equal(existsSync(path),false);const db=new DatabaseSync(path);db.close();await assert.rejects(owner.read(owner.capture(w,w.work.Component),1),NativeRecoveryDecisionReadError);const check=new DatabaseSync(path);try{assert.equal(check.prepare('SELECT count(*) AS n FROM sqlite_master').get()!.n,0);}finally{check.close();}
 let calls=0;assert.throws(()=>captureRecoveryDecisionClick({get interactionId(){calls++;return 1n;}}));assert.equal(calls,0);assert.throws(()=>captureRecoveryDecisionClick({interactionIngressId:'interaction:1',interactionId:1n,applicationId:4n,actorId:2n,channelId:1n,sourceMessageId:9n,customId:`codex_pub:v1:${proposalId}:1:a`,processingMode:'ConfirmationOnly'}));assert.throws(()=>recoverySnapshot('Publication','x'.repeat(524289),'{}'),RangeError);
 }finally{await owner.close();w.admissionPermit!.release();}
}));
test('native confirmation allowlist rejects preview domains, nonzero chunks and nonnull guards',()=>{
 for(const domain of ['recovery-publication-intent-confirmation-v1','recovery-abandonment-confirmation-v1']){assert.doesNotThrow(()=>new NativeCompletionReceiptStore('/tmp/unused',serializeSerdeValue([1n,domain,proposalId+':1',0n]),'a'.repeat(64),null));assert.throws(()=>new NativeCompletionReceiptStore('/tmp/unused',serializeSerdeValue([1n,domain,proposalId+':1',1n]),'a'.repeat(64),null));assert.throws(()=>new NativeCompletionReceiptStore('/tmp/unused',serializeSerdeValue([1n,domain,proposalId+':1',0n]),'a'.repeat(64),{jobId:'j',threadId:'t',turnId:'v'}));}
 for(const domain of ['recovery-publication-review-v1','recovery-abandonment-review-v1'])assert.throws(()=>new NativeCompletionReceiptStore('/tmp/unused',serializeSerdeValue([1n,domain,proposalId+':1',0n]),'a'.repeat(64),null));
});
for(const flow of flows)for(const operation of ['Begin','Confirm'] as const)test(`${flow} lost confirmation receipt ${operation} ACK cannot clear or replay the action`,async t=>nativeRecoveryFixture(flow,'h',async f=>{
 const lane=operation==='Begin'?'run':'runControlCompletion',run=OwnedWorkerSlot.prototype[lane];let lost=false;t.mock.method(OwnedWorkerSlot.prototype,lane,function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);if(String(args[0]).includes('native-receipt-store-worker')&&(args[1] as any).operation===operation&&!lost){lost=true;return pending.then(()=>{throw Error('lost receipt ACK');});}return pending;});
 const prepared=await f.prepare(f.w,f.w.work.Component);await assert.rejects(prepared.deliver());assert.deepEqual(f.httpSeen,operation==='Begin'?[]:['POST']);assert.equal(f.count(),1);
 if(operation==='Begin')await assert.rejects(prepared.deliver());else {await prepared.deliver();assert.deepEqual(f.httpSeen,['POST','PATCH']);}assert.equal(f.count(),1);
}));
for(const flow of flows)test(`${flow} changed evidence while waiting is rechecked without first decision`,async t=>nativeRecoveryFixture(flow,'h',async f=>{
 const run=OwnedWorkerSlot.prototype.run;let reads=0;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(native(args[0])&&(args[1] as any).operation==='Read'&&++reads===2)f.db.exec("UPDATE codex_turn_queue SET prompt='changed'");return run.apply(this,args);});await assert.rejects(f.call());assert.equal(f.count(),0);assert.equal(f.count('codex_turn_queue'),1);assert.equal(f.count('codex_request_cancellations'),0);
}));
test('lost explicit recovery ACK preserves exact handle and permanent cross-flow barrier',async t=>nativeRecoveryFixture('Publication','a',async f=>{
 const run=OwnedWorkerSlot.prototype.run;let recoveryLost=false;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);if(native(args[0])&&((args[1] as any).operation==='Decide'||(args[1] as any).operation==='Recover'&&!recoveryLost)){if((args[1] as any).operation==='Recover')recoveryLost=true;return pending.then(()=>{throw Error('lost ACK');});}return pending;});let failure:any;try{await f.call();assert.fail('expected unknown');}catch(error){failure=componentWorkerErrorInfo(error)!.source;}
 await assert.rejects(f.owner.recover(failure.handle),NativeRecoveryDecisionReadError);assert.equal((await f.owner.recover(failure.handle)).decision,'ApproveExact');await f.call();await assert.rejects(f.owner.decide(failure.handle,f.now),NativeRecoveryDecisionUnknownError);assert.equal(f.count(),1);
}));

test('abandonment full canonical seal is compared inside the original IMMEDIATE transaction',async t=>nativeRecoveryFixture('Abandonment','h',async f=>{
 const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(native(args[0])&&(args[1] as any).operation==='Decide'){
  const q=args[1] as any,stored=parseStoredAbandonmentProposal(q.sealJson),changed=serializeStoredAbandonmentProposal({...stored,source_ingress:'message:changed'}),name='cdr_recovery_abandonment_proposal_immutable';const trigger=String(f.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)!.sql);f.db.exec('DROP TRIGGER '+name);f.db.prepare('UPDATE cdr_recovery_abandonment_proposals SET seal_json=?,seal_sha256=?').run(changed,publicationDigest(changed));f.db.exec(trigger);
 }return run.apply(this,args);});await assert.rejects(f.call(),unknown);assert.equal(f.count(),0);assert.equal(f.count('codex_turn_queue'),1);
}));

test('maximum canonical escaped seal fits repeated-read transport without truncation',async()=>nativeRecoveryFixture('Publication','h',async f=>{
 const click=captureRecoveryDecisionClick({interactionIngressId:f.w.custodyIngressId,interactionId:f.w.interactionId,applicationId:4n,actorId:2n,channelId:1n,sourceMessageId:9n,customId:`codex_pub:v1:${proposalId}:1:h`,processingMode:'Execute'}),original=await f.owner.read(f.owner.capture(f.w,f.w.work.Component),f.now);
 const source=parseStoredPublicationProposal(original.sealJson),review='"'.repeat(28000),proposal={...source.proposal,review_text:review,review_sha256:publicationDigest(review)},base={...source,proposal,snapshot:{padding:''}};
 const length=Buffer.byteLength(serializeStoredPublicationProposal(base)),padding='"'.repeat(Math.floor((524288-length)/2));
 const seal=serializeStoredPublicationProposal({...base,snapshot:{padding}}),display=serializeSerdeValue({proposal,message_id:9n}),snapshot=recoverySnapshot('Publication',seal,display),value=encodeRecoverySnapshot(snapshot);
 assert.ok(Buffer.byteLength(seal)>=524286);assert.ok(Buffer.byteLength(seal)<=524288);assert.ok(Buffer.byteLength(display)<65536);
 const binding=recoveryDecisionBinding('00000000-0000-0000-0000-000000000000',f.path,'Read',click,seal,display,f.now),reply={...binding,ok:true,value};
 assert.notEqual(boundedSerdeByteCount(binding,RECOVERY_DECISION_REQUEST_BYTES),null);assert.equal(boundedSerdeByteCount(reply,2097152),null);assert.notEqual(boundedSerdeByteCount(reply,RECOVERY_DECISION_REPLY_BYTES),null);
 const decoded=parseRecoverySnapshot(value,click);assert.equal(decoded.sealJson,seal);assert.equal(decoded.displayedJson,display);assert.equal(decoded.proposal.review_text,review);assert.equal(f.count(),0);
}));

for(const flow of flows)for(const choice of ['a','h'] as const)test(`installed ${flow} ${choice} later exact-original prepare recovers read-only with live admission and retains the cross-flow barrier`,async t=>nativeRecoveryFixture(flow,choice,async f=>asyncChoiceServer({},async(server,_q,seen)=>{
 poison(t);const executor=installed(f,server),run=OwnedWorkerSlot.prototype.run,operations:string[]=[];
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);if(native(args[0])){const operation=(args[1] as any).operation;operations.push(operation);if(operation==='Decide')return pending.then(()=>{throw Error('lost decision ACK');});}return pending;});
 const prepare=()=>executor.interactionServices(f.http).prepareComponent!(f.w,f.w.work.Component);
 await assert.rejects(prepare(),unknown);assert.deepEqual(operations,['Read','Read','Ingress','Decide']);assert.equal(f.count(),1);assert.deepEqual(f.httpSeen,[]);
 const fresh=f.click(interactionId+1n),other=work(f.path,interactionId,f.gate,`codex_${flow==='Publication'?'discard':'pub'}:v1:${proposalId}:1:${choice}`);
 try{
  for(const changed of [fresh,other])await assert.rejects(executor.interactionServices(f.http).prepareComponent!(changed,changed.work.Component),unknown);
  const recovered=await prepare();assert.equal(typeof recovered.deliver,'function');assert.deepEqual(operations,['Read','Read','Ingress','Decide','Recover']);assert.deepEqual(f.httpSeen,[]);
  for(const changed of [fresh,other])await assert.rejects(executor.interactionServices(f.http).prepareComponent!(changed,changed.work.Component),unknown);
  await prepare();assert.deepEqual(operations,['Read','Read','Ingress','Decide','Recover','Recover']);assert.equal(f.count(),1);assert.deepEqual(await seen(),[]);
  assert.equal(f.count('codex_turn_queue'),flow==='Abandonment'&&choice==='a'?0:1);assert.equal(f.count('codex_request_cancellations'),flow==='Abandonment'&&choice==='a'?1:0);
 }finally{fresh.admissionPermit!.release();other.admissionPermit!.release();}
})));
for(const flow of flows)test(`${flow} installed explicit recovery lost read ACK remains unconfirmed without mutation`,async t=>nativeRecoveryFixture(flow,'h',async f=>{
 const run=OwnedWorkerSlot.prototype.run,operations:string[]=[];let loseRead=true;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);if(native(args[0])){const operation=(args[1] as any).operation;operations.push(operation);if(operation==='Decide'||operation==='Recover'&&loseRead){if(operation==='Recover')loseRead=false;return pending.then(()=>{throw Error('lost ACK');});}}return pending;});
 await assert.rejects(f.prepare(f.w,f.w.work.Component),unknown);await assert.rejects(f.prepare(f.w,f.w.work.Component),unknown);await f.prepare(f.w,f.w.work.Component);assert.deepEqual(operations,['Read','Read','Ingress','Decide','Recover','Recover']);assert.equal(f.count(),1);assert.deepEqual(f.httpSeen,[]);
}));
for(const flow of flows)test(`${flow} failed worker still holds ingress and releases original admission; explicit receipt preparation does not repair custody`,async t=>nativeRecoveryFixture(flow,'h',async f=>asyncChoiceServer({},async(server)=>{
 const executor=installed(f,server),run=OwnedWorkerSlot.prototype.run,operations:string[]=[],retained=AdmissionPermit.prototype.clone.call(f.w.admissionPermit);
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const pending=run.apply(this,args);if(native(args[0])){const operation=(args[1] as any).operation;operations.push(operation);if(operation==='Decide')return pending.then(()=>{throw Error('lost ACK');});}return pending;});
 try{
  f.db.prepare("UPDATE discord_ingress_journal SET state='acknowledged',phase='acknowledged' WHERE ingress_id=?").run(f.w.custodyIngressId);const q=createInteractionWorkQueue();enqueue(q,f.w);q.sender.dispose();
  await runInteractionWorker(q,f.path,f.http,{process:createInteractionProcessor(f.path,server,f.http,executor.interactionServices(f.http)),notifyDeliveryReady:()=>assert.fail('failed action cannot notify'),report:()=>{}});
  assert.equal(f.db.prepare('SELECT state FROM discord_ingress_journal WHERE ingress_id=?').get(f.w.custodyIngressId)!.state,'held');assert.deepEqual(f.httpSeen,[]);assert.equal(f.count(),1);
  await assert.rejects(executor.interactionServices(f.http).prepareComponent!(f.w,f.w.work.Component),error=>{assert.equal(componentWorkerErrorInfo(error)?.kind,flow==='Publication'?'RecoveryDecisionHeld':'Abandonment');assert.doesNotMatch(String(error),/not recorded|not stored/);return true;});assert.deepEqual(operations,['Read','Read','Ingress','Decide']);
  await assert.rejects(ExecutionCustody.begin(f.path,f.path,f.w.custodyIngressId,'Execute',{report:()=>{}}),/cannot begin/);
  await executor.interactionServices(f.http).prepareComponent!({...f.w,admissionPermit:retained},f.w.work.Component);assert.deepEqual(operations,['Read','Read','Ingress','Decide','Recover']);
  const row=f.db.prepare('SELECT state,outcome_json FROM discord_ingress_journal WHERE ingress_id=?').get(f.w.custodyIngressId)!;assert.equal(row.state,'held');assert.equal(row.outcome_json,null);assert.deepEqual(f.httpSeen,[]);
 }finally{retained.release();}
})));

for(const flow of flows)test(`${flow} installed explicit recovery absent receipt never retries a decision`,async t=>nativeRecoveryFixture(flow,'a',async f=>{
 const run=OwnedWorkerSlot.prototype.run,operations:string[]=[];t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(native(args[0]))operations.push((args[1] as any).operation);return run.apply(this,args);});
 f.db.exec(`CREATE TRIGGER refuse BEFORE INSERT ON ${f.table} BEGIN SELECT RAISE(IGNORE); END`);await assert.rejects(f.prepare(f.w,f.w.work.Component),unknown);f.db.exec('DROP TRIGGER refuse');
 await assert.rejects(f.prepare(f.w,f.w.work.Component),unknown);await assert.rejects(f.prepare(f.w,f.w.work.Component),unknown);assert.deepEqual(operations,['Read','Read','Ingress','Decide','Recover','Recover']);assert.equal(f.count(),0);assert.deepEqual(f.httpSeen,[]);
}));
for(const mode of ['deadline','cancel'] as const)test(`explicit recovery ${mode} joins real exit while retaining admission and original target lease`,async t=>nativeRecoveryFixture('Publication','h',async f=>{
 const run=OwnedWorkerSlot.prototype.run,blocker=new DatabaseSync(f.path),cancel=new AbortController();let started!:()=>void;const start=new Promise<void>(r=>{started=r;});
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(native(args[0])){const operation=(args[1] as any).operation;if(operation==='Decide')return run.apply(this,args).then(()=>{throw Error('lost ACK');});if(operation==='Recover'){blocker.exec('BEGIN EXCLUSIVE');const pending=run.call(this,args[0],args[1],mode==='deadline'?10:5000,mode==='cancel'?cancel.signal:args[3]);started();return pending;}}return run.apply(this,args);});
 await assert.rejects(f.prepare(f.w,f.w.work.Component),unknown);let settled=false;const task=f.prepare(f.w,f.w.work.Component);void task.then(()=>settled=true,()=>settled=true);
 try{await Promise.race([start,task]);if(mode==='cancel')cancel.abort(Error('cancelled'));const key=DrainFenceKey.create('app','1|2','retry');f.gate.seal(key);f.w.admissionPermit!.release();await new Promise(r=>setTimeout(r,35));assert.equal(settled,false);assert.equal(f.gate.isDrainedFor(key),false);assert.equal(f.locks.activeTargetCount,1);assert.equal(ownedWorkerUsage().Control,1);blocker.exec('ROLLBACK');await assert.rejects(task,unknown);assert.equal(f.gate.isDrainedFor(key),true);assert.equal(ownedWorkerUsage().Control,0);assert.equal(f.count(),1);assert.deepEqual(f.httpSeen,[]);}finally{if(blocker.isTransaction)blocker.exec('ROLLBACK');await task.catch(()=>{});blocker.close();}
}));
