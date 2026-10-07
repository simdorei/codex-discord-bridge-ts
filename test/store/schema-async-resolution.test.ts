import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  migrateAsyncResolution,
  schemaCurrentAsyncResolution,
} from '../../src/store/schema-async-resolution.ts';

const openDbs: DatabaseSync[] = [];

function trackDb(db: DatabaseSync): DatabaseSync {
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
});

function createBaseDb(): DatabaseSync {
  const db = trackDb(new DatabaseSync(':memory:'));
  db.exec(`
    CREATE TABLE cdr_async_questions (
      id TEXT PRIMARY KEY NOT NULL,
      runtime_id INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      origin_job_id TEXT NOT NULL,
      channel_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      body TEXT NOT NULL,
      chosen INTEGER,
      message_id INTEGER NOT NULL,
      dispatch_mode TEXT NOT NULL,
      preparation_json TEXT,
      state TEXT NOT NULL,
      accepted_turn_id TEXT,
      error TEXT NOT NULL,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE codex_turn_queue (
      job_id TEXT PRIMARY KEY NOT NULL,
      target_thread_id TEXT NOT NULL,
      channel_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      app_server_generation INTEGER NOT NULL,
      execution_generation INTEGER NOT NULL,
      turn_observation_generation INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL,
      turn_id TEXT NOT NULL,
      created_at REAL NOT NULL,
      baseline_turn_ids TEXT,
      state TEXT NOT NULL
    );
  `);
  return db;
}

interface QuestionFixture {
  id: string;
  runtime_id?: number;
  generation?: number;
  thread_id?: string;
  turn_id?: string;
  item_id?: number;
  origin_job_id?: string;
  channel_id?: number;
  owner_user_id?: number;
  body?: string;
  chosen?: number | null;
  message_id?: number;
  dispatch_mode?: string;
  preparation_json?: string | null;
  state?: string;
  accepted_turn_id?: string | null;
  error?: string;
  created_at?: number;
  updated_at?: number;
}

function insertQuestion(db: DatabaseSync, q: QuestionFixture): void {
  const stmt = db.prepare(`
    INSERT INTO cdr_async_questions (
      id, runtime_id, generation, thread_id, turn_id, item_id,
      origin_job_id, channel_id, owner_user_id, body, chosen,
      message_id, dispatch_mode, preparation_json, state,
      accepted_turn_id, error, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `);
  stmt.run(
    q.id,
    q.runtime_id ?? 10001,
    q.generation ?? 1,
    q.thread_id ?? 'thread-test',
    q.turn_id ?? 'turn-1',
    q.item_id ?? 20001,
    q.origin_job_id ?? 'job-test',
    q.channel_id ?? 30001,
    q.owner_user_id ?? 40001,
    q.body ?? 'test body content',
    q.chosen === undefined ? 1 : q.chosen,
    q.message_id ?? 50001,
    q.dispatch_mode ?? 'steer',
    q.preparation_json === undefined ? '{"seal":"standard"}' : q.preparation_json,
    q.state ?? 'dispatching',
    q.accepted_turn_id ?? null,
    q.error ?? '',
    q.created_at ?? 1710000000.125,
    q.updated_at ?? 1710000001.25
  );
}

interface QueueFixture {
  job_id: string;
  target_thread_id?: string;
  channel_id?: number;
  owner_user_id?: number;
  app_server_generation?: number;
  execution_generation?: number;
  turn_observation_generation?: number;
  attempt_count?: number;
  turn_id?: string;
  created_at?: number;
  baseline_turn_ids?: string | null;
  state?: string;
}

function insertQueue(db: DatabaseSync, j: QueueFixture): void {
  const stmt = db.prepare(`
    INSERT INTO codex_turn_queue (
      job_id, target_thread_id, channel_id, owner_user_id,
      app_server_generation, execution_generation,
      turn_observation_generation, attempt_count, turn_id,
      created_at, baseline_turn_ids, state
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )
  `);
  stmt.run(
    j.job_id,
    j.target_thread_id ?? 'thread-test',
    j.channel_id ?? 30001,
    j.owner_user_id ?? 40001,
    j.app_server_generation ?? 1,
    j.execution_generation ?? 1,
    j.turn_observation_generation ?? 1,
    j.attempt_count ?? 0,
    j.turn_id ?? 'turn-1',
    j.created_at ?? 1710000000.125,
    j.baseline_turn_ids ?? '["turn-0"]',
    j.state ?? 'pending'
  );
}

describe('schemaCurrentAsyncResolution and repeatable migration idempotence', () => {
  it('detects fresh schema false, migrates to true, and remains stable across repeats', () => {
    const db = createBaseDb();
    assert.equal(schemaCurrentAsyncResolution(db), false);

    migrateAsyncResolution(db);
    assert.equal(schemaCurrentAsyncResolution(db), true);

    migrateAsyncResolution(db);
    assert.equal(schemaCurrentAsyncResolution(db), true);

    const countRow = db.prepare(`
      SELECT COUNT(*) as count FROM sqlite_schema WHERE name IN (
        'cdr_async_execution_obligations','cdr_async_obligation_target',
        'cdr_async_obligation_question','cdr_async_obligation_queue_delete',
        'cdr_async_obligation_claim_immutable','cdr_async_obligation_no_forget',
        'cdr_async_obligation_attempt','cdr_async_obligation_retention',
        'cdr_async_terminal_settlements','cdr_async_unsettled_obligations',
        'cdr_async_settlement_insert','cdr_async_settlement_immutable','cdr_async_settlement_no_delete',
        'cdr_async_execution_handoffs','cdr_async_handoff_immutable','cdr_async_handoff_no_delete',
        'cdr_runtime_capability_requirements','cdr_capability_no_downgrade',
        'cdr_capability_no_delete','cdr_async_require_capability',
        'cdr_async_terminal_candidates','cdr_async_candidate_immutable','cdr_async_candidate_no_delete',
        'cdr_async_source_no_delete','cdr_async_source_seal_immutable','cdr_async_uncopied_origin_guard',
        'cdr_async_recovery_policies','cdr_async_recovery_policy_immutable',
        'cdr_async_recovery_policy_no_delete','cdr_async_recovery_policy_capability'
      )
    `).get() as { count: number };
    assert.equal(countRow.count, 30);
  });
});

describe('atomic migration savepoint failure and outer transaction preservation', () => {
  it('rolls back to savepoint on missing dependency leaving caller outer tx active', () => {
    const db = trackDb(new DatabaseSync(':memory:'));
    db.exec('CREATE TABLE caller_preceding (id INTEGER PRIMARY KEY, marker TEXT);');
    db.exec('BEGIN TRANSACTION;');
    db.exec("INSERT INTO caller_preceding VALUES (42, 'preceding_row');");

    assert.throws(() => migrateAsyncResolution(db));

    const asyncCount = db.prepare("SELECT COUNT(*) as count FROM sqlite_schema WHERE name LIKE 'cdr_%'").get() as { count: number };
    assert.equal(asyncCount.count, 0);

    const preceding = db.prepare('SELECT marker FROM caller_preceding WHERE id=42').get() as { marker: string };
    assert.equal(preceding.marker, 'preceding_row');
    db.exec("INSERT INTO caller_preceding VALUES (43, 'following_row');");
    db.exec('COMMIT;');

    const total = db.prepare('SELECT COUNT(*) as count FROM caller_preceding').get() as { count: number };
    assert.equal(total.count, 2);
  });

  it('rolls back completely when caller outer DDL transaction rolls back', () => {
    const db = createBaseDb();
    db.exec('BEGIN TRANSACTION;');
    migrateAsyncResolution(db);
    assert.equal(schemaCurrentAsyncResolution(db), true);
    db.exec('ROLLBACK;');

    assert.equal(schemaCurrentAsyncResolution(db), false);
    const tableExists = db.prepare("SELECT COUNT(*) as count FROM sqlite_schema WHERE name='cdr_async_execution_obligations'").get() as { count: number };
    assert.equal(tableExists.count, 0);
  });
});

describe('legacy steer dispatch backfill filtering and JSON fidelity', () => {
  it('only backfills steer dispatching into held obligations and retains exact json/fields', () => {
    const db = createBaseDb();

    insertQueue(db, {
      job_id: 'job-steer-1',
      target_thread_id: 'thread-steer-1',
      channel_id: 301,
      owner_user_id: 401,
      app_server_generation: 2,
      execution_generation: 3,
      turn_observation_generation: 4,
      attempt_count: 1,
      turn_id: 'turn-steer-1',
      created_at: 1710000000.125,
      baseline_turn_ids: '["base-1","base-2"]',
      state: 'pending',
    });
    insertQuestion(db, {
      id: 'q-steer-1',
      runtime_id: 9001,
      generation: 5,
      thread_id: 'thread-steer-1',
      turn_id: 'turn-steer-1',
      item_id: 8001,
      origin_job_id: 'job-steer-1',
      channel_id: 301,
      owner_user_id: 401,
      body: 'body steer original text',
      chosen: 2,
      message_id: 7001,
      dispatch_mode: 'steer',
      preparation_json: '{"seal_bytes":"legacy_proof_123"}',
      state: 'dispatching',
      error: 'initial_err',
      created_at: 1710000000.125,
      updated_at: 1710000001.25,
    });

    insertQuestion(db, {
      id: 'q-steer-submitted',
      dispatch_mode: 'steer',
      state: 'submitted',
      accepted_turn_id: 'turn-1',
    });

    insertQuestion(db, {
      id: 'q-normal-dispatching',
      dispatch_mode: 'normal',
      state: 'dispatching',
    });

    migrateAsyncResolution(db);

    const obligations = db.prepare('SELECT * FROM cdr_async_execution_obligations').all() as Array<{
      question_id: string;
      thread_id: string;
      origin_job_id: string;
      turn_id: string;
      channel_id: number;
      format_version: number;
      revision: number;
      answer_state: string;
      execution_state: string;
      admission_state: string;
      policy: string;
      original_seal: string | null;
      claim_json: string;
      owner_json: string | null;
      original_error: string;
      receipt_turn: string | null;
      created_at: number;
      updated_at: number;
    }>;

    assert.equal(obligations.length, 1);
    const ob = obligations[0];
    assert.ok(ob);
    assert.equal(ob.question_id, 'q-steer-1');
    assert.equal(ob.thread_id, 'thread-steer-1');
    assert.equal(ob.origin_job_id, 'job-steer-1');
    assert.equal(ob.turn_id, 'turn-steer-1');
    assert.equal(ob.channel_id, 301);
    assert.equal(ob.format_version, 1);
    assert.equal(ob.revision, 0);
    assert.equal(ob.answer_state, 'unresolved');
    assert.equal(ob.execution_state, 'unresolved');
    assert.equal(ob.admission_state, 'held');
    assert.equal(ob.policy, 'ordinary');
    assert.equal(ob.original_seal, '{"seal_bytes":"legacy_proof_123"}');
    assert.equal(ob.original_error, 'initial_err');
    assert.equal(ob.created_at, 1710000000.125);
    assert.equal(ob.updated_at, 1710000001.25);

    const expectedClaimJson = '{"id":"q-steer-1","runtime_id":9001,"generation":5,"thread_id":"thread-steer-1","turn_id":"turn-steer-1","item_id":8001,"origin_job_id":"job-steer-1","channel_id":301,"owner_user_id":401,"body":"body steer original text","chosen":2,"message_id":7001,"dispatch_mode":"steer"}';
    assert.equal(ob.claim_json, expectedClaimJson);

    const claim = JSON.parse(ob.claim_json);
    assert.deepEqual(claim, {
      id: 'q-steer-1',
      runtime_id: 9001,
      generation: 5,
      thread_id: 'thread-steer-1',
      turn_id: 'turn-steer-1',
      item_id: 8001,
      origin_job_id: 'job-steer-1',
      channel_id: 301,
      owner_user_id: 401,
      body: 'body steer original text',
      chosen: 2,
      message_id: 7001,
      dispatch_mode: 'steer',
    });

    assert.ok(ob.owner_json !== null);
    const expectedOwnerJson = '{"job_id":"job-steer-1","target_thread_id":"thread-steer-1","channel_id":301,"owner_user_id":401,"app_server_generation":2,"execution_generation":3,"turn_observation_generation":4,"attempt_count":1,"turn_id":"turn-steer-1","created_at":1710000000.125,"baseline_turn_ids":"[\\"base-1\\",\\"base-2\\"]"}';
    assert.equal(ob.owner_json, expectedOwnerJson);

    const owner = JSON.parse(ob.owner_json);
    assert.deepEqual(owner, {
      job_id: 'job-steer-1',
      target_thread_id: 'thread-steer-1',
      channel_id: 301,
      owner_user_id: 401,
      app_server_generation: 2,
      execution_generation: 3,
      turn_observation_generation: 4,
      attempt_count: 1,
      turn_id: 'turn-steer-1',
      created_at: 1710000000.125,
      baseline_turn_ids: '["base-1","base-2"]',
    });
  });
});

describe('runtime capability requirement validation and format_version types', () => {
  it('preserves native BigInt 9007199254740993n across migration', () => {
    const db = createBaseDb();
    db.exec(`
      CREATE TABLE cdr_runtime_capability_requirements (
        component TEXT PRIMARY KEY NOT NULL,
        format_version INTEGER NOT NULL CHECK(format_version > 0)
      );
    `);
    const stmt = db.prepare(
      "INSERT INTO cdr_runtime_capability_requirements (component, format_version) VALUES ('async_recovery_policy', ?)"
    );
    stmt.run(9007199254740993n);

    migrateAsyncResolution(db);

    const readStmt = db.prepare(
      "SELECT format_version FROM cdr_runtime_capability_requirements WHERE component='async_recovery_policy'"
    );
    readStmt.setReadBigInts(true);
    const row = readStmt.get() as { format_version: bigint };
    assert.equal(row.format_version, 9007199254740993n);
  });

  it('rejects malformed REAL format_version and rolls back migration', () => {
    const db = createBaseDb();
    db.exec(`
      CREATE TABLE cdr_runtime_capability_requirements (
        component TEXT PRIMARY KEY NOT NULL,
        format_version NOT NULL CHECK(format_version > 0)
      );
      INSERT INTO cdr_runtime_capability_requirements VALUES ('async_recovery_policy', 1.5);
    `);

    assert.throws(
      () => migrateAsyncResolution(db),
      /Failed to decode format_version: expected bigint, got number/
    );

    const tableExists = db.prepare("SELECT COUNT(*) as count FROM sqlite_schema WHERE name='cdr_async_execution_obligations'").get() as { count: number };
    assert.equal(tableExists.count, 0);
  });

  it('rejects malformed TEXT format_version and rolls back migration', () => {
    const db = createBaseDb();
    db.exec(`
      CREATE TABLE cdr_runtime_capability_requirements (
        component TEXT PRIMARY KEY NOT NULL,
        format_version NOT NULL CHECK(format_version > 0)
      );
      INSERT INTO cdr_runtime_capability_requirements VALUES ('async_recovery_policy', 'bad');
    `);

    assert.throws(
      () => migrateAsyncResolution(db),
      /Failed to decode format_version: expected bigint, got string/
    );
    assert.equal(schemaCurrentAsyncResolution(db), false);
  });

  it('throws and rolls back when RAISE(IGNORE) suppresses fallback capability insert', () => {
    const db = createBaseDb();
    db.exec(`
      CREATE TABLE cdr_runtime_capability_requirements (
        component TEXT PRIMARY KEY NOT NULL,
        format_version INTEGER NOT NULL CHECK(format_version > 0)
      );
      CREATE TRIGGER block_capability_insert
      BEFORE INSERT ON cdr_runtime_capability_requirements
      WHEN NEW.component='async_recovery_policy'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    assert.throws(
      () => migrateAsyncResolution(db),
      /Missing required capability: component 'async_recovery_policy'/
    );
    assert.equal(schemaCurrentAsyncResolution(db), false);
  });
});

describe('question state transitions and exact receipt confirmation', () => {
  it('captures sealed origin on open->dispatching and confirms answer only on exact accepted turn', () => {
    const db = createBaseDb();
    migrateAsyncResolution(db);

    insertQuestion(db, {
      id: 'q-live-1',
      turn_id: 'turn-exact',
      state: 'open',
      preparation_json: '{"seal":"origin_payload_v1"}',
    });

    let ob = db.prepare("SELECT * FROM cdr_async_execution_obligations WHERE question_id='q-live-1'").get();
    assert.equal(ob, undefined);

    db.exec("UPDATE cdr_async_questions SET state='dispatching' WHERE id='q-live-1';");
    ob = db.prepare("SELECT * FROM cdr_async_execution_obligations WHERE question_id='q-live-1'").get() as any;
    assert.ok(ob);
    assert.equal((ob as any).answer_state, 'unresolved');
    assert.equal((ob as any).execution_state, 'unresolved');
    assert.equal((ob as any).admission_state, 'held');
    assert.equal((ob as any).original_seal, '{"seal":"origin_payload_v1"}');

    db.exec(`
      UPDATE cdr_async_questions
      SET state='submitted', accepted_turn_id='turn-exact', updated_at=1710000005.0
      WHERE id='q-live-1';
    `);
    ob = db.prepare("SELECT * FROM cdr_async_execution_obligations WHERE question_id='q-live-1'").get() as any;
    assert.equal((ob as any).answer_state, 'exact_receipt_confirmed');
    assert.equal((ob as any).receipt_turn, 'turn-exact');
    assert.equal((ob as any).updated_at, 1710000005.0);
    assert.equal((ob as any).execution_state, 'unresolved');
    assert.equal((ob as any).admission_state, 'held');
  });

  it('keeps answer_state unresolved on mismatched accepted receipt', () => {
    const db = createBaseDb();
    migrateAsyncResolution(db);

    insertQuestion(db, {
      id: 'q-mismatch',
      turn_id: 'turn-expected',
      state: 'open',
      preparation_json: '{"seal":"mismatch_test"}',
    });
    db.exec("UPDATE cdr_async_questions SET state='dispatching' WHERE id='q-mismatch';");

    db.exec("UPDATE cdr_async_questions SET state='submitted', accepted_turn_id='turn-DIFFERENT' WHERE id='q-mismatch';");
    const ob = db.prepare("SELECT * FROM cdr_async_execution_obligations WHERE question_id='q-mismatch'").get() as any;
    assert.equal(ob.answer_state, 'unresolved');
    assert.equal(ob.receipt_turn, null);
  });

  it('rejects update of original_seal and claim columns as immutable', () => {
    const db = createBaseDb();
    migrateAsyncResolution(db);

    insertQuestion(db, {
      id: 'q-immut',
      state: 'open',
      preparation_json: '{"seal":"immutable_seal"}',
    });
    db.exec("UPDATE cdr_async_questions SET state='dispatching' WHERE id='q-immut';");

    assert.throws(
      () => db.exec("UPDATE cdr_async_execution_obligations SET original_seal='tampered' WHERE question_id='q-immut';"),
      /async obligation original claim is immutable/
    );
    assert.throws(
      () => db.exec("UPDATE cdr_async_execution_obligations SET claim_json='{}' WHERE question_id='q-immut';"),
      /async obligation original claim is immutable/
    );
  });
});

describe('oversized evidence boundary and source deletion protections', () => {
  it('stores NULL marker for oversized seal (>131072 bytes) and retains original source evidence', () => {
    const db = createBaseDb();
    migrateAsyncResolution(db);

    const oversizedJson = JSON.stringify({ large: 'a'.repeat(131100) });
    assert.ok(Buffer.byteLength(oversizedJson, 'utf8') > 131072);

    insertQueue(db, { job_id: 'job-large', target_thread_id: 'thread-large' });
    insertQuestion(db, {
      id: 'q-large',
      origin_job_id: 'job-large',
      thread_id: 'thread-large',
      state: 'open',
      preparation_json: oversizedJson,
    });

    db.exec("UPDATE cdr_async_questions SET state='dispatching' WHERE id='q-large';");

    const ob = db.prepare("SELECT * FROM cdr_async_execution_obligations WHERE question_id='q-large'").get() as any;
    assert.ok(ob);
    assert.equal(ob.original_seal, null);

    assert.throws(
      () => db.exec("DELETE FROM cdr_async_questions WHERE id='q-large';"),
      /unresolved async source evidence cannot be deleted/
    );

    assert.throws(
      () => db.exec("UPDATE cdr_async_questions SET preparation_json='modified' WHERE id='q-large';"),
      /uncopied async source evidence must be preserved/
    );

    assert.throws(
      () => db.exec("DELETE FROM codex_turn_queue WHERE job_id='job-large';"),
      /\[cdr-rust:async-resolution-held:v1\] original source evidence was not safely copied/
    );
  });
});

describe('turn queue attempt trigger for reviewed incident and unsettled targets', () => {
  it('blocks pending->starting for reviewed incident thread and threads with unsettled obligations', () => {
    const db = createBaseDb();
    migrateAsyncResolution(db);

    const REVIEWED_INCIDENT_THREAD = '01a06156-56cd-70b0-af02-2de7445ba4c7';

    insertQueue(db, {
      job_id: 'job-incident',
      target_thread_id: REVIEWED_INCIDENT_THREAD,
      state: 'pending',
    });
    assert.throws(
      () => db.exec("UPDATE codex_turn_queue SET state='starting' WHERE job_id='job-incident';"),
      /\[cdr-rust:async-resolution-held:v1\] original execution unresolved; no automatic retry/
    );

    insertQueue(db, {
      job_id: 'job-unsettled',
      target_thread_id: 'thread-unsettled',
      state: 'pending',
    });
    insertQuestion(db, {
      id: 'q-unsettled',
      thread_id: 'thread-unsettled',
      origin_job_id: 'job-unsettled',
      state: 'open',
    });
    db.exec("UPDATE cdr_async_questions SET state='dispatching' WHERE id='q-unsettled';");

    assert.throws(
      () => db.exec("UPDATE codex_turn_queue SET state='starting' WHERE job_id='job-unsettled';"),
      /\[cdr-rust:async-resolution-held:v1\] original execution unresolved; no automatic retry/
    );

    insertQueue(db, {
      job_id: 'job-clean',
      target_thread_id: 'thread-clean',
      state: 'pending',
    });
    db.exec("UPDATE codex_turn_queue SET state='starting' WHERE job_id='job-clean';");
    const cleanQueue = db.prepare("SELECT state FROM codex_turn_queue WHERE job_id='job-clean'").get() as any;
    assert.equal(cleanQueue.state, 'starting');
  });
});

describe('body retention via RAISE(IGNORE) and terminal settlement constraints', () => {
  it('preserves question body on UPDATE via RAISE(IGNORE) and protects unsettled obligation from DELETE', () => {
    const db = createBaseDb();
    migrateAsyncResolution(db);

    insertQuestion(db, {
      id: 'q-retention',
      body: 'original critical body text',
      state: 'open',
    });
    db.exec("UPDATE cdr_async_questions SET state='dispatching' WHERE id='q-retention';");

    db.exec("UPDATE cdr_async_questions SET body='compacted_summary' WHERE id='q-retention';");
    const qRow = db.prepare("SELECT body FROM cdr_async_questions WHERE id='q-retention'").get() as any;
    assert.equal(qRow.body, 'original critical body text');

    assert.throws(
      () => db.exec("DELETE FROM cdr_async_execution_obligations WHERE question_id='q-retention';"),
      /unresolved async obligation cannot be forgotten/
    );
  });

  it('rejects terminal settlement certificate without matching owned evidence and enforces certificate immutability', () => {
    const db = createBaseDb();
    migrateAsyncResolution(db);

    insertQuestion(db, {
      id: 'q-settle',
      state: 'open',
    });
    db.exec("UPDATE cdr_async_questions SET state='dispatching' WHERE id='q-settle';");

    const proof = JSON.stringify({ version: 1, owner_verified: 1, revision: 0 });

    assert.throws(
      () => db.prepare('INSERT INTO cdr_async_terminal_settlements (question_id, revision, proof_json) VALUES (?, ?, ?);')
        .run('q-settle', 1, proof),
      /async settlement certificate has no matching owned decision/
    );

    db.exec(`
      UPDATE cdr_async_execution_obligations
      SET execution_state='terminal', revision=1, terminal_proof_json='${proof}'
      WHERE question_id='q-settle';
    `);

    db.prepare('INSERT INTO cdr_async_terminal_settlements (question_id, revision, proof_json) VALUES (?, ?, ?);')
      .run('q-settle', 1, proof);

    assert.throws(
      () => db.exec("UPDATE cdr_async_terminal_settlements SET revision=2 WHERE question_id='q-settle';"),
      /async settlement certificate is immutable/
    );
    assert.throws(
      () => db.exec("DELETE FROM cdr_async_terminal_settlements WHERE question_id='q-settle';"),
      /async settlement certificate cannot be forgotten/
    );
  });
});


describe('legacy null seal dispatch backfill and unresolved source protection', () => {
  it('preserves null seal and null chosen on legacy dispatch backfill when queue entry is absent and prevents source deletion', () => {
    const db = createBaseDb();

    insertQuestion(db, {
      id: 'q-legacy-null-seal',
      origin_job_id: 'job-absent-queue',
      dispatch_mode: 'steer',
      state: 'dispatching',
      chosen: null,
      preparation_json: null,
    });

    migrateAsyncResolution(db);

    const ob = db.prepare("SELECT * FROM cdr_async_execution_obligations WHERE question_id='q-legacy-null-seal'").get() as any;
    assert.ok(ob);
    assert.equal(ob.original_seal, null);
    assert.equal(ob.owner_json, null);

    const claim = JSON.parse(ob.claim_json);
    assert.equal(claim.chosen, null);

    assert.throws(
      () => db.exec("DELETE FROM cdr_async_questions WHERE id='q-legacy-null-seal';"),
      /unresolved async source evidence cannot be deleted/
    );
  });
});

describe('deferred obligation creation on open questions with null preparation_json', () => {
  it('does not create obligation on open to dispatching transition when preparation_json is null until seal is set', () => {
    const db = createBaseDb();
    migrateAsyncResolution(db);

    insertQuestion(db, {
      id: 'q-open-null-prep',
      state: 'open',
      preparation_json: null,
    });

    db.exec("UPDATE cdr_async_questions SET state='dispatching' WHERE id='q-open-null-prep';");
    let ob = db.prepare("SELECT * FROM cdr_async_execution_obligations WHERE question_id='q-open-null-prep'").get();
    assert.equal(ob, undefined);

    db.exec("UPDATE cdr_async_questions SET preparation_json='{\"seal\":\"deferred_seal_payload\"}' WHERE id='q-open-null-prep';");
    ob = db.prepare("SELECT * FROM cdr_async_execution_obligations WHERE question_id='q-open-null-prep'").get() as any;
    assert.ok(ob);
    assert.equal(ob.original_seal, '{"seal":"deferred_seal_payload"}');
    assert.equal(ob.answer_state, 'unresolved');
    assert.equal(ob.execution_state, 'unresolved');
    assert.equal(ob.admission_state, 'held');
  });
});

describe('multibyte utf8 seal exact boundary (131072 accepted, 131073 null copy)', () => {
  it('accepts multibyte seal exactly at 131072 utf8 bytes unchanged', () => {
    const seal131072 = JSON.stringify({ seal: 'é'.repeat(65530) + 'a' });
    assert.equal(Buffer.byteLength(seal131072, 'utf8'), 131072);

    const db = createBaseDb();
    migrateAsyncResolution(db);

    insertQueue(db, { job_id: 'job-boundary-131072', target_thread_id: 'thread-b1' });
    insertQuestion(db, {
      id: 'q-boundary-131072',
      origin_job_id: 'job-boundary-131072',
      thread_id: 'thread-b1',
      state: 'open',
      preparation_json: seal131072,
    });
    db.exec("UPDATE cdr_async_questions SET state='dispatching' WHERE id='q-boundary-131072';");

    const ob = db.prepare("SELECT * FROM cdr_async_execution_obligations WHERE question_id='q-boundary-131072'").get() as any;
    assert.ok(ob);
    assert.equal(ob.original_seal, seal131072);
  });

  it('stores null copy for multibyte seal at 131073 utf8 bytes while preserving original source', () => {
    const seal131073 = JSON.stringify({ seal: 'é'.repeat(65530) + 'aa' });
    assert.equal(Buffer.byteLength(seal131073, 'utf8'), 131073);

    const db = createBaseDb();
    migrateAsyncResolution(db);

    insertQueue(db, { job_id: 'job-boundary-131073', target_thread_id: 'thread-b2' });
    insertQuestion(db, {
      id: 'q-boundary-131073',
      origin_job_id: 'job-boundary-131073',
      thread_id: 'thread-b2',
      state: 'open',
      preparation_json: seal131073,
    });
    db.exec("UPDATE cdr_async_questions SET state='dispatching' WHERE id='q-boundary-131073';");

    const ob = db.prepare("SELECT * FROM cdr_async_execution_obligations WHERE question_id='q-boundary-131073'").get() as any;
    assert.ok(ob);
    assert.equal(ob.original_seal, null);

    assert.throws(
      () => db.exec("DELETE FROM cdr_async_questions WHERE id='q-boundary-131073';"),
      /unresolved async source evidence cannot be deleted/
    );
  });
});