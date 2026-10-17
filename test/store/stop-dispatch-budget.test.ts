import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {acceptRunningStop} from '../../src/store/stop-control-admission.ts';
import {claimStopControl,type StopControl} from '../../src/store/stop-control-dispatch.ts';
async function fixture(run:(path:string,db:DatabaseSync,control:StopControl)=>void,options:{utf16?:boolean;generation?:bigint;nonfinite?:boolean}={}){
 await storeFixture(async path=>{if(options.utf16){const empty=new DatabaseSync(path);empty.exec("PRAGMA encoding='UTF-16le';CREATE TABLE sentinel(value TEXT)");empty.close();}const db=await openInitialized(path);
 try{db.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,?,'original',0,1,'running',1,'V','[]',?,?)").run(options.generation??7n,options.nonfinite?Infinity:1,options.nonfinite?-Infinity:1);
 const c=acceptRunningStop(path,{target:'T',channel:42n,owner:3n},{target:'T',route:'Selected',command:{Stop:{reference:null}}},null,'resident',options.generation??7n,()=>{})!;assert.ok(c);run(path,db,c);
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}});
}
function unchanged(db:DatabaseSync){assert.equal(db.prepare('SELECT phase FROM cdr_stop_controls').get()!.phase,'accepted');assert.equal(db.prepare('SELECT claim_token FROM cdr_stop_controls').get()!.claim_token,null);assert.equal(db.isTransaction,false);}
for(const sql of ["UPDATE codex_turn_queue SET prompt=printf('%.*c',65537,'x')","UPDATE codex_turn_queue SET baseline_turn_ids='['||printf('%.*c',65537,'x')","UPDATE codex_turn_queue SET prompt=zeroblob(70000)","UPDATE codex_turn_queue SET app_server_generation=zeroblob(70000)","UPDATE cdr_execution_holds SET evidence_json=zeroblob(70000)","UPDATE cdr_execution_holds SET evidence_json=printf('%.*c',4194305,'x')","UPDATE cdr_stop_controls SET record_json=zeroblob(4194305)"])
 test(`claim preflights storage before current decoder: ${sql}`,()=>fixture((path,db,c)=>{db.exec(sql);assert.throws(()=>claimStopControl(path,c,()=>{}),/budget|storage class/);unchanged(db);}));
test('mapping bytes, storage and count are bounded before any current route text decode',async()=>{
 for(const text of ["printf('%.*c',65537,'x')","zeroblob(70000)"])await fixture((path,db,c)=>{db.exec(`INSERT INTO mirror_threads VALUES(${text},'p','title',42,43,0)`);assert.throws(()=>claimStopControl(path,c,()=>{}),/budget|storage class/);unchanged(db);});
 await fixture((path,db,c)=>{for(const id of ['a','b','c'])db.prepare("INSERT INTO mirror_threads VALUES(?,'p','title',43,42,0)").run(id);assert.throws(()=>claimStopControl(path,c,()=>{}),/row.*budget/);unchanged(db);});
});
test('UTF-8 multibyte and conservative UTF-16 stored bytes refuse before queue decoding',async()=>{
 await fixture((path,db,c)=>{db.prepare('UPDATE codex_turn_queue SET prompt=?').run('😀'.repeat(16385));assert.throws(()=>claimStopControl(path,c,()=>{}),/field byte.*budget/);unchanged(db);});
 await fixture((path,db,c)=>{db.prepare('UPDATE codex_turn_queue SET prompt=?').run('x'.repeat(16385));assert.throws(()=>claimStopControl(path,c,()=>{}),/field byte.*budget/);unchanged(db);},{utf16:true});
});
test('trigger expansion is remeasured before second queue/mapping/hold validation and claim rolls back',async()=>{
 for(const mutation of ["UPDATE codex_turn_queue SET baseline_turn_ids='['||printf('%.*c',65537,'x')","UPDATE cdr_execution_holds SET evidence_json=zeroblob(70000)","INSERT INTO mirror_threads VALUES(zeroblob(70000),'p','title',42,43,0)","UPDATE cdr_stop_controls SET record_json=zeroblob(70000)"])
 await fixture((path,db,c)=>{db.exec(`CREATE TRIGGER expand AFTER UPDATE OF claim_token ON cdr_stop_controls BEGIN ${mutation}; END`);assert.throws(()=>claimStopControl(path,c,()=>{}),/budget|storage class/);unchanged(db);assert.equal(db.prepare('SELECT baseline_turn_ids FROM codex_turn_queue').get()!.baseline_turn_ids,'[]');});
});
test('cumulative repeated hold reads share one transaction budget',()=>fixture((path,db,c)=>{db.exec("UPDATE cdr_execution_holds SET evidence_json=printf('%.*c',4194304,'x')");assert.throws(()=>claimStopControl(path,c,()=>{}),/repeated-read byte.*budget/);unchanged(db);}));
test('original nested job count and byte limits are checked before clone or JSON parsing',()=>fixture((path,db,c)=>{assert.throws(()=>claimStopControl(path,{...c,jobs:Array(129).fill('bad json')},()=>{}),/row budget/);assert.throws(()=>claimStopControl(path,{...c,jobs:['['+'x'.repeat(4194304)]},()=>{}),/evidence byte budget/);unchanged(db);}));
test('claim requires ordinary existing main tables, never reads decoder-backed views',()=>fixture((path,db,c)=>{db.exec('ALTER TABLE cdr_execution_holds RENAME TO source_holds;CREATE VIEW cdr_execution_holds AS SELECT * FROM source_holds');assert.throws(()=>claimStopControl(path,c,()=>{}),/ordinary main tables/);unchanged(db);}));
test('exact bigint generation and nonfinite typed timestamps preserve original serialization and CAS',()=>fixture((path,db,c)=>{const claim=claimStopControl(path,c,()=>{});assert.ok(claim);assert.equal(claim.control.generation,9007199254740993n);assert.equal(claim.control.jobs[0],c.jobs[0]);assert.equal(db.prepare('SELECT created_at FROM codex_turn_queue').get()!.created_at,Infinity);assert.equal(db.prepare('SELECT updated_at FROM codex_turn_queue').get()!.updated_at,-Infinity);assert.equal(claimStopControl(path,c,()=>{}),null);},{generation:9007199254740993n,nonfinite:true}));
