import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {decodeGatewayInteraction} from '../../../src/discord/gateway/decoded-interaction.ts';
import {boundedRemainingDiscordIdsIn} from '../../../src/store/mirror-policy-snapshot.ts';
import {remainingDiscordIdsIn} from '../../../src/store/mirror-policy-read.ts';
import {refreshMirrorPolicyOffThread,NativeMirrorPolicyError} from '../../../src/runtime/discord-runtime/native-mirror-policy.ts';
import {OwnedWorkerBusyError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const limits={maxRows:100n,maxValueBytes:65536n,maxOutputIds:200,timeoutMs:5000};
function schema(db:DatabaseSync){db.exec(`CREATE TABLE mirror_threads(codex_thread_id TEXT,thread_title TEXT,discord_channel_id,discord_thread_id,updated_at);
 CREATE TABLE mirror_projects(discord_channel_id);`);}
const policy=()=>new InteractionAccessPolicy({allowedChannelIds:[1n],allowedUserIds:[2n],mirroredChannelIds:[77n],allowAllChannels:false});
function allowed(p:InteractionAccessPolicy,channel:bigint,user=2n){return p.evaluate(decodeGatewayInteraction(JSON.stringify({application_id:'4',id:'3',token:'fixture',type:2,authorizing_integration_owners:{},channel_id:String(channel),user:{id:String(user),username:'u',discriminator:'0001'},data:{id:'9',name:'help',type:1}}))).kind==='Allowed';}
async function fixture(body:(path:string,db:DatabaseSync)=>Promise<void>){await storeFixture(async path=>{const db=new DatabaseSync(path);try{schema(db);await body(path,db);}finally{if(db.isOpen){try{if(db.isTransaction)db.exec('ROLLBACK');}finally{db.close();}}}});}
test('bounded ID snapshot reuses exact source decoding, multiplicity and i64 values',()=>{
 const db=new DatabaseSync(':memory:');try{schema(db);db.exec(`INSERT INTO mirror_threads VALUES ('a','a',9,7,1),('b','b',9,7,2),('c','c',9,-2,3),('d','d',9,NULL,4),('e','e',9,0,5),('f','f',9,9223372036854775807,6);INSERT INTO mirror_projects VALUES (9),(9),(-3),(0),(NULL)`);
 assert.deepEqual(boundedRemainingDiscordIdsIn(db,11n,1000n),remainingDiscordIdsIn(db));
 assert.deepEqual(boundedRemainingDiscordIdsIn(db,11n,1000n),{threadIds:[-2n,7n,9223372036854775807n],projectChannelIds:[9n,9n,-3n]});
 assert.throws(()=>boundedRemainingDiscordIdsIn(db,10n,1000n),/budget/);assert.throws(()=>boundedRemainingDiscordIdsIn(db,11n,1n),/budget/);assert.equal(db.isTransaction,false);
 db.exec('BEGIN;INSERT INTO mirror_projects VALUES (88)');assert.throws(()=>boundedRemainingDiscordIdsIn(db,100n,1000n));assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
 }finally{db.close();}
});
test('native complete policy preserves source filters, static restrictions and replaces stale rooms',async()=>{
 await fixture(async(path,db)=>{db.exec(`INSERT INTO mirror_threads VALUES ('t','T',8,7,1),('','empty',66,67,2),('max','M',9223372036854775807,9007199254740993,3),('negative','N',-5,-6,4);INSERT INTO mirror_projects VALUES (9),(9)`);
 const base=policy(),next=await refreshMirrorPolicyOffThread(base,path,limits);
 for(const id of [1n,7n,8n,9n,67n,9223372036854775807n,9007199254740993n])assert.equal(allowed(next,id),true);
 assert.equal(allowed(next,66n),false);assert.equal(allowed(next,77n),false);assert.equal(allowed(next,7n,3n),false);assert.equal(allowed(base,77n),true);
 db.exec('DELETE FROM mirror_threads;DELETE FROM mirror_projects');const empty=await refreshMirrorPolicyOffThread(next,path,limits);assert.equal(allowed(empty,7n),false);assert.equal(allowed(empty,1n),true);
 });
});
test('row, raw value and output budgets hold the complete policy without stale fallback',async()=>{
 await fixture(async(path,db)=>{db.exec(`INSERT INTO mirror_threads VALUES ('t','T',8,7,1);INSERT INTO mirror_projects VALUES (9)`);const base=policy();
 for(const change of [{maxRows:1n},{maxValueBytes:1n},{maxOutputIds:1}])await assert.rejects(refreshMirrorPolicyOffThread(base,path,{...limits,...change}),NativeMirrorPolicyError);
 assert.equal(allowed(base,77n),true);assert.equal(allowed(base,7n),false);
 db.exec(`UPDATE mirror_threads SET thread_title=CAST(x'ff' AS TEXT),codex_thread_id='',discord_thread_id=0`);await assert.rejects(refreshMirrorPolicyOffThread(base,path,limits),NativeMirrorPolicyError);
 db.exec(`UPDATE mirror_threads SET thread_title='T',discord_thread_id=1.5`);await assert.rejects(refreshMirrorPolicyOffThread(base,path,limits),NativeMirrorPolicyError);
 });
});
test('missing store never initializes; invalid policy and hook limits fail before native work',async()=>{
 await storeFixture(async path=>{await assert.rejects(refreshMirrorPolicyOffThread(policy(),path,limits),NativeMirrorPolicyError);assert.equal(existsSync(path),false);
 let hooks=0;const bad=Object.defineProperty({},'maxRows',{get(){hooks++;return 1n;}});await assert.rejects(refreshMirrorPolicyOffThread(policy(),path,bad as never),TypeError);
 await assert.rejects(refreshMirrorPolicyOffThread(new Proxy(policy(),{get(){hooks++;throw Error('hook');}}),path,limits),TypeError);assert.equal(hooks,0);assert.equal(existsSync(path),false);
 const a=new AbortController();a.abort('stop');await assert.rejects(refreshMirrorPolicyOffThread(policy(),path,limits,a.signal),e=>e==='stop');assert.equal(existsSync(path),false);
 });
});
test('native cancellation retains actual worker ownership then releases capacity for explicit reuse',async()=>{
 await fixture(async(path)=>{const a=new AbortController(),reason={cancel:true};const first=refreshMirrorPolicyOffThread(policy(),path,limits,a.signal);a.abort(reason);
 await assert.rejects(refreshMirrorPolicyOffThread(policy(),path,limits),OwnedWorkerBusyError);await assert.rejects(first,e=>e===reason);
 assert.equal(ownedWorkerUsage().Background,0);await refreshMirrorPolicyOffThread(policy(),path,limits);
 });
});
test('locked native database leaves main-loop timer responsive and never returns a partial policy',async()=>{
 await fixture(async(path,db)=>{db.exec('BEGIN EXCLUSIVE');let ticks=0;const timer=setInterval(()=>ticks++,10);
 try{await assert.rejects(refreshMirrorPolicyOffThread(policy(),path,limits),NativeMirrorPolicyError);assert.ok(ticks>=2,'native lock wait must not block main loop timers');assert.equal(db.isTransaction,true);}finally{clearInterval(timer);db.exec('ROLLBACK');}
 await refreshMirrorPolicyOffThread(policy(),path,limits);
 });
});
test('resource limits are captured before asynchronous mutation and native timeout joins actual exit',async()=>{
 await fixture(async(path,db)=>{db.exec(`INSERT INTO mirror_threads VALUES ('a','A',8,7,1);INSERT INTO mirror_projects VALUES (9)`);
 const mutable={...limits,maxRows:1n};const pending=refreshMirrorPolicyOffThread(policy(),path,mutable);mutable.maxRows=100n;await assert.rejects(pending,/budget/);
 await assert.rejects(refreshMirrorPolicyOffThread(policy(),path,{...limits,timeoutMs:1}),/timed out/);assert.equal(ownedWorkerUsage().Background,0);
 const next=await refreshMirrorPolicyOffThread(policy(),path,limits);assert.equal(allowed(next,9n),true);
 });
});
