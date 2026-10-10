import {types} from 'node:util';
import {gatewayOwnField} from '../discord/gateway/values.ts';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {isDecodedGatewayMessage,type DecodedGatewayMessage} from '../discord/gateway/decoded-message.ts';
import {requireDiscordText} from '../discord/text.ts';
import {passiveErrorText} from '../core/passive-error-text.ts';
import {invokeSynchronousVoid} from '../core/synchronous-void.ts';
import {downloadAttachment,type AttachmentTransport} from './attachment-download.ts';
import {sanitizeAttachmentFilename,renderAttachmentPrompt} from './attachment-format.ts';
export interface AttachmentConfig {readonly attachmentsEnabled:boolean;readonly attachmentMaxBytes:bigint;readonly attachmentTextInlineMaxBytes:bigint}
export type AttachmentReporter=(event:{readonly messageId:bigint;readonly filename:string;readonly error:string})=>void;
export class AttachmentError extends Error {readonly kind:'Io'|'Required';constructor(kind:'Io'|'Required',source:unknown){const detail=typeof source==='string'?source:passiveErrorText(source,'attachment failure');super((kind==='Io'?'attachment filesystem operation failed: ':'required new-thread attachment preparation failed: ')+detail,{cause:source});this.name='AttachmentError';this.kind=kind;Object.freeze(this);}}
/** Sequential source envelope. Required new-thread attachment failure never
 * yields prepared input. Ordinary attachment failure is reported and rendered.
 * No command, thread, approval or database write happens in this module. */
export async function enrichMessageAttachments(message:DecodedGatewayMessage,basePrompt:string,config:AttachmentConfig,root:string,transport:AttachmentTransport,required:boolean,report:AttachmentReporter,signal?:AbortSignal):Promise<string>{
 signal?.throwIfAborted();
 if(!isDecodedGatewayMessage(message))throw new TypeError('Expected original decoded message');requireDiscordText(basePrompt);requireDiscordText(root);
 const enabled=gatewayOwnField(config,'attachmentsEnabled'),max=gatewayOwnField(config,'attachmentMaxBytes'),inline=gatewayOwnField(config,'attachmentTextInlineMaxBytes');
 if(typeof enabled!=='boolean'||typeof required!=='boolean'||typeof max!=='bigint'||max<0n||max>=1n<<64n||typeof inline!=='bigint'||inline<0n||inline>=1n<<64n)throw new TypeError('Expected attachment configuration');
 const attachments=message.attachments as readonly {filename:string;size:bigint;url:string;content_type?:string|null}[];
 if(required&&attachments.length>0&&!enabled)throw new AttachmentError('Required','attachments are disabled; no new thread started');
 if(attachments.length===0||!enabled)return basePrompt;
 if(process.platform==='win32')throw new TypeError('Windows attachment path profile is not implemented');
 if(typeof report!=='function'||types.isProxy(report)||types.isAsyncFunction(report)||types.isGeneratorFunction(report))throw new TypeError('Expected synchronous attachment reporter');
 const directory=join(root,String(message.channel_id),String(message.id));try{await mkdir(directory,{recursive:true});}catch(error){throw new AttachmentError('Io',error);}
 const details:string[]=[],previews:(readonly [string,string])[]=[];
 for(let offset=0;offset<attachments.length;offset++){
  signal?.throwIfAborted();
  const a=attachments[offset]!,index=BigInt(offset+1),filename=sanitizeAttachmentFilename(a.filename,index);
  try{const result=await downloadAttachment(index,{filename:a.filename,size:a.size,url:a.url,contentType:a.content_type??null},directory,max,inline,transport,required,signal);details.push(result.detail);if(result.preview!==null)previews.push(result.preview);}
  catch(error){if(signal?.aborted&&error===signal.reason)throw error;const text=passiveErrorText(error,'attachment download failed');if(required)throw new AttachmentError('Required',`${filename}: ${text}`);invokeSynchronousVoid(report,{},[Object.freeze({messageId:message.id,filename,error:text})]);details.push(`${index}. ${filename} failed to save: ${text}`);}
 }
 return renderAttachmentPrompt(basePrompt,details,previews);
}
