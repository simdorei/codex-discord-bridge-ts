import {fileURLToPath} from 'node:url';
import {mkdir,realpath,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {runOwnedCommand} from '../runtime/windows/owned-command.ts';
import {verifyInstallInventory} from './admin-files.ts';
export function bundledPackageRoot():string{return fileURLToPath(new URL(import.meta.url.endsWith('.ts')?'../../':'../../../',import.meta.url));}
/** Explicit installation only. Register the package that contains the staged JS
 * helper, then verify Codex's actual installed inventory against that package. */
export async function installBundledPlugin(runtimeRoot:string,codex:string,codexHome:string,signal?:AbortSignal):Promise<string>{
 const run=async(args:readonly string[])=>{const output=await runOwnedCommand({executable:codex,arguments:args,cwd:runtimeRoot,environment:{CODEX_HOME:codexHome}},{timeoutMs:60000,maxBytes:4194304,...(signal===undefined?{}:{signal})});if(output.exitCode!==0||output.truncated)throw Error('Codex plugin operation failed: '+args.slice(0,3).join(' '));return output.stdout;};
 return installPluginWithRunner(runtimeRoot,bundledPackageRoot(),run);
}
export async function installPluginWithRunner(runtimeRoot:string,packageRoot:string,run:(args:readonly string[])=>Promise<Uint8Array|string>):Promise<string>{
 const source=await realpath(packageRoot),plugin=join(source,'plugins','codex-discord-remote'),manifest=join(plugin,'.codex-plugin','plugin.json');
 await readFile(join(plugin,'lib','pro','main.js'));await readFile(join(source,'.agents','plugins','marketplace.json'));
 const directory=join(runtimeRoot,'.runtime','plugin-install');await mkdir(directory,{recursive:true});
 await run(['plugin','marketplace','add',source]);await run(['plugin','add','codex-discord-remote@codex-discord-remote']);
 const markets=join(directory,'marketplaces.json'),plugins=join(directory,'plugins.json');
 await writeFile(markets,await run(['plugin','marketplace','list','--json']));await writeFile(plugins,await run(['plugin','list','--json']));
 return 'Installed and verified codex-discord-remote '+await verifyInstallInventory(source,markets,plugins,manifest,'codex-discord-remote','codex-discord-remote@codex-discord-remote');
}
