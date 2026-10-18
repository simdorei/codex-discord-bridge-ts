import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,join} from 'node:path';
import {writeFile,readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {OwnedPortableAppServerProcess} from '../../src/app-server/portable-process.ts';
import {resolveRuntimePaths} from '../../src/runtime/runtime-paths/resolve.ts';
import {runThreadAdmin} from '../../src/cli/admin-threads.ts';
import {OwnedWorkerTimeoutError} from '../../src/runtime/owned-worker-slot.ts';
const thread='01234567-0123-4567-89ab-0123456789ab',child='01234567-0123-4567-89ab-0123456789ac';
for(const persist of [true,false])test('thread admin joins provider and '+(persist?'verifies complete archive scope':'retains fences when archive persistence is unconfirmed'),{skip:process.platform!=='win32',timeout:20000},t=>storeFixture(async path=>{
 const root=dirname(path),state=join(root,'state.sqlite'),bridge=join(root,'bridge.json'),db=new DatabaseSync(state),mirror=await openInitialized(path);mirror.close();
 db.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');for(const id of [thread,child])db.prepare('INSERT INTO threads(id,title,cwd,updated_at,archived) VALUES(?,?,?,1,0)').run(id,'CLI archive fixture',root);db.close();await writeFile(bridge,JSON.stringify({selected_thread_id:thread}));
 const source=`import readline from 'node:readline';import {DatabaseSync} from 'node:sqlite';readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='thread/list')result={data:[{id:${JSON.stringify(child)}}],nextCursor:null};if(m.method==='thread/resume'||m.method==='thread/read')result={thread:{id:m.params.threadId,status:{type:'idle',activeFlags:[]},turns:[]}};if(m.method==='thread/archive'&&${persist}){const db=new DatabaseSync(${JSON.stringify(state)});db.exec('UPDATE threads SET archived=1,archived_at=42');db.close();}process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');});`;
 const spawned:OwnedPortableAppServerProcess[]=[],spawn=OwnedPortableAppServerProcess.spawn;t.mock.method(OwnedPortableAppServerProcess,'spawn',async(config:Parameters<typeof spawn>[0])=>{const p=await spawn.call(OwnedPortableAppServerProcess,{...config,arguments:['--input-type=module','-e',source]});spawned.push(p);return p;});
 const paths=await resolveRuntimePaths({CODEX_EXE:process.execPath,CODEX_HOME:root,CODEX_STATE_DB:state,CODEX_DISCORD_MIRROR_DB:path,CODEX_BRIDGE_STATE:bridge},{root,userHome:root,localAppCandidates:[],pathCandidates:[]});
 try{
  const listing=await runThreadAdmin(paths,'test',undefined,10n);assert.match(listing,/CLI archive fixture/);assert.ok(listing.includes(thread));
  // The last native observation shares the original deadline. It can exhaust
  // inside the worker or between polls; both must preserve the same evidence.
  const pending=runThreadAdmin(paths,'test',thread,0n);if(persist)assert.match(await pending,/persisted state verified/);else await assert.rejects(pending,e=>e instanceof OwnedWorkerTimeoutError||e instanceof Error&&/persisted state was not verified/.test(e.message));
  const check=new DatabaseSync(path,{readOnly:true});try{assert.equal(check.prepare('SELECT count(*) n FROM codex_archive_fences').get()!.n,2);assert.equal(check.prepare('SELECT count(*) n FROM codex_archive_fences WHERE phase=?').get(persist?'verified':'attempted')!.n,2);}finally{check.close();}
  const result=new DatabaseSync(state,{readOnly:true});try{assert.equal(result.prepare('SELECT count(*) n FROM threads WHERE archived=1').get()!.n,persist?2:0);}finally{result.close();}
  assert.equal(JSON.parse(await readFile(bridge,'utf8')).selected_thread_id,persist?undefined:thread);assert.ok(spawned.every(p=>p.exitConfirmed));
 }finally{for(const p of spawned)await p.forceDispose();}
}));
