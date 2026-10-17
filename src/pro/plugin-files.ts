import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../runtime/owned-worker-slot.ts';
import {requireDiscordText} from '../discord/text.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {serdeField} from '../app-server/value.ts';
import {PluginFingerprintError} from './fingerprint-blocking.ts';
import {ProPreflightError} from './preflight.ts';
export {PluginFingerprintError} from './fingerprint-blocking.ts';
const slot=new OwnedWorkerSlot();
export function pluginFilesBusy():boolean{return slot.busy;}
/** One owned worker, zero queued filesystem scans. Timeout/abort is joined through
 * native worker exit. This POSIX observation is not an atomic installation lock or
 * Windows reparse-point proof. Over-budget trees are held without partial hashes. */
async function inspect(mode:'Tree'|'Fingerprint'|'Manifest',input:string,signal?:AbortSignal):Promise<string>{
 signal?.throwIfAborted();requireDiscordText(input);if(input.includes('\0'))throw new TypeError('NUL plugin input');
 if(Buffer.byteLength(input)>(mode==='Fingerprint'?1048576:32768))throw new RangeError('Plugin input exceeds observation budget');
 if(process.platform==='win32')throw new TypeError('Windows plugin file ownership requires native reparse-point validation');if(slot.busy)throw new OwnedWorkerBusyError();
 const pending=slot.run(new URL('./plugin-files-worker.ts',import.meta.url),{mode,input},15000,signal),exited=slot.join();let response:unknown;
 try{response=cloneOwnedSerdeValue(await pending);}finally{await exited;}signal?.throwIfAborted();
 if(serdeField(response,'ok')===true){const value=serdeField(response,'value');if(typeof value!=='string'||(mode==='Manifest'?value==='':!/^[0-9a-f]{64}$/.test(value)))throw new TypeError('Invalid plugin file worker result');return value;}
 const kind=serdeField(response,'kind');if(kind==='Manifest'){
  const d=serdeField(response,'diagnostic'),stage=serdeField(d,'stage'),code=serdeField(d,'code'),publicMessage=serdeField(d,'publicMessage'),recovery=serdeField(d,'recoveryAction'),detail=serdeField(d,'internalDetail');
  if(mode!=='Manifest'||stage!=='PluginManifest'||(code!=='RemoteManifestInvalid'&&code!=='RemoteManifestUnavailable')||typeof publicMessage!=='string'||typeof recovery!=='string'||typeof detail!=='string')throw new TypeError('Invalid manifest diagnostic');
  throw new ProPreflightError(stage,code,publicMessage,recovery,detail);
 }
 const detail=serdeField(response,'detail');if((kind!=='Inventory'&&kind!=='Content'&&kind!=='Io')||typeof detail!=='string')throw new TypeError('Invalid plugin fingerprint diagnostic');throw new PluginFingerprintError(kind,detail);
}
export function pluginTreeDigest(path:string,signal?:AbortSignal):Promise<string>{return inspect('Tree',path,signal);}
export function fingerprintRequiredPlugins(raw:string,signal?:AbortSignal):Promise<string>{return inspect('Fingerprint',raw,signal);}
export function expectedRemotePluginVersion(path:string,signal?:AbortSignal):Promise<string>{return inspect('Manifest',path,signal);}
