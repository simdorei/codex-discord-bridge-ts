import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {beginMirrorCategory as begin,confirmMirrorContainer as confirm,bindMirrorCategory as bind,mirrorCategoryReceipt as receipt,loadContainerIn,expectedContainerMapping,type MirrorContainerReceipt} from '../../src/store/mirror-container-creation.ts';
async function fixture(run:(path:string,db:DatabaseSync)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{await run(path,db);}finally{db.close();}});}
function fence(db:DatabaseSync,id:bigint,target:string|null=null){db.prepare("INSERT INTO cdr_cleanup_fences VALUES(?,?,'fence','deleting',1)").run(id,target);}
const read=(db:DatabaseSync)=>loadContainerIn(db,'category','1');
test('category attempt blocks duplicate creation and unknown result reuse',async()=>fixture(async(path,db)=>{
 assert.equal(await receipt(path,1n),null);const a=await begin(path,1n,null);assert.equal(a.phase,'attempted');assert.match(a.token,/^[a-f0-9-]{36}$/u);
 await assert.rejects(begin(path,1n,null),/already claimed/);await assert.rejects(receipt(path,1n),/outcome is unknown/);assert.deepEqual(read(db),a);
}));
test('confirmed category binds once; stale confirmation fails and bound receipt is idempotent',async()=>fixture(async(path,db)=>{
 const a=await begin(path,1n,null),c=await confirm(path,a,3n);assert.equal((await receipt(path,1n))?.channel,3n);await bind(path,c);
 const b=await receipt(path,1n);assert.equal(b?.phase,'bound');await assert.rejects(bind(path,c),/custody changed/);await bind(path,b!);assert.deepEqual(read(db),b);await assert.rejects(confirm(path,a,3n),/custody changed/);
}));
test('only exact bound previous receipt permits category replacement',async()=>fixture(async(path,db)=>{
 const a=await begin(path,1n,null);await assert.rejects(begin(path,1n,a),/only an authoritatively missing/);
 const c=await confirm(path,a,3n);await assert.rejects(begin(path,1n,c),/only an authoritatively missing/);await bind(path,c);const b=(await receipt(path,1n))!;
 await assert.rejects(begin(path,2n,b),/replacement scope changed/);await assert.rejects(begin(path,1n,{...b,token:'foreign'}),/custody changed/);
 const next=await begin(path,1n,b);assert.notEqual(next.token,b.token);assert.equal(next.channel,null);assert.equal(read(db)?.phase,'attempted');
}));
test('confirmation persists a known result despite cleanup, while binding and lookup refuse',async()=>fixture(async(path,db)=>{
 const a=await begin(path,1n,null);fence(db,3n);const c=await confirm(path,a,3n);assert.equal(read(db)?.channel,3n);
 await assert.rejects(bind(path,c),/blocked by room cleanup/);await assert.rejects(receipt(path,1n),/blocked by room cleanup/);assert.equal(read(db)?.phase,'confirmed');
}));
test('bound category replacement respects direct and mapped-child cleanup fences',async()=>fixture(async(path,db)=>{
 const c=await confirm(path,await begin(path,1n,null),3n);await bind(path,c);const b=(await receipt(path,1n))!;
 db.exec("INSERT INTO mirror_threads(codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at) VALUES('thread','p','t',3,4,1)");
 for(const [id,target] of [[3n,null],[4n,null],[99n,'thread']] as const){fence(db,id,target);await assert.rejects(begin(path,1n,b),/blocked by room cleanup/);assert.deepEqual(read(db),b);db.exec('DELETE FROM cdr_cleanup_fences');}
}));
test('ignored or altered insert is rolled back atomically',async()=>fixture(async(path,db)=>{
 db.exec("CREATE TRIGGER ignore_insert BEFORE INSERT ON cdr_mirror_container_creations BEGIN SELECT RAISE(IGNORE); END");await assert.rejects(begin(path,1n,null),/intent was not stored/);assert.equal(read(db),null);db.exec('DROP TRIGGER ignore_insert');
 db.exec("CREATE TRIGGER alter_insert AFTER INSERT ON cdr_mirror_container_creations BEGIN UPDATE cdr_mirror_container_creations SET token='foreign'; END");await assert.rejects(begin(path,1n,null),/custody changed/);assert.equal(read(db),null);
}));
test('ignored or altered confirmation retains original attempted receipt',async()=>fixture(async(path,db)=>{
 const a=await begin(path,1n,null);db.exec("CREATE TRIGGER ignore_confirm BEFORE UPDATE ON cdr_mirror_container_creations BEGIN SELECT RAISE(IGNORE); END");await assert.rejects(confirm(path,a,3n),/confirmation was not stored/);assert.deepEqual(read(db),a);db.exec('DROP TRIGGER ignore_confirm');
 db.exec("CREATE TRIGGER alter_confirm AFTER UPDATE ON cdr_mirror_container_creations BEGIN UPDATE cdr_mirror_container_creations SET channel_id=9; END");await assert.rejects(confirm(path,a,3n),/custody changed/);assert.deepEqual(read(db),a);
}));
test('post-bind cleanup trigger rolls back both bound phase and new fence',async()=>fixture(async(path,db)=>{
 const c=await confirm(path,await begin(path,1n,null),3n);db.exec("CREATE TRIGGER fence_bind AFTER UPDATE ON cdr_mirror_container_creations WHEN NEW.phase='bound' BEGIN INSERT INTO cdr_cleanup_fences VALUES(3,NULL,'fence','deleting',1); END");
 await assert.rejects(bind(path,c),/blocked by room cleanup/);assert.deepEqual(read(db),c);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cdr_cleanup_fences').get()?.n,0);
}));
test('stored expected snapshots retain exact i64 integers and reject malformed values',()=>{
 const base:MirrorContainerReceipt={kind:'project',key:'p',token:'t',guild:1n,parent:2n,expected:'[]',phase:'attempted',channel:null};
 assert.deepEqual(expectedContainerMapping({...base,expected:'[["p",9223372036854775807],["q",-9223372036854775808]]'}),[['p',(1n<<63n)-1n],['q',-(1n<<63n)]]);
 for(const expected of ['null','{}','[1]','[["p",1.0]]','[["p",9223372036854775808]]','[["p",1,2]]','[[null,1]]'])assert.throws(()=>expectedContainerMapping({...base,expected}),/invalid container creation mapping snapshot/);
});
test('invalid stored text or category scope cannot grant reuse',async()=>fixture(async(path,db)=>{
 const a=await begin(path,1n,null);await confirm(path,a,3n);db.exec("UPDATE cdr_mirror_container_creations SET expected_json='[[\"p\",1]]'");await assert.rejects(receipt(path,1n),/category creation scope changed/);
 db.exec("UPDATE cdr_mirror_container_creations SET expected_json='[]',token=CAST(x'ff' AS TEXT)");await assert.rejects(receipt(path,1n),/Invalid text encoding/);
}));
test('arguments are immutable across owned opening and reject accessor/proxy receipt inputs',async()=>fixture(async(path,db)=>{
 const a=await begin(path,1n,null);let hooks=0;const getter={...a};Object.defineProperty(getter,'token',{get(){hooks++;return a.token;}});await assert.rejects(confirm(path,getter,3n),TypeError);
 await assert.rejects(confirm(path,new Proxy(a,{get(){hooks++;throw Error('trap');}}),3n),TypeError);assert.equal(hooks,0);
 const mutable={...a};const pending=confirm(path,mutable,3n);mutable.token='changed';await pending;assert.equal(read(db)?.token,a.token);
}));
test('invalid guild and returned IDs fail without creating custody',async()=>fixture(async(path,db)=>{
 for(const guild of [0n,-1n])await assert.rejects(begin(path,guild,null),/invalid category creation scope/);await assert.rejects(begin(path,1n<<63n,null),TypeError);assert.equal(read(db),null);
 const a=await begin(path,1n,null);await assert.rejects(confirm(path,a,0n),/invalid container creation confirmation/);assert.deepEqual(read(db),a);
}));
