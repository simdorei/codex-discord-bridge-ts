/** Closed classifications supplied by the trusted request coordinator, not inferred
 * from an arbitrary error's message, fields or passive diagnostic classification.
 * The error-to-completion adapter and durable mutation coordinator are still separate. */
export type WrittenRequestCompletion="Success"|"Io"|"Closed"|"TransportClosed"|"ResponseChannelClosed"|"Timeout"|"OtherError";
export interface FlushIsolation{confirmFlushed():void}
interface ResidentCancellation{markCancelled(generation:bigint):void}
const outcomes=new Set<WrittenRequestCompletion>(["Success","Io","Closed","TransportClosed","ResponseChannelClosed","Timeout","OtherError"]);
/** Rust manager/admission.rs WrittenRequestGuard with explicit dispose instead of Drop.
 * Owning coordinator must use finally-dispose, while retaining its admission permit.
 * A Timeout finish itself does not quarantine: source dispatch separately decides this
 * using observational/mutation/durable-isolation evidence. No replay authority is given. */
export class WrittenRequestGuard{
  readonly #state:ResidentCancellation;readonly #generation:bigint;
  #started=false;#complete=false;#disposed=false;#isolation:{flushed:boolean}|null=null;
  constructor(state:ResidentCancellation,generation:bigint){
    if(typeof generation!=="bigint"||generation<0n||generation>=(1n<<64n))throw new TypeError("Expected u64 written-request generation");
    this.#state=state;this.#generation=generation;
  }
  #live():void{if(this.#disposed||this.#complete)throw new TypeError("Written request guard already completed");}
  confirmWriteStarted():void{this.#live();this.#started=true;}
  isolateAfterFlush():FlushIsolation{
    this.#live();const flag={flushed:false};this.#isolation=flag;
    return Object.freeze({confirmFlushed:()=>{flag.flushed=true;}});
  }
  isIsolated():boolean{return this.#isolation?.flushed===true;}
  finish(completion:WrittenRequestCompletion):void{
    this.#live();if(!outcomes.has(completion))throw new TypeError("Expected trusted written-request completion kind");
    // An explicit transport/I/O failure quarantines even after isolated flush. Isolation
    // only suppresses the unfinished Drop-equivalent path, matching the source guard.
    if(this.#started&&(completion==="Io"||completion==="Closed"||completion==="TransportClosed"||completion==="ResponseChannelClosed"))this.#state.markCancelled(this.#generation);
    this.#complete=true;
  }
  dispose():void{
    if(this.#disposed)return;
    if(this.#started&&!this.#complete&&!this.isIsolated())this.#state.markCancelled(this.#generation);
    this.#disposed=true;
  }
}
