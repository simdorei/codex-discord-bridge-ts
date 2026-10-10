import {requireDiscordText} from './text.ts';
import {DiscordTransportFault} from './transport-fault.ts';
import {decodeDiscordChannel} from './model/channel.ts';
import type {MirrorChannel} from '../runtime/mirror-sync/new-mirror-link.ts';
export function mirrorChannelId(value:bigint):string {if(typeof value!=='bigint'||value<=0n||value>=1n<<64n)throw new DiscordTransportFault('Validation','invalid channel identity');return value.toString();}
export function mirrorChannelResource(path:unknown):string|null {if(typeof path!=='string')return null;const m=/^channels\/([1-9][0-9]{0,19})(?:\/threads)?$/u.exec(path);return m!==null&&m[0]===path&&BigInt(m[1]!)<1n<<64n?'channels/'+m[1]:null;}
export function isMirrorChannelMethod(method:string,path:unknown):boolean {const resource=mirrorChannelResource(path);return resource!==null&&((method==='GET'||method==='PATCH')?path===resource:method==='POST'&&path===resource+'/threads');}
function name(value:string):void {requireDiscordText(value);const count=[...value].length;if(count<1||count>100)throw new DiscordTransportFault('Validation','the length of the name is invalid');}
/** twilight-validate0.17 uses chars().count(), despite UTF-16 wording in docs. */
export function mirrorCreateThreadRequest(parent:bigint,title:string):{path:string;body:string} {const id=mirrorChannelId(parent);name(title);return {path:`channels/${id}/threads`,body:JSON.stringify({auto_archive_duration:10080,type:11,name:title})};}
export function mirrorUpdateThreadRequest(channel:bigint,title:string):{path:string;body:string} {const id=mirrorChannelId(channel);name(title);return {path:`channels/${id}`,body:JSON.stringify({archived:false,name:title})};}
export function decodeMirrorChannelBytes(bytes:Uint8Array):MirrorChannel {
 const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),c=decodeDiscordChannel(text),metadata=c.thread_metadata as Record<string,unknown>|null;
 return Object.freeze({id:c.id as bigint,guildId:c.guild_id as bigint|null,parentId:c.parent_id as bigint|null,kind:c.type as bigint,name:c.name as string|null??'',archived:metadata?.archived===true});
}
