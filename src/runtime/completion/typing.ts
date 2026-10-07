import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import {snapshotStoredQueueJob} from "../../store/queue-read.ts";
import {TerminalFence} from "./terminal-fence.ts";
import {validateCompletionChannel} from "./final-delivery.ts";
/** Trusted watch: hasChanged is nonthrowing (true when closed); changed must settle on abort. */
export interface TypingLifecycleSubscription{hasChanged():boolean;changed(signal?:AbortSignal):Promise<void>;dispose():void}
export interface TypingBackend{
  generation():bigint;
  subscribeLifecycle():TypingLifecycleSubscription;
  lifecycleSnapshot():Promise<{readonly healthy:boolean;readonly quarantined:boolean;readonly restartPending:boolean}>;
  activeTurnId(target:string):Promise<string|null>;
}
/** REQUIRED trusted adapter: on abort, stop pending dispatch and settle the returned
 * Promise after reclaiming owned work. This module awaits settlement, not Rust Drop. */
export interface TypingTransport{createTyping(channel:bigint,signal:AbortSignal):Promise<void>}
export class TypingDeliveryError extends Error{readonly source:unknown;constructor(source:unknown){super("Discord typing request failed",{cause:source});this.name="TypingDeliveryError";this.source=source;}}
type TypingStore=Pick<IStateAccessFacade,"listFiltered"|"pendingObservedCompletions">;
interface HttpResult{kind:"http";ok:boolean;error?:unknown}
/** Source ordering with explicit JS cancellation/join. Real transport, off-thread DB
 * execution, hard cancellation and exact native error formatting remain unfinished. */
export async function sendTyping(path:string,server:TypingBackend,fence:TerminalFence,transport:TypingTransport,store:TypingStore=StateAccessFacade):Promise<void>{
  const lifecycle=server.subscribeLifecycle();let failed=false,first:unknown;
  const remember=(error:unknown)=>{if(!failed){failed=true;first=error;}};
  try{
    const generation=server.generation(),snapshot=await server.lifecycleSnapshot();
    if(!snapshot.healthy||snapshot.quarantined||snapshot.restartPending)return;
    const version=fence.retentionVersion;
    const jobs=(await store.listFiltered(path,null,null)).map(snapshotStoredQueueJob);
    const terminals=await store.pendingObservedCompletions(path);
    fence.retain(generation,jobs,version);const channels=new Set<bigint>();
    for(const job of jobs){
      const turn=job.turnId;if(turn===null||job.state!=="Running"||job.goalWaiting||channels.has(job.channelId)||terminals.some(t=>t.threadId===job.targetThreadId&&t.turnId===turn))continue;
      const revoked=fence.subscribe(),subscribedVersion=fence.retentionVersion;
      try{
        let active:string|null;try{active=await server.activeTurnId(job.targetThreadId);}catch(error){remember(error);continue;}
        if(active!==turn||server.generation()!==generation||lifecycle.hasChanged()||fence.stopped(generation,job.targetThreadId,turn))continue;
        channels.add(job.channelId);try{validateCompletionChannel(job.channelId);}catch(error){remember(error);continue;}
        // A watch already ready would win Rust's biased select before HTTP is polled.
        if(fence.retentionVersion!==subscribedVersion)continue;
        const waits=new AbortController(),requestAbort=new AbortController();
        const life=lifecycle.changed(waits.signal).then(()=>({kind:"life" as const}),()=>({kind:"life" as const}));
        const terminal=revoked.changed(waits.signal).then(()=>({kind:"terminal" as const}),()=>({kind:"terminal" as const}));
        let request:Promise<HttpResult>;
        try{request=transport.createTyping(job.channelId,requestAbort.signal).then(()=>({kind:"http" as const,ok:true}),error=>({kind:"http" as const,ok:false,error}));}
        catch(error){request=Promise.resolve({kind:"http",ok:false,error});}
        let result:HttpResult|{kind:"life"|"terminal"};
        try{
          result=await Promise.race([life,terminal,request]);
          if(lifecycle.hasChanged())result={kind:"life"};else if(fence.retentionVersion!==subscribedVersion)result={kind:"terminal"};
          if(result.kind!=="http")requestAbort.abort();
          await request; // Never leave transport work detached after revocation.
        }finally{requestAbort.abort();waits.abort();await Promise.all([request,life,terminal]);}
        if(result.kind==="life")break;
        if(result.kind==="http"&&!result.ok)remember(new TypingDeliveryError(result.error));
      }finally{revoked.dispose();}
    }
    if(failed)throw first;
  }finally{lifecycle.dispose();}
}
