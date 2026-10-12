import {types} from 'node:util';
import {pinNativeRuntimePath} from '../runtime-paths/path-text.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../owned-worker-slot.ts';
import {boundedSerdeByteCount} from '../../core/serde-byte-count.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {snapshotCompletionEntry,type CompletionEntry} from '../../store/completion-metadata.ts';
import {snapshotStoredDelivery,type StoredDelivery} from '../../store/delivery.ts';
import type {CompletionPayload} from '../../store/completion-payload.ts';
export type HttpCompletionPayload=Exclude<CompletionPayload,{kind:'Observed'}>;
export class NativeHttpPayloadUnavailable extends Error{constructor(){super('HTTP completion payload read unavailable');this.name='NativeHttpPayloadUnavailable';}}
const text=(v:unknown):string=>{requireDiscordText(v);return v;};
const integer=(v:unknown):bigint=>{if(typeof v!=='bigint'||v<-(1n<<63n)||v>=(1n<<63n))throw new NativeHttpPayloadUnavailable();return v;};
const optionalText=(v:unknown)=>v===null?null:text(v);
/** Private typed response decoder. SQL selection remains metadata, never send authority. */
function decode(payload:unknown,source:string):HttpCompletionPayload|null{
 if(payload===null)return null;const kind=own(payload,'kind'),v=own(payload,'value');if(kind!==source)throw new NativeHttpPayloadUnavailable();
 switch(kind){
  case 'Commentary':return {kind,value:{sequence:integer(own(v,'sequence')),jobId:text(own(v,'jobId')),threadId:text(own(v,'threadId')),turnId:text(own(v,'turnId')),channelId:integer(own(v,'channelId')),text:text(own(v,'text'))}};
  case 'Goal':return {kind,value:{thread:text(own(v,'thread')),turn:text(own(v,'turn')),channel:integer(own(v,'channel')),content:text(own(v,'content')),lastError:text(own(v,'lastError')),jobId:optionalText(own(v,'jobId'))}};
  case 'StartFailure':return {kind,value:{jobId:text(own(v,'jobId')),threadId:text(own(v,'threadId')),channelId:integer(own(v,'channelId')),content:text(own(v,'content'))}};
  case 'Final':return {kind,value:snapshotStoredDelivery(v as StoredDelivery)};
  case 'Question':{
   const body=own(v,'body'),index=own(body,'index'),options=own(body,'options'),chosen=own(v,'chosen');
   if(typeof index!=='bigint'||index<0n||index>=(1n<<64n)||types.isProxy(options)||!Array.isArray(options))throw new NativeHttpPayloadUnavailable();
   const strings:string[]=[];for(let i=0;i<options.length;i++)strings.push(text(own(options,String(i))));
   if(chosen!==null&&(typeof chosen!=='bigint'||chosen<0n||chosen>65535n))throw new NativeHttpPayloadUnavailable();
   return {kind,value:{id:text(own(v,'id')),runtimeId:text(own(v,'runtimeId')),generation:integer(own(v,'generation')),threadId:text(own(v,'threadId')),turnId:text(own(v,'turnId')),itemId:text(own(v,'itemId')),originJobId:text(own(v,'originJobId')),channelId:integer(own(v,'channelId')),ownerUserId:integer(own(v,'ownerUserId')),body:{index,source_text:text(own(body,'source_text')),title:text(own(body,'title')),options:strings},state:text(own(v,'state')),messageId:optionalText(own(v,'messageId')),chosen,replyJobId:optionalText(own(v,'replyJobId')),error:text(own(v,'error'))}};
  }
  default:throw new NativeHttpPayloadUnavailable();
 }
}
/** Four already-owned HTTP lanes; global Background3 bounds actual native work.
 * No retry or waiting queue. Cancellation retains ownership through actual exit. */
export class NativeHttpPayloadReader{
 readonly #path:string;readonly #timeout:number;readonly #tasks=new Map<Promise<HttpCompletionPayload|null>,AbortController>();#closed=false;
 constructor(path:string,timeoutMs=5000){requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768)throw new TypeError('Invalid completion path');this.#path=pinNativeRuntimePath(path);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new RangeError('Invalid HTTP payload deadline');this.#timeout=timeoutMs;}
 get active():number{return this.#tasks.size;}
 read(input:CompletionEntry,runtime:string,generation:bigint,signal?:AbortSignal):Promise<HttpCompletionPayload|null>{
  const entry=snapshotCompletionEntry(input);if(!['Commentary','Goal','StartFailure','Question','Final'].includes(entry.source))throw new TypeError('Expected HTTP completion source');
  if(!Number.isFinite(entry.position.stamp)||boundedSerdeByteCount(entry,65536)===null)throw new RangeError('Completion metadata exceeds native boundary');requireDiscordText(runtime);if(Buffer.byteLength(runtime)>32768)throw new RangeError('Completion runtime exceeds boundary');
  if(typeof generation!=='bigint'||generation<0n||generation>=(1n<<63n))throw new TypeError('Expected original completion generation');
  if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected AbortSignal');signal?.throwIfAborted();if(this.#closed)throw new NativeHttpPayloadUnavailable();if(this.#tasks.size>=4)throw new OwnedWorkerBusyError();
  const request={path:this.#path,entry,runtime,generation};if(boundedSerdeByteCount(request,512*1024)===null)throw new RangeError('HTTP payload request exceeds boundary');
  const slot=new OwnedWorkerSlot('Background'),controller=new AbortController(),abort=()=>controller.abort(signal!.reason);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const task=(async()=>{try{
   const pending=slot.run(new URL('./native-http-payload-worker.ts',import.meta.url),request,this.#timeout,controller.signal);let raw:unknown;try{raw=await pending;}finally{await slot.join();}controller.signal.throwIfAborted();
   if(boundedSerdeByteCount(raw,16*1024*1024)===null||own(raw,'ok')!==true)throw new NativeHttpPayloadUnavailable();return decode(own(raw,'payload'),entry.source);
  }finally{signal?.removeEventListener('abort',abort);}})();this.#tasks.set(task,controller);const clear=()=>{this.#tasks.delete(task);};void task.then(clear,clear);return task;
 }
 async close(reason:unknown=new Error('HTTP payload reader stopped')):Promise<void>{this.#closed=true;for(const c of this.#tasks.values())c.abort(reason);await Promise.allSettled([...this.#tasks.keys()]);}
}
Object.freeze(NativeHttpPayloadReader.prototype);
