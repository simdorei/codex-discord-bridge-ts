import {types} from "node:util";
import type {AppServerLineReader} from "./transport-drain.ts";
export interface ByteChunkSource{
  /** Borrowed read access; owner manages cancellation/disposal. Empty bytes or null is EOF. */
  readChunk():Promise<Uint8Array|null>;
}
export class AppServerUtf8Error extends Error{
  readonly kind="InvalidData";
  constructor(){super("stream did not contain valid UTF-8");this.name="AppServerUtf8Error";}
}
/** Tokio 1.53.1 transport line semantics over a required byte source. Decode only a
 * complete LF-delimited line (or EOF tail), so later invalid bytes never erase an
 * earlier valid line. BOM is preserved. There is no source-imposed per-line size cap.
 * Terminal-on-error is scoped to app-server drains, which stop at their first error;
 * this is not a generic Tokio Lines retry/cancellation implementation. */
export class FatalUtf8LineReader implements AppServerLineReader{
  readonly #source:ByteChunkSource;readonly #decoder=new TextDecoder("utf-8",{fatal:true,ignoreBOM:true});
  #chunk:Buffer|null=null;#offset=0;#parts:Buffer[]=[];#bytes=0;#eof=false;#busy=false;#failed=false;#failure:unknown;
  constructor(source:ByteChunkSource){this.#source=source;}
  #append(bytes:Buffer):void{if(bytes.length===0)return;this.#parts.push(bytes);this.#bytes+=bytes.length;}
  #finish(newline:boolean):string{
    const bytes=Buffer.concat(this.#parts,this.#bytes);this.#parts=[];this.#bytes=0;
    let line:string;try{line=this.#decoder.decode(bytes);}catch{throw new AppServerUtf8Error();}
    if(newline&&line.endsWith("\r"))line=line.slice(0,-1);return line;
  }
  async nextLine():Promise<string|null>{
    if(this.#busy)throw new TypeError("Concurrent nextLine calls are not allowed");
    if(this.#failed)throw this.#failure;this.#busy=true;
    try{
      while(true){
        if(this.#chunk!==null){
          const end=this.#chunk.indexOf(10,this.#offset);
          if(end!==-1){this.#append(this.#chunk.subarray(this.#offset,end));this.#offset=end+1;if(this.#offset===this.#chunk.length){this.#chunk=null;this.#offset=0;}return this.#finish(true);}
          this.#append(this.#chunk.subarray(this.#offset));this.#chunk=null;this.#offset=0;
        }
        if(this.#eof)return this.#bytes===0?null:this.#finish(false);
        // Preserve source I/O error precedence over invalid bytes in an incomplete line.
        const next=await this.#source.readChunk();
        if(next===null){this.#eof=true;continue;}
        if(types.isProxy(next)||!types.isUint8Array(next))throw new TypeError("Expected a byte chunk");
        if(next.length===0){this.#eof=true;continue;}
        this.#chunk=Buffer.from(next);this.#offset=0;
      }
    }catch(error){this.#failed=true;this.#failure=error;this.#chunk=null;this.#parts=[];this.#bytes=0;throw error;}
    finally{this.#busy=false;}
  }
}
