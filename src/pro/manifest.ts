import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serdeField,serdeObject} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {ProPreflightError} from './preflight.ts';
/** Pure UTF8-text manifest policy after an owned bounded filesystem read. Strips
 * exactly one leading BOM. Source classifies JSON syntax failure as unavailable,
 * whereas a decoded wrong shape/version is invalid. Does not read any path. */
export function parseExpectedRemotePluginVersion(raw:string):string{
 requireDiscordText(raw);let value:unknown;
 try{value=parseSerdeValue(raw.startsWith('\ufeff')?raw.slice(1):raw);}catch(error){throw new ProPreflightError('PluginManifest','RemoteManifestUnavailable','The remote plugin manifest could not be read.','Reinstall the remote plugin, then retry !pro.',`remote plugin manifest is unavailable: ${error instanceof Error?error.message:'invalid JSON'}`,error);}
 if(!serdeObject(value))throw new ProPreflightError('PluginManifest','RemoteManifestInvalid','The remote plugin manifest is invalid.','Reinstall the remote plugin, then retry !pro.','remote plugin manifest must be a JSON object');
 const version=serdeField(value,'version');if(typeof version!=='string'||version==='')throw new ProPreflightError('PluginManifest','RemoteManifestInvalid','The remote plugin manifest has no valid version.','Reinstall the remote plugin, then retry !pro.','remote plugin manifest.version must be a non-empty string');
 return version;
}
