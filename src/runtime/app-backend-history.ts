import {boundedSerdeByteCount} from "../core/serde-byte-count.ts";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {serdeField} from "../app-server/value.ts";
import {readThreadWithTimeout,type AppRequest} from "../app-server/requests.ts";
import {BackendFailureError} from "./queue-runner/errors.ts";
const MAX_BYTES=1_048_576;
export interface BackendHistoryPort{generation():bigint;request(request:AppRequest,generation:bigint,signal?:AbortSignal):Promise<unknown>}
function invalid(message:string):never{throw new BackendFailureError({message,ambiguous:false,kind:"Other"});}
function identity(metadata:unknown,thread:string):void{if(serdeField(serdeField(metadata,"thread"),"id")!==thread)invalid("thread/resume returned a different or invalid thread");}
/** Historical evidence only, not a native release proof. Deliberately preserves the
 * older caller contract: missing nextCursor means exhausted, pages alone consume
 * the history budget, and arbitrary original statuses are retained for later logic. */
export async function readBackendAsyncHistory(port:BackendHistoryPort,thread:string,originals:readonly string[],historyTimeoutMs:number,signal?:AbortSignal):Promise<Record<string,unknown>|null>{
  signal?.throwIfAborted();const wantedInput=cloneOwnedSerdeValue(originals);if(typeof thread!=="string"||/[\uD800-\uDFFF]/u.test(thread)||!Array.isArray(wantedInput)||wantedInput.some(id=>typeof id!=="string"))throw new TypeError("Expected well-formed historical identities");
  if(wantedInput.length===0)return null;if(wantedInput.length>128)invalid("too many historical original turns");
  const generation=port.generation(),timeout=Math.min(historyTimeoutMs,2000),wanted=new Set(wantedInput as string[]),found=new Set<string>(),seen=new Set<string>(),cursors=new Set<string>(),turns:unknown[]=[];let cursor:string|null=null,bytes=0;
  identity(await port.request(readThreadWithTimeout(thread,false,timeout),generation,signal),thread);
  for(let i=0;i<8;i++){
    signal?.throwIfAborted();const page=cloneOwnedSerdeValue(await port.request({method:"thread/turns/list",params:{threadId:thread,limit:16n,sortDirection:"desc",itemsView:"full",cursor},timeoutMs:timeout},generation,signal));
    const size=boundedSerdeByteCount(page,MAX_BYTES-bytes),truncated=serdeField(page,"truncated");if(size===null||(truncated!==undefined&&truncated!==false))invalid("historical page truncated or exceeds byte bound");bytes+=size;
    const data=serdeField(page,"data");if(!Array.isArray(data)||data.length>16)invalid("historical page has no bounded turn array");
    for(const turn of data){const id=serdeField(turn,"id");if(typeof id!=="string"||id===""||Buffer.byteLength(id)>512)invalid("historical turn identity missing");if(seen.has(id))invalid("duplicate historical turn identity");seen.add(id);if(wanted.has(id)){found.add(id);turns.push(turn);}}
    const raw=serdeField(page,"nextCursor");let next:string|null=null;if(raw!==undefined&&raw!==null){if(typeof raw!=="string"||raw===""||Buffer.byteLength(raw)>2048)invalid("invalid historical cursor");next=raw;}
    if(next===null||found.size===wanted.size){if(port.generation()!==generation)invalid("historical connection changed");return cloneOwnedSerdeValue({threadId:thread,turns,history_exhausted:next===null}) as Record<string,unknown>;}
    if(cursors.has(next))invalid("historical cursor repeated");cursors.add(next);cursor=next;
  }
  invalid("historical read exceeded eight pages; absence is not proof");
}
export async function readBackendAsyncTerminal(port:BackendHistoryPort,thread:string,owners:readonly string[],historyTimeoutMs:number,signal?:AbortSignal):Promise<Record<string,unknown>|null>{
  const generation=port.generation(),history=await readBackendAsyncHistory(port,thread,owners,historyTimeoutMs,signal);if(history===null)return null;
  const timeout=Math.min(historyTimeoutMs,2000),goal=await port.request({method:"thread/goal/get",params:{threadId:thread},timeoutMs:timeout},generation,signal),metadata=await port.request(readThreadWithTimeout(thread,false,timeout),generation,signal);identity(metadata,thread);
  if(port.generation()!==generation)invalid("historical terminal connection changed");
  const result={...history,goal_observation:goal,thread_observation:metadata};if(boundedSerdeByteCount(result,MAX_BYTES)===null)invalid("historical terminal observation exceeds byte bound");return cloneOwnedSerdeValue(result) as Record<string,unknown>;
}
