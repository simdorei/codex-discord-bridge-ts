import {types} from "node:util";
import {CheckedRead} from "./owned-driver.ts";
import {StoreIntegrityError} from "./schema-assembly.ts";
import {completionPageIn,type CompletionCursor,type CompletionPageRead,type CompletionEntry} from "./completion-metadata.ts";
import {requireCompletionSource,type CompletionSource,COMPLETION_PAGE_SIZE} from "./completion-metadata-sql.ts";
import {unprovableAsyncOrphansIn} from "./async-orphan-preflight.ts";
export interface CompletionMetadataRound{
  page(source:CompletionSource,cursor:CompletionCursor):CompletionPageRead;
  unprovableOrphans(entries:readonly CompletionEntry[]):number[];
}
const invalid=()=>new StoreIntegrityError("metadata round has no valid read snapshot; no results may be published");
class Round implements CompletionMetadataRound{
  readonly #path:string;readonly #runtime:string;readonly #generation:bigint;
  #snapshot:CheckedRead|null=null;#failed:{error:unknown}|null=null;#sources:CompletionSource[]=[];#preflight=false;#closed=false;
  constructor(path:string,runtime:string,generation:bigint){this.#path=path;this.#runtime=runtime;this.#generation=generation;}
  #valid():void{if(this.#closed||this.#failed!==null)throw invalid();}
  #active():CheckedRead{const snapshot=this.#snapshot;if(snapshot===null)throw invalid();try{snapshot.ensureActive();}catch(error){this.#failed={error};throw invalid();}return snapshot;}
  page(source:CompletionSource,cursor:CompletionCursor):CompletionPageRead{
    this.#valid();requireCompletionSource(source);
    if(this.#sources.length>=8||this.#sources.includes(source))throw new StoreIntegrityError("metadata round permits each of its eight sources once");
    this.#sources.push(source);
    if(this.#snapshot===null){try{this.#snapshot=CheckedRead.open(this.#path);}catch(error){this.#failed={error};throw invalid();}}
    const snapshot=this.#active();
    try{return completionPageIn(snapshot.connection(),source,cursor,this.#runtime,this.#generation);}finally{this.#active();}
  }
  unprovableOrphans(entries:readonly CompletionEntry[]):number[]{
    this.#valid();
    if(this.#preflight||!this.#sources.includes("AsyncOrphan")||entries.length>COMPLETION_PAGE_SIZE||entries.some(e=>e.source!=="AsyncOrphan"))throw new StoreIntegrityError("orphan preflight requires one bounded current source page");
    this.#preflight=true;const snapshot=this.#active();
    try{return unprovableAsyncOrphansIn(snapshot.connection(),entries.map(e=>e.target));}finally{this.#active();}
  }
  finish():void{
    this.#valid();try{this.#snapshot?.finish();}finally{this.#closed=true;}
  }
  /** Preserve the original snapshot-open/liveness failure after callback handling. */
  complete():void{if(this.#failed!==null)throw this.#failed.error;this.finish();}
  close():void{this.#closed=true;this.#snapshot?.close();}
}
/** Trusted synchronous staged callback only. Results become usable after successful finish;
 * do not publish hints from inside the callback. No pages means no file/connection access. */
export function readCompletionMetadataRound<T>(path:string,runtime:string,generation:bigint,operation:(round:CompletionMetadataRound)=>T):T{
  for(const value of [path,runtime])if(typeof value!=="string"||/[\uD800-\uDFFF]/u.test(value))throw new TypeError("Expected well-formed metadata scope");
  if(typeof generation!=="bigint"||generation<-(1n<<63n)||generation>=(1n<<63n))throw new TypeError("Expected i64 metadata generation");
  if(typeof operation!=="function"||types.isProxy(operation)||types.isAsyncFunction(operation)||types.isGeneratorFunction(operation))throw new TypeError("Metadata callback must be synchronous");
  const round=new Round(path,runtime,generation);
  try{
    const result=operation(round);
    if(types.isPromise(result)){
      // Drain rejection from this unsupported trusted callback result; this neither
      // awaits nor cancels work it may already have launched. The reader closes below.
      void Promise.prototype.then.call(result,undefined,()=>undefined);
      throw new TypeError("Metadata callback must not return a Promise");
    }
    round.complete();return result;
  }finally{round.close();}
}
