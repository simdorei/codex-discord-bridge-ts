import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import type {DatabaseSync} from 'node:sqlite';
import {abandonmentStoreFixture} from '../../helpers/abandonment-store-fixture.ts';
import {httpFixture} from '../../helpers/interaction-worker-fixture.ts';
import {AdmissionGate,AdmissionPermit,DrainFenceKey} from '../../../src/admission/drain-gate.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {proposeMessageAbandonment as propose} from '../../../src/runtime/message-worker/recovery-abandonment.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {publicationTimeBits} from '../../../src/store/publication-codec.ts';
const job='550e8400-e29b-41d4-a716-446655440000';
function message(extra:Record<string,unknown>={}){return decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'2',username:'u',discriminator:'0',bot:false},channel_id:'1',content:'!discard-request '+job,edited_timestamp:null,embeds:[],id:'8',mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-02-02T02:02:02.020000+00:00',tts:false,type:0,...extra}));}
async function fixture(run:(db:DatabaseSync,path:string,permit:AdmissionPermit,locks:TargetLocks,v:ControlTurnVerifier,gate:AdmissionGate)=>Promise<void>){await abandonmentStoreFixture(async(db,path)=>{
 await state.admitIngress(path,{ingressId:'message:8',kind:'message',eventId:8n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:8n,payload:{version:1n,content:'!discard-request '+job,author_is_bot:false,processing_mode:'normal',plan:{Execute:{DiscardRequest:{job_id:job}}}},targetThreadId:'t',canonicalOwner:null,now:100});await state.beginIngressExecution(path,'message:8','processing','t',101);
 const gate=new AdmissionGate(),permit=gate.tryEnter(),locks=new TargetLocks(),v=new ControlTurnVerifier(path,null,{selectedThreadId:()=>null},locks);try{await run(db,path,permit,locks,v,gate);}finally{permit.release();}
 },true,job);}
const count=(db:DatabaseSync,table='cdr_recovery_abandonment_proposals')=>db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n;
test('human source creates and binds exact delivered proposal but never records decision or starts request',()=>fixture(async(db,path,permit,locks,v)=>httpFixture(async(http,seen)=>{
 await propose(message(),job,permit,path,4n,http,v,()=>200);assert.deepEqual(seen,['POST']);assert.equal(count(db),1);assert.equal(count(db,'cdr_recovery_abandonment_decisions'),0);assert.equal(count(db,'codex_turn_queue'),1);assert.equal(count(db,'cdr_async_recovery_policies'),1);assert.equal(locks.activeTargetCount,0);
 const id=String(db.prepare('SELECT id FROM cdr_recovery_abandonment_proposals').get()!.id),p=state.deliveredAbandonmentProposal(path,id,1n);assert.equal(p.message_id,101n);assert.equal(p.proposal.application_id,4n);assert.equal(p.proposal.expires_at_bits,publicationTimeBits(320));assert.match(p.proposal.review_text,/never replayed/);
 const r=(await state.getIngress(path,'message:8'))!;assert.deepEqual(r.outcome,{kind:'abandonment_proposal',proposal_id:id,revision:1n,decision_recorded:false,request_started:false});assert.equal(r.confirmationDelivered,false);
})));
test('missing released and forged permits cannot create or deliver proposal',()=>fixture(async(db,path,permit,_locks,v)=>httpFixture(async(http,seen)=>{
 for(const p of [null,Object.create(AdmissionPermit.prototype)])await assert.rejects(propose(message(),job,p,path,4n,http,v,()=>200),/live normal admission/);permit.release();await assert.rejects(propose(message(),job,permit,path,4n,http,v,()=>200),/live normal admission/);assert.equal(count(db),0);assert.deepEqual(seen,[]);
})));
test('bot, wrong authenticated owner and mismatched frozen content cannot create proposal',()=>fixture(async(db,path,permit,locks,v)=>httpFixture(async(http,seen)=>{
 for(const m of [message({author:{id:'2',username:'u',discriminator:'0',bot:true}}),message({author:{id:'9',username:'u',discriminator:'0',bot:false}}),message({content:'!discard-request other'})])await assert.rejects(propose(m,job,permit,path,4n,http,v,()=>200));assert.equal(count(db),0);assert.equal(locks.activeTargetCount,0);assert.deepEqual(seen,[]);
})));
test('non-normal persisted mode refuses proposal before outbound delivery',()=>fixture(async(db,path,permit,locks,v)=>httpFixture(async(http,seen)=>{
 db.exec("UPDATE discord_ingress_journal SET payload_json=json_set(payload_json,'$.processing_mode','pending_reply_only') WHERE ingress_id='message:8'");await assert.rejects(propose(message(),job,permit,path,4n,http,v,()=>200),/frozen authenticated ingress/);assert.equal(count(db),0);assert.equal(locks.activeTargetCount,0);assert.deepEqual(seen,[]);
})));
test('mapping changed while waiting is refused without releasing another owner or retargeting',()=>fixture(async(db,path,permit,locks,v)=>httpFixture(async(http,seen)=>{
 const held=await locks.acquire('t'),pending=propose(message(),job,permit,path,4n,http,v,()=>200);await tick();db.exec("UPDATE mirror_threads SET discord_thread_id=99 WHERE codex_thread_id='t'");held.release();await assert.rejects(pending);assert.equal(count(db),0);assert.equal(locks.activeTargetCount,0);assert.deepEqual(seen,[]);
})));
test('target lock deadline creates no proposal and private permit pins drain until joined',()=>fixture(async(db,path,permit,locks,v,gate)=>httpFixture(async(http,seen)=>{
 const owner=await locks.acquire('t'),pending=propose(message(),job,permit,path,4n,http,v,()=>200),key=DrainFenceKey.create('runtime','1|2','worker');permit.release();gate.seal(key);assert.equal(gate.isDrainedFor(key),false);
 try{await assert.rejects(pending,/target is busy/);owner.requireTarget('t');assert.equal(gate.isDrainedFor(key),true);assert.equal(count(db),0);assert.deepEqual(seen,[]);}finally{owner.release();}assert.equal(locks.activeTargetCount,0);
})));
test('ten-second delivery deadline joins owned HTTP and leaves unknown receipt without binding or execution',{timeout:15000},()=>fixture(async(db,path,permit,locks,v)=>{
 const {createServer}=await import('node:http');const {DiscordChannelClient}=await import('../../../src/discord/channel-client.ts');let calls=0;
 const server=createServer((req,res)=>{req.resume();req.on('end',()=>{calls++;res.writeHead(200,{'Content-Type':'application/json'});res.write('{');});});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const http=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v10/`,report:()=>{}});
 try{await assert.rejects(propose(message(),job,permit,path,4n,http,v,()=>200),/delivery is unconfirmed/);assert.equal(calls,1);assert.equal(http.activeRequests,0);assert.equal(locks.activeTargetCount,0);assert.equal(count(db),1);assert.equal(count(db,'cdr_recovery_abandonment_deliveries'),0);assert.equal(count(db,'cdr_recovery_abandonment_decisions'),0);assert.equal(count(db,'codex_turn_queue'),1);assert.equal(await state.unknownDeliveryReceiptCount(path),1n);assert.equal((await state.getIngress(path,'message:8'))!.outcome,undefined);assert.equal(db.prepare("SELECT outcome_json FROM discord_ingress_journal WHERE ingress_id='message:8'").get()!.outcome_json,null);}
 finally{await http.close();server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r()));assert.equal(http.ownedSockets,0);}
}));
