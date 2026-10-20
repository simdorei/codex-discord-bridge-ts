import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dirname,join} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {httpFixture} from '../../helpers/interaction-worker-fixture.ts';
import {asyncChoiceServer} from '../../helpers/async-choice-server.ts';
import {promptFixture,callPromptFixture} from '../../helpers/server-prompt-fixture.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {classifyGatewayMessage} from '../../../src/runtime/message-worker/classification.ts';
import {admitMessageCandidateAt,MessageDatabaseMismatchError} from '../../../src/runtime/message-worker/admission.ts';
import {createMessageProcessor,type MessageBusinessServices} from '../../../src/runtime/message-worker/processor.ts';
import {messageWorkerErrorInfo} from '../../../src/runtime/message-worker/errors.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {AdmissionGate,DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {ActionExecutionError} from '../../../src/runtime/action-executor/action-error.ts';
import {MirrorCleanupProtectedError} from '../../../src/runtime/cleanup-refusal.ts';
import {newExecutionPrompt} from '../../../src/store/ingress-new-input.ts';
import type {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import type {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
const config={attachmentsEnabled:true,attachmentMaxBytes:100n,attachmentTextInlineMaxBytes:100n};
const policy=new InteractionAccessPolicy({allowAllChannels:true,allowedChannelIds:[],allowedUserIds:[],mirroredChannelIds:[]});
function message(content:string,extra:Record<string,unknown>={}){return decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content,edited_timestamp:null,embeds:[],id:'3',mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-02-02T02:02:02.020000+00:00',tts:false,type:0,...extra}));}
async function admitted(path:string,content:string,extra:Record<string,unknown>={}){const c=await classifyGatewayMessage(message(content,extra),path,{enableMessageContent:true,plainAskMentionUserIds:new Set()},policy,null);assert.equal(c.kind,'Candidate');if(c.kind!=='Candidate')throw Error('fixture');return (await admitMessageCandidateAt(c.candidate,100,{now:()=>101,report:()=>{}}))!;}
function context(path:string,server:PortableResidentLifecycle,http:DiscordChannelClient,services:MessageBusinessServices){return {database:path,applicationId:4n,server,http,config,attachmentRoot:dirname(path),attachmentTransport:{async get(){return {contentLength:3n,chunks:(async function*(){yield Buffer.from('abc');})(),async release(){}};}},attachmentReport:()=>{},controlVerifier:new ControlTurnVerifier(path,server,{selectedThreadId:()=> 't'},new TargetLocks()),services,now:()=>102};}
function services(execute:MessageBusinessServices['executeWithIngressContext']=async()=>({text:'done',waitsForFinal:false,ui:null})){const calls={target:0,execute:0,notify:0};const ports:MessageBusinessServices={async targetThreadId(){calls.target++;return 't';},async executeWithIngressContext(...args){calls.execute++;return execute(...args);},notifyDeliveryReady(){calls.notify++;}};return {calls,ports};}
function fixture(run:(path:string,server:PortableResidentLifecycle,http:DiscordChannelClient,seen:string[])=>Promise<void>){return storeFixture(path=>httpFixture((http,seen)=>asyncChoiceServer({},server=>run(path,server,http,seen))));}
async function edit(path:string,sql:string){const db=await openInitialized(path);try{db.exec(sql);}finally{db.close();}}
const attachment=[{id:'10',filename:'a.txt',size:3,url:'https://example.invalid/unused',proxy_url:'https://example.invalid/unused'}];
test('message action sees original actor and executing custody; saved result precedes reply and confirmation',()=>fixture(async(path,server,http,seen)=>{
 const s=services(async(action,actor,key)=>{assert.equal(action,'Help');assert.deepEqual(actor,{channelId:1n,userId:2n,discordMessageId:3n,autoQueueWhenBusy:false});assert.equal((await state.getIngress(path,key))!.state,'executing');return {text:'done',waitsForFinal:true,ui:null};});
 const owner=await admitted(path,'!help'),gate=new AdmissionGate(),permit=gate.tryEnter();owner.retainAdmission(permit);permit.release();const fence=DrainFenceKey.create('runtime','1|2','worker');gate.seal(fence);assert.equal(gate.isDrainedFor(fence),false);
 await createMessageProcessor(context(path,server,http,s.ports))(owner);assert.equal(gate.isDrainedFor(fence),true);const row=(await state.getIngress(path,'message:3'))!;assert.deepEqual(row.outcome,{response:'done',waits_for_final:true});assert.equal(row.confirmationDelivered,true);assert.deepEqual(seen,['POST']);assert.equal(s.calls.notify,1);assert.equal(s.calls.target,0);await assert.rejects(createMessageProcessor(context(path,server,http,s.ports))(owner),/consumed/);
}));
test('Ask resolves source target twice and routes no-pending prompt through executor',()=>fixture(async(path,server,http,seen)=>{
 const s=services(async(action)=>{assert.deepEqual(action,{Ask:{prompt:'hello'}});return {text:'ok',waitsForFinal:false,ui:null};});await createMessageProcessor(context(path,server,http,s.ports))(await admitted(path,'hello'));assert.equal(s.calls.target,2);assert.equal(s.calls.execute,1);assert.deepEqual(seen,['POST']);assert.equal((await state.getIngress(path,'message:3'))!.targetThreadId,'t');
}));
test('PendingReplyOnly with vanished request holds without business execution or new reply',()=>fixture(async(path,server,http,seen)=>{
 const s=services(),a=await admitted(path,'hello');await a.requirePendingReply();await assert.rejects(createMessageProcessor(context(path,server,http,s.ports))(a),e=>messageWorkerErrorInfo(e)?.kind==='Restarting');assert.equal(s.calls.execute,0);assert.deepEqual(seen,[]);assert.equal((await state.getIngress(path,'message:3'))!.state,'held');
}));
test('Pro bypasses pending text handling but cannot bypass PendingReplyOnly fence',()=>fixture(async(path,server,http,seen)=>{
 const s=services(),a=await admitted(path,'!pro investigate');await a.requirePendingReply();await assert.rejects(createMessageProcessor(context(path,server,http,s.ports))(a),e=>messageWorkerErrorInfo(e)?.kind==='Restarting');assert.equal(s.calls.target,1);assert.equal(s.calls.execute,0);assert.deepEqual(seen,[]);
}));
test('actual native pending approval reply is handled and confirmed without action execution',()=>promptFixture((path,server)=>httpFixture(async(http,seen)=>{
 const s=services(),a=await admitted(path,'1');await a.requirePendingReply();await createMessageProcessor(context(path,server,http,s.ports))(a);assert.equal(s.calls.execute,0);assert.equal(s.calls.notify,0);assert.deepEqual(await callPromptFixture(server,'answers'),[{id:'approval',result:{decision:'accept'}}]);assert.equal((await state.getIngress(path,'message:3'))!.confirmationDelivered,true);assert.deepEqual(seen,['POST']);
}),{enableResponses:true}));
test('frozen malformed plan never begins action; cleanup marks not-executed hold',()=>fixture(async(path,server,http,seen)=>{
 const s=services();await assert.rejects(createMessageProcessor(context(path,server,http,s.ports))(await admitted(path,'!discard-request invalid')),e=>messageWorkerErrorInfo(e)?.kind==='Plan');assert.equal(s.calls.execute,0);assert.equal(s.calls.target,0);assert.equal((await state.getIngress(path,'message:3'))!.state,'held');assert.deepEqual(seen,[]);
}));
test('database mismatch disposes original custody and never touches context database',()=>fixture(async(path,server,http,seen)=>{
 const s=services(),a=await admitted(path,'!help'),other=join(dirname(path),'other.sqlite');await assert.rejects(createMessageProcessor(context(other,server,http,s.ports))(a),MessageDatabaseMismatchError);assert.equal((await state.getIngress(path,'message:3'))!.state,'held');assert.equal(s.calls.execute,0);assert.deepEqual(seen,[]);
}));
test('new attachments are durable before execution while raw New plan remains unchanged',()=>fixture(async(path,server,http,seen)=>{
 const s=services(async(action,_actor,key)=>{assert.deepEqual(action,{New:{prompt:'raw'}});const row=(await state.getIngress(path,key))!;assert.match(newExecutionPrompt(row)!,/sha256: /);assert.match(newExecutionPrompt(row)!,/abc/);return {text:'created',waitsForFinal:false,ui:null};});await createMessageProcessor(context(path,server,http,s.ports))(await admitted(path,'!new raw',{attachments:attachment}));assert.equal(s.calls.execute,1);assert.deepEqual(seen,['POST']);
}));
test('required attachment failure prevents executor and leaves held source request',()=>fixture(async(path,server,http,seen)=>{
 const s=services(),ctx=context(path,server,http,s.ports);ctx.config={...config,attachmentsEnabled:false};await assert.rejects(createMessageProcessor(ctx)(await admitted(path,'!new raw',{attachments:attachment})),e=>messageWorkerErrorInfo(e)?.kind==='Attachment');assert.equal(s.calls.execute,0);assert.deepEqual(seen,[]);assert.equal((await state.getIngress(path,'message:3'))!.state,'held');
}));
test('result persistence failure sends nothing after action and leaves unconfirmed custody',()=>fixture(async(path,server,http,seen)=>{
 const a=await admitted(path,'!help');await edit(path,"CREATE TRIGGER reject_result BEFORE UPDATE OF outcome_json ON discord_ingress_journal BEGIN SELECT RAISE(ABORT,'result blocked'); END");const s=services();await assert.rejects(createMessageProcessor(context(path,server,http,s.ports))(a),e=>messageWorkerErrorInfo(e)?.kind==='Store');assert.equal(s.calls.execute,1);assert.deepEqual(seen,[]);assert.equal(s.calls.notify,0);
}));
test('known cleanup refusal confirms without second executor or generic action result',()=>fixture(async(path,server,http,seen)=>{
 const s=services(async()=>{throw new ActionExecutionError('MirrorSync',new MirrorCleanupProtectedError(9n,'queued requests'));});await createMessageProcessor(context(path,server,http,s.ports))(await admitted(path,'!help'));assert.equal(s.calls.execute,1);assert.equal(s.calls.notify,1);assert.equal((await state.getIngress(path,'message:3'))!.confirmationDelivered,true);assert.deepEqual(seen,['POST']);
}));
test('ServerPrompts UI sends no trailing ordinary message even when prompt list is empty',()=>fixture(async(path,server,http,seen)=>{
 const s=services(async()=>({text:'do not send as ordinary message',waitsForFinal:false,ui:{kind:'ServerPrompts',prompts:[]}}));await createMessageProcessor(context(path,server,http,s.ports))(await admitted(path,'!help'));assert.deepEqual(seen,[]);assert.equal((await state.getIngress(path,'message:3'))!.confirmationDelivered,true);assert.equal(s.calls.notify,1);
}));
test('source persisted !new arm response bypasses business action and confirms planned reply',()=>fixture(async(path,server,http,seen)=>{
 const s=services();await createMessageProcessor(context(path,server,http,s.ports))(await admitted(path,'!new'));assert.equal(s.calls.execute,0);assert.deepEqual(seen,['POST']);const row=(await state.getIngress(path,'message:3'))!;assert.equal(row.confirmationDelivered,true);assert.equal(typeof (row.outcome as any).response,'string');
}));
test('known refusal confirmation-write failure keeps known-outcome classification and sends only its notice',()=>fixture(async(path,server,http,seen)=>{
 const a=await admitted(path,'!help');await edit(path,"CREATE TRIGGER reject_confirmation BEFORE UPDATE OF confirmation_delivered ON discord_ingress_journal WHEN NEW.confirmation_delivered=1 BEGIN SELECT RAISE(ABORT,'confirmation blocked'); END");const s=services(async()=>{throw new ActionExecutionError('MirrorSync',new MirrorCleanupProtectedError(9n,'queued requests'));});await assert.rejects(createMessageProcessor(context(path,server,http,s.ports))(a),e=>messageWorkerErrorInfo(e)?.kind==='KnownOutcomeNotification');assert.deepEqual(seen,['POST']);assert.equal((await state.getIngress(path,'message:3'))!.confirmationDelivered,false);assert.equal(s.calls.notify,0);
}));
test('processor captures attachment configuration before ownership and awaited target work',()=>fixture(async(path,server,http,seen)=>{
 const s=services(),ctx=context(path,server,http,s.ports);ctx.config={...config};const process=createMessageProcessor(ctx);ctx.config.attachmentsEnabled=false;await process(await admitted(path,'!new raw',{attachments:attachment}));assert.equal(s.calls.execute,1);assert.deepEqual(seen,['POST']);
}));
