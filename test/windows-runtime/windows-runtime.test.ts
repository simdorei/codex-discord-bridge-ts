import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {acquireRuntimePlatform} from '../../src/runtime/runtime-platform.ts';
import {WindowsRuntimeInstance} from '../../src/runtime/windows/windows-runtime-instance.ts';
import {WindowsDrainMarkerStore} from '../../src/runtime/windows/windows-drain-marker.ts';
import {WindowsSingletonOwnerError} from '../../src/runtime/windows/windows-singleton-owner.ts';
import {RUNTIME_LOCK_NAME} from '../../src/runtime/runtime-instance.ts';
import {RUNTIME_HEARTBEAT_NAME, encodeRuntimeHeartbeat} from '../../src/runtime/runtime-heartbeat.ts';
import {RuntimeDrainController} from '../../src/runtime/restart-readiness/drain-controller.ts';
import {DRAIN_MARKER_NAMES} from '../../src/runtime/restart-readiness/drain-marker.ts';
import {enrollLocalStoreAuthority} from '../../src/runtime/discord-runtime/store-authority-profile.ts';
import {loadRuntimeConfig} from '../../src/config/runtime.ts';
import {runLocalRuntimeApplication} from '../../src/runtime/discord-runtime/local-application.ts';
import {RuntimeStoragePreparationError} from '../../src/runtime/discord-runtime/storage-preparation.ts';
import {ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {NativeBridgeStateOwner} from '../../src/runtime/bridge-state-native.ts';

const windows = {skip: process.platform !== 'win32', timeout: 15000};
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'cdr-npm-win-'));
  try { await run(root); } finally { await rm(root, {recursive: true, force: true}); }
}
async function contend(root: string): Promise<number | null> {
  const module = new URL('../../src/runtime/windows/windows-runtime-instance.js', import.meta.url).href;
  const code = `import {WindowsRuntimeInstance} from ${JSON.stringify(module)};
    try {const owner=await WindowsRuntimeInstance.acquire(${JSON.stringify(root)});await owner.release();}
    catch(error){process.exitCode=error.reason==='already-exists'?2:3;}`;
  const child = spawn(process.execPath, ['--no-strip-types', '--input-type=module', '-e', code], {stdio: 'ignore', windowsHide: true});
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
}

test('Windows native singleton excludes an OS process, then admits it after joined release', windows, async () => fixture(async root => {
  const platform = await acquireRuntimePlatform(root);
  try {
    assert.ok(platform.instance instanceof WindowsRuntimeInstance);
    assert.match(await readFile(join(root, RUNTIME_LOCK_NAME), 'utf8'), /^pid=\d+\nstarted_at=\d+\n$/);
    await assert.rejects(WindowsRuntimeInstance.acquire(root), WindowsSingletonOwnerError);
    assert.equal(await contend(root), 2);
  } finally { await platform.instance.release(); }
  assert.equal(await contend(root), 0);
  assert.deepEqual(await readdir(root), []);
}));

test('Unicode and extended-length runtime roots retain native exclusion and replace bridge state', windows, async () => fixture(async parent => {
  for (const root of [join(parent, '한글 İ 😀'), join(parent, 'long'.repeat(30), 'path'.repeat(30), '한글')]) {
    const {instance, heartbeat} = await acquireRuntimePlatform(root);
    try {
      assert.equal(await contend(root), 2);
      const state = new NativeBridgeStateOwner(join(root, 'bridge.json'));
      await state.execute({kind: 'Select', id: '첫 번째'});
      await state.execute({kind: 'Select', id: '두 번째'});
      assert.equal(await state.execute({kind: 'Selected'}), '두 번째');
      await heartbeat.publish('pid=1\nupdated_at=1\n');
      await heartbeat.removeIfOwned('pid=1\nupdated_at=1\n');
    } finally { await instance.release(); }
    assert.equal(await contend(root), 0);
    assert.deepEqual(await readdir(root), ['bridge.json']);
  }
}));

test('Windows heartbeat and drain writes serialize, replace atomically and clean only owned markers', windows, async () => fixture(async root => {
  const {instance, markers, heartbeat} = await acquireRuntimePlatform(root);
  const controller = await RuntimeDrainController.initialize(markers);
  const last = encodeRuntimeHeartbeat(process.pid, 13n);
  try {
    await Promise.all([heartbeat.publish(encodeRuntimeHeartbeat(process.pid, 12n)), heartbeat.publish(last),
      markers.publishIdentity({runtimeId: controller.runtimeId, processId: process.pid})]);
    assert.equal(await readFile(join(root, RUNTIME_HEARTBEAT_NAME), 'utf8'), last);
    const prepare = `version=1\nruntime_id=${controller.runtimeId}\nprocess_identity=${process.pid}|123\nnonce=npm-native\n`;
    await writeFile(join(root, DRAIN_MARKER_NAMES.prepare), prepare);
    const fence = await controller.claimPrepare(); assert.ok(fence);
    await controller.acknowledge(fence);
    assert.equal(await readFile(join(root, DRAIN_MARKER_NAMES.ack), 'utf8'), prepare + 'state=sealed\n');
    await writeFile(join(root, DRAIN_MARKER_NAMES.restart), prepare);
    assert.equal(await controller.waitForTransition(fence, false, new AbortController().signal), 'Restart');
    await markers.removeAckIfOwned(fence);
    await heartbeat.removeIfOwned(last);
    await writeFile(join(root, RUNTIME_LOCK_NAME), 'foreign replacement');
  } finally { await controller.dispose(); await instance.release(); }
  assert.equal(await readFile(join(root, RUNTIME_LOCK_NAME), 'utf8'), 'foreign replacement');
  assert.ok(!(await readdir(root)).some(name => name.endsWith('.tmp') || name === DRAIN_MARKER_NAMES.identity || name === RUNTIME_HEARTBEAT_NAME));
}));

test('Windows release waits for an already admitted marker before closing native ownership', windows, async () => fixture(async root => {
  const instance = await WindowsRuntimeInstance.acquire(root);
  const pending = instance.publishMarker('heartbeat', 'pid=1\nupdated_at=1\n');
  const released = instance.release();
  assert.throws(() => instance.publishMarker('heartbeat', 'late'), /currently held/);
  await pending; await released;
  assert.equal(await contend(root), 0);
}));

test('Windows store accounting prevents release until original owners close', windows, async () => fixture(async root => {
  const instance = await WindowsRuntimeInstance.acquire(root);
  const paths = {root, mirrorDb: join(root, 'discord_mirror.sqlite')};
  const domain = enrollLocalStoreAuthority(instance, paths, {kind: 'StoreAuthorityAccountingOnly'});
  try {
    assert.throws(() => instance.release(), /must close/);
    assert.throws(() => new WindowsDrainMarkerStore(root + '-other', instance));
    assert.throws(() => new WindowsDrainMarkerStore(root, Object.create(WindowsRuntimeInstance.prototype)));
    assert.equal(await contend(root), 2);
  } finally { domain.closeAfterOwnersJoined(); await instance.release(); }
  assert.throws(() => enrollLocalStoreAuthority(instance, paths, {kind: 'StoreAuthorityAccountingOnly'}));
}));

test('Windows failed publication preserves foreign target and releases its acquired handle', windows, async () => fixture(async root => {
  const marker = join(root, RUNTIME_LOCK_NAME); await mkdir(marker);
  await assert.rejects(WindowsRuntimeInstance.acquire(root));
  assert.deepEqual(await readdir(root), [RUNTIME_LOCK_NAME]);
  await rm(marker, {recursive: true});
  const next = await WindowsRuntimeInstance.acquire(root); await next.release();
}));

test('Windows orphaned drain state is preserved while the new singleton releases', windows, async () => fixture(async root => {
  await writeFile(join(root, DRAIN_MARKER_NAMES.prepare), 'prior-runtime');
  const {instance, markers} = await acquireRuntimePlatform(root);
  try { await assert.rejects(RuntimeDrainController.initialize(markers), {kind: 'OrphanedState'}); }
  finally { await instance.release(); }
  assert.equal(await readFile(join(root, DRAIN_MARKER_NAMES.prepare), 'utf8'), 'prior-runtime');
  assert.equal(await contend(root), 0);
}));

test('Windows application reaches storage and joins failed startup without Discord or Codex access', windows, async () => fixture(async root => {
  const config = {...loadRuntimeConfig(new Map([['DISCORD_BOT_TOKEN', 'offline-fixture'], ['DISCORD_ALLOW_ALL_CHANNELS', '1']])), sessionMirror: false};
  const env = {USERPROFILE: root, CODEX_HOME: root, CODEX_STATE_DB: join(root, 'missing-state.sqlite'), CODEX_EXE: process.execPath};
  await assert.rejects(runLocalRuntimeApplication(config, env, root, 'fixture', undefined, {kind: 'StoreAuthorityAccountingOnly'}), RuntimeStoragePreparationError);
  assert.ok(!(await readdir(root)).some(name => name === RUNTIME_LOCK_NAME || name === DRAIN_MARKER_NAMES.identity));
  assert.equal(await contend(root), 0);
  assert.ok(Object.values(ownedWorkerUsage()).every(value => value === 0));
}));
