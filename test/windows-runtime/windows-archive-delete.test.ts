import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dirname,join} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {prepareArchiveDeletion} from '../../src/runtime/archive-delete/native-preparation.ts';
import {OwnedWorkerSlot} from '../../src/runtime/owned-worker-slot.ts';
for(const changed of [false,true])test(`native archive deletion ${changed?'preserves changed metadata and fence':'backs up and removes exact target only'}`,{skip:process.platform!=='win32',timeout:30000},()=>storeFixture(async mirror=>{
 const root=dirname(mirror),archive=join(root,'archived');mkdirSync(archive);const rollout=join(archive,'r.jsonl');writeFileSync(rollout,'saved transcript\n');
 const paths={state:join(root,'state.sqlite'),logs:join(root,'logs.sqlite'),global:join(root,'global.json'),bridge:join(root,'bridge.json'),index:join(root,'index.jsonl'),archivedSessions:archive,root:join(root,'recovery')};
 const source=new DatabaseSync(paths.state);source.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,archived INTEGER,title TEXT);CREATE TABLE thread_spawn_edges(child_thread_id TEXT,parent_thread_id TEXT)');source.prepare('INSERT INTO threads VALUES(?,?,1,?)').run('t',rollout,'archived');source.prepare('INSERT INTO threads VALUES(?,?,1,?)').run('other','other.jsonl','keep');source.close();
 const logs=new DatabaseSync(paths.logs);logs.exec("CREATE TABLE logs(thread_id TEXT,message TEXT);INSERT INTO logs VALUES('t','delete'),('other','keep')");logs.close();writeFileSync(paths.global,'{"pinned-thread-ids":["t","other"]}');writeFileSync(paths.bridge,'{"selected_thread_id":"t"}');writeFileSync(paths.index,'{"id":"t"}\n{"id":"other"}\n');
 const db=await openInitialized(mirror);db.exec("INSERT INTO mirror_threads VALUES('t','p','title',2,3,1)");db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,created_at,updated_at) VALUES('message:11','message',11,3,7,?,'executing','executing','t',1,1)").run('{"plan":{"Execute":{"DeleteArchiveConfirm":{"reference":"t"}}}}');db.close();
 const prepared=await prepareArchiveDeletion(mirror,paths,'t',2,{messageId:11n,channelId:3n,userId:7n,reference:'t'},10000);
 if(changed)writeFileSync(paths.bridge,'{"selected_thread_id":"other"}');
 const slot=new OwnedWorkerSlot();const work=slot.run(new URL('../../src/runtime/archive-delete/delete-worker.ts',import.meta.url),{mirror,paths,id:'t',prepared,cancelled:new SharedArrayBuffer(4)},15000);let output:any;try{output=await work;}finally{await slot.join();}
 assert.equal(output.ok,!changed,JSON.stringify(output,(_,v)=>typeof v==='bigint'?v.toString():v));assert.equal(existsSync(rollout),changed);const state=new DatabaseSync(paths.state,{readOnly:true});assert.equal(state.prepare("SELECT COUNT(*) n FROM threads WHERE id='t'").get()!.n,changed?1:0);assert.equal(state.prepare("SELECT COUNT(*) n FROM threads WHERE id='other'").get()!.n,1);state.close();
 assert.equal(readFileSync(join(prepared.sourceDirectory,'transcript','rollout.jsonl'),'utf8'),'saved transcript\n');const result=new DatabaseSync(mirror,{readOnly:true});assert.equal(result.prepare('SELECT phase FROM cdr_archive_fences').get()!.phase,changed?'deleting':'deleted');result.close();if(!changed)assert.deepEqual(JSON.parse(readFileSync(paths.global,'utf8')),{'pinned-thread-ids':['other']});
}));
