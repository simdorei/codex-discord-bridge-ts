import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join,dirname} from 'node:path';
import {writeFileSync,readFileSync,unlinkSync,linkSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {CodexThreadStore} from '../../../src/codex-state/store.ts';
import type {ThreadInfo} from '../../../src/codex-state/thread.ts';
import {NativeArchivedCleanup} from '../../../src/runtime/mirror-sync/archived-native.ts';
import {OwnedWorkerSlot} from '../../../src/runtime/owned-worker-slot.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
import {parseSerdeValue} from '../../../src/core/serde-json-parse.ts';
const fresh=()=>new AbortController().signal;
async function fixture(run:(native:NativeArchivedCleanup,expected:ThreadInfo,codexDb:DatabaseSync,mirrorDb:DatabaseSync,codex:string,mirror:string)=>Promise<void>){await storeFixture(async mirror=>{
 const codex=join(dirname(mirror),'codex.sqlite'),rollout=join(dirname(mirror),'rollout.jsonl');writeFileSync(rollout,'{}\n');const db=new DatabaseSync(codex),bridge=await openInitialized(mirror);
 try{
  db.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');db.prepare("INSERT INTO threads VALUES('thread','title','/p',1,?,NULL,NULL,0,1,12)").run(rollout);bridge.exec("INSERT INTO mirror_threads VALUES('thread','p','title',2,3,1)");
  const payload=serializeSerdeValue({busy_action:'steer',busy_choice:{choice_id:'choice',owner_user_id:7n,channel_id:3n,target_thread_id:'thread',prompt:'p',allow_steer:false,created_at:10,expires_at:20}});
  bridge.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,canonical_owner,outcome_json,confirmation_delivered,created_at,updated_at) VALUES('interaction:1','interaction',1,3,7,?,'held','result_recorded','thread','busy-choice:choice',?,0,10,11)").run(payload,'{"kind":"busy_control_preflight_rejected","control_dispatched":false}');
  const expected=CodexThreadStore.open(codex).loadThread('thread',true)!;await run(new NativeArchivedCleanup(codex,mirror),expected,db,bridge,codex,mirror);
 }finally{bridge.close();db.close();}
});}
const counts=(db:DatabaseSync)=>[db.prepare('SELECT count(*) AS n FROM cdr_cleanup_fences').get()?.n,db.prepare('SELECT count(*) AS n FROM cdr_archived_cleanup_evidence').get()?.n];
import * as http from 'node:http';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {NativeMirrorStore} from '../../../src/runtime/mirror-sync/store-native.ts';
import {MirrorObsoleteCleanup} from '../../../src/runtime/mirror-sync/obsolete-cleanup.ts';
const row={threadId:'thread',discordThreadId:3n,title:'title'};
const room=(extra={})=>({id:'3',type:11,guild_id:'1',parent_id:'2',name:'title',...extra});
async function remote(handler:http.RequestListener,run:(client:DiscordChannelClient)=>Promise<void>){const server=http.createServer(handler);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');const client=await DiscordChannelClient.create({token:null,report:()=>{},testOrigin:`http://127.0.0.1:${address.port}/api/v10/`});try{await run(client);}finally{await client.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}}
test('complete active inventory preserves a missing-rollout active mapping without HTTP',async()=>fixture(async(_native,expected,db,bridge,codex,mirror)=>{
 db.exec('UPDATE threads SET archived=0');unlinkSync(expected.rolloutPath);let calls=0;await remote((_q,r)=>{calls++;r.end(JSON.stringify(room()));},async client=>{assert.equal(await new MirrorObsoleteCleanup(codex,mirror,new NativeMirrorStore(mirror),client).retireObsolete(1n,2000000000,fresh()),0);assert.equal(calls,0);assert.equal(bridge.prepare('SELECT count(*) AS n FROM mirror_threads').get()?.n,1);});
}));
test('ordinary obsolete mapping retires only after guarded DELETE',async()=>fixture(async(_native,_expected,_db,bridge,codex,mirror)=>{
 bridge.exec('DELETE FROM discord_ingress_journal');const calls:string[]=[];await remote((q,r)=>{calls.push(q.method!);if(q.method==='DELETE'){r.writeHead(204);r.end();}else r.end(JSON.stringify(room()));},async client=>{const store=new NativeMirrorStore(mirror);assert.equal(await new MirrorObsoleteCleanup(codex,mirror,store,client).retireObsolete(1n,2000000000,fresh()),1);assert.deepEqual(calls,['GET','DELETE']);assert.equal(await store.execute({kind:'ThreadChannels',args:['thread']}),null);});
}));
test('source restoration during lookup preserves mapping and avoids DELETE',async()=>fixture(async(_native,_expected,db,bridge,codex,mirror)=>{
 bridge.exec('DELETE FROM discord_ingress_journal');const calls:string[]=[];await remote((q,r)=>{calls.push(q.method!);db.exec('UPDATE threads SET archived=0');r.end(JSON.stringify(room()));},async client=>{assert.equal(await new MirrorObsoleteCleanup(codex,mirror,new NativeMirrorStore(mirror),client).retireObsolete(1n,2000000000,fresh()),0);assert.deepEqual(calls,['GET']);assert.deepEqual(counts(bridge),[0,0]);});
}));
test('shared active owner causes explicit reconciliation instead of mapping-only deletion',async()=>fixture(async(_native,_expected,db,bridge,codex,mirror)=>{
 bridge.exec('DELETE FROM discord_ingress_journal');db.exec("INSERT INTO threads SELECT 'active',title,cwd,updated_at,rollout_path,model,reasoning_effort,tokens_used,0,0 FROM threads");bridge.exec("INSERT INTO mirror_threads VALUES('active','p','title',2,3,1)");let calls=0;await remote((_q,r)=>{calls++;r.end(JSON.stringify(room()));},async client=>{await assert.rejects(new MirrorObsoleteCleanup(codex,mirror,new NativeMirrorStore(mirror),client).retireObsolete(1n,2000000000,fresh()),/shared Discord room/);assert.equal(calls,0);assert.equal(bridge.prepare('SELECT count(*) AS n FROM mirror_threads').get()?.n,2);});
}));
test('matching archived non-dispatch uses the audited exception branch',async()=>fixture(async(_native,_expected,_db,bridge,codex,mirror)=>{
 const calls:string[]=[];await remote((q,r)=>{calls.push(q.method!);if(q.method==='DELETE'){r.writeHead(204);r.end();}else r.end(JSON.stringify(room()));},async client=>{assert.equal(await new MirrorObsoleteCleanup(codex,mirror,new NativeMirrorStore(mirror),client).retireObsolete(1n,2000000000,fresh()),1);assert.deepEqual(calls,['GET','DELETE']);assert.deepEqual(counts(bridge),[1,1]);});
}));
test('absent source does not gain the archived exception from matching JSON alone',async()=>fixture(async(_native,_expected,db,bridge,codex,mirror)=>{
 db.exec('DELETE FROM threads');let calls=0;await remote((_q,r)=>{calls++;r.end(JSON.stringify(room()));},async client=>{await assert.rejects(new MirrorObsoleteCleanup(codex,mirror,new NativeMirrorStore(mirror),client).retireObsolete(1n,2000000000,fresh()));assert.equal(calls,0);assert.deepEqual(counts(bridge),[0,0]);});
}));
test('a protected missing room is never treated as permission to remove mapping',async()=>fixture(async(_native,_expected,db,bridge,codex,mirror)=>{
 db.exec('DELETE FROM threads');let calls=0;await remote((_q,r)=>{calls++;r.writeHead(404);r.end('{"code":10003,"message":"gone"}');},async client=>{await assert.rejects(new MirrorObsoleteCleanup(codex,mirror,new NativeMirrorStore(mirror),client).retireObsolete(1n,2000000000,fresh()));assert.equal(calls,0);assert.equal(bridge.prepare('SELECT count(*) AS n FROM mirror_threads').get()?.n,1);});
}));
test('exact-parent path retains an archived source rather than using the archived exception',async()=>fixture(async(_native,_expected,_db,bridge,codex,mirror)=>{
 bridge.exec('DELETE FROM discord_ingress_journal');const calls:string[]=[];await remote((q,r)=>{calls.push(q.method!);r.end(JSON.stringify(room()));},async client=>{assert.equal(await new MirrorObsoleteCleanup(codex,mirror,new NativeMirrorStore(mirror),client).retireRow(1n,2000000000,row,2n,fresh()),false);assert.deepEqual(calls,['GET']);assert.deepEqual(counts(bridge),[0,0]);});
}));
