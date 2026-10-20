import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {initialize, openInitialized} from '../../src/store/owned-driver.ts';
import {getIngressForOwnerReadonly} from '../../src/store/ingress-read.ts';
import {runnerInspectionDetailExisting as detail, runnerInspectionSummaryExisting as summary, runnerInspectionTargetCountsExisting as target, runnerInspectionGlobalExisting as global} from '../../src/store/runner-inspection.ts';
const MiB=1024*1024;
function edit<T>(path:string,work:(db:DatabaseSync)=>T):T {const db=new DatabaseSync(path);try{return work(db);}finally{db.close();}}
async function init(path:string,encoding?:'UTF-16le'|'UTF-16be'):Promise<void> {
 if(encoding!==undefined){const db=new DatabaseSync(path);try{db.exec(`PRAGMA encoding='${encoding}'`);await initialize(db,path);}finally{db.close();}}
 else {const db=await openInitialized(path);db.close();}
}
function ingress(db:DatabaseSync,id:string,channel=1,user=2,payload='{}',created=1):void {
 db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,channel_id,owner_user_id,payload_json,state,phase,created_at,updated_at) VALUES(?,'action',?,?,?,'held','saved',?,1)").run(id,channel,user,'{}',created);
 db.prepare('UPDATE discord_ingress_journal SET payload_json=? WHERE ingress_id=?').run(payload,id);
}
function job(db:DatabaseSync,id='job',created=1):void {
 db.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES(?,'target',1,'',0,0,'pending',0,'[]',?,1)").run(id,created);
}
function intake(db:DatabaseSync,id='intake',created=1):void {
 db.prepare("INSERT INTO codex_prompt_intakes(job_id,target_thread_id,channel_id,raw_prompt,auto_queue_when_busy,require_current_mirror,created_at,updated_at) VALUES(?,'target',1,'prompt',0,0,?,1)").run(id,created);
}
function delivery(db:DatabaseSync):void {
 db.exec("INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES('delivery','delivered-job','target','turn',1,'body',1,1)");
}
function queueBytes(db:DatabaseSync):number {
 return db.prepare('SELECT * FROM codex_turn_queue').all().reduce((total,row)=>total+Object.values(row).reduce<number>((n,v)=>n+(v===null?0:typeof v==='string'?Buffer.byteLength(v,'utf8'):8),0),0);
}

test('runner inspection never creates, repairs, migrates or writes an existing store',async()=>storeFixture(async path=>{
 const calls=[()=>detail(path,'request',1n,2n),()=>summary(path,1n,2n),()=>target(path,'target'),()=>global(path)];
 for(const call of calls){assert.throws(call);assert.equal(existsSync(path),false);}
 edit(path,db=>db.exec('CREATE TABLE sentinel(value TEXT)'));
 const incomplete=readFileSync(path);for(const call of calls)assert.throws(call);assert.deepEqual(readFileSync(path),incomplete);
 await init(path);const before=readFileSync(path);for(const call of calls)assert.doesNotThrow(call);assert.deepEqual(readFileSync(path),before);
 edit(path,db=>db.exec('DROP TABLE codex_prompt_intakes'));
 const broken=readFileSync(path);for(const call of calls)assert.throws(call);assert.deepEqual(readFileSync(path),broken);
}));

test('runner detail filters actor and channel before malformed or oversized payload decoding',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>{ingress(db,'request',1,2,'{"prompt":"kept","integer":9007199254740993}');ingress(db,'other',1,3,'broken');ingress(db,'other-room',4,2,'broken');});
 assert.deepEqual(detail(path,'request',1n,2n),getIngressForOwnerReadonly(path,'request',1n,2n));
 assert.equal(detail(path,'other',1n,2n),null);assert.equal(detail(path,'other-room',1n,2n),null);assert.equal(summary(path,1n,2n).length,1);
 edit(path,db=>db.prepare('UPDATE discord_ingress_journal SET payload_json=? WHERE ingress_id=?').run('x'.repeat(2*MiB),'other'));
 assert.equal(detail(path,'other',1n,2n),null);assert.throws(()=>detail(path,'other',1n,3n),/row byte budget/);
 edit(path,db=>db.exec("UPDATE discord_ingress_journal SET payload_json='broken' WHERE ingress_id='request'"));assert.throws(()=>detail(path,'request',1n,2n));
}));

test('runner summary preserves held/completed-unconfirmed, latest20 ties, and full record validation',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>{for(let i=0;i<21;i++)ingress(db,`r${String(i).padStart(2,'0')}`,1,2,i===20?'broken':'{}',10);ingress(db,'other',1,3,'broken',100);
  ingress(db,'confirmed',1,2,'{}',100);db.exec("UPDATE discord_ingress_journal SET state='completed',confirmation_delivered=1 WHERE ingress_id='confirmed'; UPDATE discord_ingress_journal SET state='completed' WHERE ingress_id='r01'");});
 const records=summary(path,1n,2n);assert.deepEqual(records.map(r=>r.ingressId),Array.from({length:20},(_,i)=>`r${String(i).padStart(2,'0')}`));assert.equal(records[1]!.state,'completed');
 edit(path,db=>db.exec("UPDATE discord_ingress_journal SET event_id=CAST(X'FF' AS BLOB) WHERE ingress_id='r00'"));assert.throws(()=>summary(path,1n,2n),/storage class/);
 edit(path,db=>db.exec("UPDATE discord_ingress_journal SET event_id=NULL,outcome_json='broken' WHERE ingress_id='r00'"));assert.throws(()=>summary(path,1n,2n));
}));

test('runner global preserves ordering, hold line deduplication, and receipt counters',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>{job(db,'b',2);job(db,'a',1);intake(db,'a',2);intake(db,'c',1);delivery(db);
  db.exec("INSERT INTO cdr_execution_holds VALUES('a','target','reason','{}',1),('c','target','second','{}',1),('unused','target',CAST(X'FF' AS TEXT),'{}',1)");
  db.exec("INSERT INTO codex_delivery_receipts(receipt_key,content_hash,message_id,retryable,blocked_reason) VALUES('unknown','hash',NULL,0,NULL),('blocked','hash',NULL,0,''),('retry','hash',NULL,1,NULL),('done','hash','message',0,'blocked')");});
 const result=global(path);assert.deepEqual(result.jobs.map(j=>j.jobId),['a','b']);assert.deepEqual(result.intakes.map(i=>i.jobId),['c','a']);assert.deepEqual(result.held,['a: reason','c: second']);assert.equal(result.pending,1n);assert.equal(result.unknown,1n);assert.equal(result.blocked,1n);
}));

test('runner global retains malformed queue, delivery, intake, and referenced hold failures',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>{job(db);intake(db);delivery(db);db.exec("INSERT INTO cdr_execution_holds VALUES('job','target','reason','{}',1)");});
 const failures=[['codex_turn_queue','baseline_turn_ids',"'broken'","'[]'"],['codex_delivery_outbox','content',"CAST(X'FF' AS TEXT)","'body'"],['codex_prompt_intakes','raw_prompt',"CAST(X'FF' AS TEXT)","'prompt'"],['cdr_execution_holds','reason',"CAST(X'FF' AS TEXT)","'reason'"]];
 for(const [table,column,bad,good] of failures){edit(path,db=>db.exec(`UPDATE ${table} SET ${column}=${bad}`));assert.throws(()=>global(path));edit(path,db=>db.exec(`UPDATE ${table} SET ${column}=${good}`));assert.doesNotThrow(()=>global(path));}
}));

test('runner target counters preserve literal quarantine and SQL NULL distinctions',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>{for(const id of ['pending','starting','running','encoded','literal','null-turn'])job(db,id);intake(db);ingress(db,'held');ingress(db,'unowned');
  db.exec("UPDATE codex_turn_queue SET state=job_id WHERE job_id IN ('starting','running'); UPDATE codex_turn_queue SET state='running',turn_id='cdr-quarantined:t',last_error='[cdr-rust:app-server-fork-quarantine:v1] reason' WHERE job_id='encoded'; UPDATE codex_turn_queue SET state='quarantined' WHERE job_id='literal'; UPDATE codex_turn_queue SET state='running',turn_id=NULL,last_error='[cdr-rust:app-server-fork-quarantine:v1] reason' WHERE job_id='null-turn'; UPDATE discord_ingress_journal SET target_thread_id='target'; UPDATE discord_ingress_journal SET state='staged' WHERE ingress_id='unowned'");});
 assert.deepEqual(target(path,'target'),[1n,1n,2n,1n,1n,1n,2n]);assert.throws(()=>global(path),/invalid durable queue state: quarantined/);
}));

test('runner SQL preflight accepts exact per-row byte bound and rejects one byte over',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>{job(db);const base=queueBytes(db);db.prepare('UPDATE codex_turn_queue SET prompt=?').run('x'.repeat(MiB-base));});
 assert.equal(global(path).jobs.length,1);edit(path,db=>db.exec("UPDATE codex_turn_queue SET prompt=prompt||'x'"));assert.throws(()=>global(path),/row byte budget/);
}));

test('runner SQL preflight accepts exact cumulative bound and rejects one byte over',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>{for(let i=0;i<5;i++)job(db,`j${i}`);const base=queueBytes(db);for(let i=0;i<4;i++)db.prepare('UPDATE codex_turn_queue SET prompt=? WHERE job_id=?').run('x'.repeat(900000),`j${i}`);db.prepare('UPDATE codex_turn_queue SET prompt=? WHERE job_id=?').run('x'.repeat(4*MiB-base-4*900000),'j4');});
 assert.equal(global(path).jobs.length,5);edit(path,db=>db.exec("UPDATE codex_turn_queue SET prompt=prompt||'x' WHERE job_id='j4'"));assert.throws(()=>global(path),/cumulative byte budget/);
}));

test('runner SQL preflight bounds identifiers in input and stored rows',async()=>storeFixture(async path=>{
 await init(path);const exact='x'.repeat(16384);edit(path,db=>{job(db);db.prepare('UPDATE codex_turn_queue SET target_thread_id=?').run(exact);});
 assert.equal(global(path).jobs[0]!.targetThreadId,exact);assert.equal(target(path,exact)[0],1n);assert.throws(()=>target(path,exact+'x'),/identifier byte budget/);
 edit(path,db=>db.prepare('UPDATE codex_turn_queue SET target_thread_id=?').run(exact+'x'));assert.throws(()=>global(path),/identifier byte budget/);
}));

test('runner SQL preflight accepts 10000 global rows and rejects 10001 without truncation',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>db.exec("WITH RECURSIVE ids(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM ids WHERE n<10000) INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) SELECT printf('j%05d',n),'t',1,'',0,0,'pending',0,'[]',n,1 FROM ids"));
 assert.equal(global(path).jobs.length,10000);edit(path,db=>intake(db));assert.throws(()=>global(path),/row budget/);
}));

test('runner preflight rejects BLOB and text storage in numeric fields before native row transfer',async()=>storeFixture(async path=>{
 await init(path);edit(path,db=>{job(db);db.exec('UPDATE codex_turn_queue SET channel_id=zeroblob(8388608)');});assert.throws(()=>global(path),/storage class/);
 edit(path,db=>db.exec("UPDATE codex_turn_queue SET channel_id='not-an-integer'"));assert.throws(()=>global(path),/storage class/);
}));

for(const encoding of ['UTF-16le','UTF-16be'] as const)test(`runner SQL preflight accounts for ${encoding} text expansion`,async()=>storeFixture(async path=>{
 await init(path,encoding);edit(path,db=>{job(db);db.prepare('UPDATE codex_turn_queue SET prompt=?').run('\u0800'.repeat(100000));});assert.equal(global(path).jobs[0]!.prompt.length,100000);
 const expanded='\u0800'.repeat(350000);assert.ok(Buffer.byteLength(expanded,'utf8')>MiB);edit(path,db=>{db.prepare('UPDATE codex_turn_queue SET prompt=?').run(expanded);assert.ok(Number(db.prepare('SELECT length(CAST(prompt AS BLOB)) AS n FROM codex_turn_queue').get()?.n)<MiB);});assert.throws(()=>global(path),/row byte budget/);
}));


test('runner inspection rejects views and virtual tables before bounded data queries',async()=>{
 for(const table of ['discord_ingress_journal','codex_turn_queue','codex_prompt_intakes','codex_delivery_outbox','cdr_execution_holds','codex_delivery_receipts'])await storeFixture(async path=>{
  await init(path);edit(path,db=>db.exec(`ALTER TABLE ${table} RENAME TO original_table; CREATE VIEW ${table} AS SELECT * FROM original_table`));
  assert.throws(()=>global(path),/ordinary main tables/);assert.throws(()=>detail(path,'request',1n,2n),/ordinary main tables/);assert.throws(()=>target(path,'target'),/ordinary main tables/);
 });
 await storeFixture(async path=>{
  await init(path);edit(path,db=>db.exec('ALTER TABLE codex_turn_queue RENAME TO original_table; CREATE VIRTUAL TABLE codex_turn_queue USING fts5(value)'));
  assert.throws(()=>global(path),/ordinary main tables/);
 });
});

test('runner preflight and full decoder share the same WAL read snapshot',async context=>storeFixture(async path=>{
 await init(path);edit(path,db=>{db.exec('PRAGMA journal_mode=WAL');ingress(db,'request',1,2,'{"prompt":"original"}');});
 const prepare=DatabaseSync.prototype.prepare;let changed=false;
 context.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){
  if(!changed&&sql.startsWith('SELECT ingress_id,kind,event_id,application_id')&&sql.includes('AS b_ingress_id')){
   changed=true;edit(path,db=>db.prepare('UPDATE discord_ingress_journal SET payload_json=? WHERE ingress_id=?').run(JSON.stringify({prompt:'x'.repeat(2*MiB)}),'request'));
  }
  return prepare.call(this,sql);
 });
 try{assert.deepEqual(detail(path,'request',1n,2n)?.payload,{prompt:'original'});assert.equal(changed,true);assert.throws(()=>detail(path,'request',1n,2n),/row byte budget/);}
 finally{context.mock.restoreAll();}
}));


test('runner catalog scalar preflight rejects oversized schema SQL before schema materialization',async()=>{
 await storeFixture(async path=>{await init(path);edit(path,db=>db.exec("CREATE TABLE oversized(value TEXT DEFAULT '"+'x'.repeat(MiB)+"')"));assert.throws(()=>global(path),/row byte budget/);});
 await storeFixture(async path=>{await init(path);edit(path,db=>{for(let i=0;i<5;i++)db.exec(`CREATE TABLE extra${i}(value TEXT DEFAULT '${'x'.repeat(900000)}')`);});assert.throws(()=>detail(path,'request',1n,2n),/cumulative byte budget/);});
});
