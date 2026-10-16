import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, writeFile, rm, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {admitHost, admittedRoot, validateManifest, parsePacket, safeResult, OwnedChild, verifyOwnedCompletion,
  orchestrateCase, admitOwnedChild, protocolForTest, supervisorCaseForTest, verifyDependencyClosure, QualificationBudget, QualificationFault, LIMITS, CASES} from '../../tools/windows-qualification.ts';
import type {Packet, CaseDriver, CaseId} from '../../tools/windows-qualification.ts';

const host = {mainThread: true, platform: 'win32', arch: 'x64', version: '24.21.0'};
const args = ['--native', '--source-root', 'C:\\source', '--fixture-base', 'C:\\fixtures'];
function packet(overrides: Partial<Packet> = {}): Packet {
  return {nonce: 'a'.repeat(24), caseId: 'load', role: 'a', sequence: 0, event: 'done', status: 'PASS',
    cleanup: 'closed', callbacks: 0, reads: 0, replacements: 0, nativePhase: false, dwords: [], ...overrides};
}
function fault(reason: string): (error: unknown) => boolean {
  return error => error instanceof QualificationFault && error.reason === reason;
}
class FakeProcess extends EventEmitter {
  stdout = new EventEmitter(); stderr = new EventEmitter(); kills = 0; failKill = false;
  kill(): boolean { this.kills++; return !this.failKill; }
  finish(code: number | null = 0, signal: string | null = null): void { this.emit('exit', code, signal); this.emit('close', code, signal); }
}

test('frozen finite containment budgets and case list', () => {
  assert.deepEqual(LIMITS, {children: 3, transitionMs: 5000, caseMs: 30000, runMs: 300000, exitMs: 5000,
    packetBytes: 4096, slots: 128, outputBytes: 65536, replacements: 32, reads: 16384, pollMs: 10, files: 1024});
  assert.equal(Object.isFrozen(LIMITS), true); assert.equal(CASES.length, 12);
});

test('default/help is inert even on an unsupported host; explicit native refusals precede effects', () => {
  const bad = {mainThread: false, platform: 'linux', arch: 'ia32', version: '0'};
  assert.equal(admitHost(bad, []), 'instructions'); assert.equal(admitHost(bad, ['--help']), 'instructions');
  for (const change of [{mainThread: false}, {platform: 'linux'}, {platform: 'darwin'}, {arch: 'ia32'}, {arch: 'riscv64'}, {version: '24.20.0'}])
    assert.throws(() => admitHost({...host, ...change}, args), fault('host'));
  assert.equal(admitHost(host, args), 'native'); assert.equal(admitHost({...host, arch: 'arm64'}, args), 'native');
  for (const invalid of [['--native'], [...args, 'extra'], ['--install'], ['--child', 'arbitrary'], ['--help', 'extra']])
    assert.throws(() => admitHost(host, invalid), fault('arguments'));
});

test('compiled entry prints instructions and refuses Linux native opt-in without using supplied paths', () => {
  assert.notEqual(process.platform, 'win32', 'This suite is cloud evidence only');
  const script = fileURLToPath(new URL('../../tools/windows-qualification.js', import.meta.url));
  const help = spawnSync(process.execPath, ['--no-strip-types', script], {encoding: 'utf8', timeout: 5000, maxBuffer: 8192, env: {}});
  assert.equal(help.status, 0); assert.match(help.stdout, /Windows qualification: NOT RUN/); assert.equal(help.stderr, '');
  const refusal = spawnSync(process.execPath, ['--no-strip-types', script, ...args], {encoding: 'utf8', timeout: 5000, maxBuffer: 8192, env: {}});
  assert.equal(refusal.status, 1); assert.deepEqual(JSON.parse(refusal.stdout), {schemaVersion: 1, status: 'NOT RUN', reason: 'host'});
  assert.equal(refusal.stderr, '');
});

test('fixture spelling excludes UNC/device/relative/Unicode/unsafe components and long roots', () => {
  for (const root of ['C:\\fixtures', 'D:\\user space\\wq-ab12\\c0\\data']) assert.equal(admittedRoot(root), root);
  for (const root of ['C:\\', 'C:relative', '\\\\host\\share', '\\\\?\\C:\\x', 'C:/x', 'C:\\a\\..\\b', 'C:\\nul', 'C:\\COM1.txt', 'C:\\a.',
    'C:\\a ', 'C:\\x\\', 'C:\\한글', 'C:\\a\0b', 'C:\\x:ads', `C:\\${'x'.repeat(140)}`]) assert.throws(() => admittedRoot(root), fault('fixture'));
});

test('missing or incomplete artifact identities fail closed, never self-enroll device bytes', () => {
  for (const value of [null, {}, {schemaVersion: 1, artifactSetId: 'checkpoint928', source: {}, emitted: {}, targets: {'win32-x64': null}}])
    assert.throws(() => validateManifest(value, 'x64'), fault('artifacts'));
  const source = Object.fromEntries(['src/runtime/windows/windows-native.ts', 'src/runtime/windows/windows-singleton-owner.ts',
    'src/runtime/windows/windows-atomic-marker.ts', 'tools/windows-qualification.ts'].map(path => [path, 'a'.repeat(64)]));
  const emitted = Object.fromEntries(Object.keys(source).map(path => [path.replace(/\.ts$/, '.js'), 'b'.repeat(64)]));
  const value = {schemaVersion: 1, artifactSetId: 'checkpoint928', source, emitted, targets: {'win32-x64': null, 'win32-arm64': null}};
  assert.throws(() => validateManifest(value, 'x64'), fault('artifacts')); assert.throws(() => validateManifest(value, 'arm64'), fault('artifacts'));
  assert.throws(() => validateManifest({...value, source: {...source, 'unreviewed.ts': 'a'.repeat(64)}}, 'x64'), fault('artifacts'));
});

test('closed protocol rejects stale/cross-case/cross-role/out-of-order/extra/oversized/malformed data', () => {
  const original = packet(); assert.deepEqual(parsePacket(JSON.stringify(original), original), original);
  for (const changed of [{nonce: 'b'.repeat(24)}, {caseId: 'owner'}, {role: 'b'}, {sequence: 1}, {sequence: 128}, {event: 'untrusted'},
    {status: 'SUCCESS'}, {cleanup: 'assumed'}, {callbacks: -1}, {callbacks: Infinity}, {reads: LIMITS.reads + 1},
    {replacements: 33}, {nativePhase: 'yes'}, {payload: 'PRIVATE'}, {path: 'PRIVATE'}, {handle: 'PRIVATE'}])
    assert.throws(() => parsePacket(JSON.stringify({...original, ...changed}), original), fault('protocol'));
  for (const text of ['{', 'null', '[]', ' '.repeat(4097), JSON.stringify({nonce: original.nonce})])
    assert.throws(() => parsePacket(text, original), fault('protocol'));
});

test('success receipt requires actual matching exit AND close, not process report or kill return', async () => {
  const process = new FakeProcess(); const owned = new OwnedChild(process); let settled = false;
  const completion = verifyOwnedCompletion(owned, packet(), 200).then(() => { settled = true; });
  await delay(5); assert.equal(settled, false); process.emit('exit', 0, null);
  await delay(5); assert.equal(settled, false); process.emit('close', 0, null); await completion;
  assert.equal(settled, true); assert.equal(process.kills, 0);
});

test('early exit, absent exit, absent close, mismatched close and nonzero status cannot pass', async () => {
  const early = new FakeProcess(); const child = new OwnedChild(early); early.finish(); assert.throws(() => child.checkAlive(), fault('early-exit'));
  for (const event of ['none', 'exit', 'close', 'mismatch', 'failure']) {
    const process = new FakeProcess(); const owned = new OwnedChild(process);
    if (event === 'exit') process.emit('exit', 0, null);
    if (event === 'close') process.emit('close', 0, null);
    if (event === 'mismatch') { process.emit('exit', 0, null); process.emit('close', 1, null); }
    if (event === 'failure') process.finish(1);
    await assert.rejects(verifyOwnedCompletion(owned, packet(), 8), QualificationFault);
  }
});

test('unresolved cleanup and failure receipts cannot be overridden by clean process exit', async () => {
  for (const extra of [{cleanup: 'unresolved' as const}, {cleanup: 'none' as const}, {status: 'FAIL' as const}, {status: 'INCONCLUSIVE' as const}, {event: 'held' as const}]) {
    const process = new FakeProcess(); const owned = new OwnedChild(process); process.finish();
    await assert.rejects(verifyOwnedCompletion(owned, packet(extra), 8), fault('protocol'));
  }
});

test('owned-only one-shot kill, kill failure, timeout and poisoned output retain uncertainty', async () => {
  const process = new FakeProcess(); const owned = new OwnedChild(process); owned.terminate(); owned.terminate(); assert.equal(process.kills, 1);
  await assert.rejects(owned.finish(true, 8), fault('timeout'));
  process.finish(null, 'SIGTERM'); await owned.finish(true, 8); await assert.rejects(verifyOwnedCompletion(owned, packet(), 8), fault('exit'));
  const failed = new FakeProcess(); failed.failKill = true; const failedChild = new OwnedChild(failed); failedChild.terminate(); failed.finish(null, 'SIGTERM');
  await assert.rejects(failedChild.finish(true, 8), fault('exit'));
  for (const stream of ['stdout', 'stderr'] as const) {
    const noisy = new FakeProcess(); const noisyChild = new OwnedChild(noisy); noisy[stream].emit('data', Buffer.alloc(LIMITS.outputBytes + 1));
    noisy.finish(); await assert.rejects(verifyOwnedCompletion(noisyChild, packet(), 8), fault('exit'));
    assert.equal(noisyChild.poisoned, true);
  }
});

function driver(caseId: CaseId, breakAt?: string) {
  const events: string[] = []; const children = new Map<string, {process: FakeProcess; owned: OwnedChild}>();
  const receipt = (role: 'a' | 'b' | 'c', sequence: number, event: Packet['event']) => packet({caseId, role, sequence, event});
  const result: CaseDriver = {
    start(mode, role, selector) {
      events.push(`start:${mode}:${role}:${selector ?? '-'}`);
      const process = new FakeProcess(), owned = new OwnedChild(process); children.set(role, {process, owned});
      process.kill = () => { process.kills++; process.finish(null, 'SIGTERM'); return true; }; return owned;
    },
    async receive(role, sequence, event) {
      const key = `receive:${role}:${sequence}:${event}`; events.push(key);
      if (key === breakAt) throw new QualificationFault('protocol'); return receipt(role, sequence, event);
    },
    async send(role, sequence) { events.push(`send:${role}:${sequence}`); },
    async complete(role, sequence) {
      const key = `complete:${role}:${sequence}`; events.push(key); const child = children.get(role)!;
      if (key === breakAt) { child.process.emit('exit', 0, null); await verifyOwnedCompletion(child.owned, receipt(role, sequence, 'done'), 8); }
      child.process.finish(); const report = receipt(role, sequence, 'done'); await verifyOwnedCompletion(child.owned, report, 8); return report;
    },
  };
  return {result, events, children};
}

test('shared real supervisor choreography joins contender before release and holder before reacquire, both directions', async () => {
  for (const id of ['contention-a', 'contention-b'] as const) {
    const fixture = driver(id); await orchestrateCase(id, fixture.result);
    const a = id === 'contention-a' ? 'a' : 'b', b = a === 'a' ? 'b' : 'a';
    assert.deepEqual(fixture.events, [`start:owner:${a}:-`, `receive:${a}:0:held`, `start:contender:${b}:-`, `complete:${b}:0`,
      `send:${a}:0`, `complete:${a}:1`, 'start:fresh:c:-', 'complete:c:0']);
    assert.equal([...fixture.children.values()].every(child => child.owned.exited && child.owned.closed), true);
  }
});

test('shared choreography stops after stale held receipt or success-without-close; no release/reacquire follows', async () => {
  for (const stop of ['receive:a:0:held', 'complete:b:0', 'complete:a:1']) {
    const fixture = driver('contention-a', stop); await assert.rejects(orchestrateCase('contention-a', fixture.result), QualificationFault);
    assert.equal(fixture.events.includes('start:fresh:c:-'), false);
    if (stop !== 'complete:a:1') assert.equal(fixture.events.includes('send:a:0'), false);
  }
});

test('shared death choreography waits actual owned death before fresh process acquisition', async () => {
  const fixture = driver('death'); await orchestrateCase('death', fixture.result);
  assert.equal(fixture.children.get('a')!.process.kills, 1); assert.equal(fixture.children.get('a')!.owned.closed, true);
  assert.deepEqual(fixture.events, ['start:owner:a:-', 'receive:a:0:held', 'start:fresh:c:-', 'complete:c:0']);
});

test('shared replacement choreography requires all 32 old/new observations for each selector before clean completion', async () => {
  for (const id of ['replace-identity', 'replace-ack'] as const) {
    const fixture = driver(id); await orchestrateCase(id, fixture.result);
    assert.equal(fixture.events.filter(event => event.endsWith(':old')).length, 32);
    assert.equal(fixture.events.filter(event => event.endsWith(':new')).length, 32);
    assert.equal(fixture.events.filter(event => event.startsWith('send:a:')).length, 33);
    assert.deepEqual(fixture.events.slice(-2), ['complete:a:33', 'complete:b:64']);
    const failed = driver(id, 'receive:b:21:new'); await assert.rejects(orchestrateCase(id, failed.result), fault('protocol'));
    assert.equal(failed.events.some(event => event.startsWith('complete:')), false);
  }
});

test('optional Rust creates no process; diagnostics cannot serialize raw paths/handles/errors/payloads', async () => {
  const fixture = driver('rust'); await orchestrateCase('rust', fixture.result); assert.deepEqual(fixture.events, []);
  const raw = Object.assign(new Error('PRIVATE C:\\secret username HANDLE'), {stack: 'PRIVATE', payload: 'PRIVATE', handle: 123n});
  const result = safeResult('load', 'FAIL', raw); assert.equal(result.reason, 'native'); assert.equal(result.retained, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|secret|username|HANDLE|payload/);
  assert.equal(safeResult('load', 'INCONCLUSIVE', new QualificationFault('timeout')).reason, 'timeout');
});


test('actual cloud file handshake waits closed payload plus sentinel, refuses stale/oversized/incomplete payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wq-protocol-'));
  try {
    const protocol = protocolForTest(root), expected = packet();
    await assert.rejects(protocol.read(expected, 5), fault('timeout'));
    await protocol.write(expected); assert.deepEqual(await protocol.read(expected), expected);
    await assert.rejects(protocol.write(expected)); // Exclusive immutable slots, no replacement.
    await writeFile(join(root, 'a.out.0.ready'), 'b'.repeat(24));
    await assert.rejects(protocol.read(expected), fault('protocol'));
    await writeFile(join(root, 'a.out.0.ready'), expected.nonce);
    await writeFile(join(root, 'a.out.0.json'), 'x'.repeat(4097));
    await assert.rejects(protocol.read(expected), QualificationFault);
    await writeFile(join(root, 'a.out.0.json'), '{'); await assert.rejects(protocol.read(expected), fault('protocol'));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('cleanup inspection rejects unowned files, lingering native temporaries and symlink escape', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wq-cleanup-'));
  try {
    const protocol = protocolForTest(root); await mkdir(join(root, 'data')); await protocol.write(packet());
    await protocol.inspect();
    await writeFile(join(root, 'foreign.txt'), 'private'); await assert.rejects(protocol.inspect(), fault('cleanup')); await rm(join(root, 'foreign.txt'));
    await writeFile(join(root, 'data', '.codex_discord_rust.marker.retained.tmp'), 'debt');
    await assert.rejects(protocol.inspect(), fault('cleanup')); await rm(join(root, 'data', '.codex_discord_rust.marker.retained.tmp'));
    await symlink(tmpdir(), join(root, 'escape')); await assert.rejects(protocol.inspect(), fault('cleanup'));
  } finally { await rm(root, {recursive: true, force: true}); }
});

test('artifact closure validator accepts only the reviewed seven-file loader shape and exact prebuild resolution targets', () => {
  const source = Object.fromEntries(['src/runtime/windows/windows-native.ts', 'src/runtime/windows/windows-singleton-owner.ts',
    'src/runtime/windows/windows-atomic-marker.ts', 'tools/windows-qualification.ts'].map(path => [path, 'a'.repeat(64)]));
  const emitted = Object.fromEntries(Object.keys(source).map(path => [path.replace(/\.ts$/, '.js'), 'b'.repeat(64)]));
  for (const arch of ['x64', 'arm64']) {
    const prefix = `node_modules/@koromix/koffi-win32-${arch}`;
    const files = Object.fromEntries(['node_modules/koffi/package.json', 'node_modules/koffi/index.cjs', 'node_modules/koffi/src/koffi/index.cjs',
      'node_modules/koffi/src/koffi/src/static.cjs', `${prefix}/package.json`, `${prefix}/index.js`, `${prefix}/win32_${arch}/koffi.node`].map(path => [path, 'c'.repeat(64)]));
    const target = {nodeSha256: 'd'.repeat(64), mainArchiveSha512: 'a'.repeat(86) + '==', prebuildArchiveSha512: 'b'.repeat(86) + '==', files,
      entry: 'node_modules/koffi/index.cjs', prebuildEntry: `${prefix}/index.js`, binary: `${prefix}/win32_${arch}/koffi.node`,
      prebuildName: `@koromix/koffi-win32-${arch}`, forbidden: [`node_modules/koffi/build/koffi/win32_${arch}/koffi.node`]};
    const value = {schemaVersion: 1, artifactSetId: 'checkpoint928', source, emitted, targets: {[`win32-${arch}`]: target}};
    assert.equal(validateManifest(value, arch), value);
    for (const change of [{nodeSha256: null}, {binary: '../outside.node'}, {prebuildEntry: target.binary}, {forbidden: []},
      {prebuildName: 'koffi'}, {files: {...files, 'node_modules/extra.js': 'c'.repeat(64)}}])
      assert.throws(() => validateManifest({...value, targets: {[`win32-${arch}`]: {...target, ...change}}}, arch), fault('artifacts'));
  }
});

test('child mode/case/role/selector and nonce directory structure are a closed matrix', () => {
  const nonce = 'a'.repeat(24), root = `C:\\fixtures\\wq-${nonce}\\c0`;
  const child = ['--child', 'load', 'C:\\source', root, 'load', 'a', nonce, 'identity', 'protocol-1'];
  assert.equal(admitHost(host, child), 'child');
  for (const [index, value] of [[1, 'move'], [3, 'C:\\live-bot'], [4, 'rust'], [5, 'b'], [6, 'b'.repeat(24)], [7, 'ack']] as const) {
    const changed = [...child]; changed[index] = value; assert.throws(() => admitHost(host, changed), fault('arguments'));
  }
});

test('deadline latches pending I/O debt, rejects late continuations and cannot restart after extending time', async () => {
  const clock = new QualificationBudget(8); let release!: () => void; let effects = 0;
  const deferred = new Promise<void>(resolve => { release = resolve; });
  await assert.rejects(clock.step(() => deferred), fault('timeout'));
  assert.equal(clock.pending, 1); assert.equal(clock.uncertainIo, true); clock.end = performance.now() + 10000;
  await assert.rejects(clock.step(async () => { effects++; }), fault('timeout')); assert.equal(effects, 0);
  release(); await delay(1); assert.equal(clock.pending, 0); assert.equal(clock.uncertainIo, true); assert.equal(clock.expired, true);
});

test('actual supervisor lifecycle requires clean terminal receipt and exit/close, uses scrubbed env, then removes only owned files', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wq-managed-')); const root = join(base, 'case'); let childWork: Promise<void> | undefined;
  try {
    const result = await supervisorCaseForTest({root, launch(args, env) {
      assert.deepEqual(Object.keys(env).sort(), ['SystemRoot', 'TEMP', 'TMP']); assert.equal(env.TEMP, root); assert.equal(env.TMP, root);
      assert.equal(args[0], '--no-strip-types'); assert.equal(args[2], '--child'); assert.equal(args[3], 'load');
      const process = new FakeProcess();
      childWork = protocolForTest(root).write(packet()).then(() => { process.finish(); }); return process;
    }});
    await childWork; assert.equal(result.evidence, 'cloud-orchestration'); assert.equal(result.result.status, 'PASS');
    assert.equal(result.result.retained, false); assert.equal(result.result.exited, 1); assert.equal(result.result.closed, 1);
    assert.equal(result.blocked, false); await assert.rejects(mkdir(join(root, 'after')), {code: 'ENOENT'});
  } finally { await rm(base, {recursive: true, force: true}); }
});

test('actual supervisor cleanup rejects an unreceived valid-looking slot and preserves uncertainty', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wq-managed-')); const root = join(base, 'case'); let childWork: Promise<void> | undefined;
  try {
    const result = await supervisorCaseForTest({root, launch() {
      const process = new FakeProcess(); childWork = (async () => {
        await writeFile(join(root, 'a.out.99.json'), '{}'); await protocolForTest(root).write(packet()); process.finish();
      })(); return process;
    }});
    await childWork; assert.equal(result.result.status, 'FAIL'); assert.equal(result.result.reason, 'cleanup');
    assert.equal(result.result.retained, true); assert.equal(result.result.uncertainty.file, true); assert.equal(result.result.uncertainty.native, false);
    assert.equal(result.result.closed, 1);
  } finally { await rm(base, {recursive: true, force: true}); }
});

test('actual supervisor rejects success-before-close, stops case, kills only own child and retains root', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wq-managed-')); const root = join(base, 'case'); let process!: FakeProcess; let childWork: Promise<void> | undefined;
  try {
    const result = await supervisorCaseForTest({root, milliseconds: 150, launch() {
      process = new FakeProcess(); process.kill = () => { process.kills++; process.finish(null, 'SIGTERM'); return true; };
      childWork = protocolForTest(root).write(packet()); return process;
    }});
    await childWork; assert.equal(result.result.status, 'INCONCLUSIVE'); assert.equal(result.result.reason, 'timeout');
    assert.equal(result.result.retained, true); assert.equal(result.blocked, true); assert.equal(process.kills, 1);
    assert.equal(result.result.uncertainty.native, true); assert.equal(result.result.exited, 1); assert.equal(result.result.closed, 1);
  } finally { await rm(base, {recursive: true, force: true}); }
});

test('actual supervisor unobserved native phase retains fixture honestly despite proved clean process closure', async () => {
  const base = await mkdtemp(join(tmpdir(), 'wq-managed-')); const root = join(base, 'case'); let childWork: Promise<void> | undefined;
  try {
    const result = await supervisorCaseForTest({root, caseId: 'native-phase', launch() {
      const process = new FakeProcess(); childWork = protocolForTest(root).write(packet({caseId: 'native-phase', status: 'INCONCLUSIVE'})).then(() => { process.finish(); });
      return process;
    }});
    await childWork; assert.equal(result.result.status, 'INCONCLUSIVE'); assert.equal(result.result.reason, 'unobserved');
    assert.equal(result.result.retained, true); assert.deepEqual(result.result.uncertainty, {native: false, file: false, process: false});
    assert.equal(result.result.exited, 1); assert.equal(result.result.closed, 1);
  } finally { await rm(base, {recursive: true, force: true}); }
});

test('actual dependency closure reads immutable mock bytes and rejects changes, fallback and nested resolution without loading code', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wq-artifacts-'));
  const prefix = 'node_modules/@koromix/koffi-win32-x64';
  const fixture: Record<string, string> = {
    'node_modules/koffi/package.json': '{"name":"koffi","main":"index.cjs"}',
    'node_modules/koffi/index.cjs': 'throw new Error("must never execute");',
    'node_modules/koffi/src/koffi/index.cjs': 'throw new Error("must never execute");',
    'node_modules/koffi/src/koffi/src/static.cjs': 'throw new Error("must never execute");',
    [`${prefix}/package.json`]: '{"name":"@koromix/koffi-win32-x64","main":"index.js"}',
    [`${prefix}/index.js`]: 'throw new Error("must never execute");',
    [`${prefix}/win32_x64/koffi.node`]: 'inert cloud bytes, never native code',
  };
  const files = Object.fromEntries(Object.entries(fixture).map(([path, content]) => [path, createHash('sha256').update(content).digest('hex')]));
  const target = {files, entry: 'node_modules/koffi/index.cjs', prebuildEntry: `${prefix}/index.js`, binary: `${prefix}/win32_x64/koffi.node`,
    prebuildName: '@koromix/koffi-win32-x64', forbidden: ['node_modules/koffi/build/koffi/win32_x64/koffi.node']};
  try {
    for (const [path, content] of Object.entries(fixture)) { await mkdir(dirname(join(root, path)), {recursive: true}); await writeFile(join(root, path), content); }
    assert.deepEqual(await verifyDependencyClosure(root, target), files);
    await writeFile(join(root, target.entry), 'tampered'); await assert.rejects(verifyDependencyClosure(root, target), fault('artifacts'));
    await writeFile(join(root, target.entry), fixture[target.entry]!);
    const fallback = join(root, target.forbidden[0]!); await mkdir(dirname(fallback), {recursive: true}); await writeFile(fallback, 'never load');
    await assert.rejects(verifyDependencyClosure(root, target), fault('artifacts')); await rm(fallback);
    // Immutable staging: a shadow must exist before this parent path's first
    // resolution. Node caches require.resolve; mutating a previously resolved
    // staging tree is outside the native gate's trusted-directory contract.
    const shadowRoot = await mkdtemp(join(tmpdir(), 'wq-shadow-'));
    try {
      for (const [path, content] of Object.entries(fixture)) { await mkdir(dirname(join(shadowRoot, path)), {recursive: true}); await writeFile(join(shadowRoot, path), content); }
      const shadow = join(shadowRoot, 'node_modules/koffi/src/koffi/src/node_modules/@koromix/koffi-win32-x64');
      await mkdir(shadow, {recursive: true}); await writeFile(join(shadow, 'package.json'), '{"main":"index.js"}'); await writeFile(join(shadow, 'index.js'), 'never load');
      await assert.rejects(verifyDependencyClosure(shadowRoot, target), fault('artifacts'));
    } finally { await rm(shadowRoot, {recursive: true, force: true}); }
  } finally { await rm(root, {recursive: true, force: true}); }
});


test('shared owned-child admission enforces cap, unique roles, stop latch and poisoned-group refusal', () => {
  const state = {stopped: false, end: performance.now() + 1000, children: [] as {role: string; closed: boolean; poisoned: boolean}[]};
  admitOwnedChild(state, 'a');
  for (const role of ['a', 'b', 'c']) state.children.push({role, closed: false, poisoned: false});
  assert.throws(() => admitOwnedChild(state, 'd'), fault('budget'));
  state.children[0]!.closed = true; admitOwnedChild(state, 'd');
  assert.throws(() => admitOwnedChild(state, 'a'), fault('budget'));
  state.children[0]!.poisoned = true; assert.throws(() => admitOwnedChild(state, 'd'), fault('budget'));
  state.children.length = 0; state.stopped = true; assert.throws(() => admitOwnedChild(state, 'a'), fault('budget'));
});


test('transition-local deadline wins over broader case budget and records only genuinely pending I/O', async () => {
  const clock = new QualificationBudget(1000);
  await assert.rejects(clock.step(() => new Promise<void>(() => {}), performance.now() + 8), fault('timeout'));
  assert.equal(clock.pending, 1); assert.equal(clock.uncertainIo, true); assert.equal(clock.expired, true);
  const finished = new QualificationBudget(1000);
  await assert.rejects(finished.step(async () => {
    const end = performance.now() + 15; while (performance.now() < end) { /* deterministic overdue settled operation */ }
  }, performance.now() + 5), fault('timeout'));
  assert.equal(finished.pending, 0); assert.equal(finished.uncertainIo, false); assert.equal(finished.expired, true);
});


test('all path arguments and derived fixture bounds are admitted before artifact reads', () => {
  for (const invalid of ['relative', 'C:/forward', 'C:\\한글', `C:\\${'x'.repeat(120)}`]) {
    const changed = [...args]; changed[4] = invalid; assert.throws(() => admitHost(host, changed), fault('fixture'));
  }
  const changed = [...args]; changed[2] = '\\\\server\\share'; assert.throws(() => admitHost(host, changed), fault('fixture'));
  const nonce = 'a'.repeat(24);
  assert.throws(() => admitHost(host, ['--child', 'load', 'relative', `C:\\f\\wq-${nonce}\\c0`, 'load', 'a', nonce, 'identity', 'protocol-1']), fault('fixture'));
});
