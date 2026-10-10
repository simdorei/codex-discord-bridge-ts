import {createHash} from 'node:crypto';
import {requireDiscordText} from '../discord/text.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {gatewayOwnField as own} from '../discord/gateway/values.ts';
export const PRO_SKILL_NAME='ask-chatgpt-pro',CHROME_MENTION_NAME='Chrome',CHROME_PLUGIN_URI='plugin://chrome@openai-bundled';
export const PRO_SKILL_CALL='$ask-chatgpt-pro [@Chrome](plugin://chrome@openai-bundled)',PRO_REVIEW_MARKER='<pro-review>';
export const PRODUCTION_CONNECTOR_NAME='Simdorei Local Project Oauth',PRODUCTION_CONNECTOR_RESOURCE='https://simdorei.duckdns.org/mcp';
const DEVICE_INSTRUCTION='\nUse only the connector named in this tag and select it explicitly.\nUse PC mode by default.\nCall list_devices, verify that device_id is online, then call select_device\nexactly once with the device_id, working_directory, and connector resource\nfrom this tag. The working directory identifies the project for this ticket.\nRead a file before updating it and pass its SHA-256 when writing an existing file.\n';
export interface DeviceTicket{readonly deviceId:string;readonly workingDirectory:string;}
const asciiLower=(value:string)=>value.replace(/[A-Z]/g,char=>char.toLowerCase());
function firstWord(value:string):readonly [string,string|null]|null{
 const trimmed=value.replace(/^\p{White_Space}+/u,'');if(trimmed==='')return null;
 const end=trimmed.search(/\p{White_Space}/u);if(end<0)return [trimmed,null];
 const rest=trimmed.slice(end).replace(/^\p{White_Space}+/u,'');return [trimmed.slice(0,end),rest===''?null:rest];
}
/** Pure command rewrite only. Does not invoke a skill, reviewer, browser or connector. */
export function rewriteProPrompt(prompt:string):string|null{
 requireDiscordText(prompt);const split=firstWord(prompt);if(split===null||asciiLower(split[0])!=='!pro')return null;
 const request=split[1];if(request===null)return PRO_SKILL_CALL;
 const [first,review]=firstWord(request)!;
 if(asciiLower(first)==='review')return review===null?`${PRO_SKILL_CALL} ${PRO_REVIEW_MARKER}`:`${PRO_SKILL_CALL} ${PRO_REVIEW_MARKER}\n${review}`;
 return `${PRO_SKILL_CALL} ${request}`.replace(/\p{White_Space}+$/u,'');
}
export function isProCommand(prompt:string):boolean{return rewriteProPrompt(prompt)!==null;}
export function proConversationScope(thread:string):string{requireDiscordText(thread);return 'codex-pro-'+createHash('sha256').update(thread,'utf8').digest('hex').slice(0,24);}
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
/** Caller must independently verify the original project directory. Formatting a
 * tag neither verifies its claims nor grants access/permission to another agent. */
export function formatLocalDevicePrompt(rewritten:string,targetThread:string,ticket:DeviceTicket):string{
 requireDiscordText(rewritten);requireDiscordText(targetThread);const device=own(ticket,'deviceId'),directory=own(ticket,'workingDirectory');requireDiscordText(device);requireDiscordText(directory);
 return `${rewritten}\n<local-device-mcp connector="${escape(PRODUCTION_CONNECTOR_NAME)}" resource="${escape(PRODUCTION_CONNECTOR_RESOURCE)}" device_id="${escape(device)}" working_directory="${escape(directory)}" conversation_scope="${proConversationScope(targetThread)}">${DEVICE_INSTRUCTION}</local-device-mcp>`;
}
export function isProSkillPrompt(prompt:string):boolean{requireDiscordText(prompt);if(!prompt.startsWith(PRO_SKILL_CALL))return false;const rest=prompt.slice(PRO_SKILL_CALL.length);return rest===''||/^\p{White_Space}/u.test(rest);}
export function buildProTurnInput(prompt:string,skillPath:string):readonly unknown[]{
 requireDiscordText(prompt);requireDiscordText(skillPath);const input:unknown[]=[{type:'text',text:prompt,text_elements:[]}];
 if(isProSkillPrompt(prompt))input.push({type:'skill',name:PRO_SKILL_NAME,path:skillPath},{type:'mention',name:CHROME_MENTION_NAME,path:CHROME_PLUGIN_URI});
 return cloneOwnedSerdeValue(input) as readonly unknown[];
}
