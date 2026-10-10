import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dirname,join} from 'node:path';
import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {classifyGatewayMessage} from '../../../src/runtime/message-worker/classification.ts';
import {admitMessageCandidateAt as admit,AdmittedMessage,MessageDatabaseMismatchError,sameMessageDatabasePath} from '../../../src/runtime/message-worker/admission.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
const config={enableMessageContent:true,plainAskMentionUserIds:new Set<bigint>()};
const policy=new InteractionAccessPolicy({allowAllChannels:true,allowedChannelIds:[],allowedUserIds:[],mirroredChannelIds:[]});
const reports:unknown[]=[];const options={now:()=>101,report:(value:unknown)=>{reports.push(value);}};
function message(id:number,content:string,extra:Record<string,unknown>={}){return decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content,edited_timestamp:null,embeds:[],id:String(id),mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-02-02T02:02:02.020000+00:00',tts:false,type:0,...extra}));}
async function candidate(path:string,id:number,text:string,extra:Record<string,unknown>={}){const c=await classifyGatewayMessage(message(id,text,extra),path,config,policy,null);assert.equal(c.kind,'Candidate');if(c.kind!=='Candidate')throw Error('fixture');return c.candidate;}
async function get(path:string,id:number,text:string){return (await admit(await candidate(path,id,text),100,options))!;}
test('first admission persists source envelope and transferred custody; duplicate produces no owner',()=>storeFixture(async path=>{
 const a=await get(path,3,'hello'),p=a.intoProcessingParts(path);try{
  assert.equal(p.message.id,3n);assert.equal(p.processingMode,'Normal');assert.equal(p.admissionPermit,null);assert.deepEqual(p.frozenPlan,{ok:true,value:{Execute:{Ask:{prompt:'hello'}}}});
  const r=(await state.getIngress(path,'message:3'))!;assert.equal(r.eventId,3n);assert.equal(r.applicationId,null);assert.equal(r.sourceMessageId,3n);assert.equal(r.targetThreadId,null);
  const v=r.payload as any;assert.equal(v.version,1n);assert.equal(v.processing_mode,'normal');assert.equal(v.author_is_bot,false);assert.deepEqual(v.routing,{mirrored_target:null,selected_target:'resolved_before_processing'});assert.equal(v.new_origin.channel,1n);
  assert.equal(await admit(await candidate(path,3,'hello'),999,options),null);assert.throws(()=>a.intoProcessingParts(path),/consumed/);
 }finally{await p.custody.dispose();await a.dispose();}
 assert.equal((await state.getIngress(path,'message:3'))!.state,'held');
 const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT seen_at FROM discord_processed_messages WHERE message_id=3').get()!.seen_at,100);}finally{db.close();}
}));
test('attachment custody stores metadata only, never URLs or proxy URLs',()=>storeFixture(async path=>{
 const a=(await admit(await candidate(path,4,'hello',{attachments:[{id:'7',filename:'x.txt',size:12,url:'https://example.invalid/private',proxy_url:'https://example.invalid/proxy',content_type:'text/plain'}]}),100,options))!;
 try{const v=(await state.getIngress(path,'message:4'))!.payload as any;assert.deepEqual(v.attachments,[{id:7n,filename:'x.txt',size:12n,content_type:'text/plain',artifact_status:'metadata_only_requires_reupload_if_unavailable'}]);assert.equal(serializeSerdeValue(v).includes('example.invalid'),false);}finally{await a.dispose();}
}));
test('malformed command is durably claimed before error display',()=>storeFixture(async path=>{
 const a=await get(path,5,'!not-a-command'),p=a.intoProcessingParts(path);try{assert.equal(p.frozenPlan.ok,false);const v=(await state.getIngress(path,'message:5'))!.payload as any;assert.equal(typeof v.plan.Error,'string');assert.equal(p.frozenPlan.ok?null:p.frozenPlan.error.message,v.plan.Error);}finally{await p.custody.dispose();}
}));
test('invalid admission time consumes candidate without writing a processed row',()=>storeFixture(async path=>{
 for(const [i,time] of [-1,NaN,Infinity].entries()){const c=await candidate(path,10+i,'hello');await assert.rejects(admit(c,time,options),TypeError);assert.equal(await state.getIngress(path,`message:${10+i}`),null);assert.throws(()=>c.intoAdmissionParts(),/consumed/);}
}));
test('invalid custody reporter fails before durable claim and forged candidates cannot mint owner',()=>storeFixture(async path=>{
 await assert.rejects(admit(await candidate(path,15,'hello'),100,{report:null as any}),TypeError);assert.equal(await state.getIngress(path,'message:15'),null);
 await assert.rejects(admit({intoAdmissionParts(){throw Error('hook');}} as any,100,options),TypeError);
 assert.throws(()=>new AdmittedMessage(Symbol(),{} as any,{} as any,{} as any),TypeError);
}));
test('database mismatch touches only original custody on disposal and no replacement database',()=>storeFixture(async path=>{
 const a=await get(path,20,'hello'),other=join(dirname(path),'wrong.sqlite');try{assert.throws(()=>a.intoProcessingParts(other),MessageDatabaseMismatchError);assert.equal(existsSync(other),false);}finally{await a.dispose();}
 assert.equal((await state.getIngress(path,'message:20'))!.state,'held');assert.equal(existsSync(other),false);
}));
test('Unix Rust path components preserve leading dot and parent components, no canonical aliasing',()=>{
 for(const [a,b] of [['/a//b/./','/a/b'],['a//./b/','a/b'],['./a/.','./a'],['.','./'],['///','/']])assert.equal(sameMessageDatabasePath(a!,b!),true);
 for(const [a,b] of [['./a','a'],['a/../b','b'],['','./'],['/a','a'],['a\\b','a/b'],['A','a']])assert.equal(sameMessageDatabasePath(a!,b!),false);
});
test('pending-only mode persisted before transfer and mutable borrow prevents racing transfer',()=>storeFixture(async path=>{
 const a=await get(path,21,'hello'),transition=a.requirePendingReply();assert.throws(()=>a.intoProcessingParts(path),/borrowed/);await transition;const p=a.intoProcessingParts(path);
 try{assert.equal(p.processingMode,'PendingReplyOnly');assert.equal(((await state.getIngress(path,'message:21'))!.payload as any).processing_mode,'pending_reply_only');}finally{await p.custody.dispose();}
}));
test('permit clones remain alive through disposal and are transferred without duplication',()=>storeFixture(async path=>{
 const gate=new AdmissionGate(),permit=gate.tryEnter(),a=await get(path,22,'hello');a.retainAdmission(permit);permit.release();const p=a.intoProcessingParts(path);assert.ok(p.admissionPermit);const c=p.admissionPermit.clone();c.release();await a.dispose();
 try{await p.custody.dispose();}finally{p.admissionPermit.release();}assert.throws(()=>p.admissionPermit!.clone());
 const b=await get(path,23,'hello'),q=gate.tryEnter();b.retainAdmission(q);q.release();const closing=b.dispose();assert.throws(()=>b.intoProcessingParts(path),/consumed/);await closing;assert.equal((await state.getIngress(path,'message:23'))!.state,'held');
}));
test('admission executes persisted new reservation response then New rather than stale Ask',()=>storeFixture(async path=>{
 const a=await get(path,30,'!new'),p=a.intoProcessingParts(path);assert.ok(p.frozenPlan.ok&&'Respond'in p.frozenPlan.value);await p.custody.dispose();
 const b=await get(path,31,'first prompt'),q=b.intoProcessingParts(path);try{assert.deepEqual(q.frozenPlan,{ok:true,value:{Execute:{New:{prompt:'first prompt'}}}});assert.equal(((await state.getIngress(path,'message:31'))!.payload as any).new_prompt_arm_ref,'message:30');}finally{await q.custody.dispose();}
 const c=await get(path,32,'second prompt'),r=c.intoProcessingParts(path);try{assert.deepEqual(r.frozenPlan,{ok:true,value:{Execute:{Ask:{prompt:'second prompt'}}}});}finally{await r.custody.dispose();}
}));
test('concurrent duplicate candidates only mint one durable custody owner',()=>storeFixture(async path=>{
 const one=await candidate(path,40,'hello'),two=await candidate(path,40,'hello');const values=await Promise.all([admit(one,100,options),admit(two,100,options)]);assert.equal(values.filter(Boolean).length,1);for(const a of values)if(a)await a.dispose();
}));
test('dispose joins in-flight mode write and holds after transition without releasing early',()=>storeFixture(async path=>{
 const a=await get(path,41,'hello'),pending=a.requirePendingReply(),closing=a.dispose();await pending;await closing;const r=(await state.getIngress(path,'message:41'))!;assert.equal(r.state,'held');assert.equal((r.payload as any).processing_mode,'pending_reply_only');
}));
test('store failure propagates without admitted owner or processed row',()=>storeFixture(async path=>{
 const c=await candidate(path,50,'hello'),db=await openInitialized(path);try{db.exec("CREATE TRIGGER reject_admission BEFORE INSERT ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'fixture admission failure'); END");}finally{db.close();}
 await assert.rejects(admit(c,100,options),/fixture admission failure/);assert.equal(await state.getIngress(path,'message:50'),null);
 const check=await openInitialized(path);try{assert.equal(check.prepare('SELECT count(*) n FROM discord_processed_messages WHERE message_id=50').get()!.n,0);}finally{check.close();}
}));
test('owner outside SQLite range fails before claim without numeric truncation',()=>storeFixture(async path=>{
 const c=await candidate(path,51,'hello',{author:{id:String(1n<<63n),username:'u',discriminator:'0',bot:false}});await assert.rejects(admit(c,100,options),/invalid message owner/);assert.equal(await state.getIngress(path,'message:51'),null);
}));
test('changed mapping after new reservation persists response instead of executing stale Ask',()=>storeFixture(async path=>{
 const a=await get(path,60,'!new');await a.dispose();const db=await openInitialized(path);try{db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('target','project','title',9n,1n,1);}finally{db.close();}
 const b=await get(path,61,'first prompt'),p=b.intoProcessingParts(path);try{assert.ok(p.frozenPlan.ok&&'Respond'in p.frozenPlan.value);assert.match((p.frozenPlan as any).value.Respond,/방 연결이 변경/);assert.equal((await state.getIngress(path,'message:61'))!.targetThreadId,null);}finally{await p.custody.dispose();}
}));
