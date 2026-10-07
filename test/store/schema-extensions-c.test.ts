import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  SchemaExtensionError,
  sameDefinition,
  migrateArchiveFence,
  schemaCurrentArchiveFence,
  migrateReservePolicy,
  schemaCurrentReservePolicy,
  migrateReserveStartNotice,
  schemaCurrentReserveStartNotice,
  migrateReserveTransitionNotice,
  schemaCurrentReserveTransitionNotice,
  migrateExecutionHold,
  schemaCurrentExecutionHold,
  migrateFinalRecovery,
  schemaCurrentFinalRecovery,
  migrateServerResponse,
  schemaCurrentServerResponse,
  migrateReserveRetirement,
  schemaCurrentReserveRetirement,
} from '../../src/store/schema-extensions-c.ts';

function setupArchiveDependencies(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS codex_turn_queue (
      job_id TEXT PRIMARY KEY,
      target_thread_id TEXT NOT NULL,
      channel_id INTEGER NOT NULL,
      owner_user_id INTEGER,
      discord_message_id INTEGER,
      prompt TEXT NOT NULL,
      queued INTEGER NOT NULL,
      ack_sent INTEGER NOT NULL,
      state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      turn_id TEXT,
      baseline_turn_ids TEXT NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS discord_ingress_journal (
      ingress_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 1 CHECK(version = 1),
      kind TEXT NOT NULL CHECK(kind IN ('message', 'interaction', 'action')),
      event_id INTEGER,
      application_id INTEGER,
      channel_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      source_message_id INTEGER,
      payload_json TEXT NOT NULL,
      runtime_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('staged','acknowledged','executing','owned','completed','held')),
      phase TEXT NOT NULL,
      target_thread_id TEXT,
      canonical_owner TEXT,
      owner_kind TEXT,
      owner_id TEXT,
      outcome_json TEXT,
      confirmation_delivered INTEGER NOT NULL DEFAULT 0,
      hold_reason TEXT NOT NULL DEFAULT '',
      notice_staged INTEGER NOT NULL DEFAULT 0,
      created_at REAL NOT NULL,
      updated_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS codex_prompt_intakes (
      job_id TEXT PRIMARY KEY,
      target_thread_id TEXT NOT NULL,
      channel_id INTEGER NOT NULL DEFAULT 0,
      owner_user_id INTEGER,
      discord_message_id INTEGER,
      raw_prompt TEXT NOT NULL DEFAULT '',
      auto_queue_when_busy INTEGER NOT NULL DEFAULT 0,
      require_current_mirror INTEGER NOT NULL DEFAULT 0,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      retry_after REAL NOT NULL DEFAULT 0,
      claim_token TEXT,
      claim_expires_at REAL NOT NULL DEFAULT 0,
      created_at REAL NOT NULL DEFAULT 0,
      updated_at REAL NOT NULL DEFAULT 0
    );
  `);
}

const LEGACY_VIEW_SQL = `CREATE VIEW IF NOT EXISTS cdr_archive_inspections_v1 AS
SELECT ingress_id FROM discord_ingress_journal WHERE
    (kind='message' AND json_extract(payload_json,'$.version')=1 AND (
        json_extract(payload_json,'$.plan.Execute') IN ('Help','Runners','Doctor','Where','Identity','Resources')
        OR json_type(payload_json,'$.plan.Execute.SavedRequest')='object'))
    OR (kind='interaction' AND json_extract(payload_json,'$.version')=1
        AND json_extract(payload_json,'$.work.Slash.name') IN ('help','runners','doctor','where'));`;

describe('schema-extensions-c: exact TS translation of 6 extensions', () => {
  describe('ArchiveFence', () => {
    it('initializes on clean DB with dependencies and reports current schema', () => {
      const db = new DatabaseSync(':memory:');
      try {
        setupArchiveDependencies(db);
        assert.equal(schemaCurrentArchiveFence(db), false);
        migrateArchiveFence(db);
        assert.equal(schemaCurrentArchiveFence(db), true);
        // repeat catalog idempotence
        migrateArchiveFence(db);
        assert.equal(schemaCurrentArchiveFence(db), true);
      } finally {
        db.close();
      }
    });

    it('refuses legacy view upgrade outside transaction and retains legacy view untouched', () => {
      const db = new DatabaseSync(':memory:');
      try {
        setupArchiveDependencies(db);
        db.exec(LEGACY_VIEW_SQL);
        assert.equal(schemaCurrentArchiveFence(db), false);

        assert.throws(
          () => migrateArchiveFence(db),
          (err: unknown) => {
            assert.ok(err instanceof SchemaExtensionError);
            assert.equal(err.kind, 'ActiveTransaction');
            assert.equal(
              err.message,
              'store schema migration requires a connection without an active transaction'
            );
            return true;
          }
        );

        // Legacy view definition was retained
        const viewRow = db
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE name='cdr_archive_inspections_v1'"
          )
          .get() as { sql: string };
        assert.ok(sameDefinition(viewRow.sql, LEGACY_VIEW_SQL));
      } finally {
        db.close();
      }
    });

    it('upgrades legacy view inside caller transaction to match current view', () => {
      const db = new DatabaseSync(':memory:');
      try {
        setupArchiveDependencies(db);
        db.exec(LEGACY_VIEW_SQL);
        db.exec('BEGIN IMMEDIATE');
        migrateArchiveFence(db);
        db.exec('COMMIT');
        assert.equal(schemaCurrentArchiveFence(db), true);
      } finally {
        db.close();
      }
    });

    it('rejects unknown view definition without DROP', () => {
      const db = new DatabaseSync(':memory:');
      try {
        setupArchiveDependencies(db);
        db.exec('CREATE VIEW cdr_archive_inspections_v1 AS SELECT 1 AS ingress_id;');
        assert.throws(
          () => migrateArchiveFence(db),
          (err: unknown) => {
            assert.ok(err instanceof SchemaExtensionError);
            assert.equal(err.kind, 'Integrity');
            assert.equal(
              err.message,
              'SQLite integrity check failed: archive inspection definition is unknown; no automatic replacement'
            );
            return true;
          }
        );
        const row = db
          .prepare(
            "SELECT sql FROM sqlite_schema WHERE name='cdr_archive_inspections_v1'"
          )
          .get() as { sql: string };
        assert.equal(row.sql, 'CREATE VIEW cdr_archive_inspections_v1 AS SELECT 1 AS ingress_id');
      } finally {
        db.close();
      }
    });

    it('rejects wrong object type (table instead of view) without DROP', () => {
      const db = new DatabaseSync(':memory:');
      try {
        setupArchiveDependencies(db);
        db.exec('CREATE TABLE cdr_archive_inspections_v1 (ingress_id TEXT PRIMARY KEY);');
        assert.throws(
          () => migrateArchiveFence(db),
          (err: unknown) => {
            assert.ok(err instanceof SchemaExtensionError);
            assert.equal(err.kind, 'Integrity');
            return true;
          }
        );
        const count = db
          .prepare(
            "SELECT count(*) AS c FROM sqlite_schema WHERE type='table' AND name='cdr_archive_inspections_v1'"
          )
          .get() as { c: number };
        assert.equal(count.c, 1);
      } finally {
        db.close();
      }
    });

    it('enforces archive triggers: queue, intake and ingress fences and held nonreplay', () => {
      const db = new DatabaseSync(':memory:');
      try {
        setupArchiveDependencies(db);
        migrateArchiveFence(db);

        db.exec(
          "INSERT INTO codex_archive_fences(target_thread_id, operation_id, phase) VALUES ('target-fenced', 'op-1', 'verified');"
        );

        // Queue insert fence
        assert.throws(
          () =>
            db.exec(`
            INSERT INTO codex_turn_queue (job_id, target_thread_id, channel_id, prompt, queued, ack_sent, state, attempt_count, baseline_turn_ids, created_at, updated_at)
            VALUES ('job-1', 'target-fenced', 10, 'prompt', 0, 0, 'pending', 0, '[]', 1.0, 1.0);
          `),
          /archive fence prevents queue handoff/
        );

        // Queue update fence
        db.exec(`
          INSERT INTO codex_turn_queue (job_id, target_thread_id, channel_id, prompt, queued, ack_sent, state, attempt_count, baseline_turn_ids, created_at, updated_at)
          VALUES ('job-ok', 'target-unfenced', 10, 'prompt', 0, 0, 'pending', 0, '[]', 1.0, 1.0);
        `);
        assert.throws(
          () =>
            db.exec(
              "UPDATE codex_turn_queue SET target_thread_id='target-fenced' WHERE job_id='job-ok';"
            ),
          /archive fence prevents queue execution or retargeting/
        );

        // Intake insert fence
        assert.throws(
          () =>
            db.exec(`
            INSERT INTO codex_prompt_intakes (job_id, target_thread_id, channel_id, raw_prompt, auto_queue_when_busy, require_current_mirror, created_at, updated_at)
            VALUES ('intake-1', 'target-fenced', 10, 'prompt', 0, 0, 1.0, 1.0);
          `),
          /archive fence prevents prompt intake handoff/
        );

        // Intake update fence
        db.exec(`
          INSERT INTO codex_prompt_intakes (job_id, target_thread_id, channel_id, raw_prompt, auto_queue_when_busy, require_current_mirror, created_at, updated_at)
          VALUES ('intake-ok', 'target-unfenced', 10, 'prompt', 0, 0, 1.0, 1.0);
        `);
        assert.throws(
          () =>
            db.exec(
              "UPDATE codex_prompt_intakes SET target_thread_id='target-fenced' WHERE job_id='intake-ok';"
            ),
          /archive fence prevents prompt intake execution or retargeting/
        );

        // Ingress admission trigger holds uninspected request for fenced target
        db.exec(`
          INSERT INTO discord_ingress_journal (
            ingress_id, version, kind, channel_id, owner_user_id, payload_json, state, phase, target_thread_id, created_at, updated_at
          ) VALUES (
            'ing-1', 1, 'message', 10, 20, '{"version":1,"plan":{"Execute":{"Unknown":"X"}}}', 'staged', 'initial', 'target-fenced', 1.0, 1.0
          );
        `);
        const ingRow = db
          .prepare('SELECT state, phase, hold_reason FROM discord_ingress_journal WHERE ingress_id=?')
          .get('ing-1') as { state: string; phase: string; hold_reason: string };
        assert.equal(ingRow.state, 'held');
        assert.equal(ingRow.phase, 'archive_fenced');
        assert.ok(ingRow.hold_reason.includes('archive scope is reserved or archived'));

        // Held ingress cannot be replayed automatically
        assert.throws(
          () =>
            db.exec(
              "UPDATE discord_ingress_journal SET state='executing' WHERE ingress_id='ing-1';"
            ),
          /archive-held request requires explicit review; no automatic replay/
        );

        // Ingress matching inspection view bypasses hold trigger
        db.exec(`
          INSERT INTO discord_ingress_journal (
            ingress_id, version, kind, channel_id, owner_user_id, payload_json, state, phase, target_thread_id, created_at, updated_at
          ) VALUES (
            'ing-help', 1, 'message', 10, 20, '{"version":1,"plan":{"Execute":"Help"}}', 'staged', 'initial', 'target-fenced', 2.0, 2.0
          );
        `);
        const helpRow = db
          .prepare('SELECT state, phase FROM discord_ingress_journal WHERE ingress_id=?')
          .get('ing-help') as { state: string; phase: string };
        assert.equal(helpRow.state, 'staged');
        assert.equal(helpRow.phase, 'initial');
      } finally {
        db.close();
      }
    });
  });

  describe('ReservePolicy & Notices', () => {
    it('migrates fresh DB, checks schema, and remains idempotent', () => {
      const db = new DatabaseSync(':memory:');
      try {
        assert.equal(schemaCurrentReservePolicy(db), false);
        migrateReservePolicy(db);
        assert.equal(schemaCurrentReservePolicy(db), true);
        migrateReservePolicy(db);
        assert.equal(schemaCurrentReservePolicy(db), true);
      } finally {
        db.close();
      }
    });

    it('upgrades older reserve policy table preserving prior rows, values, nulls and defaults', () => {
      const db = new DatabaseSync(':memory:');
      try {
        // Create legacy table missing newer columns
        db.exec(`
          CREATE TABLE codex_reserve_policy (
            thread_id TEXT PRIMARY KEY,
            mode TEXT NOT NULL CHECK(mode IN ('auto','on','off','manual')),
            state TEXT NOT NULL CHECK(state IN ('ordinary','entering','reserve','restoring','held','unknown')),
            account_id TEXT,
            process_id INTEGER,
            generation INTEGER,
            previous_model TEXT,
            previous_effort TEXT,
            previous_tier TEXT,
            revision INTEGER NOT NULL DEFAULT 0,
            updated_at REAL NOT NULL DEFAULT (unixepoch())
          );
        `);
        db.exec(`
          INSERT INTO codex_reserve_policy (thread_id, mode, state, account_id, previous_model, revision)
          VALUES ('t-legacy', 'auto', 'entering', 'acc-1', 'gpt-4', 7);
        `);

        assert.equal(schemaCurrentReservePolicy(db), false);
        migrateReservePolicy(db);
        assert.equal(schemaCurrentReservePolicy(db), true);

        const row = db
          .prepare('SELECT * FROM codex_reserve_policy WHERE thread_id=?')
          .get('t-legacy') as Record<string, unknown>;
        assert.equal(row.thread_id, 't-legacy');
        assert.equal(row.mode, 'auto');
        assert.equal(row.state, 'entering');
        assert.equal(row.account_id, 'acc-1');
        assert.equal(row.previous_model, 'gpt-4');
        assert.equal(row.revision, 7);
        assert.equal(row.previous_effort_present, 0);
        assert.equal(row.applied_model, null);
        assert.equal(row.usage_failure_id, 0);
        assert.equal(row.usage_failure_state, null);
      } finally {
        db.close();
      }
    });

    it('repairs missing start_notice and transition_notice partially missing guards', () => {
      const db = new DatabaseSync(':memory:');
      try {
        migrateReservePolicy(db);
        assert.equal(schemaCurrentReservePolicy(db), true);

        // Intentionally drop start_notices
        db.exec('DROP TABLE codex_reserve_start_notices;');
        assert.equal(schemaCurrentReserveStartNotice(db), false);
        assert.equal(schemaCurrentReservePolicy(db), false);

        migrateReserveStartNotice(db);
        assert.equal(schemaCurrentReserveStartNotice(db), true);
        assert.equal(schemaCurrentReservePolicy(db), true);

        // Drop transition index
        db.exec('DROP INDEX codex_reserve_transition_notices_pending;');
        assert.equal(schemaCurrentReserveTransitionNotice(db), false);
        assert.equal(schemaCurrentReservePolicy(db), false);

        migrateReserveTransitionNotice(db);
        assert.equal(schemaCurrentReserveTransitionNotice(db), true);
        assert.equal(schemaCurrentReservePolicy(db), true);
      } finally {
        db.close();
      }
    });
  });

  describe('ExecutionHold', () => {
    it('migrates, verifies schema_current, and enforces column count', () => {
      const db = new DatabaseSync(':memory:');
      try {
        assert.equal(schemaCurrentExecutionHold(db), false);
        migrateExecutionHold(db);
        assert.equal(schemaCurrentExecutionHold(db), true);
        migrateExecutionHold(db);
        assert.equal(schemaCurrentExecutionHold(db), true);

        // Column count guard: adding unexpected column makes schemaCurrent false
        db.exec('ALTER TABLE cdr_execution_holds ADD COLUMN extra TEXT;');
        assert.equal(schemaCurrentExecutionHold(db), false);
      } finally {
        db.close();
      }
    });
  });

  describe('FinalRecovery', () => {
    it('migrates DDL only, verifies schema_current, and guards column count', () => {
      const db = new DatabaseSync(':memory:');
      try {
        assert.equal(schemaCurrentFinalRecovery(db), false);
        migrateFinalRecovery(db);
        assert.equal(schemaCurrentFinalRecovery(db), true);
        migrateFinalRecovery(db);
        assert.equal(schemaCurrentFinalRecovery(db), true);

        // Column count guard
        db.exec('ALTER TABLE cdr_final_recovery ADD COLUMN extra TEXT;');
        assert.equal(schemaCurrentFinalRecovery(db), false);
      } finally {
        db.close();
      }
    });
  });

  describe('ServerResponse', () => {
    it('migrates, checks phase and generation CHECK constraints and index guard', () => {
      const db = new DatabaseSync(':memory:');
      try {
        assert.equal(schemaCurrentServerResponse(db), false);
        migrateServerResponse(db);
        assert.equal(schemaCurrentServerResponse(db), true);
        migrateServerResponse(db);
        assert.equal(schemaCurrentServerResponse(db), true);

        // Generation > 0 check
        assert.throws(
          () =>
            db.exec(`
            INSERT INTO cdr_server_responses (
              request_key, runtime_id, resident_owner, generation, target_thread_id,
              turn_id, job_id, authority_json, response_sha256, phase, created_at, updated_at
            ) VALUES ('k1', 'r1', 'o1', 0, 't1', 'turn1', 'j1', '{}', 'hash', 'admitted', 1.0, 1.0);
          `),
          /CHECK constraint failed/
        );

        // Phase check
        assert.throws(
          () =>
            db.exec(`
            INSERT INTO cdr_server_responses (
              request_key, runtime_id, resident_owner, generation, target_thread_id,
              turn_id, job_id, authority_json, response_sha256, phase, created_at, updated_at
            ) VALUES ('k2', 'r1', 'o1', 1, 't1', 'turn1', 'j1', '{}', 'hash', 'bogus', 1.0, 1.0);
          `),
          /CHECK constraint failed/
        );

        // Valid insert
        db.exec(`
          INSERT INTO cdr_server_responses (
            request_key, runtime_id, resident_owner, generation, target_thread_id,
            turn_id, job_id, authority_json, response_sha256, phase, created_at, updated_at
          ) VALUES ('k-valid', 'r1', 'o1', 2, 't1', 'turn1', 'j1', '{}', 'hash', 'flushed', 1.0, 1.0);
        `);

        // Index guard
        db.exec('DROP INDEX cdr_server_response_target;');
        assert.equal(schemaCurrentServerResponse(db), false);
      } finally {
        db.close();
      }
    });
  });

  describe('ReserveRetirement', () => {
    it('migrates 2 evidence tables only without runtime retire logic', () => {
      const db = new DatabaseSync(':memory:');
      try {
        assert.equal(schemaCurrentReserveRetirement(db), false);
        migrateReserveRetirement(db);
        assert.equal(schemaCurrentReserveRetirement(db), true);
        migrateReserveRetirement(db);
        assert.equal(schemaCurrentReserveRetirement(db), true);

        // Table count guard
        db.exec('DROP TABLE cdr_store_retirements;');
        assert.equal(schemaCurrentReserveRetirement(db), false);
      } finally {
        db.close();
      }
    });
  });

  describe('Rollback and Transaction Isolation', () => {
    it('rolls back uncommitted migrations completely', () => {
      const db = new DatabaseSync(':memory:');
      try {
        db.exec('BEGIN IMMEDIATE');
        migrateExecutionHold(db);
        assert.equal(schemaCurrentExecutionHold(db), true);
        db.exec('ROLLBACK');
        assert.equal(schemaCurrentExecutionHold(db), false);
      } finally {
        db.close();
      }
    });
  });
});

describe('sameDefinition: exact Rust whitespace and definition equivalence', () => {
  const plain = 'CREATE VIEW test_view AS SELECT 1';

  it('accepts outer NEL at head and tail', () => {
    assert.equal(sameDefinition('\u0085CREATE VIEW test_view AS SELECT 1', plain), true);
    assert.equal(sameDefinition('CREATE VIEW test_view AS SELECT 1\u0085', plain), true);
    assert.equal(sameDefinition('\u0085CREATE VIEW test_view AS SELECT 1\u0085', plain), true);
  });

  it('rejects BOM at head and tail', () => {
    assert.equal(sameDefinition('\uFEFFCREATE VIEW test_view AS SELECT 1', plain), false);
    assert.equal(sameDefinition('CREATE VIEW test_view AS SELECT 1\uFEFF', plain), false);
    assert.equal(sameDefinition('\uFEFFCREATE VIEW test_view AS SELECT 1\uFEFF', plain), false);
  });

  it('preserves case differences in SQL keywords and body', () => {
    assert.equal(sameDefinition('create view test_view AS SELECT 1', plain), false);
    assert.equal(sameDefinition('CREATE VIEW test_view as select 1', plain), false);
  });

  it('preserves inner SQL and body whitespace differences', () => {
    assert.equal(sameDefinition('CREATE VIEW test_view AS  SELECT 1', plain), false);
    assert.equal(sameDefinition('CREATE VIEW  test_view AS SELECT 1', plain), false);
  });

  it('preserves literal differences', () => {
    assert.equal(
      sameDefinition("CREATE VIEW test_view AS SELECT 'alpha'", "CREATE VIEW test_view AS SELECT 'beta'"),
      false
    );
  });

  it('retains outer terminator acceptance', () => {
    assert.equal(sameDefinition('CREATE VIEW test_view AS SELECT 1;', plain), true);
    assert.equal(sameDefinition('CREATE VIEW test_view AS SELECT 1;;;', plain), true);
    assert.equal(sameDefinition('CREATE VIEW test_view AS SELECT 1;\n', plain), true);
    assert.equal(sameDefinition('CREATE VIEW test_view AS SELECT 1; \t\n', plain), true);
    assert.equal(
      sameDefinition('CREATE VIEW IF NOT EXISTS test_view AS SELECT 1;', plain),
      true
    );
  });
});

describe('archive inspection admission: DiscardRequest and RecoveryAbandonDecision', () => {
  interface QueueFixture {
    job_id: string;
    target_thread_id?: string;
    channel_id?: number;
    owner_user_id?: number;
    state?: string;
    turn_id?: string | null;
  }

  interface IngressFixture {
    ingress_id: string;
    version?: number;
    kind?: string;
    event_id?: number | null;
    application_id?: number | null;
    channel_id?: number;
    owner_user_id?: number;
    source_message_id?: number | null;
    payload_json: string;
    target_thread_id?: string | null;
    state?: string;
    phase?: string;
  }

  function initFenceDb(queueRows: QueueFixture[] = []): DatabaseSync {
    const db = new DatabaseSync(':memory:');
    setupArchiveDependencies(db);
    const qStmt = db.prepare(`
      INSERT INTO codex_turn_queue (
        job_id, target_thread_id, channel_id, owner_user_id, discord_message_id,
        prompt, queued, ack_sent, state, attempt_count, turn_id,
        baseline_turn_ids, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const q of queueRows) {
      qStmt.run(
        q.job_id,
        q.target_thread_id ?? 'thread-fence-main',
        q.channel_id ?? 200,
        q.owner_user_id ?? 100,
        1,
        'queued prompt',
        1,
        0,
        q.state ?? 'pending',
        0,
        q.turn_id ?? null,
        '[]',
        '',
        1000,
        1000,
      );
    }
    migrateArchiveFence(db);
    db.prepare("INSERT INTO codex_archive_fences(target_thread_id,operation_id,own_ingress_id,phase) VALUES(?,?,NULL,?)").run('thread-fence-main','test-operation','attempted');
    return db;
  }

  function insertIngress(db: DatabaseSync, row: IngressFixture): void {
    const stmt = db.prepare(`
      INSERT INTO discord_ingress_journal (
        ingress_id, version, kind, event_id, application_id, channel_id,
        owner_user_id, source_message_id, payload_json, runtime_id,
        state, phase, target_thread_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      row.ingress_id,
      row.version ?? 1,
      row.kind ?? 'message',
      row.event_id === undefined ? 300 : row.event_id,
      row.application_id === undefined ? null : row.application_id,
      row.channel_id ?? 200,
      row.owner_user_id ?? 100,
      row.source_message_id === undefined ? 300 : row.source_message_id,
      row.payload_json,
      null,
      row.state ?? 'staged',
      row.phase ?? 'ingress',
      row.target_thread_id === undefined ? 'thread-fence-main' : row.target_thread_id,
      1000,
      1000,
    );
  }

  function checkViewAndState(db: DatabaseSync, ingressId: string): { inView: boolean; state: string | undefined } {
    const vRows = db.prepare('SELECT ingress_id FROM cdr_archive_inspections_v1 WHERE ingress_id = ?').all(ingressId) as Array<{ ingress_id: string }>;
    const jRows = db.prepare('SELECT state FROM discord_ingress_journal WHERE ingress_id = ?').all(ingressId) as Array<{ state: string }>;
    return {
      inView: vRows.length > 0,
      state: jRows[0]?.state,
    };
  }

  it('admits valid DiscardRequest message variants and retains staged state', () => {
    const db = initFenceDb([
      { job_id: 'job-v-1', target_thread_id: 'thread-fence-main', channel_id: 200, owner_user_id: 100, state: 'pending', turn_id: null },
      { job_id: 'job-v-2', target_thread_id: 'thread-fence-main', channel_id: 200, owner_user_id: 100, state: 'pending', turn_id: null },
      { job_id: 'job-v-3', target_thread_id: 'thread-fence-main', channel_id: 200, owner_user_id: 100, state: 'pending', turn_id: null },
      { job_id: 'job-v-4', target_thread_id: 'thread-fence-main', channel_id: 200, owner_user_id: 100, state: 'pending', turn_id: null },
    ]);
    try {
      const cases = [
        {
          id: 'discard-valid-min',
          payload: JSON.stringify({
            version: 1,
            author_is_bot: false,
            plan: { Execute: { DiscardRequest: { job_id: 'job-v-1' } } },
          }),
        },
        {
          id: 'discard-valid-full-optional',
          payload: JSON.stringify({
            version: 1,
            author_is_bot: false,
            processing_mode: 'normal',
            settings_binding: null,
            lifecycle_binding: null,
            plan: { Execute: { DiscardRequest: { job_id: 'job-v-2' } } },
          }),
        },
        {
          id: 'discard-valid-mode-only',
          payload: JSON.stringify({
            version: 1,
            author_is_bot: false,
            processing_mode: 'normal',
            plan: { Execute: { DiscardRequest: { job_id: 'job-v-3' } } },
          }),
        },
        {
          id: 'discard-valid-null-settings',
          payload: JSON.stringify({
            version: 1,
            author_is_bot: false,
            settings_binding: null,
            lifecycle_binding: null,
            plan: { Execute: { DiscardRequest: { job_id: 'job-v-4' } } },
          }),
        },
      ];

      for (const c of cases) {
        insertIngress(db, {
          ingress_id: c.id,
          kind: 'message',
          application_id: null,
          owner_user_id: 100,
          channel_id: 200,
          event_id: 300,
          source_message_id: 300,
          target_thread_id: 'thread-fence-main',
          payload_json: c.payload,
        });
        const res = checkViewAndState(db, c.id);
        assert.equal(res.inView, true, `${c.id} must be admitted to cdr_archive_inspections_v1`);
        assert.equal(res.state, 'staged', `${c.id} state must remain staged`);
      }
    } finally {
      db.close();
    }
  });

  it('rejects adversarial DiscardRequest messages and holds fenced rows', () => {
    const db = initFenceDb([
      { job_id: 'job-valid', target_thread_id: 'thread-fence-main', channel_id: 200, owner_user_id: 100, state: 'pending', turn_id: null },
      { job_id: 'job-executing', target_thread_id: 'thread-fence-main', channel_id: 200, owner_user_id: 100, state: 'executing', turn_id: null },
      { job_id: 'job-with-turn', target_thread_id: 'thread-fence-main', channel_id: 200, owner_user_id: 100, state: 'pending', turn_id: 'turn-exist-1' },
    ]);
    try {
      const validPayload = (patch: Record<string, unknown> = {}) => JSON.stringify({
        version: 1,
        author_is_bot: false,
        plan: { Execute: { DiscardRequest: { job_id: 'job-valid' } } },
        ...patch,
      });

      interface AdversarialCase {
        id: string;
        ingressPatch?: Partial<IngressFixture>;
        payload?: string;
        expectHeld?: boolean;
      }

      const cases: AdversarialCase[] = [
        { id: 'd-bot-true', payload: validPayload({ author_is_bot: true }) },
        { id: 'd-bot-string', payload: validPayload({ author_is_bot: 'false' }) },
        { id: 'd-wrong-owner', ingressPatch: { owner_user_id: 999 } },
        { id: 'd-wrong-channel', ingressPatch: { channel_id: 999 } },
        { id: 'd-wrong-job', payload: JSON.stringify({ version: 1, author_is_bot: false, plan: { Execute: { DiscardRequest: { job_id: 'job-missing' } } } }) },
        { id: 'd-nonpending-queue', payload: JSON.stringify({ version: 1, author_is_bot: false, plan: { Execute: { DiscardRequest: { job_id: 'job-executing' } } } }) },
        { id: 'd-nonnull-turn', payload: JSON.stringify({ version: 1, author_is_bot: false, plan: { Execute: { DiscardRequest: { job_id: 'job-with-turn' } } } }) },
        { id: 'd-source-mismatch', ingressPatch: { event_id: 300, source_message_id: 301 } },
        { id: 'd-app-nonnull', ingressPatch: { application_id: 42 } },
        { id: 'd-extra-plan-member', payload: JSON.stringify({ version: 1, author_is_bot: false, plan: { Execute: { DiscardRequest: { job_id: 'job-valid' } }, Extra: 1 } }) },
        { id: 'd-extra-execute-member', payload: JSON.stringify({ version: 1, author_is_bot: false, plan: { Execute: { DiscardRequest: { job_id: 'job-valid' }, ExtraAction: 1 } } }) },
        { id: 'd-extra-discard-field', payload: JSON.stringify({ version: 1, author_is_bot: false, plan: { Execute: { DiscardRequest: { job_id: 'job-valid', extra: 'bad' } } } }) },
        { id: 'd-work-present-null', payload: JSON.stringify({ version: 1, author_is_bot: false, work: null, plan: { Execute: { DiscardRequest: { job_id: 'job-valid' } } } }) },
        { id: 'd-work-present-obj', payload: JSON.stringify({ version: 1, author_is_bot: false, work: { Component: {} }, plan: { Execute: { DiscardRequest: { job_id: 'job-valid' } } } }) },
        { id: 'd-wrong-mode', payload: validPayload({ processing_mode: 'urgent' }) },
        { id: 'd-wrong-settings-binding', payload: validPayload({ settings_binding: 'custom' }) },
        { id: 'd-wrong-lifecycle-binding', payload: validPayload({ lifecycle_binding: 'pinned' }) },
        { id: 'd-version-real', payload: '{"version":1.0,"author_is_bot":false,"plan":{"Execute":{"DiscardRequest":{"job_id":"job-valid"}}}}' },
        { id: 'd-version-str', payload: '{"version":"1","author_is_bot":false,"plan":{"Execute":{"DiscardRequest":{"job_id":"job-valid"}}}}' },
        { id: 'd-owner-zero', ingressPatch: { owner_user_id: 0 } },
        { id: 'd-channel-zero', ingressPatch: { channel_id: 0 } },
        { id: 'd-event-zero', ingressPatch: { event_id: 0, source_message_id: 0 } },
        { id: 'd-empty-target', ingressPatch: { target_thread_id: '' }, expectHeld: false },
        { id: 'd-target-mismatch', ingressPatch: { target_thread_id: 'thread-scope-other' }, expectHeld: false },
      ];

      for (const c of cases) {
        insertIngress(db, {
          ingress_id: c.id,
          kind: 'message',
          application_id: null,
          owner_user_id: 100,
          channel_id: 200,
          event_id: 300,
          source_message_id: 300,
          target_thread_id: 'thread-fence-main',
          payload_json: c.payload ?? validPayload(),
          ...c.ingressPatch,
        });
        const res = checkViewAndState(db, c.id);
        assert.equal(res.inView, false, `${c.id} must NOT be admitted to inspections view`);
        if (c.expectHeld !== false) {
          assert.equal(res.state, 'held', `${c.id} matching fenced target must be held`);
        }
      }
    } finally {
      db.close();
    }
  });

  it('admits valid RecoveryAbandonDecision interaction variants (2-key and 5-key, both decisions)', () => {
    const db = initFenceDb();
    try {
      const cases = [
        {
          id: 'rad-2key-abandon',
          payload: JSON.stringify({
            version: 1,
            work: {
              Component: {
                RecoveryAbandonDecision: {
                  proposal_id: '0123456789abcdef0123456789abcdef',
                  revision: 1,
                  decision: 'AbandonOnly',
                },
              },
            },
          }),
        },
        {
          id: 'rad-2key-keepheld',
          payload: JSON.stringify({
            version: 1,
            work: {
              Component: {
                RecoveryAbandonDecision: {
                  proposal_id: 'abcdef0123456789abcdef0123456789',
                  revision: 12,
                  decision: 'KeepHeld',
                },
              },
            },
          }),
        },
        {
          id: 'rad-5key-abandon',
          payload: JSON.stringify({
            version: 1,
            processing_mode: 'normal',
            settings_binding: null,
            request_rejection: null,
            work: {
              Component: {
                RecoveryAbandonDecision: {
                  proposal_id: '0123456789abcdef0123456789abcdef',
                  revision: 5,
                  decision: 'AbandonOnly',
                },
              },
            },
          }),
        },
        {
          id: 'rad-5key-keepheld',
          payload: JSON.stringify({
            version: 1,
            processing_mode: 'normal',
            settings_binding: null,
            request_rejection: null,
            work: {
              Component: {
                RecoveryAbandonDecision: {
                  proposal_id: 'abcdef0123456789abcdef0123456789',
                  revision: 99,
                  decision: 'KeepHeld',
                },
              },
            },
          }),
        },
      ];

      for (const c of cases) {
        insertIngress(db, {
          ingress_id: c.id,
          kind: 'interaction',
          application_id: 50,
          owner_user_id: 100,
          channel_id: 200,
          event_id: 300,
          source_message_id: 400,
          target_thread_id: 'thread-fence-main',
          payload_json: c.payload,
        });
        const res = checkViewAndState(db, c.id);
        assert.equal(res.inView, true, `${c.id} must be in cdr_archive_inspections_v1`);
        assert.equal(res.state, 'staged', `${c.id} state must remain staged`);
      }
    } finally {
      db.close();
    }
  });

  it('rejects adversarial RecoveryAbandonDecision interactions and respects scope-sensitive hold', () => {
    const db = initFenceDb();
    try {
      const valid2Key = (innerPatch: Record<string, unknown> = {}, outerPatch: Record<string, unknown> = {}) => JSON.stringify({
        version: 1,
        work: {
          Component: {
            RecoveryAbandonDecision: {
              proposal_id: '0123456789abcdef0123456789abcdef',
              revision: 1,
              decision: 'AbandonOnly',
              ...innerPatch,
            },
          },
        },
        ...outerPatch,
      });

      interface AdversarialRadCase {
        id: string;
        ingressPatch?: Partial<IngressFixture>;
        payload?: string;
        expectHeld?: boolean;
      }

      const cases: AdversarialRadCase[] = [
        { id: 'rad-id-len-31', payload: valid2Key({ proposal_id: '0123456789abcdef0123456789abcde' }) },
        { id: 'rad-id-len-33', payload: valid2Key({ proposal_id: '0123456789abcdef0123456789abcdef0' }) },
        { id: 'rad-id-uppercase', payload: valid2Key({ proposal_id: '0123456789ABCDEF0123456789ABCDEF' }) },
        { id: 'rad-id-nonhex', payload: valid2Key({ proposal_id: '0123456789abcdef0123456789abcdeg' }) },
        { id: 'rad-rev-zero', payload: valid2Key({ revision: 0 }) },
        { id: 'rad-rev-negative', payload: valid2Key({ revision: -1 }) },
        { id: 'rad-rev-string', payload: valid2Key({ revision: '1' }) },
        { id: 'rad-rev-real', payload: '{"version":1,"work":{"Component":{"RecoveryAbandonDecision":{"proposal_id":"0123456789abcdef0123456789abcdef","revision":1.0,"decision":"AbandonOnly"}}}}' },
        { id: 'rad-decision-invalid', payload: valid2Key({ decision: 'AbandonAll' }) },
        { id: 'rad-decision-lowercase', payload: valid2Key({ decision: 'abandononly' }) },
        { id: 'rad-3keys-toplevel', payload: valid2Key({}, { extra_prop: 1 }) },
        { id: 'rad-4keys-toplevel', payload: valid2Key({}, { processing_mode: 'normal', extra_prop: 1 }) },
        { id: 'rad-6keys-toplevel', payload: valid2Key({}, { processing_mode: 'normal', settings_binding: null, request_rejection: null, extra_prop: 1 }) },
        { id: 'rad-5key-mode-bad', payload: JSON.stringify({ version: 1, processing_mode: 'urgent', settings_binding: null, request_rejection: null, work: { Component: { RecoveryAbandonDecision: { proposal_id: '0123456789abcdef0123456789abcdef', revision: 1, decision: 'AbandonOnly' } } } }) },
        { id: 'rad-5key-settings-bad', payload: JSON.stringify({ version: 1, processing_mode: 'normal', settings_binding: 'custom', request_rejection: null, work: { Component: { RecoveryAbandonDecision: { proposal_id: '0123456789abcdef0123456789abcdef', revision: 1, decision: 'AbandonOnly' } } } }) },
        { id: 'rad-5key-rejection-bad', payload: JSON.stringify({ version: 1, processing_mode: 'normal', settings_binding: null, request_rejection: 'err', work: { Component: { RecoveryAbandonDecision: { proposal_id: '0123456789abcdef0123456789abcdef', revision: 1, decision: 'AbandonOnly' } } } }) },
        { id: 'rad-work-extra-member', payload: JSON.stringify({ version: 1, work: { Component: { RecoveryAbandonDecision: { proposal_id: '0123456789abcdef0123456789abcdef', revision: 1, decision: 'AbandonOnly' } }, Slash: { name: 'unknown' } } }) },
        { id: 'rad-comp-extra-member', payload: JSON.stringify({ version: 1, work: { Component: { RecoveryAbandonDecision: { proposal_id: '0123456789abcdef0123456789abcdef', revision: 1, decision: 'AbandonOnly' }, Extra: 1 } } }) },
        { id: 'rad-item-extra-field', payload: valid2Key({ extra_field: 'forbidden' }) },
        { id: 'rad-version-real', payload: '{"version":1.0,"work":{"Component":{"RecoveryAbandonDecision":{"proposal_id":"0123456789abcdef0123456789abcdef","revision":1,"decision":"AbandonOnly"}}}}' },
        { id: 'rad-version-str', payload: '{"version":"1","work":{"Component":{"RecoveryAbandonDecision":{"proposal_id":"0123456789abcdef0123456789abcdef","revision":1,"decision":"AbandonOnly"}}}}' },
        { id: 'rad-app-zero', ingressPatch: { application_id: 0 } },
        { id: 'rad-event-zero', ingressPatch: { event_id: 0 } },
        { id: 'rad-owner-zero', ingressPatch: { owner_user_id: 0 } },
        { id: 'rad-channel-zero', ingressPatch: { channel_id: 0 } },
        { id: 'rad-source-zero', ingressPatch: { source_message_id: 0 } },
        { id: 'rad-kind-message', ingressPatch: { kind: 'message' } },
        { id: 'rad-empty-target', ingressPatch: { target_thread_id: '' }, expectHeld: false },
      ];

      for (const c of cases) {
        insertIngress(db, {
          ingress_id: c.id,
          kind: 'interaction',
          application_id: 50,
          owner_user_id: 100,
          channel_id: 200,
          event_id: 300,
          source_message_id: 400,
          target_thread_id: 'thread-fence-main',
          payload_json: c.payload ?? valid2Key(),
          ...c.ingressPatch,
        });
        const res = checkViewAndState(db, c.id);
        assert.equal(res.inView, false, `${c.id} must NOT be admitted to inspections view`);
        if (c.expectHeld !== false) {
          assert.equal(res.state, 'held', `${c.id} matching fenced target must be held`);
        }
      }

      insertIngress(db, {
        ingress_id: 'rad-target-unmatched-scope',
        kind: 'interaction',
        application_id: 50,
        owner_user_id: 100,
        channel_id: 200,
        event_id: 300,
        source_message_id: 400,
        target_thread_id: 'thread-unmatched-scope',
        payload_json: valid2Key(),
      });
      const res = checkViewAndState(db, 'rad-target-unmatched-scope');
      assert.equal(res.inView, true, 'rad-target-unmatched-scope must be in cdr_archive_inspections_v1');
      assert.equal(res.state, 'staged', 'rad-target-unmatched-scope state must remain staged');
    } finally {
      db.close();
    }
  });
});
