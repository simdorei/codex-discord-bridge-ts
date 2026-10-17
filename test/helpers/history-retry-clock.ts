import assert from 'node:assert/strict';
import type {GatewayShutdownClock} from '../../src/discord/gateway/shutdown.ts';
/** Manual monotonic time; each waiter owns and removes its abort listener. */
export function historyRetryClock(){
 let time=0,maximum=0;const pending=new Set<{at:number;resolve():void}>(),deadlines:number[]=[];
 const clock:GatewayShutdownClock={now:()=>time,sleepUntil:(at,signal)=>new Promise<void>((resolve,reject)=>{
  signal.throwIfAborted();const done=()=>{pending.delete(entry);signal.removeEventListener('abort',abort);},abort=()=>{done();reject(signal.reason);},entry={at,resolve:()=>{done();resolve();}};
  deadlines.push(at);pending.add(entry);maximum=Math.max(maximum,pending.size);signal.addEventListener('abort',abort,{once:true});if(at<=time)entry.resolve();
 })};
 return {clock,deadlines,get active(){return pending.size;},get maximum(){return maximum;},get now(){return time;},advance(at:number){assert.ok(at>=time);time=at;for(const entry of [...pending])if(entry.at<=time)entry.resolve();}};
}
export async function waitHistoryCondition(check:()=>boolean){const end=performance.now()+8000;while(!check()){assert.ok(performance.now()<end,'history fixture condition deadline');await new Promise(r=>setTimeout(r,5));}}
