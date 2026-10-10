import {StateAccessFacade as state} from "../../../store/state-access-facade.ts";
import {initialCompletionCursor,equalCompletionEntry,type CompletionCursor,type CompletionEntry} from "../../../store/completion-metadata.ts";
import {COMPLETION_SOURCES,requireCompletionSource,completionSourceIsState,type CompletionSource} from "../../../store/completion-metadata-sql.ts";
import type {CompletionMetadataRound} from "../../../store/completion-metadata-round.ts";
import {CompletionReady,COMPLETION_READY_CAP} from "./ready.ts";
interface Scan {source:CompletionSource;cursor:CompletionCursor;next:number;wake:boolean;pending:CompletionEntry[]}
export interface DiscoveryPageMetadata {readonly oversizedIdentity:boolean;readonly heldReceiptHeads:bigint;readonly deferred:readonly {readonly index:number;readonly entry:CompletionEntry}[]}
export type DiscoveryReport={readonly source:CompletionSource;readonly ok:true;readonly metadata:DiscoveryPageMetadata|null}|{readonly source:CompletionSource;readonly ok:false;readonly error:unknown};
function offer<L>(scan:Scan,ready:CompletionReady<L>,active:ReadonlySet<string>):boolean{
  while(ready.length<COMPLETION_READY_CAP){const entry=scan.pending.shift();if(entry===undefined)return true;ready.durable(entry,active);}return scan.pending.length===0;
}
function discover<L>(scan:Scan,reader:CompletionMetadataRound,ready:CompletionReady<L>,active:ReadonlySet<string>,now:()=>number):DiscoveryPageMetadata|null{
  if(!offer(scan,ready,active))return null;
  const timestamp=now();if(!Number.isFinite(timestamp)||timestamp<0)throw new TypeError("Expected monotonic milliseconds");
  const restart=scan.cursor.finished;
  if(restart&&!scan.wake&&timestamp<scan.next)return null;
  const {cursor,page}=reader.page(scan.source,restart?initialCompletionCursor():scan.cursor);
  const negatives=scan.source==="AsyncOrphan"?reader.unprovableOrphans(page.entries).map(i=>page.entries[i]!):[];
  scan.cursor=cursor;if(restart)scan.wake=false;scan.pending=[...page.entries];
  const firstNew=ready.stateLength;offer(scan,ready,active);
  const deferred:{index:number;entry:CompletionEntry}[]=[];
  ready.stateSnapshot().forEach((work,index)=>{if(index>=firstNew&&work.kind==="Durable"&&negatives.some(n=>equalCompletionEntry(n,work.entry)))deferred.push({index,entry:work.entry});});
  if(scan.cursor.finished)scan.next=timestamp+(scan.source==="Queue"||scan.source==="AsyncOrphan"?30000:1000);
  return Object.freeze({oversizedIdentity:page.oversizedIdentity,heldReceiptHeads:page.heldReceiptHeads,deferred:Object.freeze(deferred)});
}
/** Synchronous discovery coordinator only. No dispatch or observation-gap logging.
 * The enclosing runtime must consume negative sidecars before awaiting/dispatching. */
export class CompletionDiscovery {
  #scans:Scan[];#rotation=0;readonly #now:()=>number;
  constructor(sources:readonly CompletionSource[]=COMPLETION_SOURCES,now:()=>number=()=>performance.now()){
    if(sources.length>8)throw new RangeError("At most eight discovery scans");for(const source of sources)requireCompletionSource(source);
    this.#now=now;this.#scans=sources.map(source=>({source,cursor:initialCompletionCursor(),next:0,wake:false,pending:[]}));
  }
  get rotation():number{return this.#rotation;}
  snapshot():readonly {source:CompletionSource;cursor:CompletionCursor;next:number;wake:boolean;pending:readonly CompletionEntry[]}[]{return Object.freeze(this.#scans.map(s=>Object.freeze({...s,pending:Object.freeze([...s.pending])})));}
  wake(source?:CompletionSource):void{if(source!==undefined)requireCompletionSource(source);for(const scan of this.#scans)if(source===undefined||scan.source===source)scan.wake=true;}
  wakeHttp():void{for(const scan of this.#scans)if(!completionSourceIsState(scan.source))scan.wake=true;}
  get drained():boolean{return this.#scans.every(s=>s.cursor.finished&&!s.wake&&s.pending.length===0);}
  read<L>(path:string,runtime:string,generation:bigint,ready:CompletionReady<L>,active:ReadonlySet<string>):readonly DiscoveryReport[]{
    if(this.#scans.length===0)return [];
    const rotation=this.#rotation%this.#scans.length,staged=this.#scans.map(s=>({...s,pending:[...s.pending]}));
    const reports=ready.draft(()=>state.readCompletionMetadataRound(path,runtime,generation,reader=>{
      const result:DiscoveryReport[]=[];
      for(let offset=0;offset<staged.length;offset++){
        const index=(rotation+offset)%staged.length,candidate={...staged[index]!,pending:[...staged[index]!.pending]};
        try{const metadata=ready.draft(()=>discover(candidate,reader,ready,active,this.#now));staged[index]=candidate;result.push({source:candidate.source,ok:true,metadata});}
        catch(error){result.push({source:candidate.source,ok:false,error});}
      }return Object.freeze(result);
    }));
    this.#scans=staged;this.#rotation=(rotation+1)%staged.length;return reports;
  }
}
