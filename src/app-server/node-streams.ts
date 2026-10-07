import {Readable,Writable} from "node:stream";
import {finished} from "node:stream/promises";
import {types} from "node:util";
import type {OwnedAppServerInput} from "./writer.ts";
import type {ByteChunkSource} from "./line-reader.ts";
export class AppServerStreamClosedError extends Error{constructor(){super("app-server owned stream is closed");this.name="AppServerStreamClosedError";}}
/** These adapters exclusively own ordinary Node native stdio streams with close events.
 * Caller must not concurrently read/write, change encoding, or disable emitClose. */
export class NodeAppServerInput implements OwnedAppServerInput{
  readonly #stream:Writable;readonly #closed:Promise<void>;#error:unknown;#failed=false;
  constructor(stream:Writable){
    this.#stream=stream;this.#closed=stream.closed?Promise.resolve():new Promise(resolve=>stream.once("close",resolve));
    stream.on("error",error=>{if(!this.#failed){this.#failed=true;this.#error=error;}});
  }
  #check(signal?:AbortSignal):void{signal?.throwIfAborted();if(this.#failed)throw this.#error;if(this.#stream.destroyed||this.#stream.writableEnded)throw new AppServerStreamClosedError();}
  async #drained(signal?:AbortSignal):Promise<void>{
    this.#check(signal);if(!this.#stream.writableNeedDrain)return;
    await new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{this.#stream.off("drain",drain);this.#stream.off("error",error);this.#stream.off("close",close);signal?.removeEventListener("abort",abort);};
      const drain=()=>{cleanup();resolve();};const error=(error:unknown)=>{cleanup();reject(signal?.aborted?signal.reason:error);};
      const close=()=>{cleanup();reject(signal?.aborted?signal.reason:new AppServerStreamClosedError());};const abort=()=>this.#stream.destroy();
      this.#stream.once("drain",drain);this.#stream.once("error",error);this.#stream.once("close",close);signal?.addEventListener("abort",abort,{once:true});
    });
  }
  async writeAll(bytes:Uint8Array,signal?:AbortSignal):Promise<void>{
    this.#check(signal);if(types.isProxy(bytes)||!types.isUint8Array(bytes))throw new TypeError("Expected owned write bytes");
    const owned=Buffer.from(bytes),abort=()=>this.#stream.destroy();signal?.addEventListener("abort",abort,{once:true});
    try{
      await new Promise<void>((resolve,reject)=>{this.#stream.write(owned,error=>error?reject(error):resolve());});
      signal?.throwIfAborted();await this.#drained(signal);
    }catch(error){if(signal?.aborted){await this.#closed;throw signal.reason;}throw error;}
    finally{signal?.removeEventListener("abort",abort);}
  }
  async flush(signal?:AbortSignal):Promise<void>{
    try{await this.#drained(signal);}catch(error){if(signal?.aborted&&this.#stream.destroyed)await this.#closed;throw error;}
  }
  /** Caller must first acquire/take the serialized writer's stdin slot. */
  async shutdown():Promise<void>{
    const done=finished(this.#stream,{cleanup:true,readable:false});void done.catch(()=>undefined);
    if(!this.#stream.writableEnded&&!this.#stream.destroyed)this.#stream.end();await done;
  }
  async destroyAndJoin():Promise<void>{this.#stream.destroy();await this.#closed;}
}
export class NodeAppServerByteSource implements ByteChunkSource{
  readonly #stream:Readable;readonly #iterator:AsyncIterator<unknown>;readonly #closed:Promise<void>;#disposed=false;#failed=false;#error:unknown;
  constructor(stream:Readable){this.#stream=stream;this.#iterator=stream[Symbol.asyncIterator]();this.#closed=stream.closed?Promise.resolve():new Promise(resolve=>stream.once("close",resolve));stream.on("error",error=>{if(!this.#failed){this.#failed=true;this.#error=error;}});}
  async readChunk():Promise<Uint8Array|null>{
    if(this.#disposed)throw new AppServerStreamClosedError();if(this.#failed)throw this.#error;
    const item=await this.#iterator.next();if(item.done)return null;
    if(types.isProxy(item.value)||!types.isUint8Array(item.value))throw new TypeError("Node app-server output must remain byte encoded");return item.value;
  }
  async destroyAndJoin():Promise<void>{this.#disposed=true;this.#stream.destroy();await this.#closed;}
}
