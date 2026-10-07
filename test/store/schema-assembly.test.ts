import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  LATEST_STORE_SCHEMA_VERSION,
  StoreIntegrityError,
  UnsupportedVersionError,
  assertStoreIntegrity,
  migrateSchemaExtensions,
  migrateSchemaVersion,
  schemaExtensionsCurrent,
  schemaVersion,
} from "../../src/store/schema-assembly.ts";

const openDatabases: DatabaseSync[] = [];

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:", {
    enableForeignKeyConstraints: false,
  });
  openDatabases.push(db);
  return db;
}

afterEach(() => {
  while (openDatabases.length > 0) {
    const db = openDatabases.pop();
    if (db) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
  }
});

function getCatalogSignature(db: DatabaseSync): {
  userVersion: bigint;
  rows: Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>;
} {
  const userVersion = schemaVersion(db);
  const rows = db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name, tbl_name",
  ).all() as Array<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>;
  return { userVersion, rows };
}

function serializeCatalogSignature(signature: ReturnType<typeof getCatalogSignature>): string {
  return JSON.stringify(signature, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

function migrateFully(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  migrateSchemaVersion(db, 1n);
  migrateSchemaVersion(db, 2n);
  migrateSchemaExtensions(db);
  db.exec("PRAGMA user_version = 2");
  db.exec("COMMIT");
}

describe("schema-assembly integration", () => {
  it("reports schemaExtensionsCurrent false for blank database and user_version alone without tables", () => {
    const db = createTestDb();
    assert.equal(schemaVersion(db), 0n);
    assert.equal(schemaExtensionsCurrent(db), false);

    db.exec("PRAGMA user_version = 2");
    assert.equal(schemaVersion(db), 2n);
    assert.equal(schemaExtensionsCurrent(db), false);
  });

  it("migrates v1 -> v2 -> extensions under caller BEGIN IMMEDIATE, sets version 2, and validates integrity", () => {
    const db = createTestDb();

    db.exec("BEGIN IMMEDIATE");
    migrateSchemaVersion(db, 1n);
    migrateSchemaVersion(db, 2n);
    migrateSchemaExtensions(db);
    db.exec("PRAGMA user_version = 2");
    assertStoreIntegrity(db);
    db.exec("COMMIT");

    assert.equal(schemaVersion(db), LATEST_STORE_SCHEMA_VERSION);
    assert.equal(schemaVersion(db), 2n);
    assert.equal(schemaExtensionsCurrent(db), true);
    assert.doesNotThrow(() => assertStoreIntegrity(db));
  });

  it("preserves identical sqlite_schema signature including null autoindexes and user_version after repeating extensions", () => {
    const db = createTestDb();
    migrateFully(db);

    const signatureBefore = getCatalogSignature(db);
    assert.equal(signatureBefore.userVersion, 2n);
    assert.ok(signatureBefore.rows.length > 0);

    // Verify presence of null-sql autoindexes alongside tables/triggers/views
    const hasAutoindexes = signatureBefore.rows.some(
      (row) => row.name.startsWith("sqlite_autoindex_") && row.sql === null,
    );
    assert.equal(hasAutoindexes, true);

    db.exec("BEGIN IMMEDIATE");
    migrateSchemaExtensions(db);
    db.exec("COMMIT");

    const signatureAfter = getCatalogSignature(db);
    assert.deepEqual(signatureAfter, signatureBefore);
    assert.equal(schemaExtensionsCurrent(db), true);
  });

  it("preserves preceding tables and removes new extension objects and user_version on caller ROLLBACK", () => {
    const db = createTestDb();

    db.exec("BEGIN IMMEDIATE");
    migrateSchemaVersion(db, 1n);
    db.exec("PRAGMA user_version = 1");
    db.exec("CREATE TABLE preceding_marker (id INTEGER PRIMARY KEY, note TEXT NOT NULL)");
    db.exec("INSERT INTO preceding_marker (id, note) VALUES (1, 'initial')");
    db.exec("COMMIT");

    assert.equal(schemaVersion(db), 1n);

    const catalogBefore = getCatalogSignature(db);

    db.exec("BEGIN IMMEDIATE");
    migrateSchemaVersion(db, 2n);
    migrateSchemaExtensions(db);
    db.exec("PRAGMA user_version = 2");
    db.exec("ROLLBACK");

    const catalogAfter = getCatalogSignature(db);
    assert.deepEqual(catalogAfter, catalogBefore);

    assert.equal(schemaVersion(db), 1n);
    assert.equal(schemaExtensionsCurrent(db), false);

    const markerRow = db.prepare("SELECT note FROM preceding_marker WHERE id = 1").get() as {
      note: string;
    };
    assert.equal(markerRow.note, "initial");

    const outboxExists = db.prepare(
      "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'codex_delivery_outbox')",
    ).get();
    assert.equal(Object.values(outboxExists as Record<string, unknown>)[0], 0);

    const queueCols = (db.prepare("PRAGMA table_info(codex_turn_queue)").all() as Array<{
      name: string;
    }>).map((col) => col.name);
    assert.equal(queueCols.includes("app_server_generation"), false);
    assert.equal(queueCols.includes("goal_waiting"), false);
  });

  it("throws UnsupportedVersionError with exact found, supported, and message for invalid versions", () => {
    const db = createTestDb();

    for (const invalidVersion of [3n, 0n, -1n]) {
      assert.throws(
        () => migrateSchemaVersion(db, invalidVersion),
        (err: unknown) => {
          assert.ok(err instanceof UnsupportedVersionError);
          assert.equal(err.name, "UnsupportedVersionError");
          assert.equal(err.kind, "UnsupportedVersion");
          assert.equal(err.found, invalidVersion);
          assert.equal(err.supported, LATEST_STORE_SCHEMA_VERSION);
          assert.equal(
            err.message,
            `store schema version ${invalidVersion} is newer than supported version ${LATEST_STORE_SCHEMA_VERSION}`,
          );
          return true;
        },
      );
    }
  });

  it("preserves legacy v1 queue fields, >2^53 bigint discord id, fractional timestamps, and defaults nullable generations to null", () => {
    const db = createTestDb();
    migrateSchemaVersion(db, 1n);

    const legacyDiscordMessageId = 9007199254740997n; // > 2^53
    const legacyChannelId = 9007199254740995n;
    const legacyOwnerId = 9007199254740996n;
    const legacyCreatedAt = 1712000000.125;
    const legacyUpdatedAt = 1712000000.875;

    db.prepare(`
      INSERT INTO codex_turn_queue (
        job_id, target_thread_id, channel_id, owner_user_id,
        discord_message_id, prompt, queued, ack_sent,
        state, attempt_count, turn_id, baseline_turn_ids,
        last_error, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?
      )
    `).run(
      "job_v1_legacy_001",
      "thread_legacy_001",
      legacyChannelId,
      legacyOwnerId,
      legacyDiscordMessageId,
      "legacy turn prompt",
      1,
      0,
      "queued",
      0,
      null,
      "[]",
      "",
      legacyCreatedAt,
      legacyUpdatedAt,
    );

    db.prepare(
      "INSERT INTO discord_processed_messages (message_id, seen_at) VALUES (?, ?)",
    ).run(legacyDiscordMessageId, legacyCreatedAt);

    migrateSchemaVersion(db, 2n);
    migrateSchemaExtensions(db);

    const queueStmt = db.prepare("SELECT * FROM codex_turn_queue WHERE job_id = ?");
    queueStmt.setReadBigInts(true);
    const queueRow = queueStmt.get("job_v1_legacy_001") as Record<string, unknown>;

    assert.equal(queueRow.job_id, "job_v1_legacy_001");
    assert.equal(queueRow.target_thread_id, "thread_legacy_001");
    assert.equal(queueRow.channel_id, legacyChannelId);
    assert.equal(queueRow.owner_user_id, legacyOwnerId);
    assert.equal(queueRow.discord_message_id, legacyDiscordMessageId);
    assert.equal(queueRow.prompt, "legacy turn prompt");
    assert.equal(queueRow.queued, 1n);
    assert.equal(queueRow.ack_sent, 0n);
    assert.equal(queueRow.state, "queued");
    assert.equal(queueRow.attempt_count, 0n);
    assert.equal(queueRow.turn_id, null);
    assert.equal(queueRow.baseline_turn_ids, "[]");
    assert.equal(queueRow.last_error, "");
    assert.equal(queueRow.created_at, legacyCreatedAt);
    assert.equal(queueRow.updated_at, legacyUpdatedAt);
    assert.equal(queueRow.app_server_generation, 0n);
    assert.equal(queueRow.goal_waiting, 0n);
    assert.equal(queueRow.execution_generation, null);
    assert.equal(queueRow.turn_observation_generation, null);

    const processedStmt = db.prepare(
      "SELECT * FROM discord_processed_messages WHERE message_id = ?",
    );
    processedStmt.setReadBigInts(true);
    const processedRow = processedStmt.get(legacyDiscordMessageId) as Record<string, unknown>;
    assert.equal(processedRow.message_id, legacyDiscordMessageId);
    assert.equal(processedRow.seen_at, legacyCreatedAt);
  });

  it("reports current false after dropping an extension trigger and repairs it on repeat migrateSchemaExtensions", () => {
    const db = createTestDb();
    migrateFully(db);
    assert.equal(schemaExtensionsCurrent(db), true);

    const triggerToDrop = "cdr_archived_cleanup_evidence_no_update";
    const existing = db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
    ).get(triggerToDrop);
    assert.ok(existing, `expected repairable trigger ${triggerToDrop} to exist`);

    db.exec(`DROP TRIGGER ${triggerToDrop}`);
    assert.equal(schemaExtensionsCurrent(db), false);

    // Repeat extensions migration repairs the dropped trigger
    migrateSchemaExtensions(db);
    assert.equal(schemaExtensionsCurrent(db), true);

    const restoredTrigger = db.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'trigger' AND name = ?",
    ).get(triggerToDrop);
    assert.ok(restoredTrigger);
  });

  it("rolls back all DDL cleanly when mid-pipeline failure occurs due to conflicting schema or missing columns", () => {
    const db = createTestDb();

    db.exec("BEGIN IMMEDIATE");
    migrateSchemaVersion(db, 1n);
    db.exec("PRAGMA user_version = 1");
    db.exec("COMMIT");

    // Pre-create an incompatible view to cause conflict when migrateDeliveryOutbox executes
    db.exec("CREATE VIEW codex_delivery_outbox AS SELECT 1 AS dummy");

    const catalogBefore = getCatalogSignature(db);

    db.exec("BEGIN IMMEDIATE");
    assert.throws(() => {
      migrateSchemaExtensions(db);
    });
    db.exec("ROLLBACK");

    // Post-rollback state verification
    const catalogAfter = getCatalogSignature(db);
    assert.deepEqual(catalogAfter, catalogBefore);

    assert.equal(schemaVersion(db), 1n);
    assert.equal(schemaExtensionsCurrent(db), false);

    // Clean up the conflict view and verify normal migration completes
    db.exec("DROP VIEW codex_delivery_outbox");
    db.exec("BEGIN IMMEDIATE");
    migrateSchemaVersion(db, 2n);
    migrateSchemaExtensions(db);
    db.exec("PRAGMA user_version = 2");
    db.exec("COMMIT");

    assert.equal(schemaVersion(db), 2n);
    assert.equal(schemaExtensionsCurrent(db), true);
  });

  it("confirms snapshot catalog proof and verifies no fabricated ownership claim in claims tables", () => {
    const db = createTestDb();

    const unmigratedSignature = getCatalogSignature(db);
    const unmigratedSnapshot = serializeCatalogSignature(unmigratedSignature);
    assert.equal(schemaExtensionsCurrent(db), false);
    assert.equal(schemaVersion(db), 0n);

    migrateFully(db);

    const migratedSignature = getCatalogSignature(db);
    const migratedSnapshot = serializeCatalogSignature(migratedSignature);
    assert.notEqual(migratedSnapshot, unmigratedSnapshot);
    assert.notDeepEqual(migratedSignature, unmigratedSignature);
    assert.equal(migratedSignature.userVersion, 2n);
    assert.equal(schemaExtensionsCurrent(db), true);

    // Assert no ownership claims exist in claim records using accurate persistent_component_claims from V1 assembly authority
    const countClaimStmt = db.prepare(
      "SELECT COUNT(*) AS cnt FROM persistent_component_claims",
    );
    countClaimStmt.setReadBigInts(true);
    const countClaim = countClaimStmt.get() as { cnt: bigint | number };
    assert.equal(Number(countClaim.cnt), 0);

    const allTables = db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table'",
    ).all() as Array<{ name: string }>;
    const claimTables = allTables.filter((t) => t.name.includes("claim"));
    for (const claimTable of claimTables) {
      const rowCountStmt = db.prepare(`SELECT COUNT(*) AS cnt FROM ${claimTable.name}`);
      rowCountStmt.setReadBigInts(true);
      const rowCount = rowCountStmt.get() as { cnt: bigint | number };
      assert.equal(Number(rowCount.cnt), 0);
    }
  });

  it("aborts literal INSERT OR REPLACE against existing admission event preserving row bytes and sequence", () => {
    const db = createTestDb();
    migrateFully(db);

    const initialSequence = 1n;
    const initialIngressId = "admission-a";
    const initialKind = "message";
    const initialEventId = 9007199254740993n;
    const initialOrigin = "admitted";
    const initialHash = "a".repeat(64);
    const replacementHash = "b".repeat(64);

    db.prepare(`
      INSERT INTO cdr_recovery_ingress_order (
        sequence, ingress_id, kind, event_id, origin, identity_sha256
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      initialSequence,
      initialIngressId,
      initialKind,
      initialEventId,
      initialOrigin,
      initialHash,
    );

    const selectStmt = db.prepare(
      "SELECT sequence, ingress_id, kind, event_id, origin, identity_sha256 FROM cdr_recovery_ingress_order WHERE sequence = ?",
    );
    selectStmt.setReadBigInts(true);
    const beforeRow = selectStmt.get(initialSequence) as {
      sequence: bigint;
      ingress_id: string;
      kind: string;
      event_id: bigint;
      origin: string;
      identity_sha256: string;
    };

    assert.equal(beforeRow.sequence, initialSequence);
    assert.equal(beforeRow.ingress_id, initialIngressId);
    assert.equal(beforeRow.kind, initialKind);
    assert.equal(beforeRow.event_id, initialEventId);
    assert.equal(beforeRow.origin, initialOrigin);
    assert.equal(beforeRow.identity_sha256, initialHash);

    // Literal INSERT OR REPLACE with SAME primary identity and altered VALID hash must throw first-admission guard
    assert.throws(
      () => {
        db.prepare(`
          INSERT OR REPLACE INTO cdr_recovery_ingress_order (
            sequence, ingress_id, kind, event_id, origin, identity_sha256
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          initialSequence,
          initialIngressId,
          initialKind,
          initialEventId,
          initialOrigin,
          replacementHash,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(
          err.message,
          /an old ingress cannot acquire a new admission order|first admission order is immutable/,
        );
        return true;
      },
    );

    const afterRow = selectStmt.get(initialSequence);
    assert.deepEqual(afterRow, beforeRow);
  });

  it("rejects plain duplicate INSERT in room cleanup evidence with PK failure and preserves original row", () => {
    const db = createTestDb();
    migrateFully(db);

    const token = "cleanup-token-001";
    const ingressId = "ingress-cleanup-001";
    const channelId = 9007199254740995n;
    const targetThreadId = "thread-clean-001";
    const initialPayloadJson = JSON.stringify({ action: "cleanup", active: true });
    const changedPayloadJson = JSON.stringify({ action: "cleanup", active: false, altered: true });
    const outcomeJson = JSON.stringify({ result: "archived" });
    const rowSnapshotJson = JSON.stringify({ snapshot_version: 1 });
    const archiveJson = JSON.stringify({ status: "done" });
    const createdAt = 1712000000.5;

    db.prepare(`
      INSERT INTO cdr_archived_cleanup_evidence (
        token, channel_id, target_thread_id, ingress_id,
        payload_json, outcome_json, row_snapshot_json, archive_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      token,
      channelId,
      targetThreadId,
      ingressId,
      initialPayloadJson,
      outcomeJson,
      rowSnapshotJson,
      archiveJson,
      createdAt,
    );

    const selectStmt = db.prepare(`
      SELECT token, channel_id, target_thread_id, ingress_id, payload_json, outcome_json, row_snapshot_json, archive_json, created_at
      FROM cdr_archived_cleanup_evidence
      WHERE token = ? AND ingress_id = ?
    `);
    selectStmt.setReadBigInts(true);
    const beforeRow = selectStmt.get(token, ingressId) as {
      token: string;
      channel_id: bigint;
      target_thread_id: string;
      ingress_id: string;
      payload_json: string;
      outcome_json: string;
      row_snapshot_json: string;
      archive_json: string;
      created_at: number;
    };

    assert.equal(beforeRow.token, token);
    assert.equal(beforeRow.ingress_id, ingressId);
    assert.equal(beforeRow.payload_json, initialPayloadJson);

    // Plain duplicate INSERT (SAME token, ingress_id) with altered valid JSON payload_json must fail UNIQUE/PK
    assert.throws(
      () => {
        db.prepare(`
          INSERT INTO cdr_archived_cleanup_evidence (
            token, channel_id, target_thread_id, ingress_id,
            payload_json, outcome_json, row_snapshot_json, archive_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          token,
          channelId,
          targetThreadId,
          ingressId,
          changedPayloadJson,
          outcomeJson,
          rowSnapshotJson,
          archiveJson,
          createdAt,
        );
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /UNIQUE constraint failed|PRIMARY KEY/i);
        return true;
      },
    );

    const afterRow = selectStmt.get(token, ingressId);
    assert.deepEqual(afterRow, beforeRow);
  });

  it("conforms to StoreIntegrityError and UnsupportedVersionError prototype contracts", () => {
    const integrityErr = new StoreIntegrityError("tree hash mismatch");
    assert.ok(integrityErr instanceof Error);
    assert.ok(integrityErr instanceof StoreIntegrityError);
    assert.equal(integrityErr.name, "StoreIntegrityError");
    assert.equal(integrityErr.kind, "Integrity");
    assert.equal(integrityErr.result, "tree hash mismatch");
    assert.equal(integrityErr.message, "SQLite integrity check failed: tree hash mismatch");

    const unsupportedErr = new UnsupportedVersionError(5n, 2n);
    assert.ok(unsupportedErr instanceof Error);
    assert.ok(unsupportedErr instanceof UnsupportedVersionError);
    assert.equal(unsupportedErr.name, "UnsupportedVersionError");
    assert.equal(unsupportedErr.kind, "UnsupportedVersion");
    assert.equal(unsupportedErr.found, 5n);
    assert.equal(unsupportedErr.supported, 2n);
    assert.equal(
      unsupportedErr.message,
      "store schema version 5 is newer than supported version 2",
    );
  });
});
