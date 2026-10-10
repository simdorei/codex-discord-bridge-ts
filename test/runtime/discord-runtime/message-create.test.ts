import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {prepareGatewayMessage as prepare,PreparedGatewayMessage,type MessageCreateOptions} from '../../../src/runtime/discord-runtime/message-create.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {AdmissionGate,AdmissionPermit,DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {messageWorkerErrorInfo} from '../../../src/runtime/message-worker/errors.ts';
import {MessageDatabaseMismatchError} from '../../../src/runtime/message-worker/admission.ts';
const fence=()=>DrainFenceKey.create('runtime','1|2','message');
function message(id:number,content:string,extra:Record<string,unknown>={}){return decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content,edited_timestamp:null,embeds:[],id:String(id),mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-02-02T02:02:02.020000+00:00',tts:false,type:0,...extra}));}
function options(database:string,gate=new AdmissionGate(),allowDrainControl=false):MessageCreateOptions{return {database,gate,allowDrainControl,config:{enableMessageContent:true,plainAskMentionUserIds:new Set()},basePolicy:new InteractionAccessPolicy({allowAllChannels:true,allowedChannelIds:[],allowedUserIds:[],mirroredChannelIds:[]}),resolver:null,observedAt:100,custody:{now:()=>101,report:()=>{}}};}
const forbidden=()=>new InteractionAccessPolicy({allowAllChannels:true,allowedChannelIds:[],allowedUserIds:[99n],mirroredChannelIds:[]});
test('normal preparation holds gate through processing and disposal and deduplicates durable ingress',()=>storeFixture(async path=>{
 const gate=new AdmissionGate(),o=options(path,gate),p=await prepare(message(3,'!help'),null,o),key=fence();assert.equal(p.kind,'Admitted');gate.seal(key);assert.equal(gate.isDrainedFor(key),false);
 let calls=0;await p.dispatch(async a=>{calls++;const parts=a.intoProcessingParts(path);try{assert.notEqual(parts.admissionPermit,null);await parts.custody.begin(null);await state.recordIngressResult(path,'message:3',{response:'done'},101);await parts.custody.finish();}finally{await parts.custody.dispose();parts.admissionPermit!.release();}},async()=>assert.fail());assert.equal(calls,1);assert.equal(gate.isDrainedFor(key),true);
 // Source ordering requires a live admission before deduplication.
 assert.equal((await prepare(message(3,'!help'),null,o)).kind,'Unavailable');
 const duplicate=await prepare(message(3,'!help'),null,options(path));assert.equal(duplicate.kind,'Duplicate');await duplicate.dispatch(async()=>assert.fail(),async()=>assert.fail());assert.throws(()=>p.dispatch(async()=>{},async()=>{}),/consumed/);
}));
test('preparation during drain admits only pending text and stop controls, then stops after control closure',()=>storeFixture(async path=>{
 const gate=new AdmissionGate(),key=fence();gate.seal(key);const o=options(path,gate,true);
 for(const [id,text,mode] of [[3,'answer','PendingReplyOnly'],[4,'!stop','Normal']] as const){const p=await prepare(message(id,text),null,o);assert.equal(p.kind,'Admitted');await p.dispatch(async a=>{const parts=a.intoProcessingParts(path);try{assert.equal(parts.processingMode,mode);}finally{await parts.custody.dispose();parts.admissionPermit!.release();}},async()=>assert.fail());}
 assert.equal((await prepare(message(5,'!help'),null,o)).kind,'Unavailable');assert.equal(await state.isProcessedMessage(path,5n),false);gate.closeControls(key);assert.equal((await prepare(message(6,'answer'),null,o)).kind,'Unavailable');assert.equal(gate.isDrainedFor(key),true);
}));
test('human forced restart repair and recover bypass closed drain but remain authorized and deduplicated',()=>storeFixture(async path=>{
 const gate=new AdmissionGate(),key=fence();gate.seal(key);gate.closeControls(key);const o=options(path,gate,true);let id=10;
 for(const command of ['!force_restart','!repair','!recover']){const m=message(id++,command),p=await prepare(m,null,o);assert.equal(p.kind,'Admitted');await p.dispatch(async a=>{const parts=a.intoProcessingParts(path);try{assert.equal(parts.admissionPermit,null);}finally{await parts.custody.dispose();}},async()=>assert.fail());assert.equal((await prepare(m,null,o)).kind,'Duplicate');}
 assert.equal((await prepare(message(20,'!recover'),null,{...o,basePolicy:forbidden()})).kind,'Ignore');assert.equal((await prepare(message(21,'!force_restart',{author:{id:'2',username:'u',discriminator:'0',bot:true}}),null,o)).kind,'Ignore');assert.equal(gate.isDrainedFor(key),true);
}));
test('denied identity never claims processed marker even when force restart bypasses drain',()=>storeFixture(async path=>{
 const p=await prepare(message(3,'!force_restart'),null,{...options(path),basePolicy:forbidden()});assert.equal(p.kind,'Ignore');assert.equal(p.ignored?.reason,'user_not_allowed');assert.equal(await state.isProcessedMessage(path,3n),false);await p.dispose();
}));
test('fresh mirror access replaces stale dynamic policy and blocks on actual store failure',()=>storeFixture(async path=>{
 const basePolicy=new InteractionAccessPolicy({allowAllChannels:false,allowedChannelIds:[],allowedUserIds:[],mirroredChannelIds:[1n]}),o={...options(path),basePolicy};assert.equal((await prepare(message(3,'!help'),null,o)).kind,'Ignore');
 const db=await openInitialized(path);try{db.exec("INSERT INTO mirror_threads VALUES ('t','p','title',10,1,1)");}finally{db.close();}const p=await prepare(message(4,'!help'),null,o);assert.equal(p.kind,'Admitted');await p.dispose();
 const bad=await openInitialized(path);try{bad.exec('ALTER TABLE mirror_threads RENAME COLUMN discord_thread_id TO broken_thread_id');}finally{bad.close();}await assert.rejects(prepare(message(5,'!help'),null,o));
}));
test('unavailable has one original error report and no executable ingress',()=>storeFixture(async path=>{
 const gate=new AdmissionGate();gate.seal(fence());const p=await prepare(message(3,'!help'),null,options(path,gate));let calls=0;await p.dispatch(async()=>assert.fail(),async(target,error)=>{calls++;assert.equal(target.messageId,3n);assert.equal(messageWorkerErrorInfo(error)?.kind,'Restarting');});assert.equal(calls,1);assert.equal(await state.getIngress(path,'message:3'),null);
}));
test('gate permit survives central error report await and disposal joins instead of releasing early',()=>storeFixture(async path=>{
 const gate=new AdmissionGate(),p=await prepare(message(3,'!help'),null,options(path,gate)),key=fence();gate.seal(key);let release!:()=>void,started!:()=>void;const began=new Promise<void>(r=>started=r),hold=new Promise<void>(r=>release=r);
 const pending=p.dispatch(async()=>{throw Error('processing failed');},async()=>{started();await hold;});await began;let disposed=false;const cleanup=p.dispose().then(()=>{disposed=true;});await Promise.resolve();assert.equal(disposed,false);assert.equal(gate.isDrainedFor(key),false);release();await pending;await cleanup;assert.equal(gate.isDrainedFor(key),true);assert.equal((await state.getIngress(path,'message:3'))!.state,'held');
}));
test('wrong database remains fatal with no report while original permit and custody release',()=>storeFixture(async path=>{
 const gate=new AdmissionGate(),p=await prepare(message(3,'!help'),null,options(path,gate)),key=fence();gate.seal(key);await assert.rejects(p.dispatch(async()=>{throw new MessageDatabaseMismatchError(path,'other');},async()=>assert.fail()),MessageDatabaseMismatchError);assert.equal(gate.isDrainedFor(key),true);assert.equal((await state.getIngress(path,'message:3'))!.state,'held');
}));
test('unconsumed preparation disposal releases claimed custody and cannot later dispatch',()=>storeFixture(async path=>{
 const gate=new AdmissionGate(),p=await prepare(message(3,'!help'),null,options(path,gate)),key=fence();gate.seal(key);await p.dispose();assert.equal(gate.isDrainedFor(key),true);assert.throws(()=>p.dispatch(async()=>{},async()=>{}),/consumed/);assert.equal((await state.getIngress(path,'message:3'))!.state,'held');assert.throws(()=>new PreparedGatewayMessage(Symbol(),'Duplicate',{} as any,null,null),TypeError);
}));
