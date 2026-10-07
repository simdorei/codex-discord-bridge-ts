import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openExisting } from '../../src/store/existing-store.ts';

describe('openExisting store helper', () => {
  let currentTmpDir: string | null = null;
  const openHandles: DatabaseSync[] = [];

  function track(db: DatabaseSync): DatabaseSync {
    openHandles.push(db);
    return db;
  }

  function closeAllHandles(): void {
    while (openHandles.length > 0) {
      const db = openHandles.pop();
      if (db) {
        try {
          db.close();
        } catch {
          // Ignore handles already closed during individual assertions
        }
      }
    }
  }

  function safeRemoveTmpDir(targetDir: string | null): void {
    if (!targetDir) {
      return;
    }
    const resolved = resolve(targetDir);
    const parent = dirname(resolved);
    const base = basename(resolved);
    const expectedParent = resolve(tmpdir());

    if (parent === expectedParent && base.startsWith('cdr-ts-existing-')) {
      rmSync(resolved, { recursive: true, force: true });
    } else {
      throw new Error(`Refusing to remove unsafe path: ${resolved}`);
    }
  }

  beforeEach(() => {
    currentTmpDir = mkdtempSync(join(tmpdir(), 'cdr-ts-existing-'));
  });

  afterEach(() => {
    try {
      closeAllHandles();
    } finally {
      if (currentTmpDir) {
        const dirToClean = currentTmpDir;
        currentTmpDir = null;
        safeRemoveTmpDir(dirToClean);
      }
    }
  });

  it('fails on missing path without creating any file or backup directory', () => {
    const missingPath = join(currentTmpDir!, 'nonexistent.db');
    assert.strictEqual(existsSync(missingPath), false);

    assert.throws(
      () => {
        track(openExisting(missingPath));
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );

    assert.strictEqual(existsSync(missingPath), false);
    const entries = readdirSync(currentTmpDir!);
    assert.strictEqual(entries.length, 0);
  });

  it('opens existing empty file as writable with no DDL created automatically, and supports roundtrip of bigint > 2^53 and REAL timestamp', () => {
    const emptyPath = join(currentTmpDir!, 'empty.db');
    writeFileSync(emptyPath, '');

    const db = openExisting(emptyPath);
    track(db);

    const tablesBefore = db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all();
    assert.strictEqual(tablesBefore.length, 0);

    db.exec(
      'CREATE TABLE test_records (id INTEGER PRIMARY KEY, big_val INTEGER, ts REAL);',
    );

    const bigVal = 9007199254740993n; // 2^53 + 1
    assert.ok(bigVal > 2n ** 53n);
    const timestamp = 1728214842.125;

    const insertStmt = db.prepare(
      'INSERT INTO test_records (id, big_val, ts) VALUES (?, ?, ?)',
    );
    insertStmt.run(1, bigVal, timestamp);

    const stmt = db.prepare(
      'SELECT id, big_val, ts FROM test_records WHERE id = 1',
    );
    stmt.setReadBigInts(true);
    const row = stmt.get() as { id: number | bigint; big_val: bigint; ts: number };

    assert.strictEqual(row.big_val, bigVal);
    assert.strictEqual(row.ts, timestamp);
  });

  it('handles special Windows-valid Korean, space, #, %, and & in filename by exact write without alternate path creation', () => {
    const specialName =
      'cdr_test_한국어 space_#hash_%percent_&amp.db';
    const specialPath = join(currentTmpDir!, specialName);
    writeFileSync(specialPath, '');

    const db = openExisting(specialPath);
    track(db);

    db.exec(
      'CREATE TABLE special_tbl (id INTEGER PRIMARY KEY, note TEXT);',
    );
    const insertStmt = db.prepare(
      'INSERT INTO special_tbl (id, note) VALUES (?, ?)',
    );
    insertStmt.run(1, '성공 exact write');

    const row = db
      .prepare('SELECT note FROM special_tbl WHERE id = 1')
      .get() as { note: string };
    assert.strictEqual(row.note, '성공 exact write');

    assert.strictEqual(existsSync(specialPath), true);
    assert.ok(statSync(specialPath).size > 0);

    // Verify truncated or misinterpreted alternate paths do not exist
    assert.strictEqual(
      existsSync(join(currentTmpDir!, 'cdr_test_한국어 space_')),
      false,
    );
    assert.strictEqual(
      existsSync(join(currentTmpDir!, 'cdr_test_한국어 space_#hash_%percent_')),
      false,
    );

    const entries = readdirSync(currentTmpDir!);
    assert.deepStrictEqual(entries, [specialName]);
  });

  it('preserves malformed file and native SQL access rejects without repair', () => {
    const malformedPath = join(currentTmpDir!, 'malformed.db');
    const badBytes = Buffer.from(
      'NOT_A_VALID_SQLITE3_DATABASE_HEADER_PAYLOAD_1234567890',
    );
    writeFileSync(malformedPath, badBytes);

    const db = openExisting(malformedPath);
    track(db);

    assert.throws(
      () => {
        db.prepare('SELECT name FROM sqlite_schema').all();
      },
      /file is not a database/,
    );

    const currentBytes = readFileSync(malformedPath);
    assert.deepStrictEqual(currentBytes, badBytes);
  });

  it('opens existing version 999 database with table marker and preserves version and schema without repair', () => {
    const versionPath = join(currentTmpDir!, 'version999.db');
    const initDb = track(new DatabaseSync(versionPath));
    initDb.exec('PRAGMA user_version = 999;');
    initDb.exec(
      'CREATE TABLE marker_tbl (id INTEGER PRIMARY KEY, marker_text TEXT);',
    );
    initDb.exec(
      "INSERT INTO marker_tbl (id, marker_text) VALUES (42, 'preserve_marker');",
    );
    initDb.close();

    const db = openExisting(versionPath);
    track(db);

    const versionRow = db
      .prepare('PRAGMA user_version;')
      .get() as { user_version: number };
    assert.strictEqual(versionRow.user_version, 999);

    const markerRow = db
      .prepare('SELECT marker_text FROM marker_tbl WHERE id = 42')
      .get() as { marker_text: string };
    assert.strictEqual(markerRow.marker_text, 'preserve_marker');

    const attemptsTable = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name='codex_mutation_attempts'",
      )
      .get();
    assert.strictEqual(attemptsTable, undefined);

    const runtimeTable = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name='codex_mutation_runtime'",
      )
      .get();
    assert.strictEqual(runtimeTable, undefined);
  });

  it('rejects directory path without incidental file creation', () => {
    const subDirPath = join(currentTmpDir!, 'test_subdir');
    mkdirSync(subDirPath);

    assert.throws(
      () => {
        track(openExisting(subDirPath));
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );

    const subDirEntries = readdirSync(subDirPath);
    assert.strictEqual(subDirEntries.length, 0);

    const tmpEntries = readdirSync(currentTmpDir!);
    assert.deepStrictEqual(tmpEntries, ['test_subdir']);
  });
});
