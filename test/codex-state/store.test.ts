import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {existsSync, readFileSync, unlinkSync} from 'node:fs';
import {dirname} from 'node:path';
import {storeFixture} from '../helpers/store-fixture.ts';
import {CodexThreadStore} from '../../src/codex-state/store.ts';
import {CodexStateError} from '../../src/codex-state/errors.ts';
const schema = `CREATE TABLE threads (
 id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,
 model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,
 archived_at INTEGER,source TEXT,thread_source TEXT)`;
function create(path: string, sql = '', encoding?: string): void {
  const db = new DatabaseSync(path);
  try {if (encoding) db.exec("PRAGMA encoding='" + encoding + "'"); db.exec(schema); if (sql) db.exec(sql);}
  finally {db.close();}
}
function change(path: string, sql: string): void {
  const db = new DatabaseSync(path); try {db.exec(sql);} finally {db.close();}
}
const ids = (values: readonly {id: string}[]) => values.map(value => value.id);
const sqlError = (error: unknown) => error instanceof CodexStateError && error.kind === 'Sqlite';

test('open requires an existing regular file and never creates missing state', async () => {
  await storeFixture(async path => {
    assert.throws(() => CodexThreadStore.open(path), e => e instanceof CodexStateError && e.kind === 'StateDatabaseMissing'
      && e.message === 'Codex state database not found: ' + path);
    assert.equal(existsSync(path), false);
    assert.throws(() => CodexThreadStore.open(dirname(path)), e => e instanceof CodexStateError && e.kind === 'StateDatabaseMissing');
    assert.throws(() => new CodexThreadStore(Symbol(), path), TypeError);
  });
});
test('recent and exact identity lookup are independent of display limits', async () => {
  await storeFixture(async path => {
    create(path, `INSERT INTO threads(id,title,updated_at,archived) VALUES ('b','B',20,0),('a','A',20,0),('old','Old',1,0),('archived','Archive',10,1)`);
    const store = CodexThreadStore.open(path);
    assert.equal(store.path(), path);
    assert.deepEqual(ids(store.loadRecentThreads(1n)), ['a']);
    assert.deepEqual(ids(store.loadRecentThreads()), ['a', 'b', 'old']);
    assert.equal(store.loadThread('old', false)!.title, 'Old');
    assert.equal(store.loadThread('archived', false), null);
    assert.equal(store.loadThread('missing', false), null);
    assert.equal(store.loadThread('OLD', false), null);
  });
});
test('NULL defaults preserve unknown tokens and required id rejects NULL', async () => {
  await storeFixture(async path => {
    create(path, "INSERT INTO threads(id,archived) VALUES ('t',0)");
    const store = CodexThreadStore.open(path), value = store.loadThread('t', false)!;
    assert.deepEqual(value, {id: 't', title: '', cwd: '', updatedAt: 0n, rolloutPath: '', model: '', reasoningEffort: '', tokensUsed: null, archivedAt: 0n});
    assert.ok(Object.isFrozen(value) && Object.isFrozen(store.loadRecentThreads()));
    change(path, "INSERT INTO threads(id,archived) VALUES (NULL,0)");
    assert.throws(() => store.loadRecentThreads(), sqlError);
  });
});
test('i64 timestamps and cumulative usage remain exact at both signed extremes', async () => {
  await storeFixture(async path => {
    create(path, "INSERT INTO threads(id,updated_at,tokens_used,archived,archived_at) VALUES ('t',9223372036854775807,-9223372036854775808,1,9007199254740993)");
    const value = CodexThreadStore.open(path).loadArchivedThreads()[0]!;
    assert.equal(value.updatedAt, (1n << 63n) - 1n);
    assert.equal(value.tokensUsed, -(1n << 63n)); assert.equal(value.archivedAt, 9007199254740993n);
  });
});
test('archived ordering uses archived time, update time and id; inactive archived field is ignored', async () => {
  await storeFixture(async path => {
    create(path, `INSERT INTO threads(id,updated_at,archived,archived_at) VALUES
      ('c',10,1,30),('b',20,1,30),('a',20,1,30),('later',100,1,20),('live',1,0,x'ff')`);
    const store = CodexThreadStore.open(path);
    assert.deepEqual(ids(store.loadArchivedThreads()), ['a', 'b', 'c', 'later']);
    assert.deepEqual(ids(store.loadArchivedThreads(2n)), ['a', 'b']);
    assert.equal(store.loadThread('live', false)!.archivedAt, 0n);
  });
});
test('legacy vscode reader stays separate from complete interactive mirror root inventory', async () => {
  await storeFixture(async path => {
    create(path);
    const db = new DatabaseSync(path);
    try {
      const insert = db.prepare('INSERT INTO threads(id,title,updated_at,archived,source,thread_source) VALUES (?,?,10,?,?,?)');
      for (const [id, source, threadSource, title, archived] of [
        ['vscode', 'vscode', 'user', 'V', 0], ['cli', 'cli', '', 'C', 0],
        ['server-a', 'app-server', null, 'S', 0], ['server-b', 'appServer', 'user', 'S', 0],
        ['child', 'vscode', 'subagent', 'Child', 0], ['blank', 'vscode', 'user', '', 0],
        ['unknown', 'other', 'user', 'Other', 0], ['archived', 'cli', 'user', 'Archived', 1],
      ] as const) insert.run(id, title, archived, source, threadSource);
    } finally {db.close();}
    const store = CodexThreadStore.open(path);
    assert.deepEqual(ids(store.loadUserRootThreads()), ['vscode']);
    assert.deepEqual(ids(store.loadMirrorRootThreads()), ['cli', 'server-a', 'server-b', 'vscode']);
    assert.deepEqual(ids(store.loadMirrorRootThreads(2n)), ['cli', 'server-a']);
  });
});
test('query limits enforce u32 and zero means all rows', async () => {
  await storeFixture(async path => {
    create(path, "INSERT INTO threads(id,archived) VALUES ('a',0),('b',0)");
    const store = CodexThreadStore.open(path);
    assert.equal(store.loadRecentThreads(0n).length, 2);
    assert.equal(store.loadRecentThreads(0xffff_ffffn).length, 2);
    for (const value of [-1n, 0x1_0000_0000n, 1 as unknown as bigint]) assert.throws(() => store.loadRecentThreads(value), TypeError);
  });
});
test('read-only operations preserve database bytes and each method reopens current state', async () => {
  await storeFixture(async path => {
    create(path, "INSERT INTO threads(id,title,archived) VALUES ('t','original',0)");
    const before = readFileSync(path), store = CodexThreadStore.open(path);
    store.loadRecentThreads(); store.loadUserRootThreads(); store.loadMirrorRootThreads(); store.loadArchivedThreads(); store.loadThread('t', false);
    assert.deepEqual(readFileSync(path), before);
    change(path, "UPDATE threads SET title='changed'");
    assert.equal(store.loadThread('t', false)!.title, 'changed');
    unlinkSync(path); assert.throws(() => store.loadRecentThreads(), sqlError); assert.equal(existsSync(path), false);
  });
});
test('active list omits archived_at but exact lookup requires the source selected column', async () => {
  await storeFixture(async path => {
    const db = new DatabaseSync(path);
    try {db.exec(schema.replace(',archived_at INTEGER', '').replace(/\n archived_at INTEGER,/, '\n '));
      db.exec("INSERT INTO threads(id,archived) VALUES ('t',0)");}
    finally {db.close();}
    const store = CodexThreadStore.open(path);
    assert.equal(store.loadRecentThreads()[0]!.archivedAt, 0n);
    assert.throws(() => store.loadThread('t', false), sqlError);
  });
});
test('wrong SQLite storage classes and invalid UTF-8 are rejected, not replaced or rounded', async () => {
  await storeFixture(async path => {
    create(path, "INSERT INTO threads(id,title,updated_at,archived) VALUES ('t','valid',1,0)");
    const store = CodexThreadStore.open(path);
    for (const sql of ["UPDATE threads SET title=x'61'", "UPDATE threads SET title=CAST(x'ff' AS TEXT)",
      "UPDATE threads SET title='valid',updated_at=1.5", "UPDATE threads SET updated_at=1,tokens_used='bad'"]) {
      change(path, sql); assert.throws(() => store.loadThread('t', false), sqlError);
    }
  });
});
test('UTF-16 state files preserve real Unicode text with raw-byte validation', async () => {
  for (const encoding of ['UTF-16le', 'UTF-16be']) await storeFixture(async path => {
    create(path, "INSERT INTO threads(id,title,cwd,archived) VALUES ('t','😀 한국어','C:/한글',0)", encoding);
    const value = CodexThreadStore.open(path).loadRecentThreads()[0]!;
    assert.equal(value.title, '😀 한국어'); assert.equal(value.cwd, 'C:/한글');
  });
});
test('native connection reports the pinned rusqlite 5000ms busy timeout', async () => {
  await storeFixture(async path => {
    const db = new DatabaseSync(path);
    try {db.exec(`CREATE VIEW threads AS SELECT 'probe' AS id,NULL AS title,NULL AS cwd,
      timeout AS updated_at,NULL AS rollout_path,NULL AS model,NULL AS reasoning_effort,
      NULL AS tokens_used,0 AS archived,0 AS archived_at,NULL AS source,NULL AS thread_source FROM pragma_busy_timeout`);}
    finally {db.close();}
    assert.equal(CodexThreadStore.open(path).loadRecentThreads()[0]!.updatedAt, 5000n);
  });
});
