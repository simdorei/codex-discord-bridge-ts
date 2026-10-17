import {NativeMirrorReceiptStore} from './receipt-store.ts';
import {sendReceiptChunkWithPersistence,type DiscordReceiptTransport,type IdempotentChunk,type ReceiptPersistence} from '../completion/receipt-sender.ts';
/** One already-bounded mirror chunk only; no splitting, ownership decision,
 * retries, cursor writes or detached transport. Fixed native store rejects other
 * domains, thread/channel scope and non-null completion guards before HTTP.
 * Caller joins the entire operation before closing its store or releasing work.
 * Known late acceptance is persisted even if the input signal has been aborted. */
export async function sendNativeMirrorReceiptChunk(store:NativeMirrorReceiptStore,transport:DiscordReceiptTransport,channel:bigint,chunk:IdempotentChunk,signal?:AbortSignal):Promise<void>{
 const persistence:ReceiptPersistence={
  begin:(key,hash,guard,abort)=>{
   if(guard!==null)return Promise.reject(new TypeError('Mirror sender cannot replace completion guards'));
   return NativeMirrorReceiptStore.prototype.begin.call(store,key,hash,abort);
  },
  confirm:(key,hash,message)=>NativeMirrorReceiptStore.prototype.confirm.call(store,key,hash,message),
  releaseRejected:(key,hash)=>NativeMirrorReceiptStore.prototype.releaseRejected.call(store,key,hash),
  blockRejected:(key,hash,reason)=>NativeMirrorReceiptStore.prototype.blockRejected.call(store,key,hash,reason),
 };
 await sendReceiptChunkWithPersistence(persistence,transport,channel,chunk,[],null,signal);
 signal?.throwIfAborted();
}
