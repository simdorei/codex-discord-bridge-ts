import {basename} from 'node:path';
import {boundedAdminRead,decodeAdminText,updateAdminEnvironment} from './admin-files.ts';
import {AdminArgs} from './admin-args.ts';
import {mergeEnvText} from '../config/runtime.ts';
/** Fixed Discord origin, redirects refused, one request and no replay on an
 * unknown upload outcome. Token never appears in an error or response string. */
async function discord(path:string,token:string,init:RequestInit,signal?:AbortSignal):Promise<any>{
 if(!token.trim()||/[\r\n\0]/.test(token))throw new Error('Invalid Discord bot token');
 const deadline=AbortSignal.timeout(30000),combined=signal?AbortSignal.any([signal,deadline]):deadline;
 let response:Response;try{response=await fetch('https://discord.com/api/v10/'+path,{...init,headers:{...init.headers,authorization:'Bot '+token},redirect:'error',signal:combined});}catch{throw new Error('Discord request outcome unconfirmed; no automatic replay');}
 const chunks:Uint8Array[]=[];let bytes=0;try{for await(const chunk of response.body??[]){bytes+=chunk.length;if(bytes>1048576)throw new Error('Discord response exceeds bound');chunks.push(chunk);}}catch{throw new Error('Discord response unconfirmed; no automatic replay');}
 if(!response.ok)throw new Error(`Discord request rejected with HTTP ${response.status}`);return JSON.parse(decodeAdminText(Buffer.concat(chunks)));
}
export function discordId(value:string):string{if(!/^[0-9]+$/.test(value)||BigInt(value)<=0n||BigInt(value)>0xffffffffffffffffn)throw new Error('Discord ID must be a positive u64');return value;}
export const invite=(id:string)=>`https://discord.com/oauth2/authorize?client_id=${discordId(id)}&scope=bot%20applications.commands&permissions=328565115968`;
export async function setupDiscord(args:AdminArgs,root:string,signal?:AbortSignal):Promise<string>{
 if(args.dryRun)return `Dry run: no token requested; .env unchanged.\n${invite(args.value('--bot-id')??'123456789012345678')}`;
 if(!args.inputStdin&&!args.inputLines)throw new Error('setup-discord requires --input-stdin or --input-lines');
 const chunks:Buffer[]=[];let bytes=0;for await(const chunk of process.stdin){signal?.throwIfAborted();const b=Buffer.from(chunk);bytes+=b.length;if(bytes>65536)throw new Error('Setup input exceeds 64 KiB');chunks.push(b);}
 const text=decodeAdminText(Buffer.concat(chunks));let input:any;
 if(args.inputLines){const lines=text.replace(/\r\n/g,'\n').replace(/\n$/,'').split('\n');if(lines.length!==2)throw new Error('Setup requires exactly token and channel ID lines');input={token:lines[0],channel_id:lines[1]};}else input=JSON.parse(text);
 if(!input||typeof input.token!=='string'||Object.keys(input).some(k=>!['token','channel_id'].includes(k))||input.channel_id!==undefined&&typeof input.channel_id!=='string')throw new Error('Setup requires token and optional channel_id');
 const token=input.token.trim(),channel=(input.channel_id??'').trim();if(channel)discordId(channel);
 const app=await discord('applications/@me',token,{},signal),id=discordId(app.id),updates:Record<string,string>={DISCORD_BOT_TOKEN:token};
 if(channel){const env=new Map<string,string>();try{mergeEnvText(env,decodeAdminText(await boundedAdminRead(root+'/.env')));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}const allowed=(env.get('DISCORD_ALLOWED_CHANNEL_IDS')??'').split(',').map(s=>s.trim()).filter(Boolean);if(!allowed.includes(channel))allowed.push(channel);updates.DISCORD_ALLOWED_CHANNEL_IDS=allowed.join(',');if(!env.get('DISCORD_STARTUP_CHANNEL_ID'))updates.DISCORD_STARTUP_CHANNEL_ID=channel;}
 await updateAdminEnvironment(root,updates);return `Discord bot token saved.\nApplication: ${typeof app.name==='string'?app.name:'Discord application'} (${id})\nInvite link:\n${invite(id)}`;
}
export async function sendAdminAttachments(args:AdminArgs,token:string,channel:string,signal?:AbortSignal):Promise<string>{
 discordId(channel);if(args.files.length<1||args.files.length>10)throw new Error('Specify 1–10 attachments');
 const text=(args.value('--content-file')?decodeAdminText(await boundedAdminRead(args.required('--content-file'))):args.value('--content')??'').trim();if(text.length>2000)throw new Error('Message exceeds 2000 UTF-16 units');
 const form=new FormData(),attachments:{id:number;filename:string}[]=[];let remaining=104857600;
 for(const [id,path]of args.files.entries()){const filename=basename(path);if(!filename||/[\x00-\x1f\x7f]/.test(filename))throw new Error('Invalid attachment filename');const data=await boundedAdminRead(path,remaining);remaining-=data.length;attachments.push({id,filename});form.append(`files[${id}]`,new Blob([new Uint8Array(data)],{type:'application/octet-stream'}),filename);}
 form.set('payload_json',JSON.stringify({content:text,attachments,allowed_mentions:{parse:[]}}));
 const receipt=await discord(`channels/${channel}/messages`,token,{method:'POST',body:form},signal);if(receipt.channel_id!==channel||typeof receipt.id!=='string')throw new Error('Attachment receipt differs; do not automatically resend');
 return `DISCORD_ATTACHMENT_SENT\nmessage_id=${discordId(receipt.id)}\nchannel_id=${channel}\nattachments=${attachments.map(a=>a.filename).join(',')}`;
}
