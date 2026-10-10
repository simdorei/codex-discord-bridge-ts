import type {PortableSessionConfig} from '../../app-server/portable-session.ts';
import type {RuntimePaths} from '../runtime-paths/resolve.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
/** Pure AppServerConfig::new + CODEX_HOME assembly. Version is supplied by the
 * actual TS build; it is not copied from a Rust package or guessed from disk.
 * The native process owner inherits OS environment and launches without a shell. */
export function runtimeResidentConfig(paths:Pick<RuntimePaths,'codexExe'|'codexHome'>,version:string):PortableSessionConfig{
 const executable=own(paths,'codexExe'),home=own(paths,'codexHome');
 for(const value of [executable,home,version]){requireDiscordText(value as string);if((value as string).includes('\0'))throw new TypeError('NUL in native runtime configuration');}
 const environment:Record<string,string>=Object.create(null);Object.defineProperty(environment,'CODEX_HOME',{value:home,enumerable:true});
 return Object.freeze({process:Object.freeze({executable:executable as string,arguments:Object.freeze(['app-server','--stdio']),environment:Object.freeze(environment)}),clientInfo:Object.freeze({name:'codex-discord-remote',title:'Codex Discord Remote',version})});
}
