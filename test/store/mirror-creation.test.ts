import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {beginMirrorCreation as begin,confirmMirrorCreation as confirm,confirmedMirrorCreation as confirmed,readMirrorCreationIn,finishMirrorCreationIn,type MirrorCreationScope} from '../../src/store/mirror-creation.ts';
import {withStoreTransaction,commitStore} from '../../src/store/owned-scope.ts';
const scope:MirrorCreationScope={thread:'original',guild:1n,parent:2n,expected:null};
async function fixture(run:(path:string,db:DatabaseSync)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{await run(path,db);}finally{db.close();}});}
function mapping(db:DatabaseSync,parent=2n,channel=3n){db.prepare("INSERT INTO mirror_threads(codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at) VALUES('original','p','title',?,?,1)").run(parent,channel);}
function fence(db:DatabaseSync,channel=2n,target:string|null=null){db.prepare("INSERT INTO cdr_cleanup_fences VALUES(?,?,'fence','deleting',1)").run(channel,target);}
test('attempt survives duplicate begin and confirmed lookup, then exact returned id is retained',async()=>fixture(async(path,db)=>{
 assert.equal(await confirmed(path,scope),null);const token=await begin(path,scope);assert.match(token,/^[a-f0-9-]{36}$/u);await assert.rejects(begin(path,scope),/already claimed/);await assert.rejects(confirmed(path,scope),/outcome is unknown/);
 assert.equal(readMirrorCreationIn(db,'original')?.phase,'attempted');await confirm(path,scope,token,3n);assert.equal(await confirmed(path,scope),3n);await assert.rejects(confirm(path,scope,token,3n),/lost ownership/);
}));
test('scope and original mapping drift never turn an unknown attempt into permission',async()=>fixture(async(path,db)=>{
 mapping(db);const original={...scope,expected:[2n,3n] as const};const token=await begin(path,original);await assert.rejects(confirmed(path,{...original,guild:9n}),/scope changed/);await assert.rejects(confirm(path,original,'wrong',4n),/lost ownership/);await confirm(path,original,token,4n);db.exec("UPDATE mirror_threads SET discord_thread_id=8 WHERE codex_thread_id='original'");await assert.rejects(confirmed(path,original),/mapping changed/);assert.equal(readMirrorCreationIn(db,'original')?.channel,4n);
}));
test('known confirmation is saved despite later cleanup fence; lookup remains blocked',async()=>fixture(async(path,db)=>{
 const token=await begin(path,scope);fence(db);await confirm(path,scope,token,3n);assert.equal(readMirrorCreationIn(db,'original')?.channel,3n);await assert.rejects(confirmed(path,scope),/blocked by room cleanup/);
}));
test('missing creation returns null before cleanup; begin fences parent, expected room and target',async()=>fixture(async(path,db)=>{
 fence(db);assert.equal(await confirmed(path,scope),null);await assert.rejects(begin(path,scope),/blocked by room cleanup/);db.exec('DELETE FROM cdr_cleanup_fences');fence(db,99n,'original');await assert.rejects(begin(path,scope),/blocked by room cleanup/);db.exec('DELETE FROM cdr_cleanup_fences');mapping(db);fence(db,3n);await assert.rejects(begin(path,{...scope,expected:[2n,3n]}),/blocked by room cleanup/);
}));
test('ignored or substituted insert fails exact post-read and rolls back',async()=>fixture(async(path,db)=>{
 db.exec("CREATE TRIGGER ignore_creation BEFORE INSERT ON cdr_mirror_thread_creations BEGIN SELECT RAISE(IGNORE); END");await assert.rejects(begin(path,scope),/not stored/);assert.equal(readMirrorCreationIn(db,'original'),null);db.exec('DROP TRIGGER ignore_creation');
 db.exec("CREATE TRIGGER alter_creation AFTER INSERT ON cdr_mirror_thread_creations BEGIN UPDATE cdr_mirror_thread_creations SET token='foreign' WHERE thread_id=NEW.thread_id; END");await assert.rejects(begin(path,scope),/not exact/);assert.equal(readMirrorCreationIn(db,'original'),null);
}));
test('ignored or altered confirmation retains exact attempted row',async()=>fixture(async(path,db)=>{
 const token=await begin(path,scope);db.exec("CREATE TRIGGER ignore_confirmation BEFORE UPDATE ON cdr_mirror_thread_creations BEGIN SELECT RAISE(IGNORE); END");await assert.rejects(confirm(path,scope,token,3n),/not stored/);assert.equal(readMirrorCreationIn(db,'original')?.phase,'attempted');db.exec('DROP TRIGGER ignore_confirmation');
 db.exec("CREATE TRIGGER alter_confirmation AFTER UPDATE ON cdr_mirror_thread_creations BEGIN UPDATE cdr_mirror_thread_creations SET channel_id=9 WHERE thread_id=NEW.thread_id; END");await assert.rejects(confirm(path,scope,token,3n),/not stored/);assert.equal(readMirrorCreationIn(db,'original')?.phase,'attempted');
}));
test('mapping transaction finishes exact confirmed custody and caller rollback restores it',async()=>fixture(async(path,db)=>{
 const token=await begin(path,scope);await confirm(path,scope,token,3n);const original=readMirrorCreationIn(db,'original');assert.throws(()=>finishMirrorCreationIn(db,'original',2n,3n,null,original),/requires mapping transaction/);
 db.exec('BEGIN IMMEDIATE');try{mapping(db);finishMirrorCreationIn(db,'original',2n,3n,null,original);assert.equal(readMirrorCreationIn(db,'original'),null);}finally{db.exec('ROLLBACK');}assert.deepEqual(readMirrorCreationIn(db,'original'),original);
 withStoreTransaction(db,'IMMEDIATE',()=>{mapping(db);finishMirrorCreationIn(db,'original',2n,3n,null,original);return commitStore(undefined);});assert.equal(readMirrorCreationIn(db,'original'),null);
}));
test('mapping trigger custody substitution rolls back mapping and preserves confirmed row',async()=>fixture(async(path,db)=>{
 const token=await begin(path,scope);await confirm(path,scope,token,3n);const original=readMirrorCreationIn(db,'original');db.exec("CREATE TRIGGER alter_custody AFTER INSERT ON mirror_threads BEGIN UPDATE cdr_mirror_thread_creations SET token='foreign' WHERE thread_id=NEW.codex_thread_id; END");
 assert.throws(()=>withStoreTransaction(db,'IMMEDIATE',()=>{mapping(db);finishMirrorCreationIn(db,'original',2n,3n,null,original);return commitStore(undefined);}),/custody changed/);assert.deepEqual(readMirrorCreationIn(db,'original'),original);assert.equal(db.prepare('SELECT count(*) AS n FROM mirror_threads').get()?.n,0);
}));
test('ignored custody deletion or post-delete fence rolls back complete mapping transaction',async()=>fixture(async(path,db)=>{
 const token=await begin(path,scope);await confirm(path,scope,token,3n);const original=readMirrorCreationIn(db,'original');const finish=()=>withStoreTransaction(db,'IMMEDIATE',()=>{mapping(db);finishMirrorCreationIn(db,'original',2n,3n,null,original);return commitStore(undefined);});
 db.exec("CREATE TRIGGER ignore_finish BEFORE DELETE ON cdr_mirror_thread_creations BEGIN SELECT RAISE(IGNORE); END");assert.throws(finish,/completion was not stored/);db.exec('DROP TRIGGER ignore_finish');
 db.exec("CREATE TRIGGER fence_finish AFTER DELETE ON cdr_mirror_thread_creations BEGIN INSERT INTO cdr_cleanup_fences VALUES(2,NULL,'fence','deleting',1); END");assert.throws(finish,/blocked by room cleanup/);assert.deepEqual(readMirrorCreationIn(db,'original'),original);assert.equal(db.prepare('SELECT count(*) AS n FROM mirror_threads').get()?.n,0);
}));
test('begin validates Rust whitespace and i64 bounds without interpreting BOM as whitespace',async()=>fixture(async(path,db)=>{
 for(const input of [{...scope,thread:'\u0085'},{...scope,guild:0n},{...scope,parent:-1n},{...scope,expected:[2n,0n] as const}])await assert.rejects(begin(path,input),/invalid mirror creation scope/);
 await assert.rejects(begin(path,{...scope,guild:1n<<63n}),TypeError);await assert.rejects(begin(path,{...scope,thread:'\ud800'}),TypeError);await begin(path,{...scope,thread:'\ufeff'});assert.equal(readMirrorCreationIn(db,'\ufeff')?.phase,'attempted');
}));
test('scope snapshot prevents caller mutation after owned open begins',async()=>fixture(async(path,db)=>{
 const s={thread:'original',guild:1n,parent:2n,expected:null};const work=begin(path,s);s.thread='other';s.parent=9n;await work;assert.equal(readMirrorCreationIn(db,'original')?.parent,2n);assert.equal(readMirrorCreationIn(db,'other'),null);
}));
test('invalid stored text is rejected rather than accepting replacement-character identity',async()=>fixture(async(path,db)=>{
 await begin(path,scope);db.exec("UPDATE cdr_mirror_thread_creations SET token=CAST(x'ff' AS TEXT)");await assert.rejects(confirmed(path,scope),/Invalid text encoding/);
}));
