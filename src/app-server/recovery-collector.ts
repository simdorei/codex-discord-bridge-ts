import {boundedSerdeByteCount} from "../core/serde-byte-count.ts";
import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {serdeField} from "./value.ts";
import {AppServerInvalidReplyError} from "./client-errors.ts";
const MAX_BYTES=1_048_576;
function invalid(message:string):never{throw new AppServerInvalidReplyError(message);}
function exactIdle(value:unknown,thread:string):void{
  const t=serdeField(value,"thread"),truncated=serdeField(value,"truncated");
  if(serdeField(t,"id")!==thread||serdeField(serdeField(t,"status"),"type")!=="idle"||serdeField(t,"archived")===true||(truncated!==undefined&&truncated!==false))invalid("recovery observation needs the exact current idle thread");
}
/** Bounded JSON collection only. This exported function produces no native proof or
 * release authority; the owning resident must bind its actual client lifetime. */
export async function collectRecoveryObservation(thread:string,owners:ReadonlySet<string>,request:(method:string,params:unknown)=>Promise<unknown>):Promise<unknown>{
  let bytes=0;
  const read=async(method:string,params:unknown)=>{const value=cloneOwnedSerdeValue(await request(method,params));const size=boundedSerdeByteCount(value,MAX_BYTES-bytes);if(size===null)invalid("recovery observation exceeds its byte bound");bytes+=size;return value;};
  const params={threadId:thread,includeTurns:false};const initial=await read("thread/read",params);exactIdle(initial,thread);
  const found=new Set<string>(),seen=new Set<string>(),cursors=new Set<string>(),turns:unknown[]=[];let cursor:string|null=null,exhausted=false,complete=false;
  for(let pageIndex=0;pageIndex<8;pageIndex++){
    const page=await read("thread/turns/list",{threadId:thread,limit:16n,sortDirection:"desc",itemsView:"full",cursor}),truncated=serdeField(page,"truncated"),pageThread=serdeField(page,"threadId");
    if((truncated!==undefined&&truncated!==false)||(pageThread!==undefined&&pageThread!==thread))invalid("recovery history is truncated or belongs to another target");
    const data=serdeField(page,"data");if(!Array.isArray(data)||data.length>16)invalid("recovery history has no bounded turn array");
    for(const turn of data){const id=serdeField(turn,"id");if(typeof id!=="string"||id===""||Buffer.byteLength(id)>512)invalid("recovery turn identity is missing");if(seen.has(id))invalid("duplicate recovery turn identity");seen.add(id);
      if(owners.has(id)){const status=serdeField(turn,"status"),truncated=serdeField(turn,"truncated");if(!["completed","failed","interrupted"].includes(status as string)||(truncated!==undefined&&truncated!==false))invalid("required original execution is not fully terminal");found.add(id);turns.push(turn);}
    }
    const next=serdeField(page,"nextCursor");if(next!==undefined&&next!==null&&(typeof next!=="string"||next===""||Buffer.byteLength(next)>2048))invalid("invalid recovery history cursor");
    if(found.size===owners.size){complete=true;exhausted=next===null;break;}
    if(next===undefined||next===null)invalid("required original execution is absent from bounded history");
    if(cursors.has(next as string))invalid("recovery history cursor repeated");cursors.add(next as string);cursor=next as string;
  }
  if(!complete)invalid("recovery history exceeds eight pages; absence is not proof");
  const goal=await read("thread/goal/get",{threadId:thread}),g=serdeField(goal,"goal");if(g===undefined)invalid("current Goal observation is missing");if(g!==null&&(serdeField(g,"threadId")!==thread||serdeField(g,"status")!=="complete"))invalid("current Goal has not ended for the exact target");
  const current=await read("thread/read",params);exactIdle(current,thread);
  const result={threadId:thread,truncated:false,required_owners_complete:true,history_exhausted:exhausted,turns,goal_observation:goal,thread_observation:current};
  if(boundedSerdeByteCount(result,MAX_BYTES)===null)invalid("combined recovery observation exceeds its byte bound");return cloneOwnedSerdeValue(result);
}
