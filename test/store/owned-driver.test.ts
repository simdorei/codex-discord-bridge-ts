import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ActiveTransactionError,
  CheckedRead,
  initialize,
  openInitialized,
} from "../../src/store/owned-driver.ts";
import {
  LATEST_STORE_SCHEMA_VERSION,
  StoreIntegrityError,
  UnsupportedVersionError,
  assertStoreIntegrity,
  migrateSchemaVersion,
  schemaExtensionsCurrent,
  schemaVersion,
} from "../../src/store/schema-assembly.ts";
import {
  getCatalogSignature,
} from "../../src/store/catalog-cache.ts";

describe("owned driver store lifecycle and concurrency", () => {
  let tempDir: string;
  const trackedDbs: DatabaseSync[] = [];
  const trackedReads: CheckedRead[] = [];
  const trackedDirs: string[] = [];

  function trackDb(db: DatabaseSync): DatabaseSync {
    trackedDbs.push(db);
    return db;
  }

  function openRead(path: string): CheckedRead {
    const handle = CheckedRead.open(path);
    trackedReads.push(handle);
    return handle;
  }

  function hasIndex(db: DatabaseSync, indexName: string): boolean {
    const stmt = db.prepare(
      "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE type = 'index' AND name = ?)",
    );
    const row = stmt.get(indexName) as Record<string, unknown> | undefined;
    return row ? Number(Object.values(row)[0]) === 1 : false;
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cdr-ts-owned-driver-"));
    trackedDirs.push(tempDir);
  });

  afterEach(() => {
    for (const read of trackedReads) {
      try {
        read.close();
      } catch {
        // ignore already-closed errors during cleanup
      }
    }
    trackedReads.length = 0;

    for (const db of trackedDbs) {
      try {
        db.close();
      } catch {
        // ignore already-closed errors during cleanup
      }
    }
    trackedDbs.length = 0;

    const baseTmpDir = resolve(tmpdir());
    for (const dir of trackedDirs) {
      const resolvedDir = resolve(dir);
      assert(
        dirname(resolvedDir) === baseTmpDir &&
          parse(resolvedDir).base.startsWith("cdr-ts-owned-driver-"),
        `Cleaned directory must be an exact mkdtemp owned root: ${resolvedDir}`,
      );
      rmSync(resolvedDir, { recursive: true, force: true });
    }
    trackedDirs.length = 0;
  });

  it("fresh openInitialized creates full current version 2 schema and passes integrity, caller closes", async () => {
    const dbPath = join(tempDir, "fresh.sqlite");
    const db = trackDb(await openInitialized(dbPath));

    assert.strictEqual(schemaVersion(db), LATEST_STORE_SCHEMA_VERSION);
    assert.strictEqual(schemaExtensionsCurrent(db), true);
    assert.doesNotThrow(() => assertStoreIntegrity(db));

    const tableStmt = db.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('codex_turn_queue', 'codex_delivery_outbox', 'mirror_projects') ORDER BY name",
    );
    const tables = (tableStmt.all() as Array<{ name: string }>).map((r) => r.name);
    assert.deepStrictEqual(tables, ["codex_delivery_outbox", "codex_turn_queue", "mirror_projects"]);

    db.close();

    const driverModule = await import("../../src/store/owned-driver.ts");
    assert.strictEqual("PROCESS_CATALOG_CACHE" in driverModule, false);
  });

  it("CheckedRead rejects missing file and file remains absent", () => {
    const missingPath = join(tempDir, "missing-file.sqlite");
    assert.strictEqual(existsSync(missingPath), false);

    assert.throws(
      () => openRead(missingPath),
      (err: unknown) => {
        assert(err instanceof Error);
        return true;
      },
    );

    assert.strictEqual(existsSync(missingPath), false);
  });

  it("CheckedRead rejects version 1 with UnsupportedVersionError without creating backup or modifying schema", () => {
    const v1Path = join(tempDir, "v1-readonly.sqlite");
    const initDb = trackDb(
      new DatabaseSync(v1Path, { timeout: 5000, enableForeignKeyConstraints: false }),
    );
    migrateSchemaVersion(initDb, 1n);
    initDb.exec("PRAGMA user_version = 1;");
    const sigBefore = getCatalogSignature(initDb);
    initDb.close();

    const backupDir = join(tempDir, ".codex-discord-backups");
    assert.strictEqual(existsSync(backupDir), false);

    assert.throws(
      () => openRead(v1Path),
      (err: unknown) => {
        assert(err instanceof UnsupportedVersionError);
        assert.strictEqual(err.found, 1n);
        assert.strictEqual(err.supported, LATEST_STORE_SCHEMA_VERSION);
        return true;
      },
    );

    assert.strictEqual(existsSync(backupDir), false);

    const checkDb = trackDb(
      new DatabaseSync(v1Path, { timeout: 5000, enableForeignKeyConstraints: false }),
    );
    assert.strictEqual(schemaVersion(checkDb), 1n);
    assert.strictEqual(getCatalogSignature(checkDb), sigBefore);
    checkDb.close();
  });

  it("CheckedRead rejects version 2 incomplete schema with StoreIntegrityError without attempting repair", () => {
    const incompletePath = join(tempDir, "v2-incomplete.sqlite");
    const initDb = trackDb(
      new DatabaseSync(incompletePath, { timeout: 5000, enableForeignKeyConstraints: false }),
    );
    migrateSchemaVersion(initDb, 1n);
    initDb.exec("PRAGMA user_version = 2;");
    assert.strictEqual(schemaExtensionsCurrent(initDb), false);
    const sigBefore = getCatalogSignature(initDb);
    initDb.close();

    assert.throws(
      () => openRead(incompletePath),
      (err: unknown) => {
        assert(err instanceof StoreIntegrityError);
        assert.strictEqual(
          err.result,
          "metadata discovery requires an initialized current schema; no repair attempted",
        );
        return true;
      },
    );

    const checkDb = trackDb(
      new DatabaseSync(incompletePath, { timeout: 5000, enableForeignKeyConstraints: false }),
    );
    assert.strictEqual(schemaVersion(checkDb), 2n);
    assert.strictEqual(schemaExtensionsCurrent(checkDb), false);
    assert.strictEqual(getCatalogSignature(checkDb), sigBefore);
    checkDb.close();
  });

  it("initialize creates native backup of v1 DB preserving uncheckpointed WAL row with large integer and fractional values", async () => {
    const mainDbPath = join(tempDir, "store-v1-wal.sqlite");
    const db = trackDb(
      new DatabaseSync(mainDbPath, { timeout: 5000, enableForeignKeyConstraints: false }),
    );
    db.exec("PRAGMA journal_mode = WAL;");
    migrateSchemaVersion(db, 1n);
    db.exec("PRAGMA user_version = 1;");
    db.exec("PRAGMA wal_checkpoint(PASSIVE);");
    assert(statSync(mainDbPath).size > 0);

    const largeId = 9007199254740993n;
    const fractionalTime = 1700000000.125;
    const insertStmt = db.prepare(
      "INSERT INTO discord_processed_messages (message_id, seen_at) VALUES (?, ?)",
    );
    insertStmt.run(largeId, fractionalTime);

    const walPath = `${mainDbPath}-wal`;
    assert(existsSync(walPath));
    assert(statSync(walPath).size > 0);

    const backupPath = await initialize(db, mainDbPath);
    assert.notStrictEqual(backupPath, null);

    const resolvedBackupPath = resolve(backupPath!);
    const expectedBackupDir = resolve(join(tempDir, ".codex-discord-backups"));
    assert.strictEqual(dirname(resolvedBackupPath), expectedBackupDir);

    const backupFilename = parse(resolvedBackupPath).base;
    const filenamePattern = /^store-v1-wal\.v1-to-v2\.\d{8}T\d{6}Z\.[0-9a-f]{12}\.sqlite$/;
    assert(
      filenamePattern.test(backupFilename),
      `Backup filename "${backupFilename}" did not match pattern ${filenamePattern}`,
    );

    const backupDb = trackDb(
      new DatabaseSync(resolvedBackupPath, {
        timeout: 5000,
        enableForeignKeyConstraints: false,
      }),
    );
    assert.strictEqual(schemaVersion(backupDb), 1n);
    assert.doesNotThrow(() => assertStoreIntegrity(backupDb));

    const backupStmt = backupDb.prepare(
      "SELECT message_id, seen_at FROM discord_processed_messages WHERE message_id = ?",
    );
    backupStmt.setReadBigInts(true);
    const backupRow = backupStmt.get(largeId) as
      | { message_id: bigint; seen_at: number }
      | undefined;
    assert(backupRow);
    assert.strictEqual(backupRow.message_id, largeId);
    assert.strictEqual(backupRow.seen_at, fractionalTime);
    backupDb.close();

    assert.strictEqual(schemaVersion(db), 2n);
    assert.strictEqual(schemaExtensionsCurrent(db), true);
    assert.doesNotThrow(() => assertStoreIntegrity(db));

    const mainStmt = db.prepare(
      "SELECT message_id, seen_at FROM discord_processed_messages WHERE message_id = ?",
    );
    mainStmt.setReadBigInts(true);
    const mainRow = mainStmt.get(largeId) as
      | { message_id: bigint; seen_at: number }
      | undefined;
    assert(mainRow);
    assert.strictEqual(mainRow.message_id, largeId);
    assert.strictEqual(mainRow.seen_at, fractionalTime);

    db.close();
  });

  it("initialize handles in-memory and current version databases without creating backup", async () => {
    const memDb = trackDb(
      new DatabaseSync(":memory:", { timeout: 5000, enableForeignKeyConstraints: false }),
    );
    const nonExistingPath = join(tempDir, "nonexistent-for-mem.sqlite");

    const backupResult = await initialize(memDb, nonExistingPath);
    assert.strictEqual(backupResult, null);
    assert.strictEqual(existsSync(join(tempDir, ".codex-discord-backups")), false);
    assert.strictEqual(schemaVersion(memDb), LATEST_STORE_SCHEMA_VERSION);
    assert.strictEqual(schemaExtensionsCurrent(memDb), true);

    const secondResult = await initialize(memDb, nonExistingPath);
    assert.strictEqual(secondResult, null);
    assert.strictEqual(schemaVersion(memDb), LATEST_STORE_SCHEMA_VERSION);

    memDb.close();
  });

  it("initialize preserves active caller transaction on current schema but rejects active transaction on old schema before backup", async () => {
    const currentDbPath = join(tempDir, "current-active.sqlite");
    const currentDb = trackDb(await openInitialized(currentDbPath));

    currentDb.exec("BEGIN IMMEDIATE;");
    currentDb.exec("CREATE TABLE caller_tx_test (id INTEGER PRIMARY KEY);");
    const currentResult = await initialize(currentDb, currentDbPath);
    assert.strictEqual(currentResult, null);
    assert.strictEqual(currentDb.isTransaction, true);
    currentDb.exec("COMMIT;");
    assert.strictEqual(currentDb.isTransaction, false);
    currentDb.close();

    const oldDbPath = join(tempDir, "old-active.sqlite");
    const oldDb = trackDb(
      new DatabaseSync(oldDbPath, { timeout: 5000, enableForeignKeyConstraints: false }),
    );
    migrateSchemaVersion(oldDb, 1n);
    oldDb.exec("PRAGMA user_version = 1;");
    oldDb.exec("INSERT INTO discord_processed_messages (message_id, seen_at) VALUES (1, 100.0);");
    assert(statSync(oldDbPath).size > 0);

    const backupDir = join(tempDir, ".codex-discord-backups");
    assert.strictEqual(existsSync(backupDir), false);

    oldDb.exec("BEGIN IMMEDIATE;");
    await assert.rejects(
      async () => {
        await initialize(oldDb, oldDbPath);
      },
      (err: unknown) => {
        assert(err instanceof ActiveTransactionError);
        return true;
      },
    );

    assert.strictEqual(oldDb.isTransaction, true);
    assert.strictEqual(existsSync(backupDir), false);

    oldDb.exec("ROLLBACK;");
    oldDb.close();
  });

  it("initialize and CheckedRead reject unsupported version 999 without creating backup or schema changes", async () => {
    const v999Path = join(tempDir, "v999.sqlite");
    const db999 = trackDb(
      new DatabaseSync(v999Path, { timeout: 5000, enableForeignKeyConstraints: false }),
    );
    db999.exec("PRAGMA user_version = 999;");
    db999.exec("CREATE TABLE table999 (val TEXT);");
    const sig999 = getCatalogSignature(db999);

    const backupDir = join(tempDir, ".codex-discord-backups");
    assert.strictEqual(existsSync(backupDir), false);

    await assert.rejects(
      async () => {
        await initialize(db999, v999Path);
      },
      (err: unknown) => {
        assert(err instanceof UnsupportedVersionError);
        assert.strictEqual(err.found, 999n);
        assert.strictEqual(err.supported, LATEST_STORE_SCHEMA_VERSION);
        return true;
      },
    );

    assert.strictEqual(existsSync(backupDir), false);
    assert.strictEqual(schemaVersion(db999), 999n);
    assert.strictEqual(getCatalogSignature(db999), sig999);
    db999.close();

    assert.throws(
      () => openRead(v999Path),
      (err: unknown) => {
        assert(err instanceof UnsupportedVersionError);
        assert.strictEqual(err.found, 999n);
        assert.strictEqual(err.supported, LATEST_STORE_SCHEMA_VERSION);
        return true;
      },
    );
    assert.strictEqual(existsSync(backupDir), false);
  });

  it("initialize rolls back negative version migration preserving original negative version and catalog while retaining completed pre-backup", async () => {
    const negPath = join(tempDir, "negative-version.sqlite");
    const negDb = trackDb(
      new DatabaseSync(negPath, { timeout: 5000, enableForeignKeyConstraints: false }),
    );
    negDb.exec("PRAGMA user_version = -1;");
    negDb.exec("CREATE TABLE neg_table (id INTEGER PRIMARY KEY, note TEXT);");
    negDb.exec("INSERT INTO neg_table (id, note) VALUES (1, 'keep');");
    assert(statSync(negPath).size > 0);
    const sigBefore = getCatalogSignature(negDb);

    await assert.rejects(
      async () => {
        await initialize(negDb, negPath);
      },
      (err: unknown) => {
        assert(err instanceof UnsupportedVersionError);
        assert.strictEqual(err.found, 0n);
        assert.strictEqual(err.supported, LATEST_STORE_SCHEMA_VERSION);
        return true;
      },
    );

    assert.strictEqual(schemaVersion(negDb), -1n);
    assert.strictEqual(getCatalogSignature(negDb), sigBefore);

    const testStmt = negDb.prepare("SELECT note FROM neg_table WHERE id = 1");
    const row = testStmt.get() as { note: string } | undefined;
    assert(row);
    assert.strictEqual(row.note, "keep");
    negDb.close();

    const backupDir = join(tempDir, ".codex-discord-backups");
    assert(existsSync(backupDir));
    const backups = readdirSync(backupDir).filter((f) => f.includes(".v-1-to-v2."));
    assert.strictEqual(backups.length, 1);
    assert(backups[0]);
    const chosenBackup = backups[0]!;

    const backupDb = trackDb(
      new DatabaseSync(join(backupDir, chosenBackup), {
        timeout: 5000,
        enableForeignKeyConstraints: false,
      }),
    );
    assert.strictEqual(schemaVersion(backupDb), -1n);
    backupDb.close();
  });

  it("mid-pipeline DDL failure rolls back entire migration, retains backup, and prevents catalog cache grant", async () => {
    const malformedPath = join(tempDir, "malformed-v1.sqlite");
    const db = trackDb(
      new DatabaseSync(malformedPath, { timeout: 5000, enableForeignKeyConstraints: false }),
    );
    migrateSchemaVersion(db, 1n);
    db.exec("PRAGMA user_version = 1;");
    db.exec("DROP INDEX codex_turn_queue_message_id;");

    const insertStmt = db.prepare(
      "INSERT INTO codex_turn_queue (job_id, target_thread_id, channel_id, discord_message_id, prompt, queued, ack_sent, state, attempt_count, baseline_turn_ids, created_at, updated_at) " +
        "VALUES (?, 'th1', 1, 99999, 'p', 1, 0, 'queued', 0, '', 1.0, 1.0)",
    );
    insertStmt.run("job1");
    insertStmt.run("job2");
    assert(statSync(malformedPath).size > 0);

    const sigBefore = getCatalogSignature(db);

    await assert.rejects(
      async () => {
        await initialize(db, malformedPath);
      },
      (err: unknown) => {
        assert(err instanceof Error);
        assert.match(err.message, /UNIQUE constraint failed/i);
        return true;
      },
    );

    assert.strictEqual(schemaVersion(db), 1n);
    assert.strictEqual(getCatalogSignature(db), sigBefore);
    db.close();

    const backupDir = join(tempDir, ".codex-discord-backups");
    assert(existsSync(backupDir));
    const backups = readdirSync(backupDir).filter((f) => f.startsWith("malformed-v1.v1-to-v2."));
    assert.strictEqual(backups.length, 1);
    assert(backups[0]);
    const chosenBackup = backups[0]!;

    const backupDb = trackDb(
      new DatabaseSync(join(backupDir, chosenBackup), {
        timeout: 5000,
        enableForeignKeyConstraints: false,
      }),
    );
    assert.strictEqual(schemaVersion(backupDb), 1n);
    backupDb.close();

    assert.throws(
      () => openRead(malformedPath),
      (err: unknown) => {
        assert(err instanceof UnsupportedVersionError);
        assert.strictEqual(err.found, 1n);
        return true;
      },
    );

    await assert.rejects(
      async () => {
        await openInitialized(malformedPath);
      },
      (err: unknown) => {
        assert(err instanceof Error);
        assert.match(err.message, /UNIQUE constraint failed/i);
        return true;
      },
    );
  });

  it("CheckedRead enforces read-only query-only semantics, ensureActive, and idempotent close/finish", async () => {
    const currentPath = join(tempDir, "checked-read-current.sqlite");
    const initDb = trackDb(await openInitialized(currentPath));
    initDb.close();

    const read = openRead(currentPath);
    const conn = read.connection();

    const qoStmt = conn.prepare("PRAGMA query_only;");
    const qoRow = qoStmt.get() as Record<string, unknown>;
    assert.strictEqual(Object.values(qoRow)[0], 1);

    assert.throws(() => {
      conn.exec("CREATE TABLE should_fail (x INTEGER);");
    });

    assert.doesNotThrow(() => read.ensureActive());

    read.finish();

    assert.throws(() => read.connection(), /CheckedRead is closed/);
    assert.throws(() => read.finish(), /CheckedRead is closed/);
    assert.throws(() => read.ensureActive(), (err: unknown) => {
      assert(err instanceof StoreIntegrityError);
      assert.strictEqual(err.result, "metadata read snapshot ended before publication");
      return true;
    });

    assert.doesNotThrow(() => read.close());
    assert.doesNotThrow(() => read.close());
  });

  it("CheckedRead detects externally ended snapshot in ensureActive and finish, closing connection", async () => {
    const currentPath = join(tempDir, "externally-ended.sqlite");
    const initDb = trackDb(await openInitialized(currentPath));
    initDb.exec("CREATE TABLE marker_ext_ended (id INTEGER);");
    initDb.close();

    const read1 = openRead(currentPath);
    const conn1 = read1.connection();
    conn1.exec("ROLLBACK;");

    assert.throws(
      () => read1.ensureActive(),
      (err: unknown) => {
        assert(err instanceof StoreIntegrityError);
        assert.strictEqual(err.result, "metadata read snapshot ended before publication");
        return true;
      },
    );
    read1.close();

    const read2 = openRead(currentPath);
    const conn2 = read2.connection();
    conn2.exec("ROLLBACK;");

    assert.throws(
      () => read2.finish(),
      (err: unknown) => {
        assert(err instanceof StoreIntegrityError);
        assert.strictEqual(err.result, "metadata read snapshot ended before publication");
        return true;
      },
    );

    assert.strictEqual(conn2.isOpen, false);
    assert.throws(() => conn2.prepare("SELECT 1;"));
    assert.throws(() => read2.connection(), /CheckedRead is closed/);
    assert.doesNotThrow(() => read2.close());
  });

  it("unfinished close releases snapshot and concurrent WAL writer changes are isolated until new readers reject", async () => {
    const walPath = join(tempDir, "wal-isolation.sqlite");
    const initDb = trackDb(await openInitialized(walPath));
    initDb.exec("PRAGMA journal_mode = WAL;");
    initDb.exec("CREATE TABLE marker_wal_iso (id INTEGER);");
    const oldSig = getCatalogSignature(initDb);
    initDb.close();

    const discardRead = openRead(walPath);
    assert.doesNotThrow(() => discardRead.connection());
    discardRead.close();
    assert.throws(() => discardRead.connection(), /CheckedRead is closed/);

    const reader = openRead(walPath);
    const readerConn = reader.connection();

    const writer = trackDb(
      new DatabaseSync(walPath, { timeout: 5000, enableForeignKeyConstraints: false }),
    );
    writer.exec("PRAGMA user_version = 999;");
    writer.close();

    assert.strictEqual(schemaVersion(readerConn), 2n);
    assert.strictEqual(getCatalogSignature(readerConn), oldSig);

    assert.throws(
      () => openRead(walPath),
      (err: unknown) => {
        assert(err instanceof UnsupportedVersionError);
        assert.strictEqual(err.found, 999n);
        assert.strictEqual(err.supported, LATEST_STORE_SCHEMA_VERSION);
        return true;
      },
    );

    reader.finish();

    assert.throws(
      () => openRead(walPath),
      (err: unknown) => {
        assert(err instanceof UnsupportedVersionError);
        assert.strictEqual(err.found, 999n);
        return true;
      },
    );

    await assert.rejects(
      async () => {
        await openInitialized(walPath);
      },
      (err: unknown) => {
        assert(err instanceof UnsupportedVersionError);
        assert.strictEqual(err.found, 999n);
        return true;
      },
    );
  });

  it("openInitialized repairs dropped required index on cache miss while CheckedRead rejects without repair", async () => {
    const repairPath = join(tempDir, "repairable.sqlite");
    const initDb = trackDb(await openInitialized(repairPath));
    initDb.exec("CREATE TABLE marker_repair_uniq (id INTEGER);");
    assert.strictEqual(schemaExtensionsCurrent(initDb), true);
    assert.strictEqual(hasIndex(initDb, "codex_mutation_prepared_target"), true);

    initDb.exec("DROP INDEX IF EXISTS codex_mutation_prepared_target;");
    assert.strictEqual(hasIndex(initDb, "codex_mutation_prepared_target"), false);
    assert.strictEqual(schemaExtensionsCurrent(initDb), false);
    const droppedSig = getCatalogSignature(initDb);
    initDb.close();

    assert.throws(
      () => openRead(repairPath),
      (err: unknown) => {
        assert(err instanceof StoreIntegrityError);
        assert.strictEqual(
          err.result,
          "metadata discovery requires an initialized current schema; no repair attempted",
        );
        return true;
      },
    );

    const verifyDb = trackDb(
      new DatabaseSync(repairPath, { timeout: 5000, enableForeignKeyConstraints: false }),
    );
    assert.strictEqual(hasIndex(verifyDb, "codex_mutation_prepared_target"), false);
    assert.strictEqual(getCatalogSignature(verifyDb), droppedSig);
    verifyDb.close();

    const repairedDb = trackDb(await openInitialized(repairPath));
    assert.strictEqual(schemaVersion(repairedDb), LATEST_STORE_SCHEMA_VERSION);
    assert.strictEqual(schemaExtensionsCurrent(repairedDb), true);
    assert.strictEqual(hasIndex(repairedDb, "codex_mutation_prepared_target"), true);
    assert.doesNotThrow(() => assertStoreIntegrity(repairedDb));

    repairedDb.close();
  });
});
