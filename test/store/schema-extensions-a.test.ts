import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  migrateGoalProgress,
  schemaCurrentGoalProgress,
  migrateObservedCompletion,
  schemaCurrentObservedCompletion,
  migrateObservedFinalAnswer,
  schemaCurrentObservedFinalAnswer,
  migrateAsyncQuestion,
  schemaCurrentAsyncQuestion,
  migrateIdleRelease,
  schemaCurrentIdleRelease,
  migrateObservationGap,
  schemaCurrentObservationGap,
  migrateMutationAttempt,
  schemaCurrentMutationAttempt,
  migrateControlBinding,
  schemaCurrentControlBinding,
} from "../../src/store/schema-extensions-a.ts";

describe("schema-extensions-a: fresh catalog and initial migrate", () => {
  it("evaluates false on fresh DB and true after migration for each extension", () => {
    const db = new DatabaseSync(":memory:");
    try {
      assert.equal(schemaCurrentGoalProgress(db), false);
      migrateGoalProgress(db);
      assert.equal(schemaCurrentGoalProgress(db), true);

      assert.equal(schemaCurrentObservedCompletion(db), false);
      migrateObservedCompletion(db);
      assert.equal(schemaCurrentObservedCompletion(db), true);

      assert.equal(schemaCurrentObservedFinalAnswer(db), false);
      migrateObservedFinalAnswer(db);
      assert.equal(schemaCurrentObservedFinalAnswer(db), true);

      assert.equal(schemaCurrentAsyncQuestion(db), false);
      migrateAsyncQuestion(db);
      assert.equal(schemaCurrentAsyncQuestion(db), true);

      assert.equal(schemaCurrentIdleRelease(db), false);
      migrateIdleRelease(db);
      assert.equal(schemaCurrentIdleRelease(db), true);

      assert.equal(schemaCurrentObservationGap(db), false);
      migrateObservationGap(db);
      assert.equal(schemaCurrentObservationGap(db), true);

      assert.equal(schemaCurrentMutationAttempt(db), false);
      migrateMutationAttempt(db);
      assert.equal(schemaCurrentMutationAttempt(db), true);

      assert.equal(schemaCurrentControlBinding(db), false);
      db.exec(
        `CREATE TABLE codex_turn_queue (
          job_id TEXT PRIMARY KEY,
          target_thread_id TEXT NOT NULL,
          turn_id TEXT
        );`,
      );
      migrateControlBinding(db);
      assert.equal(schemaCurrentControlBinding(db), true);
    } finally {
      db.close();
    }
  });
});

describe("schema-extensions-a: idempotent repeated migration", () => {
  it("survives repeated migrations without altering current schema or existing records", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateGoalProgress(db);
      migrateObservedCompletion(db);
      migrateObservedFinalAnswer(db);
      migrateAsyncQuestion(db);
      migrateIdleRelease(db);
      migrateObservationGap(db);
      migrateMutationAttempt(db);
      db.exec(
        `CREATE TABLE codex_turn_queue (
          job_id TEXT PRIMARY KEY,
          target_thread_id TEXT NOT NULL,
          turn_id TEXT
        );`,
      );
      migrateControlBinding(db);

      // Insert sample rows
      db.exec(
        "INSERT INTO codex_goal_progress(thread,turn,channel,content,job_id) VALUES('t1','tu1',1,'progress','job1')",
      );
      db.exec(
        "INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload,resident_owner) VALUES('t1','tu1',1,'ok','res1')",
      );
      db.exec(
        "INSERT INTO codex_observed_final_answers(thread_id,turn_id,generation,content) VALUES('t1','tu1',1,'final')",
      );
      db.exec(
        "INSERT INTO cdr_idle_release(intent_id,owner_id,generation,thread_id,turn_id,job_id,revision,state,detail) VALUES('i1','o1',1,'t1','tu1','job1',1,'Candidate','')",
      );

      // Second idempotent migration pass
      migrateGoalProgress(db);
      migrateObservedCompletion(db);
      migrateObservedFinalAnswer(db);
      migrateAsyncQuestion(db);
      migrateIdleRelease(db);
      migrateObservationGap(db);
      migrateMutationAttempt(db);
      migrateControlBinding(db);

      assert.equal(schemaCurrentGoalProgress(db), true);
      assert.equal(schemaCurrentObservedCompletion(db), true);
      assert.equal(schemaCurrentObservedFinalAnswer(db), true);
      assert.equal(schemaCurrentAsyncQuestion(db), true);
      assert.equal(schemaCurrentIdleRelease(db), true);
      assert.equal(schemaCurrentObservationGap(db), true);
      assert.equal(schemaCurrentMutationAttempt(db), true);
      assert.equal(schemaCurrentControlBinding(db), true);

      const progressRow = db
        .prepare("SELECT content, job_id FROM codex_goal_progress WHERE thread='t1'")
        .get() as { content: string; job_id: string };
      assert.equal(progressRow.content, "progress");
      assert.equal(progressRow.job_id, "job1");
    } finally {
      db.close();
    }
  });
});

describe("schema-extensions-a: transaction rollback behavior", () => {
  it("reverts uncommitted migration changes on rollback", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE codex_turn_queue (
          job_id TEXT PRIMARY KEY,
          target_thread_id TEXT NOT NULL,
          turn_id TEXT
        );`,
      );
      db.exec("BEGIN IMMEDIATE");
      migrateGoalProgress(db);
      migrateObservedCompletion(db);
      migrateObservedFinalAnswer(db);
      migrateAsyncQuestion(db);
      migrateIdleRelease(db);
      migrateObservationGap(db);
      migrateMutationAttempt(db);
      migrateControlBinding(db);
      db.exec("ROLLBACK");

      assert.equal(schemaCurrentGoalProgress(db), false);
      assert.equal(schemaCurrentObservedCompletion(db), false);
      assert.equal(schemaCurrentObservedFinalAnswer(db), false);
      assert.equal(schemaCurrentAsyncQuestion(db), false);
      assert.equal(schemaCurrentIdleRelease(db), false);
      assert.equal(schemaCurrentObservationGap(db), false);
      assert.equal(schemaCurrentMutationAttempt(db), false);
      assert.equal(schemaCurrentControlBinding(db), false);

      // Now commit in a new transaction
      db.exec("BEGIN IMMEDIATE");
      migrateGoalProgress(db);
      migrateObservedCompletion(db);
      migrateObservedFinalAnswer(db);
      migrateAsyncQuestion(db);
      migrateIdleRelease(db);
      migrateObservationGap(db);
      migrateMutationAttempt(db);
      migrateControlBinding(db);
      db.exec("COMMIT");

      assert.equal(schemaCurrentGoalProgress(db), true);
      assert.equal(schemaCurrentObservedCompletion(db), true);
      assert.equal(schemaCurrentObservedFinalAnswer(db), true);
      assert.equal(schemaCurrentAsyncQuestion(db), true);
      assert.equal(schemaCurrentIdleRelease(db), true);
      assert.equal(schemaCurrentObservationGap(db), true);
      assert.equal(schemaCurrentMutationAttempt(db), true);
      assert.equal(schemaCurrentControlBinding(db), true);
    } finally {
      db.close();
    }
  });
});

describe("schema-extensions-a: legacy column preservation and candidate null fences", () => {
  it("preserves existing goal_progress rows with null job_id during upgrade", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE codex_goal_progress (
          thread TEXT NOT NULL, turn TEXT NOT NULL, channel INTEGER NOT NULL,
          content TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '',
          PRIMARY KEY(thread,turn));`,
      );
      db.exec(
        "INSERT INTO codex_goal_progress(thread, turn, channel, content) VALUES('thread_legacy', 'turn_legacy', 42, 'saved_content')",
      );
      assert.equal(schemaCurrentGoalProgress(db), false);

      migrateGoalProgress(db);
      assert.equal(schemaCurrentGoalProgress(db), true);

      const row = db
        .prepare(
          "SELECT thread, turn, channel, content, last_error, job_id FROM codex_goal_progress WHERE thread='thread_legacy'",
        )
        .get() as Record<string, unknown>;
      assert.equal(row["thread"], "thread_legacy");
      assert.equal(row["turn"], "turn_legacy");
      assert.equal(row["content"], "saved_content");
      assert.equal(row["job_id"], null);
    } finally {
      db.close();
    }
  });

  it("preserves existing observed_completions rows with null resident_owner during upgrade", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(
        `CREATE TABLE codex_observed_completions (
          thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, generation INTEGER NOT NULL,
          payload TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '',
          PRIMARY KEY(thread_id, turn_id));`,
      );
      db.exec(
        "INSERT INTO codex_observed_completions(thread_id, turn_id, generation, payload) VALUES('t_comp', 'tu_comp', 7, 'done')",
      );
      assert.equal(schemaCurrentObservedCompletion(db), false);

      migrateObservedCompletion(db);
      assert.equal(schemaCurrentObservedCompletion(db), true);

      const row = db
        .prepare(
          "SELECT thread_id, turn_id, generation, payload, resident_owner FROM codex_observed_completions WHERE thread_id='t_comp'",
        )
        .get() as Record<string, unknown>;
      assert.equal(row["payload"], "done");
      assert.equal(row["resident_owner"], null);
    } finally {
      db.close();
    }
  });

  it("preserves null candidate columns and preparation_json without fabricating legacy authority", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE cdr_async_question_inbox (
        id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, generation INTEGER NOT NULL,
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
        candidate_job_id TEXT NOT NULL, candidate_channel_id INTEGER NOT NULL,
        candidate_owner_id INTEGER NOT NULL, body TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'waiting', created_at REAL NOT NULL);`);
      db.exec(`CREATE TABLE cdr_async_questions (
        id TEXT PRIMARY KEY, runtime_id TEXT NOT NULL, generation INTEGER NOT NULL,
        thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
        origin_job_id TEXT NOT NULL, channel_id INTEGER NOT NULL, owner_user_id INTEGER NOT NULL,
        body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'observed', message_id TEXT, chosen INTEGER,
        dispatch_mode TEXT, reply_job_id TEXT, accepted_turn_id TEXT, error TEXT NOT NULL DEFAULT '',
        owner_confirmed INTEGER NOT NULL DEFAULT 0,
        created_at REAL NOT NULL, updated_at REAL NOT NULL);`);

      db.exec(
        `INSERT INTO cdr_async_question_inbox(id, runtime_id, generation, thread_id, turn_id, item_id, candidate_job_id, candidate_channel_id, candidate_owner_id, body, created_at)
         VALUES('inbox_legacy', 'run1', 1, 'th1', 'tu1', 'item1', 'cjob1', 10, 20, 'prompt', 1.0)`,
      );
      db.exec(
        `INSERT INTO cdr_async_questions(id, runtime_id, generation, thread_id, turn_id, item_id, origin_job_id, channel_id, owner_user_id, body, created_at, updated_at)
         VALUES('q_legacy', 'run1', 1, 'th1', 'tu1', 'item1', 'orig1', 10, 20, 'prompt', 1.0, 1.0)`,
      );

      assert.equal(schemaCurrentAsyncQuestion(db), false);

      migrateAsyncQuestion(db);
      assert.equal(schemaCurrentAsyncQuestion(db), true);

      const inboxRow = db
        .prepare(
          "SELECT id, candidate_generation, candidate_execution_generation, candidate_attempt_count FROM cdr_async_question_inbox WHERE id='inbox_legacy'",
        )
        .get() as Record<string, unknown>;
      assert.equal(inboxRow["id"], "inbox_legacy");
      assert.equal(inboxRow["candidate_generation"], null);
      assert.equal(inboxRow["candidate_execution_generation"], null);
      assert.equal(inboxRow["candidate_attempt_count"], null);

      const questionRow = db
        .prepare("SELECT id, preparation_json FROM cdr_async_questions WHERE id='q_legacy'")
        .get() as Record<string, unknown>;
      assert.equal(questionRow["id"], "q_legacy");
      assert.equal(questionRow["preparation_json"], null);
    } finally {
      db.close();
    }
  });
});

describe("schema-extensions-a: missing/malformed guards matching Rust predicates", () => {
  it("evaluates schemaCurrentAsyncQuestion strictly per predicate terms", () => {
    const db = new DatabaseSync(":memory:");
    try {
      // Inbox only (table count != 2)
      db.exec(
        "CREATE TABLE cdr_async_question_inbox(id TEXT PRIMARY KEY, candidate_generation INT, candidate_execution_generation INT, candidate_attempt_count INT)",
      );
      assert.equal(schemaCurrentAsyncQuestion(db), false);

      // Add cdr_async_questions but omit preparation_json
      db.exec("CREATE TABLE cdr_async_questions(id TEXT PRIMARY KEY)");
      assert.equal(schemaCurrentAsyncQuestion(db), false);

      // Add preparation_json, but drop one candidate column
      db.exec("ALTER TABLE cdr_async_questions ADD COLUMN preparation_json TEXT");
      db.exec("DROP TABLE cdr_async_question_inbox");
      db.exec(
        "CREATE TABLE cdr_async_question_inbox(id TEXT PRIMARY KEY, candidate_generation INT, candidate_execution_generation INT)",
      );
      assert.equal(schemaCurrentAsyncQuestion(db), false);

      // Complete third candidate column
      db.exec("ALTER TABLE cdr_async_question_inbox ADD COLUMN candidate_attempt_count INT");
      assert.equal(schemaCurrentAsyncQuestion(db), true);
    } finally {
      db.close();
    }
  });

  it("evaluates schemaCurrentObservedCompletion on missing resident_owner or missing table", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE codex_observed_completions(thread_id TEXT, turn_id TEXT)");
      assert.equal(schemaCurrentObservedCompletion(db), false);
      db.exec("ALTER TABLE codex_observed_completions ADD COLUMN resident_owner TEXT");
      assert.equal(schemaCurrentObservedCompletion(db), true);
    } finally {
      db.close();
    }
  });

  it("evaluates schemaCurrentMutationAttempt on missing index, runtime_id, or request_sha256", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE codex_mutation_runtime(singleton INT, runtime_id TEXT)");
      db.exec("CREATE TABLE codex_mutation_attempts(attempt_id TEXT PRIMARY KEY, request_sha256 TEXT)");
      // Missing unique index
      assert.equal(schemaCurrentMutationAttempt(db), false);

      db.exec(
        "CREATE UNIQUE INDEX codex_mutation_prepared_target ON codex_mutation_attempts(attempt_id)",
      );
      assert.equal(schemaCurrentMutationAttempt(db), true);

      // Drop attempts and re-create without request_sha256
      db.exec("DROP TABLE codex_mutation_attempts");
      db.exec("CREATE TABLE codex_mutation_attempts(attempt_id TEXT PRIMARY KEY)");
      db.exec(
        "CREATE UNIQUE INDEX codex_mutation_prepared_target ON codex_mutation_attempts(attempt_id)",
      );
      assert.equal(schemaCurrentMutationAttempt(db), false);
    } finally {
      db.close();
    }
  });

  it("evaluates schemaCurrentControlBinding on missing trigger or missing table", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE codex_busy_control_bindings(choice_id TEXT PRIMARY KEY)");
      assert.equal(schemaCurrentControlBinding(db), false);

      db.exec("CREATE TABLE codex_turn_queue(job_id TEXT, turn_id TEXT, target_thread_id TEXT)");
      db.exec(
        `CREATE TRIGGER codex_bind_preparing_control
         AFTER UPDATE OF turn_id ON codex_turn_queue
         WHEN OLD.turn_id IS NULL AND NEW.turn_id IS NOT NULL
         BEGIN
           UPDATE codex_busy_control_bindings SET turn_id=NEW.turn_id WHERE choice_id='x';
         END;`,
      );
      assert.equal(schemaCurrentControlBinding(db), true);

      db.exec("DROP TABLE codex_busy_control_bindings");
      assert.equal(schemaCurrentControlBinding(db), false);
    } finally {
      db.close();
    }
  });

  it("evaluates schemaCurrentObservationGap column count and table count", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE cdr_observation_streams(owner_id TEXT, generation INT)");
      db.exec(
        "CREATE TABLE cdr_observation_gaps(gap_id INT, owner_id TEXT, generation INT, first_seq INT, last_seq INT, scan_cursor INT, revision INT, state TEXT)",
      );
      // Only 8 columns in gaps
      assert.equal(schemaCurrentObservationGap(db), false);

      db.exec("ALTER TABLE cdr_observation_gaps ADD COLUMN verified_json TEXT");
      assert.equal(schemaCurrentObservationGap(db), true);

      db.exec("DROP TABLE cdr_observation_streams");
      assert.equal(schemaCurrentObservationGap(db), false);
    } finally {
      db.close();
    }
  });
});

describe("schema-extensions-a: UNIQUE partial prepared target on mutation attempts", () => {
  it("enforces target uniqueness only when scoped=1 and state='prepared'", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateMutationAttempt(db);

      // Insert scoped prepared attempt for thread 'th_shared'
      db.exec(
        `INSERT INTO codex_mutation_attempts(
          attempt_id, runtime_id, owner_id, generation, wire_id, method,
          target_thread_id, scoped, request_sha256, state, created_at, updated_at
        ) VALUES ('att_1', 'r1', 'o1', 1, 'w1', 'm1', 'th_shared', 1, 'hash1', 'prepared', 1.0, 1.0)`,
      );

      // A second scoped prepared attempt for thread 'th_shared' must fail
      assert.throws(() => {
        db.exec(
          `INSERT INTO codex_mutation_attempts(
            attempt_id, runtime_id, owner_id, generation, wire_id, method,
            target_thread_id, scoped, request_sha256, state, created_at, updated_at
          ) VALUES ('att_2', 'r1', 'o1', 1, 'w2', 'm1', 'th_shared', 1, 'hash2', 'prepared', 2.0, 2.0)`,
        );
      });

      // Scoped prepared attempt on a DIFFERENT thread succeeds
      db.exec(
        `INSERT INTO codex_mutation_attempts(
          attempt_id, runtime_id, owner_id, generation, wire_id, method,
          target_thread_id, scoped, request_sha256, state, created_at, updated_at
        ) VALUES ('att_diff', 'r1', 'o1', 1, 'w3', 'm1', 'th_other', 1, 'hash3', 'prepared', 3.0, 3.0)`,
      );

      // Scoped non-prepared attempts on 'th_shared' succeed
      db.exec(
        `INSERT INTO codex_mutation_attempts(
          attempt_id, runtime_id, owner_id, generation, wire_id, method,
          target_thread_id, scoped, request_sha256, state, created_at, updated_at
        ) VALUES ('att_ok', 'r1', 'o1', 1, 'w4', 'm1', 'th_shared', 1, 'hash4', 'reply_ok', 4.0, 4.0)`,
      );
      db.exec(
        `INSERT INTO codex_mutation_attempts(
          attempt_id, runtime_id, owner_id, generation, wire_id, method,
          target_thread_id, scoped, request_sha256, state, created_at, updated_at
        ) VALUES ('att_not_sent', 'r1', 'o1', 1, 'w5', 'm1', 'th_shared', 1, 'hash5', 'not_sent', 5.0, 5.0)`,
      );

      // Multiple unscoped (scoped=0) prepared attempts succeed even without target_thread_id
      db.exec(
        `INSERT INTO codex_mutation_attempts(
          attempt_id, runtime_id, owner_id, generation, wire_id, method,
          target_thread_id, scoped, request_sha256, state, created_at, updated_at
        ) VALUES ('att_unscoped_1', 'r1', 'o1', 1, 'w6', 'm1', NULL, 0, 'hash6', 'prepared', 6.0, 6.0)`,
      );
      db.exec(
        `INSERT INTO codex_mutation_attempts(
          attempt_id, runtime_id, owner_id, generation, wire_id, method,
          target_thread_id, scoped, request_sha256, state, created_at, updated_at
        ) VALUES ('att_unscoped_2', 'r1', 'o1', 1, 'w7', 'm1', NULL, 0, 'hash7', 'prepared', 7.0, 7.0)`,
      );
    } finally {
      db.close();
    }
  });
});

describe("schema-extensions-a: CHECK constraints on mutation, idle release, and observation gaps", () => {
  it("enforces mutation_runtime singleton=1 constraint", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateMutationAttempt(db);
      db.exec("INSERT INTO codex_mutation_runtime(singleton, runtime_id) VALUES(1, 'r1')");
      assert.throws(() => {
        db.exec("INSERT INTO codex_mutation_runtime(singleton, runtime_id) VALUES(2, 'r2')");
      });
    } finally {
      db.close();
    }
  });

  it("enforces mutation_attempts scoped and state CHECK constraints", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateMutationAttempt(db);
      // scoped=1 with NULL target_thread_id evaluates CHECK constraint to NULL, which SQLite accepts; verify insert succeeds and retains NULL
      db.exec(
        `INSERT INTO codex_mutation_attempts(
          attempt_id, runtime_id, owner_id, generation, wire_id, method,
          target_thread_id, scoped, request_sha256, state, created_at, updated_at
        ) VALUES ('a_bad_scope', 'r1', 'o1', 1, 'w1', 'm1', NULL, 1, 'hash', 'prepared', 1.0, 1.0)`,
      );
      const row = db
        .prepare("SELECT target_thread_id FROM codex_mutation_attempts WHERE attempt_id='a_bad_scope'")
        .get() as { target_thread_id: string | null };
      assert.equal(row.target_thread_id, null);
      assert.throws(() => {
        db.exec(
          `INSERT INTO codex_mutation_attempts(
            attempt_id, runtime_id, owner_id, generation, wire_id, method,
            target_thread_id, scoped, request_sha256, state, created_at, updated_at
          ) VALUES ('a_empty_thread', 'r1', 'o1', 1, 'w1', 'm1', '', 1, 'hash', 'prepared', 1.0, 1.0)`,
        );
      });
      // invalid state
      assert.throws(() => {
        db.exec(
          `INSERT INTO codex_mutation_attempts(
            attempt_id, runtime_id, owner_id, generation, wire_id, method,
            target_thread_id, scoped, request_sha256, state, created_at, updated_at
          ) VALUES ('a_bad_state', 'r1', 'o1', 1, 'w1', 'm1', 'th1', 1, 'hash', 'executing', 1.0, 1.0)`,
        );
      });
    } finally {
      db.close();
    }
  });

  it("enforces idle release state CHECK constraints", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateIdleRelease(db);
      // Valid state
      db.exec(
        `INSERT INTO cdr_idle_release(
          intent_id, owner_id, generation, thread_id, turn_id, job_id, revision, state, detail
        ) VALUES ('i1', 'o1', 1, 'th1', 'tu1', 'j1', 1, 'Candidate', '')`,
      );
      // Invalid state
      assert.throws(() => {
        db.exec(
          `INSERT INTO cdr_idle_release(
            intent_id, owner_id, generation, thread_id, turn_id, job_id, revision, state, detail
          ) VALUES ('i2', 'o1', 1, 'th2', 'tu1', 'j1', 1, 'Dispatched_Invalid', '')`,
        );
      });
    } finally {
      db.close();
    }
  });

  it("enforces observation gap bounds and state CHECK constraints", () => {
    const db = new DatabaseSync(":memory:");
    try {
      migrateObservationGap(db);
      // first_seq < 0
      assert.throws(() => {
        db.exec(
          `INSERT INTO cdr_observation_gaps(
            owner_id, generation, first_seq, last_seq, scan_cursor, revision, state
          ) VALUES ('o1', 1, -1, 10, 0, 0, 'Open')`,
        );
      });
      // last_seq < first_seq
      assert.throws(() => {
        db.exec(
          `INSERT INTO cdr_observation_gaps(
            owner_id, generation, first_seq, last_seq, scan_cursor, revision, state
          ) VALUES ('o1', 1, 10, 5, 9, 0, 'Open')`,
        );
      });
      // scan_cursor < first_seq - 1
      assert.throws(() => {
        db.exec(
          `INSERT INTO cdr_observation_gaps(
            owner_id, generation, first_seq, last_seq, scan_cursor, revision, state
          ) VALUES ('o1', 1, 10, 20, 8, 0, 'Open')`,
        );
      });
      // scan_cursor > last_seq
      assert.throws(() => {
        db.exec(
          `INSERT INTO cdr_observation_gaps(
            owner_id, generation, first_seq, last_seq, scan_cursor, revision, state
          ) VALUES ('o1', 1, 10, 20, 21, 0, 'Open')`,
        );
      });
      // Valid boundaries: scan_cursor == first_seq - 1
      db.exec(
        `INSERT INTO cdr_observation_gaps(
          owner_id, generation, first_seq, last_seq, scan_cursor, revision, state
        ) VALUES ('o1', 1, 10, 20, 9, 0, 'Open')`,
      );
      // Valid boundaries: scan_cursor == last_seq
      db.exec(
        `INSERT INTO cdr_observation_gaps(
          owner_id, generation, first_seq, last_seq, scan_cursor, revision, state
        ) VALUES ('o1', 1, 21, 30, 30, 0, 'Verified')`,
      );
      // first_seq=0 partial unique index (only one first_seq=0 per owner/generation)
      db.exec(
        `INSERT INTO cdr_observation_gaps(
          owner_id, generation, first_seq, last_seq, scan_cursor, revision, state
        ) VALUES ('o2', 1, 0, 0, 0, 0, 'Unresolved')`,
      );
      assert.throws(() => {
        db.exec(
          `INSERT INTO cdr_observation_gaps(
            owner_id, generation, first_seq, last_seq, scan_cursor, revision, state
          ) VALUES ('o2', 1, 0, 5, 0, 0, 'Open')`,
        );
      });
    } finally {
      db.close();
    }
  });
});

describe("schema-extensions-a: control binding trigger on minimal turn queue fixture", () => {
  it("binds preparing control only for exact original job and thread when transition is NULL to non-NULL", () => {
    const db = new DatabaseSync(":memory:");
    try {
      // Test-owned minimal codex_turn_queue fixture
      db.exec(
        `CREATE TABLE codex_turn_queue (
          job_id TEXT PRIMARY KEY,
          target_thread_id TEXT NOT NULL,
          turn_id TEXT
        );`,
      );

      migrateControlBinding(db);
      assert.equal(schemaCurrentControlBinding(db), true);

      // Insert candidate control bindings with turn_id IS NULL
      db.exec(
        `INSERT INTO codex_busy_control_bindings(choice_id, thread_id, turn_id, job_id) VALUES
          ('choice_target', 'thread_a', NULL, 'job_exact'),
          ('choice_wrong_job', 'thread_a', NULL, 'job_other'),
          ('choice_wrong_thread', 'thread_b', NULL, 'job_exact'),
          ('choice_already_bound', 'thread_a', 'preexisting_turn', 'job_exact');`,
      );

      // Insert initial turn queue rows
      db.exec(
        `INSERT INTO codex_turn_queue(job_id, target_thread_id, turn_id) VALUES
          ('job_exact', 'thread_a', NULL),
          ('job_other', 'thread_a', NULL),
          ('job_nonnull_init', 'thread_a', 'turn_initial');`,
      );

      // 1. Non-NULL to non-NULL transition: must NOT fire trigger
      db.exec("UPDATE codex_turn_queue SET turn_id='turn_updated' WHERE job_id='job_nonnull_init'");
      const checkNonnull = db
        .prepare("SELECT turn_id FROM codex_busy_control_bindings WHERE choice_id='choice_target'")
        .get() as { turn_id: string | null };
      assert.equal(checkNonnull.turn_id, null);

      // 2. NULL to NULL update: must NOT fire trigger
      db.exec("UPDATE codex_turn_queue SET turn_id=NULL WHERE job_id='job_exact'");
      const checkNullNull = db
        .prepare("SELECT turn_id FROM codex_busy_control_bindings WHERE choice_id='choice_target'")
        .get() as { turn_id: string | null };
      assert.equal(checkNullNull.turn_id, null);

      // 3. Update job_other to turn: matches thread_a but job is job_other, not job_exact
      db.exec("UPDATE codex_turn_queue SET turn_id='turn_for_other' WHERE job_id='job_other'");
      const checkWrongJob = db
        .prepare("SELECT turn_id FROM codex_busy_control_bindings WHERE choice_id='choice_target'")
        .get() as { turn_id: string | null };
      assert.equal(checkWrongJob.turn_id, null);

      const checkBoundWrongJob = db
        .prepare("SELECT turn_id FROM codex_busy_control_bindings WHERE choice_id='choice_wrong_job'")
        .get() as { turn_id: string | null };
      assert.equal(checkBoundWrongJob.turn_id, "turn_for_other");

      // 4. Exact NULL to non-NULL update for job_exact on thread_a
      db.exec("UPDATE codex_turn_queue SET turn_id='turn_target_assigned' WHERE job_id='job_exact'");

      // choice_target MUST be updated
      const targetRow = db
        .prepare("SELECT turn_id FROM codex_busy_control_bindings WHERE choice_id='choice_target'")
        .get() as { turn_id: string | null };
      assert.equal(targetRow.turn_id, "turn_target_assigned");

      // choice_wrong_thread MUST NOT be updated
      const wrongThreadRow = db
        .prepare("SELECT turn_id FROM codex_busy_control_bindings WHERE choice_id='choice_wrong_thread'")
        .get() as { turn_id: string | null };
      assert.equal(wrongThreadRow.turn_id, null);

      // choice_already_bound MUST retain its original turn
      const alreadyBoundRow = db
        .prepare("SELECT turn_id FROM codex_busy_control_bindings WHERE choice_id='choice_already_bound'")
        .get() as { turn_id: string | null };
      assert.equal(alreadyBoundRow.turn_id, "preexisting_turn");
    } finally {
      db.close();
    }
  });
});
