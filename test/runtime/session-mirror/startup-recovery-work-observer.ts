import fs, {type FileHandle} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {getEnvironmentData, setEnvironmentData, isMainThread, threadId} from 'node:worker_threads';
import {OwnedWorkerSlot} from '../../../src/runtime/owned-worker-slot.ts';
import {activeMirrorFileReads} from '../../../src/runtime/session-mirror/file-window.ts';

const KEY = 'checkpoint935-read-work';
const HEADER = 16, CAPACITY = 1024, STRIDE = 4;
export type ActualRead = {position: number; requested: number; returned: number; failed: number};
type Configuration = {rollout: string; buffer: SharedArrayBuffer};
export type WorkerObservation = {
  kind: string; module: string; ready: number; threadId: number; exited: number;
  opens: number; closes: number; handles: number; activeFileReads: number;
  overflow: number; observerErrors: number; readFailures: number; closeFailures: number;
  reads: ActualRead[]; responseReceived: boolean;
};

// Loaded with --import inside the ORIGINAL native worker. The real entry module,
// workerData, ACK channel, cancellation buffer, and deadlines are unchanged.
if (!isMainThread) {
  const configuration = getEnvironmentData(KEY) as Configuration | undefined;
  if (configuration !== undefined) {
    const cells = new Int32Array(configuration.buffer), originalOpen = fs.open;
    fs.open = async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (args[0] === configuration.rollout) {
        Atomics.add(cells, 1, 1); Atomics.add(cells, 3, 1);
        const originalRead = handle.read, originalClose = handle.close;
        handle.read = async function (this: FileHandle, ...readArgs: unknown[]) {
          let result: Awaited<ReturnType<FileHandle['read']>>;
          try {result = await Reflect.apply(originalRead, this, readArgs);}
          catch (error) {Atomics.add(cells, 9, 1); throw error;}
          // Telemetry never changes a successful read into an observer error.
          // Invalid/overflow evidence instead fails acceptance after native join.
          try {
            const index = Atomics.add(cells, 0, 1), position = readArgs[3], requested = readArgs[2];
            if (index >= CAPACITY) Atomics.store(cells, 6, 1);
            else if (typeof position !== 'bigint' || position < 0n || position > 2_147_483_647n ||
              typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < 0 || requested > 2_147_483_647 ||
              !Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 || result.bytesRead > requested) Atomics.store(cells, 7, 1);
            else {
              const at = HEADER + index * STRIDE;
              Atomics.store(cells, at, Number(position)); Atomics.store(cells, at + 1, requested);
              Atomics.store(cells, at + 2, result.bytesRead); Atomics.store(cells, at + 3, 0);
            }
          } catch {Atomics.store(cells, 7, 1);}
          return result;
        } as FileHandle['read'];
        handle.close = async function (this: FileHandle, ...closeArgs: Parameters<FileHandle['close']>) {
          try {
            const result = await Reflect.apply(originalClose, this, closeArgs);
            Atomics.add(cells, 2, 1); Atomics.sub(cells, 3, 1); return result;
          } catch (error) {Atomics.add(cells, 10, 1); throw error;}
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    Atomics.store(cells, 8, threadId);
    Atomics.store(cells, 11, 1);
    process.once('exit', () => {
      Atomics.store(cells, 5, activeMirrorFileReads());
      fs.open = originalOpen; syncBuiltinESMExports();
      Atomics.store(cells, 4, 1);
    });
  }
}

/** Launch this emitted module via --import in the real test process argv.
 * Original workers inherit the genuine startup preload; never mutate execArgv.
 * Only the preload and isolated telemetry are added. No worker replacement,
 * extra ACK messages, source-byte parsing, fabricated result, or extra IO. */
export function observeStartupRecoveryWork(rollout: string) {
  if (!isMainThread) throw new Error('Observer owner must be main isolate');
  const originalRun = OwnedWorkerSlot.prototype.run;
  const originalEnvironment = getEnvironmentData(KEY);
  const rows: {kind: string; module: string; cells: Int32Array; responseReceived: boolean; response?: unknown}[] = [];
  OwnedWorkerSlot.prototype.run = function (this: OwnedWorkerSlot, url, data, timeout, signal) {
    const kind = data !== null && typeof data === 'object' ? Object.getOwnPropertyDescriptor(data, 'kind')?.value : undefined;
    const row = {kind: typeof kind === 'string' ? kind : 'Unknown', module: url.pathname.split('/').at(-1)!.replace(/\.(?:ts|js)$/, ''),
      cells: new Int32Array(new SharedArrayBuffer((HEADER + CAPACITY * STRIDE) * 4)), responseReceived: false} as typeof rows[number];
    rows.push(row);
    setEnvironmentData(KEY, {rollout, buffer: row.cells.buffer});
    // Worker creation snapshots environment data synchronously in originalRun.
    let pending: Promise<unknown>;
    try {pending = originalRun.call(this, url, data, timeout, signal);}
    finally {setEnvironmentData(KEY, originalEnvironment);}
    return pending.then(response => {row.responseReceived = true; row.response = response; return response;});
  };
  return {
    responses: () => rows.map(row => row.response),
    snapshot(): WorkerObservation[] {
      return rows.map(row => {
        const n = (index: number) => Atomics.load(row.cells, index);
        return {kind: row.kind, module: row.module, ready: n(11), threadId: n(8), exited: n(4), opens: n(1), closes: n(2),
          handles: n(3), activeFileReads: n(5), overflow: n(6), observerErrors: n(7), readFailures: n(9), closeFailures: n(10),
          responseReceived: row.responseReceived,
          reads: Array.from({length: Math.min(n(0), CAPACITY)}, (_, index) => ({position: n(HEADER + index * STRIDE),
            requested: n(HEADER + index * STRIDE + 1), returned: n(HEADER + index * STRIDE + 2), failed: n(HEADER + index * STRIDE + 3)}))};
      });
    },
    restore(): void {
      OwnedWorkerSlot.prototype.run = originalRun;
      setEnvironmentData(KEY, originalEnvironment);
    },
  };
}
