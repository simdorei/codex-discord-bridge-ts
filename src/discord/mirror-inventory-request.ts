import {parseSerdeField} from '../core/serde-struct-json.ts';
import {discordChannelField,discordThreadMemberField} from './model/channel.ts';
import {decodeDiscordUser} from './model/user.ts';
import {modelVector,modelStruct,modelShape,modelOption} from './model/fields.ts';
import {parseDiscordTimestamp,type DiscordModelTimestamp} from './model/timestamp.ts';
import {mirrorChannelId} from './mirror-channel-request.ts';
import type {MirrorChannel} from '../runtime/mirror-sync/new-mirror-link.ts';
export interface MirrorInventoryChannel extends MirrorChannel{readonly topic:string|null;readonly ownerId:bigint|null;readonly archiveBefore:string|null}
export interface MirrorThreadsPage{readonly hasMore:boolean|null;readonly threads:readonly MirrorInventoryChannel[]}
export function mirrorArchiveTimestamp(value:DiscordModelTimestamp):string{
 const n=value.unixNanoseconds;if(typeof n!=='bigint')throw new TypeError('Expected exact timestamp');
 const billion=1000000000n,remainder=(n%billion+billion)%billion,date=new Date(Number((n-remainder)/billion)*1000),year=date.getUTCFullYear();
 if(!Number.isInteger(year)||year<0||year>9999)throw new RangeError('Archive timestamp year out of range');
 const two=(n:number)=>String(n).padStart(2,'0');
 return String(year).padStart(4,'0')+'-'+two(date.getUTCMonth()+1)+'-'+two(date.getUTCDate())+'T'+two(date.getUTCHours())+':'+two(date.getUTCMinutes())+':'+two(date.getUTCSeconds())+'.'+String(remainder/1000n).padStart(6,'0')+'+00:00';
}
function canonicalStamp(value:string):boolean{
 const m=/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}\+00:00$/u.exec(value);
 if(m===null||m[0]!==value)return false;try{return mirrorArchiveTimestamp(parseDiscordTimestamp(value))===value;}catch{return false;}
}
export function mirrorArchivedThreadsPath(parent:bigint,before:string|null):string{
 const id=mirrorChannelId(parent);if(before!==null&&(typeof before!=='string'||!canonicalStamp(before)))throw new TypeError('Expected canonical archive timestamp');
 return 'channels/'+id+'/threads/archived/public?'+(before===null?'':'before='+before+'&')+'limit=100';
}
export function mirrorInventoryResource(path:unknown):string|null{
 if(typeof path!=='string')return null;if(path==='users/@me')return 'none';
 const guild=/^guilds\/([1-9][0-9]{0,19})\/(?:channels|threads\/active)$/u.exec(path);
 if(guild!==null&&guild[0]===path&&BigInt(guild[1]!)<1n<<64n)return 'guilds/'+guild[1];
 const archive=/^channels\/([1-9][0-9]{0,19})\/threads\/archived\/public\?(?:before=([^&]+)&)?limit=100$/u.exec(path);
 return archive!==null&&archive[0]===path&&BigInt(archive[1]!)<1n<<64n&&(archive[2]===undefined||canonicalStamp(archive[2]))?'channels/'+archive[1]:null;
}
const text=(b:Uint8Array)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(b);
function project(value:unknown):MirrorInventoryChannel{
 const c=value as Record<string,unknown>,m=c.thread_metadata as Record<string,unknown>|null;
 return Object.freeze({id:c.id as bigint,guildId:c.guild_id as bigint|null,parentId:c.parent_id as bigint|null,kind:c.type as bigint,name:(c.name as string|null)??'',archived:m?.archived===true,topic:c.topic as string|null,ownerId:c.owner_id as bigint|null,archiveBefore:m===null?null:mirrorArchiveTimestamp(m.archive_timestamp as DiscordModelTimestamp)});
}
const listing=modelStruct(modelShape([['has_more',modelOption('bool')],['members',modelVector(discordThreadMemberField)],['threads',modelVector(discordChannelField)]],['has_more']));
export function decodeMirrorGuildChannels(bytes:Uint8Array):readonly MirrorInventoryChannel[]{return Object.freeze((parseSerdeField(text(bytes),modelVector(discordChannelField)) as unknown[]).map(project));}
export function decodeMirrorThreadsPage(bytes:Uint8Array):MirrorThreadsPage{const v=parseSerdeField(text(bytes),listing) as Record<string,unknown>;return Object.freeze({hasMore:v.has_more as boolean|null,threads:Object.freeze((v.threads as unknown[]).map(project))});}
export function decodeMirrorBotId(bytes:Uint8Array):bigint{return decodeDiscordUser(text(bytes)).id as bigint;}

export function decodeMirrorInventoryChannel(bytes:Uint8Array):MirrorInventoryChannel{return project(parseSerdeField(text(bytes),discordChannelField));}
