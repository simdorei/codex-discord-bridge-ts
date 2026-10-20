import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {NativeMirrorSourceReader} from '../../../src/runtime/mirror-sync/source-reader.ts';
const signal=()=>new AbortController().signal;
async function fixture(run:(path:string,db:DatabaseSync,reader:NativeMirrorSourceReader)=>Promise<void>){await storeFixture(async path=>{
 const db=new DatabaseSync(path);try{db.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');await run(path,db,new NativeMirrorSourceReader(path));}finally{db.close();}
});}
function row(db:DatabaseSync,id:string,archived=0){db.prepare("INSERT INTO threads VALUES(?,?,'/p',1,'/missing',NULL,NULL,9007199254740993,?,2)").run(id,id,archived);}
test('complete active inventory ignores missing rollout and excludes only archived records',async()=>fixture(async(path,db,reader)=>{
 row(db,'root');row(db,'child');row(db,'archived',1);const bytes=readFileSync(path);assert.deepEqual([...await reader.activeIds(signal())].sort(),['child','root']);assert.deepEqual(readFileSync(path),bytes);
}));
test('exact reads preserve archive discriminator and lossless numeric fields',async()=>fixture(async(path,db,reader)=>{
 row(db,'active');row(db,'archived',1);const before=readFileSync(path);const a=await reader.thread('active',false,signal());assert.equal(a?.tokensUsed,9007199254740993n);assert.equal(a?.archivedAt,0n);assert.equal(await reader.thread('active',true,signal()),null);assert.equal((await reader.thread('archived',true,signal()))?.archivedAt,2n);assert.equal(await reader.thread('missing',false,signal()),null);assert.deepEqual(readFileSync(path),before);
}));
test('a later active restoration is observed rather than cached as absent',async()=>fixture(async(_path,db,reader)=>{
 assert.equal(await reader.thread('restored',false,signal()),null);row(db,'restored');assert.equal((await reader.thread('restored',false,signal()))?.id,'restored');db.exec('UPDATE threads SET archived=1');assert.equal(await reader.thread('restored',false,signal()),null);assert.equal((await reader.thread('restored',true,signal()))?.id,'restored');
}));
test('corrupt selected rows fail complete inventory instead of manufacturing absence',async()=>fixture(async(_path,db,reader)=>{
 row(db,'good');row(db,'bad');db.exec("UPDATE threads SET updated_at='bad' WHERE id='bad'");await assert.rejects(reader.activeIds(signal()),/absence not established/);assert.equal((await reader.thread('good',false,signal()))?.id,'good');await assert.rejects(reader.thread('bad',false,signal()),/absence not established/);
}));
test('missing database errors and pre-abort never create Codex storage',async()=>storeFixture(async path=>{
 const reader=new NativeMirrorSourceReader(path);await assert.rejects(reader.activeIds(signal()),/absence not established/);assert.equal(existsSync(path),false);const abort=new AbortController(),reason=new Error('cancel');abort.abort(reason);await assert.rejects(reader.thread('x',false,abort.signal),e=>e===reason);assert.equal(existsSync(path),false);
}));
