import {open, readFile, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {passiveErrorText} from '../core/passive-error-text.ts';
import {requireDiscordText} from '../discord/text.ts';
import {gatewayOwnField} from '../discord/gateway/values.ts';
import {sanitizeAttachmentFilename, isTextAttachment} from './attachment-format.ts';
export interface DownloadAttachment {readonly filename:string; readonly size:bigint; readonly url:string; readonly contentType:string|null}
/** Caller-owned transport. Success status is checked before this response is
 * returned. release must join body cancellation, including early size rejection.
 * No implementation or network authorization is supplied by this interface. */
export interface AttachmentResponse {
 readonly contentLength:bigint|null;
 readonly chunks:AsyncIterable<Uint8Array>;
 release():Promise<void>;
}
export interface AttachmentTransport {get(url:string):Promise<AttachmentResponse>}
export interface AttachmentDownload {readonly detail:string; readonly preview:readonly [string,string]|null}
function u64(value:unknown):asserts value is bigint {
 if(typeof value!=='bigint'||value<0n||value>=1n<<64n)throw new TypeError('Expected u64 attachment byte count');
}
/** Rust UTF-8 lossy decoding, then a Unicode-scalar (not UTF-16) preview limit.
 * Buffer decoding preserves BOM and replaces malformed UTF-8 subsequences. */
export function attachmentTextPreview(bytes:Uint8Array):string {
 if(!types.isUint8Array(bytes)||types.isProxy(bytes))throw new TypeError('Expected attachment bytes');
 const text=Buffer.from(bytes).toString('utf8'), chars=Array.from(text);
 return chars.slice(0,12000).join('')+(chars.length>12000?'\n\n[truncated]':'');
}
/** Source-backed streaming filesystem leaf. Directory creation belongs to the
 * envelope layer. Required new-thread input is fsynced before a hash is returned.
 * Mid-stream errors keep source partial-file semantics; only oversize removes it. */
export async function downloadAttachment(index:bigint, input:DownloadAttachment, directory:string,
 maxBytes:bigint, inlineMaxBytes:bigint, transport:AttachmentTransport, required:boolean):Promise<AttachmentDownload> {
 u64(index);u64(maxBytes);u64(inlineMaxBytes);requireDiscordText(directory);
 if(typeof required!=='boolean')throw new TypeError('Expected required attachment flag');
 const raw=gatewayOwnField(input,'filename'),size=gatewayOwnField(input,'size'),url=gatewayOwnField(input,'url'),contentType=gatewayOwnField(input,'contentType');
 requireDiscordText(raw);requireDiscordText(url);u64(size);if(contentType!==null)requireDiscordText(contentType);
 const filename=sanitizeAttachmentFilename(raw,index);
 const skipped=(why:string):AttachmentDownload=>Object.freeze({detail:`${index}. ${filename} skipped: ${why}.`,preview:null});
 if(size>maxBytes){const reason=`file is ${size} bytes; limit is ${maxBytes} bytes`;if(required)throw new Error(reason);return skipped(reason);}
 const getter=transport.get;if(typeof getter!=='function'||types.isProxy(getter)||types.isGeneratorFunction(getter))throw new TypeError('Expected attachment transport');
 const request=getter.call(transport,url);if(!types.isPromise(request))throw new TypeError('Expected native attachment request Promise');
 const response=await request;
 try {
  if(response.contentLength!==null){u64(response.contentLength);if(response.contentLength>maxBytes){const reason=`response exceeds ${maxBytes} bytes`;if(required)throw new Error(reason);return skipped(reason);}}
  const destination=join(directory,`${String(index).padStart(2,'0')}-${filename}`),file=await open(destination,'w');
  const digest=createHash('sha256');let written=0n,oversize=false;
  try {
   for await(const inputChunk of response.chunks){
    if(!types.isUint8Array(inputChunk)||types.isProxy(inputChunk))throw new TypeError('Expected binary attachment chunk');
    const chunk=Buffer.from(inputChunk);written+=BigInt(chunk.byteLength);
    if(written>maxBytes){oversize=true;break;}
    let offset=0;while(offset<chunk.length){const result=await file.write(chunk,offset,chunk.length-offset);if(result.bytesWritten===0)throw new Error('attachment write returned zero bytes');offset+=result.bytesWritten;}
    digest.update(chunk);
   }
   if(!oversize&&required)await file.sync();
  } finally {await file.close();}
  if(oversize){
   try{await unlink(destination);}catch(error){if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw new Error('oversized partial-file cleanup failed: '+passiveErrorText(error,'filesystem error'),{cause:error});}
   const reason=`download exceeded ${maxBytes} bytes`;if(required)throw new Error(reason);return skipped(reason);
  }
  let detail=`${index}. ${filename}\n   path: ${destination}\n   content_type: ${contentType??'-'}\n   size_bytes: ${written}`;
  if(required)detail+=`\n   sha256: ${digest.digest('hex')}`;
  let preview:readonly [string,string]|null=null;
  if(written<=inlineMaxBytes&&isTextAttachment(filename,contentType)){
   let bytes:Buffer|null=null;try{bytes=await readFile(destination);}catch(error){if(required)throw new Error('text attachment preview read failed: '+passiveErrorText(error,'filesystem error'),{cause:error});}
   if(bytes!==null)preview=Object.freeze([filename,attachmentTextPreview(bytes)]);
  }
  return Object.freeze({detail,preview});
 } finally {await response.release();}
}
