import {createZstdDecompress,type ZstdDecompress} from 'node:zlib';
import {types} from 'node:util';
export class GatewayCompressionError extends Error{readonly kind:'Decompressing'|'NotUtf8';constructor(kind:'Decompressing'|'NotUtf8'){super(kind==='Decompressing'?'message could not be decompressed':'decompressed message is not UTF-8');this.name='GatewayCompressionError';this.kind=kind;}}
interface Context{stream:ZstdDecompress;closed:Promise<void>;isClosed:boolean;failed:boolean;chunks:Buffer[]|null}
/** Stateful zstd transport decoder on Node's asynchronous native engine. Each
 * write boundary returns all currently produced bytes, even for a partial frame,
 * matching the source stream decoder. No per-message output cap is invented.
 * Cancellation/dispose WAIT for in-flight write completion before handle teardown;
 * stream close alone is not treated as proof that native work has finished.
 * Native work is not preemptible here; the owning runtime retains its deadline. */
export class GatewayZstdDecoder{
 #context:Context;#operation:Promise<unknown>|undefined;#disposed=false;#closing:Promise<void>|undefined;
 constructor(){this.#context=this.#create();}
 #create():Context{const stream=createZstdDecompress({chunkSize:32768});const context:Context={stream,closed:Promise.resolve(),isClosed:false,failed:false,chunks:null};context.closed=new Promise<void>(resolve=>stream.once('close',()=>{context.isClosed=true;resolve();}));stream.on('error',()=>{context.failed=true;});stream.on('data',(chunk:Buffer)=>{if(context.chunks===null)context.failed=true;else context.chunks.push(chunk);});return context;}
 #close(context:Context):Promise<void>{context.stream.destroy();return context.closed;}
 #own<T>(operation:Promise<T>):Promise<T>{const owned=operation.finally(()=>{if(this.#operation===owned)this.#operation=undefined;});this.#operation=owned;return owned;}
 get pending():boolean{return this.#operation!==undefined;}
 get disposed():boolean{return this.#disposed;}
 get openContexts():number{return this.#context.isClosed?0:1;}
 decompress(bytes:Uint8Array,signal?:AbortSignal):Promise<string>{
  if(this.#disposed)return Promise.reject(new TypeError('Gateway decompressor disposed'));if(this.#operation!==undefined)return Promise.reject(new TypeError('Concurrent Gateway decompression/reset'));if(!types.isUint8Array(bytes))return Promise.reject(new TypeError('Expected compressed bytes'));if(signal?.aborted)return Promise.reject(signal.reason);if(this.#context.failed||this.#context.isClosed)return Promise.reject(new GatewayCompressionError('Decompressing'));
  return this.#own(this.#decompress(Buffer.from(bytes),signal));
 }
 async #decompress(bytes:Buffer,signal?:AbortSignal):Promise<string>{
  let context=this.#context,input=bytes;const chunks:Buffer[]=[];
  try{
   for(;;){
    context.chunks=chunks;let failure=false;const before=context.stream.bytesWritten;
    // Node native error completion skips the ordinary write callback, but its
    // error is emitted after AfterThreadPoolWork clears write_in_progress.
    await new Promise<void>(resolve=>{const failed=()=>{failure=true;resolve();};context.stream.once('error',failed);context.stream.write(input,error=>{context.stream.off('error',failed);failure=error!==null&&error!==undefined;resolve();});});
    if(failure||context.failed){await this.#close(context);throw new GatewayCompressionError('Decompressing');}
    if(signal?.aborted){await this.#close(context);throw signal.reason;}
    if(this.#disposed)throw new TypeError('Gateway decompressor disposed');
    const after=context.stream.bytesWritten,consumed=after-before;
    if(!Number.isSafeInteger(before)||!Number.isSafeInteger(after)||consumed<0||consumed>input.length){await this.#close(context);throw new GatewayCompressionError('Decompressing');}
    if(consumed===input.length)break;
    // Node stops its readable at an ended frame with unconsumed input. The Rust
    // decoder continues. Retire the completed context and feed the exact suffix
    // into a fresh default context; collect bytes before a single UTF8 check.
    if(consumed===0){await this.#close(context);throw new GatewayCompressionError('Decompressing');}
    await this.#close(context);context.chunks=null;
    if(signal?.aborted)throw signal.reason;if(this.#disposed)throw new TypeError('Gateway decompressor disposed');
    this.#context=context=this.#create();input=input.subarray(consumed);
   }
   try{return new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(Buffer.concat(chunks));}catch{throw new GatewayCompressionError('NotUtf8');}
  }finally{context.chunks=null;}
 }
 /** Node does not document reusable zstd reset; replace the joined context with
  * the same default parameters instead of calling an undocumented native reset. */
 reset():Promise<void>{if(this.#disposed)return Promise.reject(new TypeError('Gateway decompressor disposed'));if(this.#operation!==undefined)return Promise.reject(new TypeError('Concurrent Gateway decompression/reset'));return this.#own((async()=>{await this.#close(this.#context);if(this.#disposed)throw new TypeError('Gateway decompressor disposed');this.#context=this.#create();})());}
 dispose():Promise<void>{if(this.#closing!==undefined)return this.#closing;this.#disposed=true;this.#closing=(async()=>{try{await this.#operation;}catch{}await this.#close(this.#context);})();return this.#closing;}
}
