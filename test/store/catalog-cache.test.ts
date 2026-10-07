import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Buffer } from 'node:buffer';
import {
  getCatalogSignature,
  CatalogCache,
  MAX_CATALOGS,
  MAX_CATALOG_BYTES,
} from '../../src/store/catalog-cache.ts';

test('catalog signature includes version and full DDL but not rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE marker(value INTEGER);');
    const original = getCatalogSignature(db);
    db.exec('INSERT INTO marker VALUES (7);');
    assert.strictEqual(getCatalogSignature(db), original);
    db.exec('ALTER TABLE marker ADD COLUMN other TEXT;');
    const changed = getCatalogSignature(db);
    assert.notStrictEqual(changed, original);
    db.exec('PRAGMA user_version = 8;');
    assert.notStrictEqual(getCatalogSignature(db), changed);
  } finally {
    db.close();
  }
});

test('cache is bounded and remembering a signature is idempotent (65 entries FIFO)', () => {
  const cache = new CatalogCache();
  for (let i = 0; i < 65; i++) {
    cache.remember(`catalog-${String(i).padStart(3, '0')}`);
  }
  assert.strictEqual(cache.size, 64);
  assert.strictEqual(cache.contains('catalog-000'), false);
  assert.strictEqual(cache.contains('catalog-064'), true);
  cache.remember('catalog-064');
  assert.strictEqual(cache.size, 64);
  assert.strictEqual(cache.snapshot[63], 'catalog-064');
});

test('exact encoding preserves quoted names and null sql', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE "quoted""name"(id TEXT PRIMARY KEY, value TEXT DEFAULT \'null,[]\');');
    const encoded = getCatalogSignature(db);
    const rows = JSON.parse(encoded) as Array<[number, string, string, string, string | null]>;
    const table = rows.find((r) => r[1] === 'table');
    assert.ok(table);
    assert.strictEqual(table[2], 'quoted"name');
    assert.strictEqual(table[3], 'quoted"name');
    assert.ok(table[4]?.includes("'null,[]'"));
    const index = rows.find((r) => r[1] === 'index');
    assert.ok(index);
    assert.strictEqual(index[4], null);
    assert.ok(rows.every((r) => r[0] === 0));
  } finally {
    db.close();
  }
});

test('byte budget evicts old catalogs and does not retain oversized entries', () => {
  const cache = new CatalogCache();
  const half = MAX_CATALOG_BYTES / 2;
  for (const ch of ['a', 'b', 'c']) {
    cache.remember(ch.repeat(half));
  }
  assert.strictEqual(cache.size, 2);
  assert.strictEqual(cache.bytes, MAX_CATALOG_BYTES);
  assert.strictEqual(cache.snapshot[0]?.startsWith('b'), true);
  cache.remember('x'.repeat(MAX_CATALOG_BYTES + 1));
  assert.strictEqual(cache.size, 2);
  assert.strictEqual(cache.bytes, MAX_CATALOG_BYTES);
});

test('dropping index changes signature even if schema_version is restored', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE t(id INT PRIMARY KEY); CREATE INDEX idx_t ON t(id);');
    const row = db.prepare('PRAGMA schema_version;').get() as { schema_version?: number } | undefined;
    const schemaVersion = row?.schema_version;
    assert.notStrictEqual(schemaVersion, undefined);
    const sigBefore = getCatalogSignature(db);
    db.exec('DROP INDEX idx_t;');
    db.exec(`PRAGMA schema_version = ${schemaVersion};`);
    const sigAfter = getCatalogSignature(db);
    assert.notStrictEqual(sigAfter, sigBefore);
  } finally {
    db.close();
  }
});

test('two independent in-memory databases have equal signature with same DDL and separate data', () => {
  const dbA = new DatabaseSync(':memory:');
  const dbB = new DatabaseSync(':memory:');
  try {
    const ddl = 'CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT);';
    dbA.exec(ddl);
    dbB.exec(ddl);
    dbA.exec("INSERT INTO kv VALUES ('key1', 'valA');");
    dbB.exec("INSERT INTO kv VALUES ('key1', 'valB');");
    assert.strictEqual(getCatalogSignature(dbA), getCatalogSignature(dbB));
    const rowA = dbA.prepare("SELECT v FROM kv WHERE k = 'key1';").get() as { v?: string } | undefined;
    const rowB = dbB.prepare("SELECT v FROM kv WHERE k = 'key1';").get() as { v?: string } | undefined;
    assert.strictEqual(rowA?.v, 'valA');
    assert.strictEqual(rowB?.v, 'valB');
  } finally {
    dbA.close();
    dbB.close();
  }
});

test('user_version 999 changes catalog signature key', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE marker(id INT);');
    const sig0 = getCatalogSignature(db);
    db.exec('PRAGMA user_version = 999;');
    const sig999 = getCatalogSignature(db);
    assert.notStrictEqual(sig0, sig999);
    const parsed = JSON.parse(sig999) as Array<[number, ...unknown[]]>;
    assert.strictEqual(parsed[0]?.[0], 999);
  } finally {
    db.close();
  }
});

test('empty catalog returns exact row from left join', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const emptySig = getCatalogSignature(db);
    assert.deepStrictEqual(JSON.parse(emptySig), [[0, null, null, null, null]]);
  } finally {
    db.close();
  }
});

test('unicode utf-8 budget accounting and neither contains nor duplicate remember promotes FIFO', () => {
  const cache = new CatalogCache();
  const emoji = '🔥';
  assert.strictEqual(emoji.length, 2);
  assert.strictEqual(Buffer.byteLength(emoji, 'utf8'), 4);
  cache.remember(emoji);
  assert.strictEqual(cache.bytes, 4);
  cache.remember('second');
  assert.deepStrictEqual(cache.snapshot, [emoji, 'second']);
  assert.strictEqual(cache.contains(emoji), true);
  assert.deepStrictEqual(cache.snapshot, [emoji, 'second']);
  cache.remember(emoji);
  assert.deepStrictEqual(cache.snapshot, [emoji, 'second']);

  for (let i = 0; i < 62; i++) {
    cache.remember(`fill-${i}`);
  }
  assert.strictEqual(cache.size, 64);
  assert.strictEqual(cache.contains(emoji), true);
  cache.remember('push-out');
  assert.strictEqual(cache.size, 64);
  assert.strictEqual(cache.contains(emoji), false);
  assert.strictEqual(cache.contains('second'), true);
});

test('returned inspection snapshot is defensive copy and cannot mutate cache', () => {
  const cache = new CatalogCache();
  cache.remember('sig-a');
  const snap = cache.snapshot as string[];
  snap.push('sig-injected');
  assert.strictEqual(cache.size, 1);
  assert.strictEqual(cache.contains('sig-injected'), false);
  snap[0] = 'sig-corrupted';
  assert.strictEqual(cache.snapshot[0], 'sig-a');
});
