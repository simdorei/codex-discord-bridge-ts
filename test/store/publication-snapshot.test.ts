import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {migrateSchemaVersion,migrateSchemaExtensions} from '../../src/store/schema-assembly.ts';
import {enqueueInTransaction} from '../../src/store/queue-enqueue.ts';
import {capturePublicationSnapshotIn,PublicationRowMissingError} from '../../src/store/publication-snapshot.ts';
import {ActiveTransactionError} from '../../src/store/owned-driver.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
function fixture(run:(db:DatabaseSync)=>void,encoding='UTF-8'){
 const db=new DatabaseSync(':memory:');try{db.exec(`PRAGMA encoding='${encoding}'; BEGIN IMMEDIATE`);migrateSchemaVersion(db,1n);migrateSchemaVersion(db,2n);migrateSchemaExtensions(db);db.exec('PRAGMA user_version=2');
  enqueueInTransaction(db,{jobId:'job',targetThreadId:'t',channelId:1n,ownerUserId:2n,discordMessageId:null,appServerGeneration:1n,prompt:'prompt',queued:true,ackSent:true,createdAt:1});db.exec("INSERT INTO mirror_threads VALUES('t','p','title',10,1,1); COMMIT");run(db);assert.equal(db.isOpen,true);
 }finally{if(db.isOpen){if(db.isTransaction)db.exec('ROLLBACK');db.close();}}
}
const capture=(db:DatabaseSync)=>capturePublicationSnapshotIn(db,'job');
const table=(snapshot:ReturnType<typeof capture>,key='queue')=>(snapshot.seal as Record<string,any>)[key] as {columns:string[];rows:any[][]};
test('snapshot requires caller transaction, never creates one and preserves its ownership',()=>fixture(db=>{
 assert.throws(()=>capture(db),ActiveTransactionError);assert.equal(db.isTransaction,false);db.exec('BEGIN');const changes=db.prepare('SELECT total_changes() AS n').get()!.n;
 const result=capture(db);assert.equal(db.isTransaction,true);assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n,changes);assert.equal(result.thread,'t');assert.equal(result.owner,2n);assert.equal(result.channel,1n);assert.ok(Object.isFrozen(result.seal));assert.deepEqual((result.seal as any).stop_origin,{target:'t',stopRevision:0n});
}));
test('native cell seal preserves column order and null/integer/real/text/blob identity',()=>fixture(db=>{
 db.exec('ALTER TABLE codex_turn_queue ADD COLUMN extra_real REAL; ALTER TABLE codex_turn_queue ADD COLUMN extra_blob BLOB; ALTER TABLE codex_turn_queue ADD COLUMN "quoted""column" TEXT');
 db.prepare('UPDATE codex_turn_queue SET extra_real=?,extra_blob=?,"quoted""column"=?').run(Infinity,Buffer.from([0,255,16]),'텍스트😀');db.exec('BEGIN');const t=table(capture(db)),row=t.rows[0]!;
 const get=(key:string)=>row[t.columns.indexOf(key)];assert.deepEqual(get('owner_user_id'),['integer',2n]);assert.deepEqual(get('turn_id'),['null']);assert.deepEqual(get('created_at'),['real_bits','4607182418800017408']);assert.deepEqual(get('extra_real'),['real_bits','9218868437227405312']);assert.deepEqual(get('extra_blob'),['blob_hex','00ff10']);assert.deepEqual(get('quoted"column'),['text','텍스트😀']);
 assert.deepEqual(t.columns,db.prepare('SELECT * FROM codex_turn_queue').columns().map(c=>c.name));
}));
test('exact owner, Pending state, generation, target and mapping are required',()=>{
 for(const sql of ["UPDATE codex_turn_queue SET owner_user_id=NULL","UPDATE codex_turn_queue SET state='starting'","UPDATE codex_turn_queue SET channel_id=0","UPDATE codex_turn_queue SET app_server_generation=0","UPDATE codex_turn_queue SET target_thread_id=' '","DELETE FROM mirror_threads","INSERT INTO mirror_threads VALUES('other','p','title',10,1,1)"]){fixture(db=>{db.exec(sql+'; BEGIN');assert.throws(()=>capture(db),/owner|owned Pending|mapping/);});}
 fixture(db=>{db.exec('BEGIN');assert.throws(()=>capturePublicationSnapshotIn(db,'absent'),PublicationRowMissingError);});
});
test('prompt byte precheck rejects oversized input before decoding it',()=>fixture(db=>{
 db.prepare('UPDATE codex_turn_queue SET prompt=?').run('x'.repeat(131073));db.exec('BEGIN');assert.throws(()=>capture(db),/pending input exceeds review bound/);
}));
test('128 rows are accepted and 129th evidence row is refused',()=>fixture(db=>{
 const columns=db.prepare('PRAGMA table_info(codex_turn_queue)').all().map(c=>String(c.name)),other=columns.filter(c=>c!=='job_id'),quote=(c:string)=>'"'+c.replaceAll('"','""')+'"';
 const add=db.prepare(`INSERT INTO codex_turn_queue(job_id,${other.map(quote).join(',')}) SELECT ?,${other.map(quote).join(',')} FROM codex_turn_queue WHERE job_id='job'`);
 for(let i=1;i<128;i++)add.run('j'+i);db.exec('BEGIN');assert.equal(table(capture(db)).rows.length,128);add.run('overflow');assert.throws(()=>capture(db),/local evidence page exceeds bound/);
}));
test('oversized text/blob cells are bounded before Node materializes their content',()=>{
 fixture(db=>{db.exec('ALTER TABLE mirror_threads ADD COLUMN extra TEXT');db.prepare('UPDATE mirror_threads SET extra=?').run('x'.repeat(262145));db.exec('BEGIN');assert.throws(()=>capture(db),/evidence cell exceeds bound/);});
 fixture(db=>{db.exec('ALTER TABLE mirror_threads ADD COLUMN extra BLOB');db.prepare('UPDATE mirror_threads SET extra=?').run(Buffer.alloc(131073));db.exec('BEGIN');assert.throws(()=>capture(db),/evidence blob exceeds bound/);});
});
test('cumulative cells across tables cannot exceed the shared evidence budget',()=>fixture(db=>{
 db.exec('ALTER TABLE codex_turn_queue ADD COLUMN extra TEXT; ALTER TABLE mirror_threads ADD COLUMN extra BLOB');db.prepare('UPDATE codex_turn_queue SET extra=?').run('x'.repeat(200000));db.prepare('UPDATE mirror_threads SET extra=?').run(Buffer.alloc(40000));db.exec('BEGIN');assert.throws(()=>capture(db),/local evidence exceeds review bound/);
}));
test('final serialized seal includes column/row structure and can fail below the cell-only budget',()=>fixture(db=>{
 db.exec("ALTER TABLE mirror_threads ADD COLUMN extra TEXT; UPDATE mirror_threads SET extra=''; BEGIN");const first=capture(db),seal=structuredClone(first.seal) as any;
 let cellBytes=0;for(const key of ['queue','mapping','obligations','settlements','handoffs','policy'])for(const row of seal[key].rows)for(const cell of row)cellBytes+=Buffer.byteLength(serializeSerdeValue(cell));
 const text='x'.repeat(262144-cellBytes-10),mapping=seal.mapping;mapping.rows[0][mapping.columns.indexOf('extra')]=['text',text];assert.ok(Buffer.byteLength(serializeSerdeValue(seal))>262144);db.prepare('UPDATE mirror_threads SET extra=?').run(text);assert.throws(()=>capture(db),/local evidence exceeds review bound/);
}));
test('invalid UTF8 text cannot be silently replaced in immutable evidence',()=>fixture(db=>{
 db.exec("ALTER TABLE mirror_threads ADD COLUMN extra TEXT; UPDATE mirror_threads SET extra=CAST(x'ff' AS TEXT); BEGIN");assert.throws(()=>capture(db),/non-UTF8 evidence/);
}));
test('UTF16 databases seal the same logical UTF8 text and count UTF8 evidence bytes',()=>{
 for(const encoding of ['UTF-16le','UTF-16be'])fixture(db=>{db.exec('ALTER TABLE mirror_threads ADD COLUMN extra TEXT');db.prepare('UPDATE mirror_threads SET extra=?').run('한글😀\ufeff');db.exec('BEGIN');const t=table(capture(db),'mapping');assert.deepEqual(t.rows[0]![t.columns.indexOf('extra')],['text','한글😀\ufeff']);},encoding);
});
test('changing local evidence changes seal but capture itself never updates queue or policy rows',()=>fixture(db=>{
 db.exec('BEGIN');const a=capture(db);db.exec("UPDATE codex_turn_queue SET last_error='changed'");const b=capture(db);assert.notEqual(serializeSerdeValue(a.seal),serializeSerdeValue(b.seal));assert.equal((a.seal as any).queue.rows[0][(a.seal as any).queue.columns.indexOf('last_error')][1],'');
}));
