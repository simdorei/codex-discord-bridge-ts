import {isMainThread} from "node:worker_threads";
import type {NativeCompletionDiscoveryReader,NativeDiscoverySnapshot} from "../native-discovery.ts";
import {StateAccessFacade as state} from "../../../store/state-access-facade.ts";
import {initialCompletionCursor,equalCompletionEntry,nativeCompletionCursorRestore,nativeCompletionCursorWire,snapshotCompletionEntry,type CompletionCursor,type CompletionEntry} from "../../../store/completion-metadata.ts";
import {COMPLETION_SOURCES,requireCompletionSource,completionSourceIsState,type CompletionSource} from "../../../store/completion-metadata-sql.ts";
import type {CompletionMetadataRound} from "../../../store/completion-metadata-round.ts";
import {CompletionReady,COMPLETION_READY_CAP} from "./ready.ts";
interface Scan {source:CompletionSource;cursor:CompletionCursor;next:number;wake:boolean;wakeVersion:object;pending:CompletionEntry[]}
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
/** Pure staged discovery with sync compatibility and explicit autonomous native profile. No dispatch or observation-gap logging.
 * The enclosing runtime must consume negative sidecars before awaiting/dispatching. */
export class CompletionDiscovery {
  #scans:Scan[];#rotation=0;#reading=false;readonly #now:()=>number;readonly #native:NativeCompletionDiscoveryReader|undefined;
  constructor(sources:readonly CompletionSource[]=COMPLETION_SOURCES,now:()=>number=()=>performance.now(),native?:NativeCompletionDiscoveryReader){
    if(sources.length>8)throw new RangeError("At most eight discovery scans");for(const source of sources)requireCompletionSource(source);
    this.#now=now;this.#native=native;this.#scans=sources.map(source=>({source,cursor:native?.initialCursor()??initialCompletionCursor(),next:0,wake:false,wakeVersion:Object.freeze({}),pending:[]}));
  }
  get isNative():boolean{return this.#native!==undefined;}
  get rotation():number{return this.#rotation;}
  snapshot():readonly {source:CompletionSource;cursor:CompletionCursor;next:number;wake:boolean;pending:readonly CompletionEntry[]}[]{return Object.freeze(this.#scans.map(s=>Object.freeze({source:s.source,cursor:s.cursor,next:s.next,wake:s.wake,pending:Object.freeze([...s.pending])})));}
  wake(source?:CompletionSource):void{if(source!==undefined)requireCompletionSource(source);for(const scan of this.#scans)if(source===undefined||scan.source===source){scan.wake=true;scan.wakeVersion=Object.freeze({});}}
  wakeHttp():void{for(const scan of this.#scans)if(!completionSourceIsState(scan.source)){scan.wake=true;scan.wakeVersion=Object.freeze({});}}
  get drained():boolean{return this.#scans.every(s=>s.cursor.finished&&!s.wake&&s.pending.length===0);}
  read<L>(path:string,runtime:string,generation:bigint,ready:CompletionReady<L>,active:ReadonlySet<string>):readonly DiscoveryReport[]{
    if(this.#native!==undefined||this.#reading)throw new TypeError("Discovery reader mode or ownership mismatch");
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
    this.#commit(staged,rotation);return reports;
  }
  #commit(staged:Scan[],rotation:number):void{
    for(let i=0;i<staged.length;i++){const live=this.#scans[i]!,next=staged[i]!;if(live.wakeVersion!==next.wakeVersion){next.wake=true;next.wakeVersion=live.wakeVersion;}}
    this.#scans=staged;this.#rotation=(rotation+1)%staged.length;
  }
  /** Main runtime cannot restore public cursor bytes or instantiate a worker snapshot. */
  static restoreNative(input:NativeDiscoverySnapshot,now:()=>number):CompletionDiscovery{
    if(isMainThread)throw new TypeError("Discovery snapshot restore is worker-only");
    if(!Array.isArray(input.scans)||input.scans.length>8||!Number.isSafeInteger(input.rotation)||input.rotation<0||input.rotation>=Math.max(1,input.scans.length))throw new TypeError("Invalid discovery snapshot");
    const result=new CompletionDiscovery(input.scans.map(s=>s.source),now);result.#rotation=input.rotation;
    result.#scans=input.scans.map(s=>{
      requireCompletionSource(s.source);if(typeof s.wake!=="boolean"||!Number.isFinite(s.next)||s.next<0||!Array.isArray(s.pending)||s.pending.length>32)throw new TypeError("Invalid discovery scan");
      const pending=s.pending.map((e:CompletionEntry)=>{const v=snapshotCompletionEntry(e);if(v.source!==s.source)throw new TypeError("Wrong pending source");return v;});
      return {source:s.source,cursor:nativeCompletionCursorRestore(s.cursor),next:s.next,wake:s.wake,wakeVersion:Object.freeze({}),pending};
    });return result;
  }
  snapshotNative():NativeDiscoverySnapshot{
    if(isMainThread)throw new TypeError("Discovery snapshot export is worker-only");
    return {rotation:this.#rotation,scans:this.#scans.map(s=>({source:s.source,cursor:nativeCompletionCursorWire(s.cursor),next:s.next,wake:s.wake,pending:[...s.pending]}))};
  }
  async readAsync<L>(runtime:string,generation:bigint,ready:CompletionReady<L>,active:ReadonlySet<string>,signal?:AbortSignal):Promise<readonly DiscoveryReport[]>{
    if(this.#native===undefined||this.#reading)throw new TypeError("Discovery reader mode or ownership mismatch");signal?.throwIfAborted();if(this.#scans.length===0)return [];this.#reading=true;
    const native=this.#native,rotation=this.#rotation%this.#scans.length,staged=this.#scans.map(s=>({...s,pending:[...s.pending]})),samples:number[]=[],needed=Symbol("native page needed");
    const noSql:CompletionMetadataRound={page(){throw needed;},unprovableOrphans(){throw needed;}};
    try{
      // Common cooldown/backpressure rounds remain pure and allocate no native owner.
      try{
        const reports=ready.draft(()=>{const reports:DiscoveryReport[]=[];
          for(let offset=0;offset<staged.length;offset++){
            const index=(rotation+offset)%staged.length,candidate={...staged[index]!,pending:[...staged[index]!.pending]};
            try{const metadata=ready.draft(()=>discover(candidate,noSql,ready,active,()=>{const value=this.#now();samples.push(value);return value;}));staged[index]=candidate;reports.push({source:candidate.source,ok:true,metadata});}
            catch(error){if(error===needed)throw error;reports.push({source:candidate.source,ok:false,error});}
          }return Object.freeze(reports);
        });this.#commit(staged,rotation);return reports;
      }catch(error){if(error!==needed)throw error;}
      // Preflight was rolled back; capture original scans and owned Ready references.
      const original=this.#scans.map(s=>({...s,pending:[...s.pending]}));
      const result=await ready.draftAsync(async draft=>{
        const value=await native.discover(runtime,generation,{rotation,scans:original},draft.stateSnapshot(),draft.httpSnapshot(),active,samples,signal);
        signal?.throwIfAborted();const before=draft.length;
        for(const entry of value.state)draft.durable(entry,new Set());for(const entry of value.http)draft.durable(entry,new Set());
        if(draft.length!==before+value.state.length+value.http.length)throw new TypeError("Native discovery changed ready prefix or capacity");return value;
      });
      const next=result.scans.map((s,i)=>({...s,wakeVersion:original[i]!.wakeVersion,pending:[...s.pending]}));this.#commit(next,rotation);return result.reports;
    }finally{this.#reading=false;}
  }

}
