import {it} from 'node:test';import assert from 'node:assert/strict';import {createServer} from 'node:http';import {dirname,join} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {asyncChoiceServer} from '../../helpers/async-choice-server.ts';
import {recoverDiscordHistoryChannel,type DiscordHistoryGapOptions} from '../../../src/runtime/history-poll/discord-gap.ts';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';import {AdmissionGate,DrainFenceKey} from '../../../src/admission/drain-gate.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';import {SettingsTargetResolver} from '../../../src/runtime/settings-binding.ts';import {BridgeState} from '../../../src/runtime/bridge-state.ts';import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';import {TargetLocks} from '../../../src/core/keyed-locks.ts';
const message=(id:number,content='!help',bot=false,channel='1')=>({attachments:[],author:{id:'2',username:'u',discriminator:'0',bot},channel_id:channel,content,embeds:[],id:String(id),type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false});
const floor={micros:1577836800000000n,messageId:1n};
async function fixture(page:unknown[],run:(f:{path:string;options:DiscordHistoryGapOptions;calls:unknown[];seen:string[];reports:string[]})=>Promise<void>){
 await storeFixture(path=>asyncChoiceServer({},async server=>{
  const seen:string[]=[],calls:unknown[]=[],reports:string[]=[],web=createServer((req,res)=>{req.resume();req.on('end',()=>{seen.push(req.method!);res.end(JSON.stringify(req.method==='GET'?page:message(100+seen.length,'')));});});await new Promise<void>(r=>web.listen(0,'127.0.0.1',r));
  const http=await DiscordChannelClient.create({token:null,testOrigin:'http://127.0.0.1:'+(web.address() as {port:number}).port+'/api/v10/',report:()=>{}}),bridge=new BridgeState(join(dirname(path),'bridge.json'));
  const options:DiscordHistoryGapOptions={applicationId:4n,botUserId:9n,gate:new AdmissionGate(),classification:{enableMessageContent:true,plainAskMentionUserIds:new Set()},policy:new InteractionAccessPolicy({allowAllChannels:true,allowedChannelIds:[],allowedUserIds:[],mirroredChannelIds:[]}),resolver:new SettingsTargetResolver(join(dirname(path),'codex.sqlite'),path,bridge),report:code=>{reports.push(code);},context:{database:path,server,http,config:{attachmentsEnabled:true,attachmentMaxBytes:100n,attachmentTextInlineMaxBytes:100n},attachmentRoot:dirname(path),attachmentTransport:{async get(){assert.fail();}},attachmentReport:()=>{},controlVerifier:new ControlTurnVerifier(path,server,bridge,new TargetLocks()),services:{async targetThreadId(){return 't';},async executeWithIngressContext(action,_actor,key){calls.push({action,key});return {text:'done',waitsForFinal:false,ui:null};},notifyDeliveryReady(){}},now:()=>102}};
  try{await run({path,options,calls,seen,reports});}finally{await http.close();web.closeAllConnections();await new Promise<void>((r,j)=>web.close(e=>e?j(e):r()));}
 }));
}
it('actual HTTP page is processed oldest first and durable duplicate suppression prevents replay',async()=>fixture([message(3),message(2)],async f=>{
 const out=await recoverDiscordHistoryChannel(f.options,1n,floor);assert.equal(out.coverage,'Reached');assert.equal(out.processed,2);assert.deepEqual(f.calls.map((v:any)=>v.key),['message:2','message:3']);assert.deepEqual(f.seen,['GET','POST','POST']);
 const repeat=await recoverDiscordHistoryChannel(f.options,1n,floor);assert.equal(repeat.processed,0);assert.equal(f.calls.length,2);assert.equal((await state.getIngress(f.path,'message:2'))!.confirmationDelivered,true);
}));
it('same-page !new admission is visible to later unmentioned prompt classification',async()=>fixture([message(3,'first prompt'),message(2,'!new')],async f=>{
 f.options.classification.plainAskMentionUserIds.add(777n);const out=await recoverDiscordHistoryChannel(f.options,1n,floor);assert.equal(out.processed,2);assert.deepEqual(f.calls,[{action:{New:{prompt:'first prompt'}},key:'message:3'}]);const row=await state.getIngress(f.path,'message:3');assert.equal((row!.payload as any).new_prompt_arm_ref,'message:2');assert.deepEqual(f.seen,['GET','POST','POST']);
}));
it('bots and force restart history never claim execution; full window remains incomplete',async()=>fixture(Array.from({length:10},(_,i)=>message(20-i,i===0?'!force_restart':'!help',i!==0)),async f=>{
 const out=await recoverDiscordHistoryChannel(f.options,1n,floor);assert.equal(out.coverage,'Incomplete');assert.equal(out.processed,0);assert.deepEqual(f.calls,[]);assert.equal(await state.isProcessedMessage(f.path,20n),false);assert.deepEqual(f.seen,['GET']);
}));
it('cross-channel response rejects entire page before first durable claim',async()=>fixture([message(3),message(2,'!help',false,'7')],async f=>{
 await assert.rejects(recoverDiscordHistoryChannel(f.options,1n,floor),/adaptation/);assert.equal(await state.isProcessedMessage(f.path,3n),false);assert.deepEqual(f.calls,[]);assert.deepEqual(f.seen,['GET']);
}));
it('sealed admission refuses HTTP and releases no foreign permit',async()=>fixture([message(2)],async f=>{
 const key=DrainFenceKey.create('runtime','1|2','worker');f.options.gate.seal(key);await assert.rejects(recoverDiscordHistoryChannel(f.options,1n,floor));assert.deepEqual(f.seen,[]);assert.equal(f.options.gate.isDrainedFor(key),true);
}));
it('cancellation during business work joins custody and releases the outer drain permit',async()=>fixture([message(3),message(2)],async f=>{
 const c=new AbortController(),reason=new Error('stop history');let started!:()=>void,finish!:()=>void;const entered=new Promise<void>(r=>started=r),release=new Promise<void>(r=>finish=r);let settled=false;
 f.options.context.services.executeWithIngressContext=async(_a,_actor,_key,signal)=>{started();await release;assert.equal(signal!.reason,reason);throw reason;};
 const pending=recoverDiscordHistoryChannel(f.options,1n,floor,c.signal);void pending.then(()=>settled=true,()=>settled=true);const check=assert.rejects(pending,e=>e===reason);await entered;c.abort(reason);const key=DrainFenceKey.create('runtime','1|2','worker');f.options.gate.seal(key);assert.equal(f.options.gate.isDrainedFor(key),false);assert.equal(settled,false);finish();await check;assert.equal((await state.getIngress(f.path,'message:2'))!.state,'held');assert.equal(await state.getIngress(f.path,'message:3'),null);assert.equal(f.options.gate.isDrainedFor(key),true);assert.deepEqual(f.seen,['GET']);
}));

import {MessageGapTracker} from '../../../src/discord/gateway/message-gaps.ts';
import {recoverPendingDiscordHistory} from '../../../src/runtime/discord-runtime/gap-recovery.ts';
const record=(tracker:MessageGapTracker,id=1n)=>tracker.record(1n,{timestampMicros:floor.micros,messageId:id},'Full');
it('real gap recovery acknowledges original notice only after complete processing and delivery',async()=>fixture([message(2)],async f=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe();try{record(tracker);await recoverPendingDiscordHistory(rx,f.options);assert.equal(rx.snapshot().length,0);assert.deepEqual(f.reports,['discord_message_gap_recovered']);assert.equal((await state.getIngress(f.path,'message:2'))!.confirmationDelivered,true);}finally{rx.dispose();tracker.close();}
}));
it('full newer window retains sticky gap and reports incomplete coverage',async()=>fixture(Array.from({length:10},(_,i)=>message(20-i,'!help',true)),async f=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe();try{record(tracker);await recoverPendingDiscordHistory(rx,f.options);assert.equal(rx.snapshot().length,1);assert.deepEqual(f.reports,['discord_message_gap_degraded']);}finally{rx.dispose();tracker.close();}
}));
it('new gap during processing makes original acknowledgement stale and cannot clear newer revision',async()=>fixture([message(2)],async f=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe();try{record(tracker);const execute=f.options.context.services.executeWithIngressContext;f.options.context.services.executeWithIngressContext=async(...args)=>{record(tracker,3n);return execute(...args);};await recoverPendingDiscordHistory(rx,f.options);assert.equal(rx.snapshot()[0]!.snapshot().revision,2n);assert.deepEqual(f.reports,['discord_message_gap_ack_stale']);}finally{rx.dispose();tracker.close();}
}));
it('malformed provider page is recoverable source failure and never acknowledges gap',async()=>fixture([{}],async f=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe();try{record(tracker);await recoverPendingDiscordHistory(rx,f.options);assert.equal(rx.snapshot().length,1);assert.deepEqual(f.reports,['discord_message_gap_failed']);assert.deepEqual(f.calls,[]);}finally{rx.dispose();tracker.close();}
}));
it('sealed gap pass defers without fetching or consuming pending notice',async()=>fixture([message(2)],async f=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe();try{record(tracker);f.options.gate.seal(DrainFenceKey.create('runtime','1|2','worker'));await recoverPendingDiscordHistory(rx,f.options);assert.equal(rx.snapshot().length,1);assert.deepEqual(f.seen,[]);assert.deepEqual(f.reports,['discord_message_gap_deferred']);}finally{rx.dispose();tracker.close();}
}));
it('fatal processing report failure preserves pending notice and propagates after custody cleanup',async()=>fixture([message(2)],async f=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe(),fatal=new Error('report failure');try{record(tracker);f.options.context.services.executeWithIngressContext=async()=>{throw Error('business failure');};const options={...f.options,report:(code:string)=>{if(code==='on_message_error')throw fatal;}};await assert.rejects(recoverPendingDiscordHistory(rx,options));assert.equal(rx.snapshot().length,1);assert.equal((await state.getIngress(f.path,'message:2'))!.state,'held');const seal=DrainFenceKey.create('runtime','1|2','worker');f.options.gate.seal(seal);assert.equal(f.options.gate.isDrainedFor(seal),true);}finally{rx.dispose();tracker.close();}
}));

import {writeFileSync} from 'node:fs';
it('actual corrupt policy database reports policy failure without fetching or acknowledging gap',async()=>fixture([message(2)],async f=>{
 const tracker=new MessageGapTracker(),rx=tracker.subscribe();try{record(tracker);writeFileSync(f.path,'not a sqlite database');await recoverPendingDiscordHistory(rx,f.options);assert.equal(rx.snapshot().length,1);assert.deepEqual(f.seen,[]);assert.deepEqual(f.reports,['discord_message_gap_failed']);}finally{rx.dispose();tracker.close();}
}));
