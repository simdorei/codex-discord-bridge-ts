export interface DiagnosticSnapshot{readonly lines:readonly string[];readonly retainedBytes:number;readonly droppedLines:bigint}
const MAX_LINES=512,MAX_BYTES=64*1024;
/** Diagnostic data only; never execution authority. Deliberate safety correction:
 * pinned Rust truncates at byte 65536 even inside UTF-8, which can panic. We floor
 * to a scalar boundary instead; this edge is not claimed as exact Rust behavior. */
export class BoundedDiagnostics{
  readonly #lines:{text:string;bytes:number}[]=[];#bytes=0;#dropped=0n;
  push(input:string):void{
    if(typeof input!=="string"||/[\uD800-\uDFFF]/u.test(input))throw new TypeError("Expected well-formed diagnostic text");
    let end=0,bytes=0;for(const char of input){const size=Buffer.byteLength(char,"utf8");if(bytes+size>MAX_BYTES)break;bytes+=size;end+=char.length;}
    this.#lines.push({text:input.slice(0,end),bytes});this.#bytes+=bytes;
    while(this.#lines.length>MAX_LINES||this.#bytes>MAX_BYTES){const removed=this.#lines.shift()!;this.#bytes-=removed.bytes;this.#dropped++;}
  }
  snapshot():DiagnosticSnapshot{return Object.freeze({lines:Object.freeze(this.#lines.map(l=>l.text)),retainedBytes:this.#bytes,droppedLines:this.#dropped});}
}
