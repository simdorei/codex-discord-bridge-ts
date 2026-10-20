import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {findMirrorProject} from '../../src/store/mirror-project-creation.ts';
import {NativeMirrorStore} from '../../src/runtime/mirror-sync/store-native.ts';
import {captureMirrorStoreResult} from '../../src/runtime/mirror-sync/store-native-protocol.ts';
const match = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
test('empty/null/Unicode whitespace project lookup returns without creating DB or calling matcher', async () => storeFixture(async path => {
  for (const key of [null, '', '\u2003\n']) assert.equal(await findMirrorProject(path, key, () => { throw new Error('unexpected'); }), null);
  assert.equal(existsSync(path), false);
}));
test('trimmed exact match wins and masks malformed unrelated alias row and comparator', async () => storeFixture(async path => {
  const db = await openInitialized(path);
  try { db.exec("INSERT INTO mirror_projects VALUES('p','project',3,1),('bad','bad','malformed',9)"); }
  finally { db.close(); }
  assert.deepEqual(await findMirrorProject(path, '\u2003p\n', () => { throw new Error('must not run'); }), {channelId: 3n, storedKey: 'p'});
}));
test('alias fallback chooses newest matching row after decoding all records', async () => storeFixture(async path => {
  const db = await openInitialized(path);
  try { db.exec("INSERT INTO mirror_projects VALUES('P','old',3,1),('p','new',4,9),('other','other',5,20)"); }
  finally { db.close(); }
  const seen: string[] = [];
  assert.deepEqual(await findMirrorProject(path, 'canonical', (a, b) => { seen.push(a); assert.equal(b, 'canonical'); return a === 'p' || a === 'P'; }), {channelId: 4n, storedKey: 'p'});
  assert.deepEqual(seen, ['other', 'p']);
}));
test('corrupt later alias row fails before matcher despite earlier matching row', async () => storeFixture(async path => {
  const db = await openInitialized(path);
  try { db.exec("INSERT INTO mirror_projects VALUES('P','project',3,9),('bad','bad','malformed',1)"); }
  finally { db.close(); }
  let calls = 0;
  await assert.rejects(findMirrorProject(path, 'p', () => { calls++; return true; }));
  assert.equal(calls, 0);
}));
test('native project lookup and room ownership share initialized off-thread store', async () => storeFixture(async path => {
  const db = await openInitialized(path);
  try { db.exec("INSERT INTO mirror_projects VALUES('/project','project',3,1)"); }
  finally { db.close(); }
  const store = new NativeMirrorStore(path);
  assert.deepEqual(await store.execute({kind: 'FindProject', args: ['/project/']}), {channelId: 3n, storedKey: '/project'});
  assert.deepEqual(await store.execute({kind: 'ProjectForChannel', args: [3n]}), ['/project', 'project']);
  assert.equal(await store.execute({kind: 'ProjectForChannel', args: [0n]}), null);
  assert.equal(await store.execute({kind: 'ProjectForChannel', args: [null]}), null);
  assert.equal(await store.execute({kind: 'FindProject', args: ['missing']}), null);
}));
test('transport rejects incomplete/coercible project match and malformed ownership tuple', () => {
  for (const value of [{channelId: 3, storedKey: 'p'}, {channelId: 3n}, {channelId: 3n, storedKey: 'p', extra: true}]) assert.throws(() => captureMirrorStoreResult('FindProject', value), TypeError);
  for (const value of [[], ['p'], ['p', 2n], ['p', 'name', 'extra']]) assert.throws(() => captureMirrorStoreResult('ProjectForChannel', value), TypeError);
});
test('lookup keeps exact i64 identity and rejects nonboolean alias comparator', async () => storeFixture(async path => {
  const db = await openInitialized(path);
  try { db.prepare('INSERT INTO mirror_projects VALUES(?,?,?,1)').run('P', 'project', 9223372036854775807n); }
  finally { db.close(); }
  assert.deepEqual(await findMirrorProject(path, 'p', match), {channelId: 9223372036854775807n, storedKey: 'P'});
  await assert.rejects(findMirrorProject(path, 'p', (() => 1) as unknown as typeof match), TypeError);
}));
