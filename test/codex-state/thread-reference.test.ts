import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ThreadInfo} from '../../src/codex-state/thread.ts';
import {ThreadResolveError, resolveThreadRefPosix as resolve, workspaceReferenceMap as aliases,
  normalizeWorkspacePathPosix as normalize, stripWindowsExtendedPrefix as strip} from '../../src/codex-state/thread-reference.ts';
function thread(id: string, cwd = ''): ThreadInfo {
  return Object.freeze({id, cwd, title: '', updatedAt: 0n, rolloutPath: '', model: '', reasoningEffort: '', tokensUsed: null, archivedAt: 0n});
}
const uuid = '01a079b3-1111-4000-8000-000000000001';
const kind = (expected: string) => (error: unknown) => error instanceof ThreadResolveError && error.kind === expected;

test('exact identity wins before numeric, reserved word and workspace namespaces', () => {
  const rows = [thread('other-id', '/thread-target'), thread('thread-target', '/target'), thread('1', '/one'), thread('other', '/other')];
  for (const id of ['thread-target', '1', 'other']) assert.equal(resolve(rows, id, null, false), rows.find(row => row.id === id));
});
test('full UUID matches ASCII case only and absent full ID never selects a copy or workspace', () => {
  const row = thread(uuid, '/original');
  assert.equal(resolve([row], uuid.toUpperCase(), null, false), row);
  assert.throws(() => resolve([thread(uuid + '-bot', '/copy'), thread('other', '/' + uuid)], uuid, null, false), kind('NotFound'));
});
test('prefix and workspace collision is ambiguous, not a first matching target', () => {
  const rows = [thread('abcd0000-1111-2222-3333-444444444444', '/first'), thread('other-id', '/abcd')];
  assert.throws(() => resolve(rows, 'abcd', null, false), kind('Ambiguous'));
});
test('every displayed alias round trips for all pinned reserved and unsafe name cases', () => {
  for (const name of ['abcd', '1', 'other', 'next', 'abcd0000-1111-2222-3333-444444444444', 'id-a',
    ' 1', ' other', ' next', '\u20031', 'my project', 'x|y']) {
    const rows = [thread('abcd0000-1111-2222-3333-444444444444', 'C:/first'), thread('id-a', 'C:/alpha'), thread('id-b', 'C:/' + name)];
    const map = aliases(rows);
    for (const row of rows) assert.equal(resolve(rows, map.get(row.id)!, 'id-b', false), row, name);
  }
});
test('a trailing newline in a workspace component cannot produce an unusable displayed alias', () => {
  const rows = [thread('row-a', '/hello\n/'), thread('row-b', '/other')];
  assert.equal(aliases(rows).get('row-a'), 'row-a');
  for (const row of rows) assert.equal(resolve(rows, aliases(rows).get(row.id)!, null, false), row);
});
test('duplicate workspace names get stable numbered aliases and case-only collisions stay distinct', () => {
  const rows = [thread('id-a', 'C:\\one\\Same'), thread('id-b', 'D:\\two\\same')];
  assert.deepEqual([...aliases(rows)], [['id-a', 'Same:1'], ['id-b', 'same:2']]);
  assert.equal(resolve(rows, 'same:1', null, false), rows[0]);
  assert.equal(resolve(rows, 'SAME:2', null, false), rows[1]);
  assert.throws(() => resolve(rows, 'same', null, false), kind('Ambiguous'));
});
test('other and next choose the first nonselected original row', () => {
  const rows = [thread('id-a', '/a'), thread('id-b', '/b')];
  assert.equal(resolve(rows, 'OTHER', 'id-a', false), rows[1]);
  assert.equal(resolve(rows, 'next', 'id-b', false), rows[0]);
  assert.equal(resolve(rows, 'next', null, false), rows[0]);
  assert.throws(() => resolve([rows[0]!], 'next', 'id-a', false), kind('NoAlternate'));
});
test('one-based numeric selection includes leading zeroes and fail-closed usize overflow', () => {
  const rows = [thread('a'), thread('b')];
  assert.equal(resolve(rows, '0002', null, false), rows[1]);
  for (const ref of ['', '0', '3', '18446744073709551615', '18446744073709551616', '9'.repeat(1000)]) {
    assert.throws(() => resolve(rows, ref, null, true), error => error instanceof ThreadResolveError
      && error.kind === 'IndexOutOfRange' && error.reference === ref && error.archived);
  }
});
test('empty, absent, ambiguous and index failure messages preserve source distinctions', () => {
  assert.throws(() => resolve([], '1', null, true), e => e instanceof ThreadResolveError && e.message === 'No archived Codex threads found in the local state DB.');
  assert.throws(() => resolve([thread('a')], '2', null, false), e => e instanceof ThreadResolveError && e.message === 'Thread thread index out of range: 2');
  assert.throws(() => resolve([thread('a')], 'missing', null, false), e => e instanceof ThreadResolveError && e.message === 'Thread not found: missing');
});
test('ambiguous diagnostics retain source row order and cap options at ten', () => {
  const rows = Array.from({length: 12}, (_, i) => thread('id-' + i, '/same'));
  assert.throws(() => resolve(rows, 'same', null, false), e => e instanceof ThreadResolveError
    && e.options === rows.slice(0, 10).map(row => row.id).join(', ') && !e.options.includes('id-10'));
});
test('short hexadecimal references require four characters and a unique match', () => {
  const rows = [thread(uuid, '/a'), thread('01a079b3-2222-4000-8000-000000000002', '/b')];
  assert.throws(() => resolve(rows, '01a079b3', null, false), kind('Ambiguous'));
  assert.equal(resolve(rows, '01a079b3-1111', null, false), rows[0]);
  assert.throws(() => resolve(rows, '01a', null, false), kind('NotFound'));
});
test('POSIX full paths preserve case and shared paths remain ambiguous', () => {
  const rows = [thread('a', '/repos/Project'), thread('b', '/repos/project')];
  assert.equal(resolve(rows, '/repos/./Project', null, false), rows[0]);
  assert.equal(resolve(rows, '/repos/project/', null, false), rows[1]);
  assert.throws(() => resolve(rows, '/REPOS/project', null, false), kind('NotFound'));
  assert.throws(() => resolve([thread('a', '/repo'), thread('b', '/repo/')], '/repo', null, false), kind('Ambiguous'));
});
test('POSIX lexical pop drops excess parent segments rather than retaining dot-dot', () => {
  for (const [input, expected] of [['', ''], ['.', ''], ['..', ''], ['a/../../b', 'b'],
    ['/a/../../b', '/b'], ['//a///./b/', '/a/b'], ['C:\\repo\\x', 'C:\\repo\\x']]) assert.equal(normalize(input!), expected);
});
test('Windows extended-prefix stripping is exact and independent of POSIX path interpretation', () => {
  assert.equal(strip('  \\\\?\\C:\\repo  '), 'C:\\repo');
  assert.equal(strip('\\\\?\\UNC\\server\\share'), '\\\\server\\share');
  assert.equal(strip('\\\\?\\unc\\server\\share'), 'unc\\server\\share');
  assert.equal(normalize('\\\\?\\C:\\repo'), 'C:\\repo');
});
test('Unicode 17 lowercase includes contextual sigma and aliases use Alphabetic plus Number', () => {
  const rows = [thread('a', '/ΟΣ'), thread('b', '/漢字Ⅷ'), thread('c', '/İ')];
  assert.equal(resolve(rows, 'ος', null, false), rows[0]);
  assert.equal(aliases(rows).get('b'), '漢字Ⅷ');
  assert.equal(resolve(rows, 'i\u0307', null, false), rows[2]);
});
test('alias map has UTF-8 key order and returned maps cannot alter later resolution', () => {
  const rows = [thread('😀', '/one'), thread('\ue000', '/two')], map = aliases(rows);
  assert.deepEqual([...map.keys()], ['\ue000', '😀']);
  (map as Map<string, string>).set('😀', 'changed');
  assert.equal(resolve(rows, 'one', null, false), rows[0]);
});
test('malformed rows and active getters are rejected before hooks execute', () => {
  let calls = 0;
  const fake = {get id() {calls++; return 'a';}, cwd: '/a'};
  assert.throws(() => aliases([fake as ThreadInfo]), TypeError);
  assert.throws(() => aliases([new Proxy({}, {get() {calls++; return 'a';}}) as ThreadInfo]), TypeError);
  assert.equal(calls, 0);
});
