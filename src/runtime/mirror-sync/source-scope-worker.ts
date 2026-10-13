import {parentPort, workerData as input} from 'node:worker_threads';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {loadMirrorSourceScope} from './source-scope-local.ts';
const port = parentPort;
if (port === null) throw new Error('Owned mirror scope worker required');
const binding = {id: input.id, codex: input.codex, mirror: input.mirror, limit: input.limit};
try {
  const value = await loadMirrorSourceScope(input.codex, input.mirror, input.limit);
  if (boundedSerdeByteCount(value, 4 * 1024 * 1024) === null) throw new Error('Mirror source scope exceeds 4 MiB transfer budget');
  port.postMessage({...binding, ok: true, value});
} catch { port.postMessage({...binding, ok: false}); }
finally { port.close(); }
