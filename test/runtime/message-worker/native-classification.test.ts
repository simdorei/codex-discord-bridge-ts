import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,renameSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {abandonmentStoreFixture} from '../../helpers/abandonment-store-fixture.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../../helpers/store-authority-worker-fixture.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {classifyGatewayMessage,createNativeMessageClassifier,captureMessageClassifier,captureNativeMessageClassificationLimits,takeMessageClassificationCapacityRefusal,MessageAdmissionIntegerRangeError,NativeMessageClassificationError,type NativeMessageClassificationLimits,type MessageClassification} from '../../../src/runtime/message-worker/classification.ts';
import {captureClassificationReadResult} from '../../../src/runtime/message-worker/classification-wire.ts';
import {MessagePlanError} from '../../../src/runtime/message-plan.ts';
import {PrefixPlanError} from '../../../src/runtime/prefix-plan.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {StoreIntegrityError,UnsupportedVersionError} from '../../../src/store/schema-assembly.ts';
import {AbandonmentRowMissingError} from '../../../src/store/abandonment-identity.ts';
import {AbandonmentIntegrityError} from '../../../src/store/schema-abandonment.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,OwnedWorkerTimeoutError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const limits={maxRows:100n,maxValueBytes:65536n,maxOutputBytes:65536,timeoutMs:5000};
const config={enableMessageContent:true,plainAskMentionUserIds:new Set<bigint>()};
const policy=new InteractionAccessPolicy({allowAllChannels:true,allowedChannelIds:[],allowedUserIds:[],mirroredChannelIds:[]});
const denied=new InteractionAccessPolicy({allowAllChannels:false,allowedChannelIds:[],allowedUserIds:[],mirroredChannelIds:[]});
const workerName='message-worker/native-classification-worker'+(import.meta.url.endsWith('.js')?'.js':'.ts');
function message(content='hello',extra:Record<string,unknown>={}){return decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content,edited_timestamp:null,embeds:[],id:'9007199254740993',mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-02-02T02:02:02.020000+00:00',tts:false,type:0,...extra}));}
function parts(value:MessageClassification){assert.equal(value.kind,'Candidate');if(value.kind!=='Candidate')throw Error('fixture');return value.candidate.intoAdmissionParts();}
async function fixture(run:(path:string,db:DatabaseSync)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{await run(path,db);}finally{if(db.isOpen)db.close();}});}
const classify=(path:string,text='hello',cfg=config,extra:Record<string,unknown>={},access=policy,bounds:NativeMessageClassificationLimits=limits)=>createNativeMessageClassifier(path,bounds)(message(text,extra),path,cfg,access,null);
function fillBackground(){const gate=new SharedArrayBuffer(4),slots=Array.from({length:3},()=>new OwnedWorkerSlot('Background')),pending=Promise.all(slots.map(slot=>slot.run(new URL('data:text/javascript,'+encodeURIComponent("import {parentPort,workerData} from 'node:worker_threads';Atomics.wait(new Int32Array(workerData),0,0,15000);parentPort.postMessage(true);")),gate,10000)));let released:Promise<void>|undefined;return {release:()=>released??=(async()=>{Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0,3);await pending;await Promise.all(slots.map(slot=>slot.join()));})()};}

test('native origin is complete, immutable and exactly equivalent for unmapped, mapped and parent vectors',()=>fixture(async(path,db)=>{
 const big=9007199254740995n;
 for(const setup of ['',`INSERT INTO mirror_projects VALUES('child','x',1,1),('parent','x',${big},1);INSERT INTO mirror_threads VALUES('target','mapped','title',${big},1,1)`,"INSERT INTO mirror_projects VALUES('codex:chats','x',1,1);INSERT INTO mirror_threads VALUES('z','p','x',1,20,2),('a','p','x',1,21,1)","INSERT INTO mirror_projects VALUES('ordinary','x',1,1);INSERT INTO mirror_threads VALUES('z','p','x',1,20,2),('a','p','x',1,21,1)"]){
  db.exec('DELETE FROM mirror_projects;DELETE FROM mirror_threads;'+setup);const expected=parts(await classifyGatewayMessage(message(),path,config,policy,null)),actual=parts(await classify(path));assert.deepEqual(actual,expected);assert.ok(Object.isFrozen(actual.newOrigin));assert.ok(Object.isFrozen(actual.newOrigin.chat_targets));assert.equal(actual.message.id,9007199254740993n);
 }
}));
for(const text of ['!unknown','!settings "','!mirror detail','!discard-request bad'])test(`native malformed plan retains exact owner error prototype: ${text}`,()=>fixture(async(path)=>{
 const expected=parts(await classifyGatewayMessage(message(text),path,config,policy,null)),actual=parts(await classify(path,text));assert.equal(actual.frozenPlan.ok,false);assert.deepEqual(actual.frozenPlan,expected.frozenPlan);if(actual.frozenPlan.ok)throw Error('fixture');assert.ok(actual.frozenPlan.error instanceof MessagePlanError);if(actual.frozenPlan.error.kind==='Prefix')assert.ok(actual.frozenPlan.error.source instanceof PrefixPlanError);
 assert.equal(await state.getIngress(path,'message:9007199254740993'),null);
}));
for(const cause of ['duplicate-room','duplicate-project','malformed','incompatible','version'] as const)test(`native origin ${cause} fails even for ignored command`,()=>fixture(async(path,db)=>{
 if(cause==='duplicate-room')db.exec("INSERT INTO mirror_threads VALUES('a','p','x',9,1,1),('b','p','x',9,1,1)");
 if(cause==='duplicate-project')db.exec("INSERT INTO mirror_projects VALUES('a','x',1,1),('b','x',1,1)");
 if(cause==='malformed')db.exec("INSERT INTO mirror_threads VALUES(CAST(x'ff' AS TEXT),'p','x',9,1,1)");if(cause==='incompatible')db.exec('DROP TABLE mirror_projects');if(cause==='version')db.exec('PRAGMA user_version=99');
 await assert.rejects(classify(path,'!bad',config,{},denied),cause==='version'?UnsupportedVersionError:cause==='malformed'?Error:StoreIntegrityError);
}));
test('native missing database is never created, migrated or replaced',()=>storeFixture(async path=>{await assert.rejects(classify(path));assert.equal(existsSync(path),false);}));
test('complete selected branch bounds fail rather than truncate and ignore unrelated large values',()=>fixture(async(path,db)=>{
 db.exec("INSERT INTO mirror_projects VALUES('codex:chats','x',1,1);INSERT INTO mirror_threads VALUES('z','p','x',1,20,2),('a','p','x',1,21,1)");
 for(const bounds of [{...limits,maxRows:3n},{...limits,maxValueBytes:1n},{...limits,maxOutputBytes:1}])await assert.rejects(classify(path,'hello',config,{},policy,bounds));
 assert.deepEqual(parts(await classify(path)).newOrigin.chat_targets,['a','z']);db.exec("DELETE FROM mirror_projects;DELETE FROM mirror_threads;INSERT INTO mirror_threads VALUES('unrelated',printf('%100000s','x'),'title',20,21,1)");assert.equal(parts(await classify(path,'hello',config,{},policy,{...limits,maxValueBytes:8n})).routingTarget,null);
}));
test('actor remains u64 until a conditional arm or successful human discard branch',()=>fixture(async(path,db)=>{
 const author={id:String(1n<<63n),username:'u',discriminator:'0',bot:false},extra={author},required={...config,plainAskMentionUserIds:new Set([42n])};
 assert.equal(parts(await classify(path,'hello',config,extra)).userId,1n<<63n);
 assert.equal((await classify(path,'!unknown',required,extra)).kind,'Candidate');assert.equal((await classify(path,'!discard-request bad',required,extra)).kind,'Candidate');
 assert.equal((await classify(path,'hello',required,{...extra,mentions:[{id:'42',username:'m',discriminator:'0',bot:false,public_flags:0}]})).kind,'Candidate');
 for(const access of [policy,denied])await assert.rejects(classify(path,'hello',required,extra,access),MessageAdmissionIntegerRangeError);
 await assert.rejects(classify(path,'!discard-request 550e8400-e29b-41d4-a716-446655440000',config,extra),MessageAdmissionIntegerRangeError);
 assert.equal((await classify(path,'!discard-request 550e8400-e29b-41d4-a716-446655440000',config,extra,denied)).kind,'Ignore');
 assert.equal((await classify(path,'hello',required,{author:{...author,bot:true}})).kind,'Ignore');
 db.exec("INSERT INTO mirror_threads VALUES('t','p','x',9,1,1)");assert.equal((await classify(path,'hello',required,extra)).kind,'Candidate');
}));
test('origin error precedes conditional actor overflow; message/channel overflow precedes any open',()=>fixture(async(path,db)=>{
 db.exec("INSERT INTO mirror_threads VALUES('a','p','x',9,1,1),('b','p','x',9,1,1)");await assert.rejects(classify(path,'hello',{...config,plainAskMentionUserIds:new Set([42n])},{author:{id:String(1n<<63n),username:'u',discriminator:'0',bot:false}}),StoreIntegrityError);
 db.close();renameSync(path,path+'.saved');try{for(const field of ['id','channel_id'])await assert.rejects(classify(path,'hello',config,{[field]:String(1n<<63n)}),MessageAdmissionIntegerRangeError);}finally{renameSync(path+'.saved',path);}
}));
test('latest arm is selected before consumed/event ordering checks, never falls back to an older arm',()=>fixture(async(path,db)=>{
 const cfg={...config,plainAskMentionUserIds:new Set([42n])};
 for(const id of [1n,2n])await state.admitIngress(path,{ingressId:`message:${id}`,kind:'message',eventId:id,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:id,payload:{version:1n,author_is_bot:false,content:'!new',plan:{Execute:{New:{prompt:''}}}},targetThreadId:null,canonicalOwner:null,now:1});
 assert.equal(parts(await classify(path,'hello',cfg)).newPromptMentionArm,'message:2');
 db.exec("UPDATE discord_ingress_journal SET payload_json=json_set(payload_json,'$.new_prompt_arm.consumed_by','later') WHERE ingress_id='message:2'");assert.equal((await classify(path,'hello',cfg)).kind,'Ignore');
 db.exec("UPDATE discord_ingress_journal SET payload_json=json_set(payload_json,'$.new_prompt_arm.consumed_by',NULL),event_id=9007199254740993 WHERE ingress_id='message:2'");assert.equal((await classify(path,'hello',cfg)).kind,'Ignore');
}));
test('held-job discard reads existing identity without a proposal or execution permission',()=>abandonmentStoreFixture(async(db,path)=>{
 const text='!discard-request 550e8400-e29b-41d4-a716-446655440000';assert.equal(parts(await classify(path,text)).routingTarget,'t');assert.equal(db.prepare('SELECT count(*) n FROM cdr_recovery_abandonment_proposals').get()!.n,0);
 await assert.rejects(classify(path,text,config,{author:{id:'8',username:'u',discriminator:'0',bot:false}}),AbandonmentRowMissingError);
},true,'550e8400-e29b-41d4-a716-446655440000'));
test('decoded/config/limits/path are captured and proxies/accessors never execute',()=>fixture(async(path)=>{
 const ids=new Set([42n]),bounds={...limits},native=createNativeMessageClassifier(path,bounds),cfg={enableMessageContent:true,plainAskMentionUserIds:ids},pending=native(message(),path,cfg,policy,null);ids.clear();cfg.enableMessageContent=false;bounds.maxOutputBytes=1;assert.equal((await pending).kind,'Ignore');
 await assert.rejects(native(message(),path+'.other',config,policy,null),TypeError);let hooks=0;const getter={get classifyMessage(){hooks++;return native;}};assert.throws(()=>captureMessageClassifier(getter),TypeError);assert.throws(()=>captureMessageClassifier(new Proxy({},{get(){hooks++;throw Error();}})),TypeError);assert.throws(()=>captureMessageClassifier({classifyMessage:new Proxy(native,{apply(){hooks++;throw Error();}})}),TypeError);assert.throws(()=>captureNativeMessageClassificationLimits({...limits,get maxRows(){hooks++;return 2n;}}),TypeError);await assert.rejects(native(new Proxy(message(),{get(){hooks++;throw Error();}}),path,config,policy,null),TypeError);assert.equal(hooks,0);
 const options={classifyMessage:native},captured=captureMessageClassifier(options);options.classifyMessage=async()=>{throw Error('replacement');};assert.equal((await captured(message(),path,config,policy,null)).kind,'Candidate');
}));
test('origin decoder rejects getters, proxies, partial vectors and bigint corruption without invoking hooks',()=>{
 const origin={version:1n,channel:1n,target:null,mapped_project:null,parent_channel:null,project:null,parent_project:null,chat_targets:['a','z']},value={origin,arm:null,abandonmentTarget:null};assert.deepEqual(captureClassificationReadResult(value,1n,limits),value);let hooks=0;
 for(const bad of [new Proxy(value,{get(){hooks++;throw Error();}}),{...value,get origin(){hooks++;return origin;}},{...value,origin:{...origin,channel:1}},{...value,origin:{...origin,parent_channel:1n<<63n}},{...value,origin:{...origin,chat_targets:['a',undefined]}}])assert.throws(()=>captureClassificationReadResult(bad,1n,limits),NativeMessageClassificationError);assert.equal(hooks,0);
});
test('native genuine capacity proof is exact-Promise, one-use and cannot be replayed or forged',()=>fixture(async(path)=>{
 const busy=fillBackground(),native=createNativeMessageClassifier(path,limits),pending=native(message(),path,config,policy,null);let failure:unknown;try{await pending;}catch(error){failure=error;}
 try{assert.ok(failure instanceof OwnedWorkerBudgetError===false);const wrapped=pending.then(v=>v);void wrapped.catch(()=>{});assert.equal(takeMessageClassificationCapacityRefusal(wrapped,failure),false);assert.equal(takeMessageClassificationCapacityRefusal(Promise.resolve(undefined as never),{}),false);assert.equal(takeMessageClassificationCapacityRefusal(pending,new OwnedWorkerBudgetError()),false);assert.equal(takeMessageClassificationCapacityRefusal(pending,failure),true);assert.equal(takeMessageClassificationCapacityRefusal(pending,failure),false);}finally{await busy.release();}
}));
for(const mode of ['public','forged','admitted','wrapped-run'] as const)test(`${mode} worker refusal cannot mint classifier retry proof`,async t=>fixture(async(path)=>{
 const run=OwnedWorkerSlot.prototype.run,error=mode==='forged'?Object.assign(Error('fake'),{name:'MessageClassificationCapacityError'}):new OwnedWorkerBudgetError(),busy=mode==='wrapped-run'?fillBackground():null;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(mode==='wrapped-run')return run.apply(this,args).then(v=>v);if(mode==='admitted')return run.apply(this,args).then(()=>{throw error;});return Promise.reject(error);});
 const pending=classify(path);let failure:unknown;try{await pending;}catch(e){failure=e;}assert.equal(takeMessageClassificationCapacityRefusal(pending,failure),false);await busy?.release();
}));
for(const mode of ['cancel','timeout'] as const)test(`classification SQLite lock ${mode} retains Background until actual native exit`,()=>fixture(async(path,db)=>{
 db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const trace=new SharedArrayBuffer(12),restore=instrumentStoreWorker({match:workerName,trace,before:'Atomics.store(trace,0,1);',after:'Atomics.store(trace,2,1);Atomics.wait(trace,1,0,15000);'}),abort=new AbortController(),reason=Error('stop classification');let settled=false;
 const pending=createNativeMessageClassifier(path,{...limits,timeoutMs:mode==='timeout'?25:5000})(message(),path,config,policy,null,abort.signal);void pending.then(()=>settled=true,()=>settled=true);
 try{await waitTrace(trace);if(mode==='cancel')abort.abort(reason);await new Promise(r=>setTimeout(r,60));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Background,1);db.exec('ROLLBACK');await new Promise(r=>setTimeout(r,100));assert.equal(settled,false);restore();releaseTrace(trace);await assert.rejects(pending,mode==='cancel'?e=>e===reason:OwnedWorkerTimeoutError);assert.equal(ownedWorkerUsage().Background,0);assert.equal(takeMessageClassificationCapacityRefusal(pending,reason),false);}finally{if(db.isTransaction)db.exec('ROLLBACK');restore();releaseTrace(trace);await pending.catch(()=>{});}
}));

test('non-held discard is rejected without weakening persistent policy guards',()=>abandonmentStoreFixture(async(_db,path)=>{await assert.rejects(classify(path,'!discard-request 550e8400-e29b-41d4-a716-446655440000'),AbandonmentIntegrityError);},false,'550e8400-e29b-41d4-a716-446655440000'));

test('discard budget includes held-policy and final exact-mapping rows after routing',()=>abandonmentStoreFixture(async(_db,path)=>{
 const text='!discard-request 550e8400-e29b-41d4-a716-446655440000';
 for(const maxRows of [4n,6n])await assert.rejects(classify(path,text,config,{},policy,{...limits,maxRows}),/selected rows exceed budget/);
 assert.equal(parts(await classify(path,text,config,{},policy,{...limits,maxRows:7n})).routingTarget,'t');
},true,'550e8400-e29b-41d4-a716-446655440000'));
