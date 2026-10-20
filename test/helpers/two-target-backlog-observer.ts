import assert from 'node:assert/strict';
import fs, {type FileHandle} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {OwnedWorkerSlot} from '../../src/runtime/owned-worker-slot.ts';

type ActualRead = {path: string; position: unknown; requested: unknown; returned: number};
type Interval = {reads: ActualRead[]; calls: Record<string, number>; decoderResponses: unknown[]};

/** Exact rollout opens only; forward the same receiver/arguments/result/errors.
 * No source bytes are copied or parsed by the observer. Metadata-only opens do
 * not contribute bytes. Each returned count comes from the real FileHandle.read.
 * Main-isolate interception deliberately makes no cold/native-isolate IO claim. */
export function observeWork(rollouts: readonly string[]) {
  let active: Interval | null = null;
  const readsByPath: Record<string, number> = {};
  const originalOpen = fs.open, originalRun = OwnedWorkerSlot.prototype.run;
  fs.open = async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (typeof args[0] === 'string' && rollouts.includes(args[0])) {
      const originalRead = handle.read;
      handle.read = async function (this: FileHandle, ...readArgs: unknown[]) {
        const interval = active;
        const result = await Reflect.apply(originalRead, this, readArgs) as {bytesRead: number; buffer: NodeJS.ArrayBufferView};
        if (interval !== null) {
          interval.reads.push({path: args[0] as string, position: readArgs[3], requested: readArgs[2], returned: result.bytesRead});
          const path = args[0] as string; readsByPath[path] = (readsByPath[path] ?? 0) + 1;
        }
        return result;
      } as FileHandle['read'];
    }
    return handle;
  };
  syncBuiltinESMExports();
  OwnedWorkerSlot.prototype.run = function (this: OwnedWorkerSlot, url, data, timeout, signal) {
    const interval = active;
    const module = url.pathname.split('/').at(-1)!.replace(/\.(?:ts|js)$/, '');
    const kind = data !== null && typeof data === 'object' ? Object.getOwnPropertyDescriptor(data, 'kind')?.value : undefined;
    const key = module + (typeof kind === 'string' ? ':' + kind : '');
    if (interval !== null) interval.calls[key] = (interval.calls[key] ?? 0) + 1;
    const pending = originalRun.call(this, url, data, timeout, signal);
    return pending.then(result => {
      if (interval !== null && module === 'decode-worker') interval.decoderResponses.push(result);
      return result;
    });
  };
  return {
    readCalls(path: string): number {return readsByPath[path] ?? 0;},
    start(): Interval {
      assert.equal(active, null);
      active = {reads: [], calls: {}, decoderResponses: []};
      return active;
    },
    stop(): void {active = null;},
    restore(): void {
      active = null;
      OwnedWorkerSlot.prototype.run = originalRun;
      fs.open = originalOpen;
      syncBuiltinESMExports();
    },
  };
}

/** Reconcile actual reads against the frozen logical ranges. A real short read
 * may split a range, so FileHandle call count is recorded, not an acceptance
 * constant. Every byte, including read-ahead and both anchor pairs, is included. */
export function readAccounting(reads: readonly ActualRead[], start: number, next: number, dataBytes: number) {
  const ranges = [{position: start - 256, length: 256, data: false}, {position: 0, length: 256, data: false}];
  if (dataBytes > 0) ranges.push({position: start, length: dataBytes, data: true});
  if (next > start) ranges.push({position: next - 256, length: 256, data: false}, {position: 0, length: 256, data: false});
  let index = 0, data = 0, anchors = 0;
  for (const range of ranges) {
    let used = 0;
    while (used < range.length) {
      const read = reads[index++];
      assert.ok(read, 'missing actual rollout read');
      assert.equal(read.position, BigInt(range.position + used));
      assert.equal(read.requested, range.length - used);
      assert.ok(Number.isSafeInteger(read.returned) && read.returned > 0 && read.returned <= range.length - used);
      used += read.returned;
      if (range.data) data += read.returned; else anchors += read.returned;
    }
  }
  assert.equal(index, reads.length, 'unaccounted rollout read');
  return {dataBytes: data, anchorBytes: anchors, returnedBytes: data + anchors, readCalls: reads.length};
}

export function expectedCalls(records: number): Record<string, number> {
  return {
    'cursor-store-worker:Read': 1,
    'decode-worker': 1,
    ...(records === 0 ? {} : {
      'ownership-worker': records + 1,
      'receipt-plan-worker': 1,
      'receipt-store-worker:Begin': records,
      'receipt-store-worker:Confirm': records,
      'cursor-store-worker:MixedAdvance': 1,
    }),
  };
}
