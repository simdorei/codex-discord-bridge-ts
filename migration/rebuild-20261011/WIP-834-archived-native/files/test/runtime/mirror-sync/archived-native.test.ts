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
test('native archive verification atomically commits fence and exact source audit without modifying Codex',async()=>fixture(async(native,expected,_db,bridge,codex)=>{
 const before=readFileSync(codex);assert.equal(await native.pending(3n,'thread',20,fresh()),null);const token=await native.begin(3n,'thread',2n,20,expected,fresh());assert.match(token,/^[0-9a-f-]{36}$/);assert.deepEqual(counts(bridge),[1,1]);const proof=parseSerdeValue<Record<string,unknown>>(String(bridge.prepare('SELECT archive_json FROM cdr_archived_cleanup_evidence').get()?.archive_json));assert.equal(proof.thread_id,'thread');assert.equal(proof.archived_at,12n);assert.equal(proof.notification_confirmation,'unknown-preserved');assert.deepEqual(readFileSync(codex),before);
}));
for(const mode of ['restored','timestamp','path','missing-file'] as const)test('native changed archive '+mode+' rolls back audit and fence',async()=>fixture(async(native,expected,db,bridge)=>{
 if(mode==='restored')db.exec('UPDATE threads SET archived=0');else if(mode==='timestamp')db.exec('UPDATE threads SET archived_at=13');else if(mode==='path')db.exec("UPDATE threads SET rollout_path='/different'");else unlinkSync(expected.rolloutPath);
 await assert.rejects(native.begin(3n,'thread',2n,20,expected,fresh()),/no deletion authorized/);assert.deepEqual(counts(bridge),[0,0]);
}));
test('hard-linked mirror alias is rejected before Codex can be initialized as bridge',async()=>fixture(async(_native,expected,_db,_bridge,codex)=>{
 const alias=join(dirname(codex),'alias.sqlite');linkSync(codex,alias);const before=readFileSync(codex);await assert.rejects(new NativeArchivedCleanup(codex,alias).begin(3n,'thread',2n,20,expected,fresh()));assert.deepEqual(readFileSync(codex),before);
}));
test('preabort and different captured target cannot create a fence',async()=>fixture(async(native,expected,_db,bridge)=>{
 const abort=new AbortController(),reason=new Error('cancel');abort.abort(reason);await assert.rejects(native.begin(3n,'thread',2n,20,expected,abort.signal),e=>e===reason);await assert.rejects(native.begin(3n,'other',2n,20,expected,fresh()),/target differs/);assert.deepEqual(counts(bridge),[0,0]);
}));
test('lost acknowledgement leaves committed fence and audit but returns no deletion token',async context=>fixture(async(native,expected,_db,bridge)=>{
 const original=OwnedWorkerSlot.prototype.run;const mock=context.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<OwnedWorkerSlot['run']>){return original.apply(this,args).then(()=>{throw new Error('lost acknowledgement');});});
 try{await assert.rejects(native.begin(3n,'thread',2n,20,expected,fresh()),/lost acknowledgement/);}finally{mock.mock.restore();}
 assert.deepEqual(counts(bridge),[1,1]);await assert.rejects(native.begin(3n,'thread',2n,20,expected,fresh()));assert.deepEqual(counts(bridge),[1,1]);
}));
