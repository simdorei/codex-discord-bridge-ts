import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile, mkdir, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PosixRuntimeInstance, RUNTIME_LOCK_NAME, RUNTIME_SOCKET_NAME} from '../../src/runtime/runtime-instance.ts';

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'cdr-i-'));
  try { await run(root); } finally { await rm(root, {recursive: true, force: true}); }
}
test('singleton excludes another owner, joins release and can reacquire', async () => {
  await fixture(async root => {
    const first = await PosixRuntimeInstance.acquire(root);
    try {
      assert.match(await readFile(join(root, RUNTIME_LOCK_NAME), 'utf8'), /^pid=\d+\nstarted_at=\d+\n$/);
      await assert.rejects(PosixRuntimeInstance.acquire(root), {code: 'EADDRINUSE'});
    } finally { await first.release(); }
    await first.release();
    const second = await PosixRuntimeInstance.acquire(root);
    await second.release();
  });
});
test('canonical root aliases cannot acquire separate ownership', async () => {
  await fixture(async root => {
    const target = join(root, 'target'), alias = join(root, 'alias');
    await mkdir(target); await symlink(target, alias);
    const first = await PosixRuntimeInstance.acquire(target);
    try { await assert.rejects(PosixRuntimeInstance.acquire(alias), {code: 'EADDRINUSE'}); }
    finally { await first.release(); }
  });
});
test('occupied socket name is never removed on acquisition failure', async () => {
  await fixture(async root => {
    const socket = join(root, RUNTIME_SOCKET_NAME);
    await writeFile(socket, 'foreign');
    await assert.rejects(PosixRuntimeInstance.acquire(root), {code: 'EADDRINUSE'});
    assert.equal(await readFile(socket, 'utf8'), 'foreign');
  });
});
test('marker publication failure releases socket without deleting foreign marker', async () => {
  await fixture(async root => {
    await mkdir(join(root, RUNTIME_LOCK_NAME));
    await assert.rejects(PosixRuntimeInstance.acquire(root));
    await rm(join(root, RUNTIME_LOCK_NAME), {recursive: true});
    const owner = await PosixRuntimeInstance.acquire(root); await owner.release();
  });
});
test('release preserves replaced marker bytes', async () => {
  await fixture(async root => {
    const owner = await PosixRuntimeInstance.acquire(root);
    await writeFile(join(root, RUNTIME_LOCK_NAME), 'replacement');
    await owner.release();
    assert.equal(await readFile(join(root, RUNTIME_LOCK_NAME), 'utf8'), 'replacement');
  });
});
test('relative roots are refused', async () => {
  await assert.rejects(PosixRuntimeInstance.acquire('relative'), TypeError);
});

test('another OS process is excluded while the owner is alive', async () => {
  const {spawn} = await import('node:child_process');
  const moduleUrl = new URL('../../src/runtime/runtime-instance.ts', import.meta.url).href.replace(/\.ts$/, '.js');
  await fixture(async root => {
    const owner = await PosixRuntimeInstance.acquire(root);
    async function probe(): Promise<number | null> {
      const source = `import {PosixRuntimeInstance} from ${JSON.stringify(moduleUrl)}; try { const owner = await PosixRuntimeInstance.acquire(${JSON.stringify(root)}); await owner.release(); } catch (e) { process.exitCode = e.code === 'EADDRINUSE' ? 2 : 3; }`;
      const child = spawn(process.execPath, ['--no-strip-types', '--input-type=module', '-e', source], {stdio: 'ignore'});
      return await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    }
    try { assert.equal(await probe(), 2); } finally { await owner.release(); }
    assert.equal(await probe(), 0);
  });
});
