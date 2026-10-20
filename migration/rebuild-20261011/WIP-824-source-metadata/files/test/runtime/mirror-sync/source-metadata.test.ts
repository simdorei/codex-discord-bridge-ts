import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync, mkdirSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {NativeMirrorMetadata} from '../../../src/runtime/mirror-sync/source-metadata.ts';
import {mirrorProjectIdentity} from '../../../src/runtime/mirror-sync/source-metadata-local.ts';
import {newMirrorThreadName} from '../../../src/runtime/mirror-sync/new-mirror-link.ts';
const fresh = () => new AbortController().signal;
test('native titles ignore malformed rows, trim Unicode whitespace and retain last nonempty name', async () => storeFixture(async path => {
  writeFileSync(path, [JSON.stringify({id: 'x', thread_name: ' first '}), 'broken', '{}', JSON.stringify({id: 1, thread_name: 'wrong'}), JSON.stringify({id: 'x', thread_name: '\u2003final\n'}), JSON.stringify({id: 'x', thread_name: '\u2003'})].join('\n'));
  assert.deepEqual([...(await new NativeMirrorMetadata().titles(path, fresh()))], [['x', 'final']]);
}));
test('missing file and directory are empty title sources; invalid UTF8 fails the whole read', async () => storeFixture(async path => {
  const reader = new NativeMirrorMetadata(); assert.equal((await reader.titles(path, fresh())).size, 0);
  mkdirSync(path + '.directory'); assert.equal((await reader.titles(path + '.directory', fresh())).size, 0);
  writeFileSync(path, Buffer.from([0xff])); await assert.rejects(reader.titles(path, fresh()), /unconfirmed/);
}));
test('BOM is not silently removed and names retain Rust byte ordering', async () => storeFixture(async path => {
  writeFileSync(path, '\ufeff' + JSON.stringify({id: 'bom', thread_name: 'ignored'}) + '\n' + JSON.stringify({id: '😀', thread_name: 'astral'}) + '\n' + JSON.stringify({id: '\ue000', thread_name: 'bmp'}));
  assert.deepEqual([...(await new NativeMirrorMetadata().titles(path, fresh()))], [['\ue000', 'bmp'], ['😀', 'astral']]);
}));
test('rollout availability observes current file state and directories stay false', async () => storeFixture(async path => {
  const reader = new NativeMirrorMetadata(); assert.equal(await reader.rollout(path, fresh()), false);
  writeFileSync(path, '{}'); assert.equal(await reader.rollout(path, fresh()), true);
  mkdirSync(path + '.directory'); assert.equal(await reader.rollout(path + '.directory', fresh()), false);
}));
test('project grouping recognizes desktop chat layout and preserves POSIX path semantics', () => {
  assert.deepEqual(mirrorProjectIdentity(' /a/Docs/../project/ '), ['/a/project', 'project']);
  assert.deepEqual(mirrorProjectIdentity('/Users/me/Documents/Codex/2026-10-13/new-chat-2'), ['codex:chats', '채팅']);
  assert.deepEqual(mirrorProjectIdentity('C:\\Users\\me\\DOCUMENTS\\CODEX\\2026-10-13\\chatgpt-conversation-1'), ['codex:chats', '채팅']);
  assert.deepEqual(mirrorProjectIdentity(' \n'), ['projectless:projectless', 'projectless']);
  assert.deepEqual(mirrorProjectIdentity('/'), ['/', 'projectless']);
  assert.notEqual(mirrorProjectIdentity('/Users/me/Documents/Codex/날짜00000000/new-chat-1')[0], 'codex:chats');
});
test('source title formatting collapses Rust whitespace and respects UTF16 limit without splitting astral', () => {
  assert.equal(newMirrorThreadName(' A\u0085B\n C ', 'id'), 'A B C');
  assert.equal(newMirrorThreadName('😀'.repeat(46), 'id'), '😀'.repeat(45));
  assert.equal(newMirrorThreadName('', '😀12345678'), 'codex-😀1234567');
});
test('pre-aborted metadata read propagates exact reason without file access', async () => {
  const abort = new AbortController(), reason = new Error('cancel'); abort.abort(reason);
  await assert.rejects(new NativeMirrorMetadata().titles('/not-present', abort.signal), error => error === reason);
});
