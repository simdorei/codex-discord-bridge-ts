import {readCodexPluginInventory} from './inventory.ts';
import {fingerprintRequiredPlugins,PluginFingerprintError} from './plugin-files.ts';
import {ProPreflightError} from './preflight.ts';
const detail=(error:unknown)=>error instanceof Error?error.message:'native plugin capture failed';
/** Actual inventory child followed by actual owned fingerprint worker. Both child
 * owners finish before this function returns, including cancellation. Capturing
 * installed files is not a successful browser/remote connection or resident bind. */
export async function captureProPlugins(executable:string,signal?:AbortSignal){
 signal?.throwIfAborted();let inventory:string;
 try{inventory=await readCodexPluginInventory(executable,signal);}catch(error){signal?.throwIfAborted();throw new ProPreflightError('PluginInventory','PluginInventoryQueryFailed','Codex could not read the installed plugin inventory.','Run `codex plugin list --json`, fix the reported error, then retry !pro.',detail(error),error);}
 signal?.throwIfAborted();let fingerprint:string;
 try{fingerprint=await fingerprintRequiredPlugins(inventory,signal);}catch(error){signal?.throwIfAborted();
  if(error instanceof PluginFingerprintError&&error.kind==='Inventory')throw new ProPreflightError('PluginInventory','PluginInventoryInvalid','Codex returned invalid plugin source metadata.','Repair or reinstall the required plugins, then retry !pro.',detail(error),error);
  throw new ProPreflightError('PluginContent','PluginContentUnverified','The installed plugin files could not be verified; Chrome availability was not tested.','Repair or reinstall the required plugins, restart the remote bot, then retry !pro.',detail(error),error);
 }
 signal?.throwIfAborted();return Object.freeze({inventory,fingerprint});
}
