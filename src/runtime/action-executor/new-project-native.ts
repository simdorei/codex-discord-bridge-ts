import {OwnedWorkerSlot} from '../owned-worker-slot.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {serializeSerdeValue} from '../../core/serde-json.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {decodeNewThreadOrigin,type NewProjectLookup} from './new-project-cwd.ts';
import {InvalidActionRequestError} from './errors.ts';
const LIMIT=16*1024*1024;
export class NativeNewProjectUnavailableError extends Error {constructor(cause:unknown){super('New project lookup unavailable after actual native join; no inferred cwd or retry',{cause});this.name='NativeNewProjectUnavailableError';}}
/** Original full decode/selection inside one existing Discovery slot. Internal
 * full inventory materialization is unchanged, not a memory-bound certificate. */
export function createNativeNewProjectLookup(path:string,timeoutMs=5000):NewProjectLookup {
 requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid project store path');if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid project deadline');const fixed=pinNativeRuntimePath(path);
 return async(given,input,signal)=>{
  signal?.throwIfAborted();if(process.platform==='win32')throw new Error('Windows new project resolution is not yet qualified');if(given!==path)throw new TypeError('Project store differs from original binding');
  if(boundedSerdeByteCount(input,LIMIT)===null)throw new TypeError('Expected bounded passive origin');const origin=serializeSerdeValue(decodeNewThreadOrigin(input)),base=process.cwd(),data={path:fixed,base,origin};if(boundedSerdeByteCount(data,LIMIT)===null)throw new RangeError('Project request exceeds complete wire bound');
  const slot=new OwnedWorkerSlot('Discovery');let admitted=false,raw:unknown;
  try{const pending=slot.run(new URL('./new-project-worker.ts',import.meta.url),data,timeoutMs,signal);admitted=slot.busy;try{raw=await pending;}finally{await slot.join();}}catch(error){if(signal?.aborted)throw signal.reason;if(admitted)throw new NativeNewProjectUnavailableError(error);throw error;}
  let rejection:string|undefined;
  try{if(boundedSerdeByteCount(raw,LIMIT)===null||own(raw,'path')!==fixed||own(raw,'base')!==base||own(raw,'origin')!==origin)throw new TypeError('Project reply differs from captured request');
   if(own(raw,'ok')===true){const cwd=own(raw,'cwd');if(cwd!==null){requireDiscordText(cwd);if(Buffer.byteLength(cwd)>65536)throw new RangeError('Project cwd exceeds bound');}return cwd;}
   if(own(raw,'kind')!=='Invalid')throw new Error('No complete project result');const reason=own(raw,'reason');requireDiscordText(reason);if(Buffer.byteLength(reason)>65536)throw new RangeError('Invalid reason size');rejection=reason;
  }catch(error){throw new NativeNewProjectUnavailableError(error);}
  throw new InvalidActionRequestError(rejection);
 };
}
