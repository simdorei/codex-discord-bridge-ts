import {parentPort, workerData as input} from 'node:worker_threads';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {loadMirrorSessionTitles, mirrorRolloutAvailable} from './source-metadata-local.ts';
const port = parentPort;
if (port === null) throw new Error('Owned mirror metadata worker required');
const binding = {id: input.id, path: input.path, kind: input.kind};
try {
  const value = input.kind === 'titles' ? loadMirrorSessionTitles(input.path) : input.kind === 'rollout' ? mirrorRolloutAvailable(input.path) : (() => { throw new TypeError('Unknown metadata operation'); })();
  if (boundedSerdeByteCount(value, 4 * 1024 * 1024) === null) throw new Error('Mirror metadata exceeds transfer budget');
  port.postMessage({...binding, ok: true, value});
} catch { port.postMessage({...binding, ok: false}); }
finally { port.close(); }
