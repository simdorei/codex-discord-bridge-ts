import {randomUUID} from 'node:crypto';
import {OwnedWorkerSlot, OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';

const slot = new OwnedWorkerSlot('Background');
/** One bounded read-only probe. Cancellation retains its slot until native exit. */
export async function windowsResourceReport(path: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted(); requireDiscordText(path);
  if (path.includes('\0') || Buffer.byteLength(path) > 32768) throw new TypeError('Invalid resource path');
  if (slot.busy) throw new OwnedWorkerBusyError();
  const id = randomUUID(), pinned = pinNativeRuntimePath(path); let response: unknown;
  try { response = await slot.run(new URL('./windows-resources-worker.ts', import.meta.url), {id, path: pinned}, 3000, signal); }
  finally { await slot.join(); }
  signal?.throwIfAborted();
  const text = own(response, 'text');
  if (own(response, 'id') !== id || own(response, 'path') !== pinned || typeof text !== 'string' || Buffer.byteLength(text) > 4096)
    throw new Error('Unconfirmed Windows resource observation');
  return text;
}
