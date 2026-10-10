import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serdeField,serdeObject} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
export const REMOTE_PLUGIN_ID='codex-discord-remote@codex-discord-remote';
export const CHROME_PLUGIN_ID='chrome@openai-bundled';
export type ProDiagnosticStage='PluginInventory'|'PluginManifest'|'PluginContent'|'ResidentAppServer'|'RemoteMcp'|'ProjectTicket';
export type ProDiagnosticCode='PluginInventoryQueryFailed'|'PluginInventoryInvalid'|'RemotePluginMissing'|'RemotePluginNotInstalled'|'RemotePluginDisabled'|'RemotePluginVersionInvalid'|'RemotePluginVersionMismatch'|'BrowserPluginMissing'|'BrowserPluginNotInstalled'|'BrowserPluginDisabled'|'BrowserPluginVersionInvalid'|'PluginContentUnverified'|'RemoteManifestUnavailable'|'RemoteManifestInvalid'|'ResidentUnhealthy'|'ResidentSnapshotFailed'|'ResidentSnapshotMissing'|'ResidentStale'|'RemoteMcpConfigurationInvalid'|'RemoteMcpConnectionFailed'|'RemoteMcpNotConfigured'|'ProjectTicketTimezoneInvalid'|'ProjectTicketExpired';
export interface ProRuntimeDiagnostic{readonly stage:ProDiagnosticStage;readonly code:ProDiagnosticCode;readonly publicMessage:string;readonly recoveryAction:string;readonly internalDetail:string;}
export class ProPreflightError extends Error{
 readonly diagnostic:ProRuntimeDiagnostic;
 constructor(stage:ProDiagnosticStage,code:ProDiagnosticCode,publicMessage:string,recoveryAction:string,internalDetail:string){super(internalDetail);this.name='ProPreflightError';this.diagnostic=Object.freeze({stage,code,publicMessage,recoveryAction,internalDetail});}
}
export interface ProResidentSnapshot{readonly generation:bigint;readonly healthy:boolean;readonly accepting:boolean;readonly pluginRuntimeFingerprint:string|null;readonly pluginRuntimeError:string|null;}
export interface ProRuntimeStatus{readonly remotePluginVersion:string;readonly browserPluginVersion:string;readonly residentGeneration:bigint;}
function invalid(detail:string):never{throw new ProPreflightError('PluginInventory','PluginInventoryInvalid','Codex returned an invalid installed plugin inventory.','Run `codex plugin list --json`, fix the reported error, then retry !pro.',detail);}
function required(records:readonly unknown[],id:string,browser:boolean):Readonly<Record<string,unknown>>{
 const matches=records.filter(record=>serdeField(record,'pluginId')===id);
 if(matches.length===1)return matches[0] as Readonly<Record<string,unknown>>;
 throw new ProPreflightError('PluginInventory',browser?'BrowserPluginMissing':'RemotePluginMissing',browser?'The Chrome plugin entry is missing or duplicated; Chrome availability was not tested.':'The remote plugin entry is missing or duplicated.',browser?'Reinstall and enable the Chrome plugin, then retry !pro.':'Reinstall and enable the remote plugin, then retry !pro.',`plugin '${id}' was not installed exactly once`);
}
function version(record:Readonly<Record<string,unknown>>,id:string,browser:boolean):string{
 const value=serdeField(record,'version');
 const reason=serdeField(record,'installed')!==true?'not installed':serdeField(record,'enabled')!==true?'disabled':typeof value!=='string'||value===''?'version invalid':null;
 if(reason===null)return value as string;
 const code:ProDiagnosticCode=browser?(reason==='not installed'?'BrowserPluginNotInstalled':reason==='disabled'?'BrowserPluginDisabled':'BrowserPluginVersionInvalid'):(reason==='not installed'?'RemotePluginNotInstalled':reason==='disabled'?'RemotePluginDisabled':'RemotePluginVersionInvalid');
 throw new ProPreflightError('PluginInventory',code,`The required plugin is ${reason}.`,'Repair or reinstall the required plugin, then retry !pro.',`plugin '${id}' is ${reason}`);
}
/** Pure source preflight policy. Does not run Codex, read plugin files, test Chrome,
 * restart a resident, authorize a remote ticket, or establish a native snapshot. */
export function verifyPluginInventory(raw:string,expectedRemoteVersion:string){
 requireDiscordText(raw);requireDiscordText(expectedRemoteVersion);
 let inventory:unknown;try{inventory=parseSerdeValue(raw);}catch(error){invalid(`Codex plugin inventory is not valid JSON: ${error instanceof Error?error.message:'invalid JSON'}`);}
 if(!serdeObject(inventory))invalid('Codex plugin inventory must be a JSON object');
 const records=serdeField(inventory,'installed');if(!Array.isArray(records))invalid('Codex plugin inventory.installed must be a JSON array');
 if(records.some(record=>!serdeObject(record)))invalid('Codex plugin inventory entries must be JSON objects');
 // Preserve source precedence: both required identities before either enabled check.
 const remote=required(records,REMOTE_PLUGIN_ID,false),browser=required(records,CHROME_PLUGIN_ID,true);
 const remoteVersion=version(remote,REMOTE_PLUGIN_ID,false),browserVersion=version(browser,CHROME_PLUGIN_ID,true);
 if(remoteVersion!==expectedRemoteVersion)throw new ProPreflightError('PluginInventory','RemotePluginVersionMismatch','The installed remote plugin version does not match this bot.','Reinstall the remote plugin and restart the remote bot.',`plugin '${REMOTE_PLUGIN_ID}' version mismatch: expected '${expectedRemoteVersion}', got '${remoteVersion}'`);
 return Object.freeze({remoteVersion,browserVersion});
}
export function verifyProRuntime(raw:string,expectedRemoteVersion:string,resident:ProResidentSnapshot,currentPluginFingerprint:string):ProRuntimeStatus{
 const plugins=verifyPluginInventory(raw,expectedRemoteVersion);
 requireDiscordText(currentPluginFingerprint);
 const generation=own(resident,'generation'),healthy=own(resident,'healthy'),accepting=own(resident,'accepting');
 if(typeof generation!=='bigint'||generation<0n||generation>=(1n<<64n)||typeof healthy!=='boolean'||typeof accepting!=='boolean')throw new TypeError('Expected owned resident snapshot');
 if(!healthy||!accepting)throw new ProPreflightError('ResidentAppServer','ResidentUnhealthy','The resident Codex process is not ready to accept !pro.','Restart the remote bot, wait for it to become healthy, then retry !pro.',`resident Codex app-server is not healthy (generation ${generation})`);
 const error=own(resident,'pluginRuntimeError');if(error!==null){requireDiscordText(error);throw new ProPreflightError('ResidentAppServer','ResidentSnapshotFailed','The resident Codex process could not verify its plugin snapshot.','Repair the plugin installation and restart the remote bot.',`resident Codex app-server plugin snapshot failed: ${error}`);}
 const fingerprint=own(resident,'pluginRuntimeFingerprint');
 if(fingerprint===null)throw new ProPreflightError('ResidentAppServer','ResidentSnapshotMissing','The resident Codex process started without a verified plugin snapshot.','Restart the remote bot, then retry !pro.',`resident Codex app-server has no plugin snapshot (generation ${generation})`);
 requireDiscordText(fingerprint);
 if(fingerprint!==currentPluginFingerprint)throw new ProPreflightError('ResidentAppServer','ResidentStale','The installed plugins changed after the resident Codex process started.','Restart the remote bot, then retry !pro.',`resident Codex app-server plugin snapshot is stale (generation ${generation}); restart the remote bot`);
 return Object.freeze({remotePluginVersion:plugins.remoteVersion,browserPluginVersion:plugins.browserVersion,residentGeneration:generation});
}
