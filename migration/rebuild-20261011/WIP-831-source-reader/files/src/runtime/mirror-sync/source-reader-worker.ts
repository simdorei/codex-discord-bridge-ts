import {parentPort, workerData as input} from 'node:worker_threads';
import {CodexThreadStore} from '../../codex-state/store.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
const port = parentPort;
if (port === null) throw new Error('Owned source reader required');
const binding = {id: input.id, path: input.path, kind: input.kind, thread: input.thread, archived: input.archived};
try {
  if (process.platform === 'win32') throw new Error('Windows source reader unqualified');
  const store = CodexThreadStore.open(input.path);
  let value: unknown;
  if (input.kind === 'ActiveIds') value = [...new Set(store.loadRecentThreads(0n).map(row => row.id))];
  else if (input.kind === 'Thread') value = store.loadThread(input.thread, input.archived);
  else throw new TypeError('Invalid source query');
  if (boundedSerdeByteCount(value, 4 * 1024 * 1024) === null) throw new RangeError('Source query exceeds transfer budget');
  port.postMessage({...binding, ok: true, value});
} catch { port.postMessage({...binding, ok: false}); }
finally { port.close(); }
