import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {DatabaseSync, type SQLInputValue} from 'node:sqlite';
import {it} from 'node:test';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {list, listFiltered, type StoredQueueJob} from '../../src/store/queue-read.ts';
import {getMirrorOffset, getMirrorCursorTurn, getOrInitMirrorCursor} from '../../src/store/mirror-cursor.ts';
import {isProcessedMessage} from '../../src/store/processed-messages.ts';
import {schemaVersion, schemaExtensionsCurrent, assertStoreIntegrity} from '../../src/store/schema-assembly.ts';

// Literal Rust V1_SCHEMA, not the TypeScript migration under test.
// simdorei/codex-discord-remote-rust @ d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34
// crates/cdr-store/src/schema.rs blob 96486dcb2414aee2feba67ce59da923bf494ebd4
const V1_SCHEMA = [
  "CREATE TABLE IF NOT EXISTS mirror_projects (project_key TEXT PRIMARY KEY, project_name TEXT NOT NULL, discord_channel_id INTEGER NOT NULL, updated_at REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS mirror_threads (codex_thread_id TEXT PRIMARY KEY, project_key TEXT NOT NULL, thread_title TEXT NOT NULL, discord_channel_id INTEGER NOT NULL, discord_thread_id INTEGER NOT NULL, updated_at REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS session_mirror_details (codex_thread_id TEXT PRIMARY KEY, detail_mode TEXT NOT NULL CHECK(detail_mode IN ('send', 'all')))",
  "CREATE TABLE IF NOT EXISTS busy_choices (choice_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, channel_id INTEGER NOT NULL, target_thread_id TEXT, prompt TEXT NOT NULL, allow_steer INTEGER NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL, claimed_at REAL)",
  "CREATE TABLE IF NOT EXISTS persistent_component_claims (claim_key TEXT PRIMARY KEY, created_at REAL NOT NULL, expires_at REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS discord_processed_messages (message_id INTEGER PRIMARY KEY, seen_at REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS codex_session_mirror_offsets (codex_thread_id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, cursor INTEGER NOT NULL, updated_at REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS codex_session_mirror_events (event_digest TEXT PRIMARY KEY, codex_thread_id TEXT NOT NULL, created_at REAL NOT NULL)",
  "CREATE TABLE IF NOT EXISTS codex_turn_queue (job_id TEXT PRIMARY KEY, target_thread_id TEXT NOT NULL, channel_id INTEGER NOT NULL, owner_user_id INTEGER, discord_message_id INTEGER, prompt TEXT NOT NULL, queued INTEGER NOT NULL, ack_sent INTEGER NOT NULL, state TEXT NOT NULL, attempt_count INTEGER NOT NULL, turn_id TEXT, baseline_turn_ids TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS codex_turn_queue_message_id ON codex_turn_queue(discord_message_id) WHERE discord_message_id IS NOT NULL",
  "CREATE INDEX IF NOT EXISTS codex_turn_queue_target_order ON codex_turn_queue(target_thread_id, created_at, job_id)"
] as const;

const TARGET = 'thread_legacy_001';
const CHANNEL = 9007199254740995n;
const OWNER = 9007199254740996n;
const CREATED = 1712000000.125;
const UPDATED = 1712000000.875;
const ROLLOUT = 'legacy/rollout-한글.jsonl'; // Opaque text; no rollout file is opened.
const CURSOR = 9007199254740993n;
const QUEUE_COLUMNS = ['job_id','target_thread_id','channel_id','owner_user_id','discord_message_id','prompt','queued','ack_sent','state','attempt_count','turn_id','baseline_turn_ids','last_error','created_at','updated_at'] as const;
const CURSOR_COLUMNS = ['codex_thread_id','rollout_path','cursor','updated_at'] as const;
const QUEUE_TEXT = ['job_id','target_thread_id','prompt','state','turn_id','baseline_turn_ids','last_error'] as const;
const common = {target_thread_id:TARGET,channel_id:CHANNEL,owner_user_id:OWNER,prompt:'legacy 한글😀',queued:1n,baseline_turn_ids:'["turn-before"]',created_at:CREATED,updated_at:UPDATED};
const LEGACY_ROWS = [
  {...common,job_id:'job_legacy_pending',discord_message_id:9007199254740997n,ack_sent:0n,state:'pending',attempt_count:0n,turn_id:null,last_error:''},
  {...common,job_id:'job_legacy_starting',discord_message_id:9007199254740998n,ack_sent:1n,state:'starting',attempt_count:1n,turn_id:null,last_error:''},
  {...common,job_id:'job_legacy_running',discord_message_id:9007199254740999n,ack_sent:1n,state:'running',attempt_count:1n,turn_id:'turn-running',last_error:''},
  {...common,job_id:'job_legacy_quarantined',discord_message_id:9007199254741000n,ack_sent:1n,state:'running',attempt_count:1n,turn_id:'cdr-quarantined:turn-held',last_error:'[cdr-rust:app-server-fork-quarantine:v1] process died'},
] as const;
const SORTED_ROWS = [...LEGACY_ROWS].sort((a,b)=>a.job_id<b.job_id?-1:1);
const EXPECTED_TYPED: StoredQueueJob[] = SORTED_ROWS.map(row=>({
  jobId:row.job_id,targetThreadId:TARGET,channelId:CHANNEL,ownerUserId:OWNER,
  discordMessageId:row.discord_message_id,appServerGeneration:0n,executionGeneration:null,
  turnObservationGeneration:null,goalWaiting:false,prompt:common.prompt,queued:true,
  ackSent:row.ack_sent===1n,state:row.job_id==='job_legacy_pending'?'Pending':row.job_id==='job_legacy_starting'?'Starting':row.job_id==='job_legacy_running'?'Running':'Quarantined',
  attemptCount:row.attempt_count,turnId:row.turn_id,baselineTurnIds:['turn-before'],
  lastError:row.last_error,createdAt:CREATED,updatedAt:UPDATED,
}));

function rows(db:DatabaseSync,sql:string):Record<string,unknown>[] {
  const statement=db.prepare(sql);statement.setReadBigInts(true);
  return statement.all().map(row=>({...row}));
}
function columns(db:DatabaseSync,table:string):unknown[] {
  return rows(db,`PRAGMA table_info(${table})`).map(row=>row.name);
}
function catalog(db:DatabaseSync):Record<string,unknown>[] {
  return rows(db,'SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name,tbl_name');
}
function legacyQueue(db:DatabaseSync):Record<string,unknown>[] {
  return rows(db,`SELECT ${QUEUE_COLUMNS.join(',')} FROM codex_turn_queue ORDER BY job_id`);
}
function queueBytes(db:DatabaseSync):Record<string,unknown>[] {
  return rows(db,`SELECT ${QUEUE_TEXT.map(name=>`hex(CAST(${name} AS BLOB)) AS ${name}`).join(',')} FROM codex_turn_queue ORDER BY job_id`);
}
function markers(db:DatabaseSync):Record<string,unknown>[] {
  return rows(db,'SELECT message_id,seen_at FROM discord_processed_messages ORDER BY message_id');
}
function legacyCursor(db:DatabaseSync):Record<string,unknown>[] {
  return rows(db,`SELECT ${CURSOR_COLUMNS.join(',')} FROM codex_session_mirror_offsets ORDER BY codex_thread_id`);
}
function assertOriginalData(db:DatabaseSync):void {
  assert.deepEqual(legacyQueue(db),SORTED_ROWS);
  assert.deepEqual(queueBytes(db),SORTED_ROWS.map(row=>Object.fromEntries(QUEUE_TEXT.map(key=>[key,row[key]===null?'':Buffer.from(row[key]!, 'utf8').toString('hex').toUpperCase()]))));
  assert.deepEqual(markers(db),LEGACY_ROWS.map(row=>({message_id:row.discord_message_id,seen_at:CREATED})));
  assert.deepEqual(legacyCursor(db),[{codex_thread_id:TARGET,rollout_path:ROLLOUT,cursor:CURSOR,updated_at:UPDATED}]);
  assert.deepEqual(rows(db,'SELECT hex(CAST(rollout_path AS BLOB)) AS bytes FROM codex_session_mirror_offsets'),[{bytes:Buffer.from(ROLLOUT).toString('hex').toUpperCase()}]);
}
function assertLegacyShape(db:DatabaseSync):void {
  assert.equal(schemaVersion(db),1n);
  assert.deepEqual(columns(db,'codex_turn_queue'),QUEUE_COLUMNS);
  assert.deepEqual(columns(db,'codex_session_mirror_offsets'),CURSOR_COLUMNS);
  assert.deepEqual(columns(db,'discord_processed_messages'),['message_id','seen_at']);
  assert.equal(schemaExtensionsCurrent(db),false);
}
function snapshot(db:DatabaseSync) {
  return {version:schemaVersion(db),catalog:catalog(db),queue:rows(db,'SELECT * FROM codex_turn_queue ORDER BY job_id'),queueBytes:queueBytes(db),processed:markers(db),cursor:rows(db,'SELECT * FROM codex_session_mirror_offsets ORDER BY codex_thread_id')};
}
function assertMigrated(db:DatabaseSync):void {
  assert.equal(schemaVersion(db),2n);assert.equal(schemaExtensionsCurrent(db),true);assertStoreIntegrity(db);
  assertOriginalData(db);
  assert.deepEqual(rows(db,'SELECT job_id,app_server_generation,goal_waiting,execution_generation,turn_observation_generation FROM codex_turn_queue ORDER BY job_id'),SORTED_ROWS.map(row=>({job_id:row.job_id,app_server_generation:0n,goal_waiting:0n,execution_generation:null,turn_observation_generation:null})));
  assert.deepEqual(rows(db,'SELECT turn_context FROM codex_session_mirror_offsets'),[{turn_context:null}]);
}

it('imports a literal frozen Rust v1 file through real migration, backup and typed public consumers',async()=>{
  assert.equal(process.version,'v24.21.0');
  const tempRoot=realpathSync(tmpdir());
  const dir=realpathSync(mkdtempSync(join(tempRoot,'cdr-g6-legacy-import-')));
  const path=join(dir,'legacy.sqlite');
  let handle:DatabaseSync|undefined;
  try {
    handle=new DatabaseSync(path,{enableForeignKeyConstraints:false});
    handle.exec("PRAGMA encoding='UTF-8'; PRAGMA journal_mode=DELETE;");
    assert.equal(V1_SCHEMA.length,11);
    for(const statement of V1_SCHEMA)handle.exec(statement);
    const insert=handle.prepare(`INSERT INTO codex_turn_queue (${QUEUE_COLUMNS.join(',')}) VALUES (${QUEUE_COLUMNS.map(()=>'?').join(',')})`);
    for(const row of LEGACY_ROWS){
      insert.run(...QUEUE_COLUMNS.map(key=>row[key] as SQLInputValue));
      handle.prepare('INSERT INTO discord_processed_messages(message_id,seen_at) VALUES(?,?)').run(row.discord_message_id,CREATED);
    }
    handle.prepare('INSERT INTO codex_session_mirror_offsets(codex_thread_id,rollout_path,cursor,updated_at) VALUES(?,?,?,?)').run(TARGET,ROLLOUT,CURSOR,UPDATED);
    handle.exec('PRAGMA user_version=1');
    assertLegacyShape(handle);assertOriginalData(handle);assertStoreIntegrity(handle);
    assert.deepEqual(rows(handle,'PRAGMA encoding'),[{encoding:'UTF-8'}]);
    const original=snapshot(handle);
    // All nine V1 tables are present. Only three contain synthetic rows.
    const emptyLegacyTables=['mirror_projects','mirror_threads','session_mirror_details','busy_choices','persistent_component_claims','codex_session_mirror_events'];
    assert.equal(rows(handle,"SELECT name FROM sqlite_schema WHERE type='table'").length,9);
    for(const table of emptyLegacyTables)assert.deepEqual(rows(handle,`SELECT * FROM ${table}`),[]);
    handle.close();handle=undefined;

    // Explicit initialization open 1/2: actual file migration and backup.
    handle=await openInitialized(path);assertMigrated(handle);
    const migrated=snapshot(handle);
    handle.close();handle=undefined;
    const backupDir=join(dir,'.codex-discord-backups');
    const backups=readdirSync(backupDir).sort();
    assert.equal(backups.length,1);
    assert.match(backups[0]!,/^legacy\.v1-to-v2\.[0-9]{8}T[0-9]{6}Z\.[0-9a-f]{12}\.sqlite$/);
    // A raw read-only connection cannot accidentally migrate the backup.
    handle=new DatabaseSync(join(backupDir,backups[0]!),{readOnly:true,enableForeignKeyConstraints:false});
    assertLegacyShape(handle);assertOriginalData(handle);assertStoreIntegrity(handle);
    assert.deepEqual(snapshot(handle),original);
    for(const table of emptyLegacyTables)assert.deepEqual(rows(handle,`SELECT * FROM ${table}`),[]);
    handle.close();handle=undefined;

    // Exactly 13 public consumer calls, each internally opens initialized state.
    assert.deepEqual(await list(path),EXPECTED_TYPED); // 1
    assert.deepEqual(await listFiltered(path,TARGET,0n),EXPECTED_TYPED); // 2
    assert.deepEqual(await listFiltered(path,TARGET,1n),[]); // 3
    for(const row of LEGACY_ROWS)assert.equal(await isProcessedMessage(path,row.discord_message_id),true); // 4–7
    assert.equal(await isProcessedMessage(path,9007199254741001n),false); // 8
    const expectedOffset={rolloutPath:ROLLOUT,cursor:CURSOR,updatedAt:UPDATED};
    assert.deepEqual(await getMirrorOffset(path,TARGET),expectedOffset); // 9
    assert.equal(await getMirrorCursorTurn(path,TARGET),null); // 10
    assert.equal(await getOrInitMirrorCursor(path,TARGET,ROLLOUT,0n,1712000001.875),CURSOR); // 11
    assert.deepEqual(await getMirrorOffset(path,TARGET),expectedOffset); // 12
    assert.equal(await getMirrorCursorTurn(path,TARGET),null); // 13

    // Explicit initialization open 2/2: idempotence after all consumer opens.
    handle=await openInitialized(path);assertMigrated(handle);
    assert.deepEqual(snapshot(handle),migrated);
    handle.close();handle=undefined;
    assert.deepEqual(readdirSync(backupDir).sort(),backups);
  } finally {
    try { if(handle?.isOpen)handle.close(); }
    finally {
      assert.equal(realpathSync(dir),dir);
      assert.equal(dirname(dir),tempRoot);
      assert.ok(basename(dir).startsWith('cdr-g6-legacy-import-'));
      rmSync(dir,{recursive:true,force:false});
    }
  }
});
