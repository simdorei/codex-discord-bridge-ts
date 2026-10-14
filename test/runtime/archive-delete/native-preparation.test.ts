import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dirname,join} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {prepareArchiveDeletion,ArchivePreparationError} from '../../../src/runtime/archive-delete/native-preparation.ts';
import type {ValidatedArchiveBackupPaths} from '../../../src/runtime/archive-delete/native-backup.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const confirmation={messageId:11n,channelId:3n,userId:7n,reference:'t'};
async function fixture(run:(mirror:string,p:ValidatedArchiveBackupPaths,rollout:string)=>Promise<void>){await storeFixture(async mirror=>{
 const root=dirname(mirror),archive=join(root,'archived');mkdirSync(archive);const rollout=join(archive,'r.jsonl');writeFileSync(rollout,'saved transcript\n');
 const p={state:join(root,'state.sqlite'),logs:join(root,'logs.sqlite'),global:join(root,'global.json'),bridge:join(root,'bridge.json'),index:join(root,'index.jsonl'),archivedSessions:archive,root:join(root,'recovery')};
 const source=new DatabaseSync(p.state);try{source.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,archived INTEGER)');source.prepare('INSERT INTO threads VALUES(?,?,1)').run('t',rollout);}finally{source.close();}writeFileSync(p.global,'{}');writeFileSync(p.bridge,'{}');writeFileSync(p.index,'{"id":"t"}\n');
 const db=await openInitialized(mirror);try{db.exec("INSERT INTO mirror_threads VALUES('t','p','title',2,3,1)");db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES('message:11','message',11,3,7,?,'executing','executing','t',1,1)").run('{"plan":{"Execute":{"DeleteArchiveConfirm":{"reference":"t"}}}}');}finally{db.close();}
 await run(mirror,p,rollout);
 });}
function fence(mirror:string){const db=new DatabaseSync(mirror,{readOnly:true});try{return db.prepare('SELECT token,phase FROM cdr_archive_fences').get();}finally{db.close();}}
test('one native preparation preserves sources and backs up exact durable reservation',()=>fixture(async(mirror,p,rollout)=>{
 const receipt=await prepareArchiveDeletion(mirror,p,'t',2,confirmation,10000);assert.equal(fence(mirror)?.token,receipt.token);assert.equal(fence(mirror)?.phase,'deleting');assert.equal(receipt.files,5);assert.equal(receipt.rollout,rollout);assert.equal(readFileSync(rollout,'utf8'),'saved transcript\n');assert.equal(readFileSync(join(receipt.sourceDirectory,'transcript','rollout.jsonl'),'utf8'),'saved transcript\n');
 const db=new DatabaseSync(join(receipt.directory,'mirror.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT token FROM cdr_archive_fences').get()?.token,receipt.token);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mirror_threads').get()?.n,1);}finally{db.close();}assert.equal(ownedWorkerUsage().Background,0);
}));
test('wrong original user cannot reserve or create recovery directory',()=>fixture(async(mirror,p)=>{
 await assert.rejects(prepareArchiveDeletion(mirror,p,'t',2,{...confirmation,userId:8n},10000),e=>e instanceof ArchivePreparationError&&e.token===null&&e.recoveryDirectory===null);assert.equal(fence(mirror),undefined);assert.equal(existsSync(p.root),false);
}));
test('failure after reservation keeps fence and mirror backup for explicit recovery',()=>fixture(async(mirror,p,rollout)=>{
 writeFileSync(p.bridge,'[]');let failure:ArchivePreparationError|undefined;await assert.rejects(prepareArchiveDeletion(mirror,p,'t',2,confirmation,10000),e=>{assert.ok(e instanceof ArchivePreparationError);failure=e;return true;});assert.ok(failure?.token);assert.equal(fence(mirror)?.token,failure.token);assert.ok(existsSync(join(failure.recoveryDirectory!,'mirror.sqlite')));assert.ok(existsSync(rollout));assert.equal(ownedWorkerUsage().Background,0);
}));
test('repeated preparation never replaces existing token or creates another recovery directory',()=>fixture(async(mirror,p)=>{
 const first=await prepareArchiveDeletion(mirror,p,'t',2,confirmation,10000);await assert.rejects(prepareArchiveDeletion(mirror,p,'t',3,confirmation,10000));assert.equal(fence(mirror)?.token,first.token);assert.equal(readdirSync(p.root).length,1);
}));
test('pre-abort has exact reason and no reservation',()=>fixture(async(mirror,p)=>{
 const controller=new AbortController(),reason={cancel:'before'};controller.abort(reason);await assert.rejects(prepareArchiveDeletion(mirror,p,'t',2,confirmation,10000,controller.signal),e=>e===reason);assert.equal(fence(mirror),undefined);assert.equal(existsSync(p.root),false);
}));
test('in-flight cancellation joins native exit and never implies reservation rollback',()=>fixture(async(mirror,p)=>{
 const controller=new AbortController(),reason={cancel:'inflight'};const pending=prepareArchiveDeletion(mirror,p,'t',2,confirmation,10000,controller.signal);controller.abort(reason);await assert.rejects(pending,e=>e===reason);assert.equal(ownedWorkerUsage().Background,0);const row=fence(mirror);assert.ok(row===undefined||row.phase==='deleting');
}));
test('concurrent call fails before starting a second preparation',()=>fixture(async(mirror,p)=>{
 const first=prepareArchiveDeletion(mirror,p,'t',2,confirmation,10000);await assert.rejects(prepareArchiveDeletion(mirror,p,'t',2,confirmation,10000),/busy/i);await first;assert.equal(readdirSync(p.root).length,1);
}));
test('path alias, oversized reference and deadline are rejected before reservation',()=>fixture(async(mirror,p)=>{
 await assert.rejects(prepareArchiveDeletion(mirror,{...p,state:mirror},'t',2,confirmation,10000),/distinct/);await assert.rejects(prepareArchiveDeletion(mirror,p,'t',2,{...confirmation,reference:'a'.repeat(4097)},10000),/budget/);await assert.rejects(prepareArchiveDeletion(mirror,p,'t',2,confirmation,0),/Invalid/);assert.equal(fence(mirror),undefined);assert.equal(existsSync(p.root),false);
}));
test('active source is refused before installing a durable archive reservation',()=>fixture(async(mirror,p)=>{
 const db=new DatabaseSync(p.state);try{db.exec('UPDATE threads SET archived=0');}finally{db.close();}await assert.rejects(prepareArchiveDeletion(mirror,p,'t',2,confirmation,10000),/ActiveThread/);assert.equal(fence(mirror),undefined);assert.equal(existsSync(p.root),false);
}));
