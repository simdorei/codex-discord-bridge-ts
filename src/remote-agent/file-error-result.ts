import {types} from 'node:util';
import {requireDiscordText} from '../discord/text.ts';
import type {BridgeResult} from './bridge-inbound.ts';
import {remoteCancelledResult} from './dispatch-contract.ts';
import {captureRemoteFileFailure} from './files/error.ts';
import {redactRemoteText} from './files/redaction.ts';
const codes=Object.freeze({UnsafePath:'unsafeprojectpath',UnsafePattern:'unsafeprojectpath',Size:'projectfilesize',Encoding:'projectfileencoding',Conflict:'fileconflict',Limit:'projectfilelimit',Io:'projectfile'});
const fallback='The remote file error could not be safely rendered.';
/** Source file_error mapping at one redaction boundary. All raw error text is
 * bounded and sent only to an owned CPU worker. Redaction failure never falls
 * back to that raw text. Wire cap is applied AFTER redaction, by Unicode scalar.
 * No native dispatcher registration or permission is created by this leaf. */
export async function remoteFileErrorResult(requestId:string,error:unknown,signal?:AbortSignal):Promise<Extract<BridgeResult,{type:'operation_error'}>>{
 if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected abort signal');
 requireDiscordText(requestId);if(Buffer.byteLength(requestId)>4096)throw new RangeError('Remote request identity exceeds byte limit');
 if(signal?.aborted)return remoteCancelledResult(requestId);
 const captured=captureRemoteFileFailure(error);let message:string;
 try{message=await redactRemoteText(captured.message,signal);}catch{if(signal?.aborted)return remoteCancelledResult(requestId);message=fallback;}
 if(signal?.aborted)return remoteCancelledResult(requestId);
 if(message==='')message=fallback;
 let count=0,end=0;for(const char of message){if(count++===1000)break;end+=char.length;}message=message.slice(0,end);
 return Object.freeze({type:'operation_error',request_id:requestId,error_code:codes[captured.kind],message});
}
