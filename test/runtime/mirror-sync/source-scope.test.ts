import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join, dirname} from 'node:path';
import {readFileSync, linkSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {NativeMirrorSourceScope} from '../../../src/runtime/mirror-sync/source-scope.ts';
async function fixture(run: (codex: string, mirror: string, db: DatabaseSync, bridge: DatabaseSync) => Promise<void>) {
  await storeFixture(async mirror => {
    const codex = join(dirname(mirror), 'codex.sqlite'); const db = new DatabaseSync(codex); const bridge = await openInitialized(mirror);
    try {
      db.exec('CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER,source TEXT,thread_source TEXT)');
      await run(codex, mirror, db, bridge);
    } finally { bridge.close(); db.close(); }
  });
}
function row(db: DatabaseSync, id: string, time: number, source = 'cli', kind = 'user', archived = 0) {
  db.prepare("INSERT INTO threads VALUES(?,?,'/p',?,'/rollout',NULL,NULL,0,?,0,?,?)").run(id, id, time, archived, source, kind);
}
function mapping(bridge: DatabaseSync, id: string, channel = 3) {
  bridge.prepare("INSERT INTO mirror_threads VALUES(?,'/p',?,2,?,1)").run(id, id, channel);
}
const fresh = () => new AbortController().signal;
test('unlimited scope combines roots and mapped active forks, deduplicates, and orders oldest first', async () => fixture(async (codex, mirror, db, bridge) => {
  row(db, 'root', 3); row(db, 'mapped', 1, 'app-server', 'subagent'); row(db, 'unmapped', 4, 'app-server', 'subagent'); row(db, 'archived', 2, 'cli', 'user', 1);
  mapping(bridge, 'root'); mapping(bridge, 'mapped', 4); mapping(bridge, 'archived', 5); mapping(bridge, 'missing', 6);
  const before = readFileSync(codex), result = await new NativeMirrorSourceScope(codex, mirror).load(null, fresh());
  assert.deepEqual(result.map(item => item.id), ['mapped', 'root']); assert.deepEqual(readFileSync(codex), before);
}));
test('limited scope includes recent non-root rows and clamps zero/negative to one', async () => fixture(async (codex, mirror, db, _bridge) => {
  row(db, 'root', 1); row(db, 'child', 2, 'app-server', 'subagent');
  const scope = new NativeMirrorSourceScope(codex, mirror);
  for (const limit of [0n, -99n, 1n]) assert.deepEqual((await scope.load(limit, fresh())).map(item => item.id), ['child']);
  assert.deepEqual((await scope.load(2n, fresh())).map(item => item.id), ['root', 'child']);
}));
test('limited scope caps only explicit limit at100; unlimited scope retains all101 roots', async () => fixture(async (codex, mirror, db, _bridge) => {
  for (let i = 0; i < 101; i++) row(db, `r${i}`, i);
  const scope = new NativeMirrorSourceScope(codex, mirror);
  assert.equal((await scope.load(1000n, fresh())).length, 100);
  assert.equal((await scope.load(null, fresh())).length, 101);
}));
test('limited mode does not inspect malformed bridge mappings; unlimited mode refuses them', async () => fixture(async (codex, mirror, db, bridge) => {
  row(db, 'root', 1); bridge.exec("INSERT INTO mirror_threads VALUES('bad','/p','bad',2,'malformed',1)");
  const scope = new NativeMirrorSourceScope(codex, mirror);
  assert.equal((await scope.load(1n, fresh())).length, 1); await assert.rejects(scope.load(null, fresh()), /Unconfirmed mirror source scope/);
}));
test('hard-linked Codex/bridge alias rejects without schema mutation', async () => fixture(async (codex, _mirror, db, _bridge) => {
  row(db, 'root', 1); const alias = join(dirname(codex), 'alias.sqlite'); linkSync(codex, alias); const before = readFileSync(codex);
  await assert.rejects(new NativeMirrorSourceScope(codex, alias).load(null, fresh()));
  assert.deepEqual(readFileSync(codex), before);
}));
test('pre-abort and invalid limit never create a source or bridge database', async () => storeFixture(async mirror => {
  const codex = join(dirname(mirror), 'absent.sqlite'), scope = new NativeMirrorSourceScope(codex, mirror); const abort = new AbortController(), reason = new Error('cancel'); abort.abort(reason);
  await assert.rejects(scope.load(null, abort.signal), error => error === reason);
  await assert.rejects(scope.load(1n << 63n, fresh()), TypeError);
}));
test('stable timestamp ties preserve source candidate ordering', async () => fixture(async (codex, mirror, db, bridge) => {
  row(db, 'b', 1); row(db, 'a', 1); row(db, 'child', 1, 'app-server', 'subagent'); mapping(bridge, 'child');
  assert.deepEqual((await new NativeMirrorSourceScope(codex, mirror).load(null, fresh())).map(item => item.id), ['a', 'b', 'child']);
}));
