import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import test,{type TestContext} from 'node:test';
import {abandonmentStoreFixture} from '../../helpers/abandonment-store-fixture.ts';
import {httpFixture} from '../../helpers/interaction-worker-fixture.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
import {AdmissionGate,DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {getIngressExisting} from '../../../src/store/ingress-read.ts';
import {createNativeMessageJournal,admitOriginalMessageJournal,OriginalMessageJournal} from '../../../src/runtime/message-worker/journal.ts';
import {MessageCustody} from '../../../src/runtime/message-worker/custody.ts';
import {NativeAbandonmentProposalOwner,NativeAbandonmentProposalUnknownError} from '../../../src/runtime/message-worker/abandonment-proposal-native.ts';
import {captureProposalOriginal,proposalBinding,captureProposal} from '../../../src/runtime/message-worker/abandonment-proposal-protocol.ts';
import {NativeCompletionReceiptStore} from '../../../src/runtime/completion/native-receipt-store.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {StoreAuthorityDomain} from '../../../src/store/store-authority-domain.ts';
import {abandonmentDecisionRows,serializeDiscordComponent} from '../../../src/discord/components.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {receiptHash} from '../../../src/store/delivery-receipt-key.ts';
const job='550e8400-e29b-41d4-a716-446655440000',extension=import.meta.url.endsWith('.js')?'.js':'.ts';
function message(event=8n,content='!discard-request '+job){return decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content,embeds:[],id:String(event),mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false,type:0}));}
function poison(t:TestContext){for(const name of ['abandonmentCommandTarget','getIngress','proposeAbandonment','bindAbandonmentDelivery','beginDeliveryReceipt','confirmDeliveryReceipt','releaseRejectedDelivery','blockRejectedDelivery','recordIngressResult','confirmIngress','holdIngress'] as const)t.mock.method(state,name,()=>assert.fail('synchronous facade '+name));}
async function fixture(run:(f:{db:Parameters<Parameters<typeof abandonmentStoreFixture>[0]>[0];path:string;c:MessageCustody;owner:OriginalMessageJournal;gate:AdmissionGate;permit:ReturnType<AdmissionGate['tryEnter']>;locks:TargetLocks;verifier:ControlTurnVerifier;m:ReturnType<typeof message>;http:DiscordChannelClient;seen:string[];propose:(signal?:AbortSignal)=>Promise<void>})=>Promise<void>,event=8n){return abandonmentStoreFixture(async(db,path)=>httpFixture(async(http,seen)=>{
 const m=message(event),key=`message:${event}`,journal=createNativeMessageJournal(path),{owner}=await admitOriginalMessageJournal(path,{ingressId:key,kind:'message',eventId:event,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:event,payload:{version:1n,content:m.content,author_is_bot:false,processing_mode:'normal',plan:{Execute:{DiscardRequest:{job_id:job}}}},targetThreadId:'t',canonicalOwner:null,now:100},journal);assert.ok(owner);
 const c=new MessageCustody(path,key,{messageJournal:journal,now:()=>200,report:()=>assert.fail('custody hold failed')},owner),gate=new AdmissionGate(),permit=gate.tryEnter(),locks=new TargetLocks(),verifier=new ControlTurnVerifier(path,null,{selectedThreadId:()=>null},locks);await c.begin('t');
 const propose=(signal?:AbortSignal)=>{const pending=c.nativeAbandonment(m,job,4n,permit,http,verifier,signal);assert.ok(pending);return pending;};
 try{await run({db,path,c,owner,gate,permit,locks,verifier,m,http,seen,propose});}finally{await c.dispose();permit.release();assert.equal(ownedWorkerUsage().Control,0);assert.equal(locks.activeTargetCount,0);}
}),true,job);}
const count=(db:Parameters<Parameters<typeof abandonmentStoreFixture>[0]>[0],table='cdr_recovery_abandonment_proposals')=>db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n;
function proposalCall(args:Parameters<OwnedWorkerSlot['run']>,op?:string){return String(args[0]).endsWith('/abandonment-proposal-native-worker.ts')&&(op===undefined||(args[1] as any).operation===op);}
function receiptCall(args:Parameters<OwnedWorkerSlot['run']>,op?:string){return String(args[0]).endsWith('/native-receipt-store-worker.ts')&&(op===undefined||(args[1] as any).operation===op);}
function receiptIdentity(p:any){const components=abandonmentDecisionRows(p.id,p.revision),logical=`${p.id}:${p.revision}`,key=serializeSerdeValue([p.channel_id,'recovery-abandonment-proposal-v1',logical,0n]),hash=receiptHash(`[${JSON.stringify(p.review_text)},[${components.map(serializeDiscordComponent).join(',')}]]`);return {key,hash};}

test('native exact original large event completes one POST, receipt, binding, result and finish with every facade poisoned',async t=>fixture(async f=>{
 poison(t);const ordinary=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion,ops:string[]=[];
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof ordinary>){if(proposalCall(args)||receiptCall(args))ops.push('fresh:'+(args[1] as any).operation);return ordinary.apply(this,args);});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){ops.push('completion:'+(args[1] as any).operation);if(proposalCall(args,'Bind'))assert.equal(f.locks.activeTargetCount,1);return complete.apply(this,args);});
 await f.propose();assert.deepEqual(f.seen,['POST']);assert.deepEqual(ops,['fresh:Route','fresh:Prepare','fresh:Begin','completion:Confirm','completion:Bind','completion:Result','completion:Confirm']);
 assert.equal(count(f.db),1);assert.equal(count(f.db,'cdr_recovery_abandonment_deliveries'),1);assert.equal(count(f.db,'cdr_recovery_abandonment_decisions'),0);assert.equal(count(f.db,'codex_turn_queue'),1);assert.equal(count(f.db,'cdr_async_recovery_policies'),1);
 const row=getIngressExisting(f.path,'message:9007199254740993')!;assert.equal(row.confirmationDelivered,true);assert.equal((row.outcome as any).kind,'abandonment_proposal');assert.throws(()=>f.propose(),/already consumed/);
},9007199254740993n));

test('forged journal, decoded-message copy and crossed original message cannot mint proposal custody',()=>fixture(async f=>{
 for(const owner of [Object.create(OriginalMessageJournal.prototype),{}])assert.throws(()=>new NativeAbandonmentProposalOwner(owner,f.path,f.m,job,4n),TypeError);
 assert.throws(()=>new NativeAbandonmentProposalOwner(f.owner,f.path,{...f.m},job,4n),/decoded/);assert.throws(()=>new NativeAbandonmentProposalOwner(f.owner,f.path,message(9n),job,4n),/original admission/);
 assert.throws(()=>new NativeAbandonmentProposalOwner(f.owner,f.path+'other',f.m,job,4n),/original admission/);assert.equal(count(f.db),0);assert.deepEqual(f.seen,[]);
}));

test('same genuine original journal cannot mint a second native owner, including after refusal',()=>fixture(async f=>{
 const owner=new NativeAbandonmentProposalOwner(f.owner,f.path,f.m,job,4n);
 assert.throws(()=>new NativeAbandonmentProposalOwner(f.owner,f.path,f.m,job,4n),/already consumed/);
 await assert.rejects(owner.run(null,f.http,f.verifier,()=>200),/live normal admission/);
 assert.throws(()=>new NativeAbandonmentProposalOwner(f.owner,f.path,f.m,job,4n),/already consumed/);
 assert.equal(count(f.db),0);assert.deepEqual(f.seen,[]);
}));

test('strict protocol rejects proxy, accessor, wrong types, extra identity and oversize before work',()=>{
 const original={path:'/tmp/test.db',ingress:'message:8',event:8n,channel:1n,actor:2n,application:4n,job,content:'!discard-request '+job,proposal:'a'.repeat(32)};let getters=0;
 for(const value of [new Proxy(original,{ownKeys(){getters++;return Reflect.ownKeys(original);},getPrototypeOf(){getters++;return Object.getPrototypeOf(original);},getOwnPropertyDescriptor(_target,key){getters++;return Object.getOwnPropertyDescriptor(original,key);}}),Object.defineProperty({...original},'content',{get(){getters++;return '';}}),{...original,channel:1},{...original,ingress:'message:9'},{...original,job:'x'},{...original,extra:true},{...original,content:'x'.repeat(131073)}])assert.throws(()=>captureProposalOriginal(value));assert.equal(getters,0);
 assert.throws(()=>proposalBinding('a'.repeat(36),original,'Prepare','t',NaN,null,null,null));assert.throws(()=>proposalBinding('a'.repeat(36),original,'Bind','t',200,1n,1n,'x'));
});

for(const operation of ['Prepare','Bind'] as const)for(const field of ['requestId','path','ingress','event','channel','actor','application','job','content','proposal','target','at','message','revision','hash','value','missing','oversize','accessor','proxy'] as const)test(`${operation} ${field} ACK fails closed after actual commit without replay`,async t=>fixture(async f=>{
 poison(t);const name=operation==='Bind'?'runControlCompletion':'run',base=OwnedWorkerSlot.prototype[name];let writes=0;
 t.mock.method(OwnedWorkerSlot.prototype,name,async function(this:OwnedWorkerSlot,...args:Parameters<typeof base>){const raw=await base.apply(this,args) as any;if(!proposalCall(args,operation))return raw;writes++;if(field==='missing')return {ok:true};if(field==='oversize')return {...raw,value:'x'.repeat(524289)};if(field==='proxy')return new Proxy(raw,{});if(field==='accessor')return Object.defineProperty({...raw},'value',{get(){assert.fail('ACK getter');}});return {...raw,[field]:field==='value'?false:'crossed'};});
 await assert.rejects(f.propose(),NativeAbandonmentProposalUnknownError);assert.throws(()=>f.propose(),/already consumed/);assert.equal(writes,1);assert.equal(count(f.db),1);assert.equal(count(f.db,'cdr_recovery_abandonment_deliveries'),operation==='Bind'?1:0);assert.deepEqual(f.seen,operation==='Bind'?['POST']:[]);assert.equal(getIngressExisting(f.path,'message:8')!.outcome,undefined);
}));

for(const field of ['id','revision','job_id','thread_id','owner_user_id','channel_id','application_id','created_at_bits','expires_at_bits','review_text','review_sha256'] as const)test(`prepared proposal ${field} cannot retarget original HTTP`,async t=>fixture(async f=>{
 const base=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',async function(this:OwnedWorkerSlot,...args:Parameters<typeof base>){const raw=await base.apply(this,args) as any;if(proposalCall(args,'Prepare'))raw.value={...raw.value,[field]:field==='revision'?0n:'foreign'};return raw;});
 await assert.rejects(f.propose(),NativeAbandonmentProposalUnknownError);assert.deepEqual(f.seen,[]);assert.equal(count(f.db,'cdr_recovery_abandonment_deliveries'),0);
}));

for(const operation of ['Begin','Confirm'] as const)test(`unconfirmed receipt ${operation} ACK never authorizes binding or another POST`,async t=>fixture(async f=>{
 const name=operation==='Confirm'?'runControlCompletion':'run',base=OwnedWorkerSlot.prototype[name];t.mock.method(OwnedWorkerSlot.prototype,name,async function(this:OwnedWorkerSlot,...args:Parameters<typeof base>){const raw=await base.apply(this,args);return receiptCall(args,operation)?{ok:true,binding:'crossed',value:operation==='Confirm'?true:{kind:'New'}}:raw;});
 await assert.rejects(f.propose(),/unconfirmed/);assert.throws(()=>f.propose(),/already consumed/);assert.equal(count(f.db),1);assert.equal(count(f.db,'cdr_recovery_abandonment_deliveries'),0);assert.deepEqual(f.seen,operation==='Confirm'?['POST']:[]);assert.equal(getIngressExisting(f.path,'message:8')!.outcome,undefined);
}));

for(const state of ['Delivered','Unknown','ContentConflict','RejectedBlocked'] as const)test(`original native proposal receipt ${state} preserves send state machine`,async t=>fixture(async f=>{
 const base=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',async function(this:OwnedWorkerSlot,...args:Parameters<typeof base>){const raw=await base.apply(this,args) as any;if(proposalCall(args,'Prepare')){const {key,hash}=receiptIdentity(raw.value),store=new NativeCompletionReceiptStore(f.path,key,state==='ContentConflict'?receiptHash('different'):hash,null);try{await store.begin(key,state==='ContentConflict'?receiptHash('different'):hash,null);if(state==='Delivered')await store.confirm(key,hash,'101');if(state==='RejectedBlocked')await store.blockRejected(key,hash,'definite rejection');}finally{await store.close();}}return raw;});
 if(state==='Delivered'){await f.propose();assert.equal(count(f.db,'cdr_recovery_abandonment_deliveries'),1);assert.equal(getIngressExisting(f.path,'message:8')!.confirmationDelivered,true);}else{await assert.rejects(f.propose());assert.equal(count(f.db,'cdr_recovery_abandonment_deliveries'),0);}
 assert.deepEqual(f.seen,[]);assert.equal(count(f.db),1);
}));

for(const boundary of ['Route','Prepare','Begin'] as const)test(`${boundary} true Control saturation has zero queue and no proposal retry`,async t=>fixture(async f=>{
 const base=OwnedWorkerSlot.prototype.run,blocker=new OwnedWorkerSlot('Control');let busy:Promise<unknown>|undefined,attempts=0;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof base>){if((boundary==='Begin'?receiptCall(args,'Begin'):proposalCall(args,boundary))){attempts++;busy=base.call(blocker,new URL('data:text/javascript,'+encodeURIComponent("import {parentPort} from 'node:worker_threads';setTimeout(()=>parentPort.postMessage(true),150);")),{},1000);}return base.apply(this,args);});
 try{await assert.rejects(f.propose(),OwnedWorkerBudgetError);assert.equal(attempts,1);assert.equal(count(f.db),boundary==='Begin'?1:0);assert.deepEqual(f.seen,[]);}finally{await busy;await blocker.join();}
}));

for(const boundary of ['afterRoute','beforePrepare','afterPrepare','beforeBind'] as const)test(`mapping changes ${boundary} never retarget original proposal`,async t=>fixture(async f=>{
 const base=OwnedWorkerSlot.prototype.run,complete=OwnedWorkerSlot.prototype.runControlCompletion;let changed=false;const change=()=>{if(!changed){f.db.exec("UPDATE mirror_threads SET discord_thread_id=99 WHERE codex_thread_id='t'");changed=true;}};
 t.mock.method(OwnedWorkerSlot.prototype,'run',async function(this:OwnedWorkerSlot,...args:Parameters<typeof base>){if(boundary==='beforePrepare'&&proposalCall(args,'Prepare'))change();const raw=await base.apply(this,args);if(boundary==='afterRoute'&&proposalCall(args,'Route')||boundary==='afterPrepare'&&proposalCall(args,'Prepare'))change();return raw;});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){if(boundary==='beforeBind'&&proposalCall(args,'Bind'))change();return complete.apply(this,args);});
 await assert.rejects(f.propose());assert.equal(count(f.db,'cdr_recovery_abandonment_deliveries'),0);assert.deepEqual(f.seen,boundary==='afterPrepare'||boundary==='beforeBind'?['POST']:[]);assert.equal(count(f.db,'codex_turn_queue'),1);
}));

test('accepted HTTP cancellation retains target lease and original cloned permit through binding/result/finish',async t=>fixture(async f=>{
 poison(t);const send=DiscordChannelClient.prototype.sendValidated,abort=new AbortController(),reason=Error('cancel after HTTP');t.mock.method(DiscordChannelClient.prototype,'sendValidated',async function(this:DiscordChannelClient,...args:Parameters<typeof send>){const id=await send.apply(this,args);abort.abort(reason);return id;});
 const pending=f.propose(abort.signal);f.permit.release();const fence=DrainFenceKey.create('proposal','1|2','test');f.gate.seal(fence);assert.equal(f.gate.isDrainedFor(fence),false);await pending;assert.equal(f.gate.isDrainedFor(fence),true);assert.equal(count(f.db,'cdr_recovery_abandonment_deliveries'),1);assert.equal(getIngressExisting(f.path,'message:8')!.confirmationDelivered,true);assert.deepEqual(f.seen,['POST']);
}));

for(const stage of ['Prepare','Bind'] as const)for(const failure of ['cancel','drop'] as const)test(`${stage} ${failure} retains enrolled writer, lease and permit until actual native exit`,async t=>fixture(async f=>{
 f.db.close();const domain=StoreAuthorityDomain.enroll(f.path);f.db=new DatabaseSync(f.path,{readOnly:true});const trace=new SharedArrayBuffer(8),abort=new AbortController(),reason=Error('stop original'),base=OwnedWorkerSlot.prototype[stage==='Bind'?'runControlCompletion':'run'];let restore:()=>void=()=>{};
 t.mock.method(OwnedWorkerSlot.prototype,stage==='Bind'?'runControlCompletion':'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof base>){if(proposalCall(args,stage)){restore=instrumentStoreWorker({match:'abandonment-proposal-native-worker'+extension,trace,...(failure==='drop'?{ack:'drop' as const}:{})});}return base.apply(this,args);});
 const pending=f.propose(abort.signal),observed=pending.catch(e=>e);f.permit.release();const fence=DrainFenceKey.create('stalled','1|2','test');f.gate.seal(fence);let done=false;void observed.then(()=>done=true);
 try{await waitTrace(trace);abort.abort(reason);await new Promise(r=>setTimeout(r,50));assert.equal(done,false);assert.equal(f.gate.isDrainedFor(fence),false);assert.equal(f.locks.activeTargetCount,1);assert.equal(domain.snapshot().writers,1);assert.throws(()=>domain.closeAfterOwnersJoined(),/not joined/);
  restore();releaseTrace(trace);const result=await observed;if(stage==='Bind'&&failure==='cancel'){assert.equal(result,undefined);assert.equal(getIngressExisting(f.path,'message:8')!.confirmationDelivered,true);}else assert.ok(result instanceof NativeAbandonmentProposalUnknownError);
  assert.equal(f.gate.isDrainedFor(fence),true);assert.equal(domain.snapshot().writers,0);assert.equal(count(f.db),1);assert.deepEqual(f.seen,stage==='Bind'?['POST']:[]);
 }finally{restore();releaseTrace(trace);await observed;await f.c.dispose();f.db.close();domain.closeAfterOwnersJoined();}
}));

for(const mutation of ['content_hash','message_id','delete','beforeBindHash','beforeBindMessage'] as const)test(`exact native receipt readback rejects ${mutation} mutation after HTTP acceptance`,async t=>fixture(async f=>{
 const send=DiscordChannelClient.prototype.sendValidated;
 if(mutation==='message_id')f.db.exec("CREATE TRIGGER rewrite_receipt AFTER UPDATE OF message_id ON codex_delivery_receipts BEGIN UPDATE codex_delivery_receipts SET message_id='999' WHERE receipt_key=NEW.receipt_key; END");
 t.mock.method(DiscordChannelClient.prototype,'sendValidated',async function(this:DiscordChannelClient,...args:Parameters<typeof send>){const id=await send.apply(this,args);if(mutation==='content_hash')f.db.prepare('UPDATE codex_delivery_receipts SET content_hash=?').run('b'.repeat(64));if(mutation==='delete')f.db.exec('DELETE FROM codex_delivery_receipts');return id;});
 const complete=OwnedWorkerSlot.prototype.runControlCompletion;t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof complete>){if(proposalCall(args,'Bind')){if(mutation==='beforeBindHash')f.db.prepare('UPDATE codex_delivery_receipts SET content_hash=?').run('b'.repeat(64));if(mutation==='beforeBindMessage')f.db.exec("UPDATE codex_delivery_receipts SET message_id='999'");}return complete.apply(this,args);});
 await assert.rejects(f.propose());assert.equal(count(f.db,'cdr_recovery_abandonment_deliveries'),0);assert.equal(getIngressExisting(f.path,'message:8')!.outcome,undefined);assert.deepEqual(f.seen,['POST']);assert.throws(()=>f.propose(),/already consumed/);
}));

for(const malformed of ['extraNew','extraDelivered','missingDelivered','proxy','accessor','prototype'] as const)test(`receipt ${malformed} result cannot authorize send or bind`,async t=>fixture(async f=>{
 const base=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',async function(this:OwnedWorkerSlot,...args:Parameters<typeof base>){const raw=await base.apply(this,args) as any;if(!receiptCall(args,'Begin'))return raw;
 const value=malformed==='extraNew'?{kind:'New',extra:true}:malformed==='extraDelivered'?{kind:'Delivered',messageId:'101',extra:true}:malformed==='missingDelivered'?{kind:'Delivered'}:malformed==='proxy'?new Proxy({kind:'New'},{}):malformed==='accessor'?Object.defineProperty({kind:'Delivered'},'messageId',{get(){assert.fail('active receipt getter');}}):Object.assign(Object.create({extra:true}),{kind:'New'});return {...raw,value};});
 await assert.rejects(f.propose());assert.deepEqual(f.seen,[]);assert.equal(count(f.db,'cdr_recovery_abandonment_deliveries'),0);
}));

for(const stage of ['Prepare','Bind'] as const)test(`${stage} SQLite write stall and deadline retain lease and admission until late actual commit`,async t=>fixture(async f=>{
 const method=stage==='Prepare'?'run':'runControlCompletion',base=OwnedWorkerSlot.prototype[method];let blocker:DatabaseSync|undefined;
 t.mock.method(OwnedWorkerSlot.prototype,method,function(this:OwnedWorkerSlot,...args:Parameters<typeof base>){if(proposalCall(args,stage)){blocker=new DatabaseSync(f.path);blocker.exec('BEGIN IMMEDIATE');return base.call(this,args[0],args[1],30,args[3]);}return base.apply(this,args);});
 const pending=f.propose(),failure=assert.rejects(pending,NativeAbandonmentProposalUnknownError);f.permit.release();const fence=DrainFenceKey.create('sqlite-lock','1|2','test');f.gate.seal(fence);let settled=false;void pending.then(()=>settled=true,()=>settled=true);
 try{const deadline=Date.now()+5000;while(blocker===undefined){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,5));}await new Promise(r=>setTimeout(r,180));assert.equal(settled,false);assert.equal(f.gate.isDrainedFor(fence),false);assert.equal(f.locks.activeTargetCount,1);assert.equal(ownedWorkerUsage().Control,1);blocker.exec('ROLLBACK');await failure;assert.equal(f.gate.isDrainedFor(fence),true);assert.equal(count(f.db),1);assert.equal(count(f.db,'cdr_recovery_abandonment_deliveries'),stage==='Bind'?1:0);assert.deepEqual(f.seen,stage==='Bind'?['POST']:[]);assert.equal(getIngressExisting(f.path,'message:8')!.outcome,undefined);assert.throws(()=>f.propose(),/already consumed/);}
 finally{if(blocker?.isTransaction)blocker.exec('ROLLBACK');await pending.catch(()=>{});blocker?.close();}
}));

test('native target lock two-second deadline makes no proposal and retains original permit until joined',()=>fixture(async f=>{
 const held=await f.locks.acquire('t'),pending=f.propose();f.permit.release();const fence=DrainFenceKey.create('target-lock','1|2','test');f.gate.seal(fence);assert.equal(f.gate.isDrainedFor(fence),false);
 try{await assert.rejects(pending,/target is busy/);held.requireTarget('t');assert.equal(f.gate.isDrainedFor(fence),true);assert.equal(count(f.db),0);assert.deepEqual(f.seen,[]);}finally{held.release();}
}));

test('known delivered Bind waits once in existing completion FIFO and survives cancellation while queued',async t=>fixture(async f=>{
 const base=OwnedWorkerSlot.prototype.runControlCompletion,blocker=new OwnedWorkerSlot('Control'),shared=new SharedArrayBuffer(4),abort=new AbortController();let busy:Promise<unknown>|undefined,binds=0;
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof base>){if(proposalCall(args,'Bind')){binds++;busy=blocker.run(new URL('data:text/javascript,'+encodeURIComponent("import {parentPort,workerData} from 'node:worker_threads';Atomics.wait(new Int32Array(workerData),0,0,10000);parentPort.postMessage(true);")),shared,10000);abort.abort(Error('queued known bind'));}return base.apply(this,args);});
 const pending=f.propose(abort.signal);f.permit.release();const fence=DrainFenceKey.create('queued-bind','1|2','test');f.gate.seal(fence);
 try{const deadline=Date.now()+5000;while(busy===undefined){assert.ok(Date.now()<deadline);await new Promise(r=>setTimeout(r,5));}assert.equal(f.gate.isDrainedFor(fence),false);assert.equal(f.locks.activeTargetCount,1);assert.equal(ownedWorkerUsage().Control,1);assert.equal(count(f.db,'cdr_recovery_abandonment_deliveries'),0);Atomics.store(new Int32Array(shared),0,1);Atomics.notify(new Int32Array(shared),0);await busy;await blocker.join();await pending;assert.equal(binds,1);assert.equal(count(f.db,'cdr_recovery_abandonment_deliveries'),1);assert.equal(getIngressExisting(f.path,'message:8')!.confirmationDelivered,true);assert.equal(f.gate.isDrainedFor(fence),true);assert.deepEqual(f.seen,['POST']);}
 finally{Atomics.store(new Int32Array(shared),0,1);Atomics.notify(new Int32Array(shared),0);await busy;await blocker.join();await pending.catch(()=>{});}
}));
