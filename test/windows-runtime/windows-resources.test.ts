import assert from 'node:assert/strict';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {windowsResourceReport} from '../../src/runtime/windows/windows-resources.ts';
import {OwnedWorkerBusyError, ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {StoreAuthorityDomain} from '../../src/store/store-authority-domain.ts';

const windows = {skip: process.platform !== 'win32'};
test('native resource sampling reports measured CPU, physical RAM and caller disk units', windows, async () => {
  const report = await windowsResourceReport(tmpdir());
  assert.match(report, /CPU sample 0\.[2-9]\ds/);
  const percent = Number(/CPU: ([\d.]+)%/.exec(report)?.[1]);
  assert.ok(percent >= 0 && percent <= 100);
  assert.match(report, /RAM: .*GiB/); assert.match(report, /Disk: .*GiB/);
  assert.ok(!report.includes('조회 실패'));
});
test('disk failure preserves independent CPU and RAM observations', windows, async () => {
  const report = await windowsResourceReport(join(tmpdir(), 'cdr-resource-absent-' + crypto.randomUUID()));
  assert.match(report, /CPU: [\d.]+%/); assert.match(report, /RAM: .*GiB/);
  assert.match(report, /Disk: 조회 실패 · GetDiskFreeSpaceExW/);
});
test('cancelled resource probe joins native exit before freeing its single slot', windows, async () => {
  const stop = new AbortController(), reason = new Error('cancel');
  const pending = windowsResourceReport(tmpdir(), stop.signal);
  await assert.rejects(windowsResourceReport(tmpdir()), OwnedWorkerBusyError);
  stop.abort(reason); await assert.rejects(pending, e => e === reason);
  assert.equal(ownedWorkerUsage().Background, 0);
});
test('resource probe remains registered and read-only under enrolled store accounting', windows, async () => {
  const domain = StoreAuthorityDomain.enroll(join(tmpdir(), 'cdr-resource-domain-' + crypto.randomUUID() + '.sqlite'));
  const revision = domain.snapshot().revision;
  const pending = windowsResourceReport(tmpdir());
  try {
    assert.equal(domain.snapshot().writers, 0);
    assert.match(await pending, /CPU: [\d.]+%/);
    assert.equal(domain.snapshot().revision, revision);
  } finally { await pending.catch(() => {}); domain.closeAfterOwnersJoined(); }
});
