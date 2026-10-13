import {mirrorChannelId} from './mirror-channel-request.ts';
import {requireDiscordText} from './text.ts';
import {DiscordTransportFault} from './transport-fault.ts';
function name(value:string):void{requireDiscordText(value);const n=[...value].length;if(n<1||n>100)throw new DiscordTransportFault('Validation','the length of the name is invalid');}
function topic(value:string|null):void{if(value===null)return;requireDiscordText(value);if([...value].length>1024)throw new DiscordTransportFault('Validation','the length of the topic is invalid');}
export function mirrorContainerCreatePath(path:unknown):boolean{if(typeof path!=='string')return false;const m=/^guilds\/([1-9][0-9]{0,19})\/channels$/u.exec(path);return m!==null&&m[0]===path&&BigInt(m[1]!)<1n<<64n;}
/** Reachable category/text subset of frozen MirrorTransport::create. */
export function mirrorCreateContainerRequest(guild:bigint,parent:bigint|null,kind:0n|4n,title:string,description:string|null):{path:string;body:string}{
 const id=mirrorChannelId(guild);if(kind!==0n&&kind!==4n)throw new DiscordTransportFault('Validation','unsupported mirror container kind');name(title);topic(description);
 const body:{type:number;name:string;parent_id?:string;topic?:string}={type:Number(kind),name:title};if(parent!==null)body.parent_id=mirrorChannelId(parent);if(description!==null)body.topic=description;
 return {path:'guilds/'+id+'/channels',body:JSON.stringify(body)};
}
export function mirrorUpdateContainerRequest(channel:bigint,title:string,description:string|null):{path:string;body:string}{
 const id=mirrorChannelId(channel);name(title);topic(description);const body:{name:string;topic?:string}={name:title};if(description!==null)body.topic=description;return{path:'channels/'+id,body:JSON.stringify(body)};
}
