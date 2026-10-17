import {createRequire} from 'node:module';
import {toNamespacedPath} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {parentPort, workerData as input} from 'node:worker_threads';

if (parentPort === null || process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch))
  throw new Error('Expected owned Windows resource worker');
const koffi = createRequire(import.meta.url)('koffi');
if (koffi.version !== '3.3.3') throw new Error('Unexpected native binding version');
const library = koffi.load('kernel32.dll');
const lastError = library.func('uint32_t __stdcall GetLastError(void)');
const cpu = library.func('int32_t __stdcall GetSystemTimes(void *idle, void *kernel, void *user)');
const memory = library.func('int32_t __stdcall GlobalMemoryStatusEx(void *status)');
const disk = library.func('int32_t __stdcall GetDiskFreeSpaceExW(str16 path, void *available, void *total, void *free)');
const processors = library.func('uint32_t __stdcall GetActiveProcessorCount(uint16_t group)');
const checked = (value: number, api: string) => { if (value === 0) throw new Error(`${api}: Win32 ${lastError()}`); return value; };
const gib = (bytes: bigint) => {const n = bytes * 100n / (1n << 30n); return `${n / 100n}.${String(n % 100n).padStart(2, '0')} GiB`;};
const capture = <T>(work: () => T): {value: T} | {error: string} => {try {return {value: work()};} catch (e) {return {error: e instanceof Error ? e.message : 'Native observation failed'};}};
function cpuTimes() {
  const idle = Buffer.alloc(8), kernel = Buffer.alloc(8), user = Buffer.alloc(8);
  checked(cpu(idle, kernel, user), 'GetSystemTimes');
  return {idle: idle.readBigUInt64LE(), kernel: kernel.readBigUInt64LE(), user: user.readBigUInt64LE()};
}
try {
  const before = capture(cpuTimes), start = performance.now();
  const ram = capture(() => {
    const data = Buffer.alloc(64); data.writeUInt32LE(64); checked(memory(data), 'GlobalMemoryStatusEx');
    const total = data.readBigUInt64LE(8), available = data.readBigUInt64LE(16);
    if (total === 0n || available > total) throw new Error('Invalid physical memory counters');
    return `RAM: 사용 ${gib(total - available)} / 전체 ${gib(total)} · 사용 가능 ${gib(available)}`;
  });
  const space = capture(() => {
    const total = Buffer.alloc(8), available = Buffer.alloc(8), free = Buffer.alloc(8);
    checked(disk(toNamespacedPath(input.path), available, total, free), 'GetDiskFreeSpaceExW');
    const t = total.readBigUInt64LE(), a = available.readBigUInt64LE();
    if (t === 0n || a > t) throw new Error('Invalid caller disk counters');
    return `Disk: 사용자 할당 전체 ${gib(t)} · 사용자 사용 가능 ${gib(a)} · 볼륨 free ${gib(free.readBigUInt64LE())}`;
  });
  const count = capture(() => checked(processors(0xffff), 'GetActiveProcessorCount'));
  let elapsed: number | null = null, percent: {value: string} | {error: string};
  if ('error' in before) percent = before;
  else {
    await delay(Math.max(0, 200 - (performance.now() - start)));
    percent = capture(() => {
      const after = cpuTimes(), idle = after.idle - before.value.idle, kernel = after.kernel - before.value.kernel, user = after.user - before.value.user;
      const total = kernel + user;
      if (idle < 0n || kernel < 0n || user < 0n || total <= 0n || idle > total) throw new Error('CPU sample interval is empty or inconsistent');
      elapsed = performance.now() - start;
      return `${(Number((total - idle) * 10000n / total) / 100).toFixed(2)}%`;
    });
  }
  const text = [elapsed === null ? 'Host resources · CPU sample unavailable' : `Host resources · CPU sample ${(elapsed / 1000).toFixed(2)}s`,
    'CPU: ' + ('value' in percent ? percent.value : `조회 실패 · ${percent.error}`),
    'value' in count ? `논리 CPU: ${count.value}${count.value > 64 ? ' · CPU%는 primary processor group 범위이며 전체 CPU가 아님' : ''}` : `CPU 측정 범위 미확인: ${count.error}`,
    'value' in ram ? ram.value : `RAM: 조회 실패 · ${ram.error}`, 'value' in space ? space.value : `Disk: 조회 실패 · ${space.error}`].join('\n');
  parentPort.postMessage({id: input.id, path: input.path, text});
} finally { parentPort.close(); }
