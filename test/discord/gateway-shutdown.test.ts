import assert from 'node:assert/strict';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {GatewayTask,GatewayShutdownError,GatewayShutdownReportingError,joinGatewayTasksForCause,nativeGatewayShutdownClock,GATEWAY_SHUTDOWN_TIMEOUT_MS,type GatewayShutdownClock,type GatewayShutdownOptions} from '../../src/discord/gateway/shutdown.ts';
class Clock implements GatewayShutdownClock{
 time=0;readonly scheduled:number[]=[];readonly waiting=new Set<{at:number;wake:()=>void}>();now():number{return this.time;}
 sleepUntil(at:number,signal:AbortSignal):Promise<void>{signal.throwIfAborted();this.scheduled.push(at);if(at<=this.time)return Promise.resolve();return new Promise((resolve,reject)=>{const record={at,wake:()=>{clean();resolve();}},clean=()=>{this.waiting.delete(record);signal.removeEventListener('abort',abort);},abort=()=>{clean();reject(signal.reason);};this.waiting.add(record);signal.addEventListener('abort',abort,{once:true});});}
 advance(to:number):void{assert.ok(to>=this.time);this.time=to;for(const w of [...this.waiting])if(w.at<=to)w.wake();}
}
function controlled(shard:number,obey=true,onAbort:()=>void=()=>{}){
 let resolve!:()=>void,reject!:(error:unknown)=>void,signal!:AbortSignal;
 const task=new GatewayTask(shard,s=>{signal=s;return new Promise<void>((yes,no)=>{let done=false;const clean=()=>{signal.removeEventListener('abort',abort);},finish=(error:boolean,value?:unknown)=>{if(done)return;done=true;clean();if(error)no(value);else yes();},abort=()=>{onAbort();if(obey)finish(true,signal.reason);};resolve=()=>finish(false);reject=e=>finish(true,e);signal.addEventListener('abort',abort,{once:true});});});return {task,resolve,reject,signal};
}
function options(clock=new Clock()){const reports:{shard:number;error:GatewayShutdownError}[]=[],fatal=new Error('fatal-sentinel');let fatals=0;const value:GatewayShutdownOptions={clock,reportTriggerFailure:(shard,error)=>{reports.push({shard,error});},fatal:()=>{fatals++;throw fatal;}};return {clock,reports,fatal,fatals:()=>fatals,value};}
test('empty shutdown consumes nothing and keeps trigger absent without starting timers',async()=>{
 const o=options(),input:GatewayTask[]=[];assert.equal(GATEWAY_SHUTDOWN_TIMEOUT_MS,10000);assert.deepEqual(await joinGatewayTasksForCause(input,2000,9,o.value),{trigger:null,cleanup:{ok:true}});assert.equal(o.clock.waiting.size,0);assert.equal(o.fatals(),0);
});
test('completed task wins even after the deadline and the caller vector is consumed',async()=>{
 const o=options(),c=controlled(1);c.resolve();await c.task.join();o.clock.advance(5000);const input=[c.task];assert.deepEqual(await joinGatewayTasksForCause(input,1,1,o.value),{trigger:{ok:true},cleanup:{ok:true}});assert.deepEqual(input,[]);assert.deepEqual(o.clock.scheduled,[]);
});
test('first join error follows vector order while all remaining tasks still join',{timeout:5000},async()=>{
 const o=options(),a=controlled(1),b=controlled(2),first=new Error('first'),second=new Error('second');b.reject(second);const joined=joinGatewayTasksForCause([a.task,b.task],2000,null,o.value);await tick();assert.equal(o.clock.waiting.size,1);a.reject(first);const report=await joined;assert.equal(report.cleanup.ok,false);if(!report.cleanup.ok){assert.equal(report.cleanup.error.kind,'Join');assert.equal(report.cleanup.error.taskError,first);}assert.equal(o.clock.waiting.size,0);
});
test('trigger task is selected out of order and reported before remaining cleanup',{timeout:5000},async()=>{
 const o=options(),a=controlled(1),trigger=controlled(2),reason=new Error('trigger'),input=[a.task,trigger.task];const joined=joinGatewayTasksForCause(input,2000,2,o.value);await tick();assert.deepEqual(input,[]);assert.equal(o.clock.scheduled[0],2000);trigger.reject(reason);await tick();assert.equal(o.reports.length,1);assert.equal(o.reports[0]!.shard,2);assert.equal(o.reports[0]!.error.taskError,reason);assert.equal(a.signal.aborted,false);a.resolve();const report=await joined;assert.ok(report.trigger&&!report.trigger.ok);assert.equal(report.cleanup.ok,true);assert.equal(o.clock.waiting.size,0);
});
test('grace deadline aborts every remaining task before forced joins and returns Timeout',{timeout:5000},async()=>{
 const o=options(),aborted:number[]=[],a=controlled(1,true,()=>aborted.push(1)),b=controlled(2,true,()=>aborted.push(2));const joined=joinGatewayTasksForCause([a.task,b.task],2000,null,o.value);await tick();assert.equal(o.clock.scheduled[0],1000);o.clock.advance(1000);const report=await joined;assert.deepEqual(aborted,[1,2]);assert.equal(report.cleanup.ok,false);if(!report.cleanup.ok)assert.equal(report.cleanup.error.kind,'Timeout');assert.equal(o.fatals(),0);assert.equal(o.clock.waiting.size,0);
});
test('real error after forced cancellation wins over the cleanup Timeout classification',{timeout:5000},async()=>{
 const o=options(),a=controlled(1),b=controlled(2),reason=new Error('later task failed');b.reject(reason);const joined=joinGatewayTasksForCause([a.task,b.task],2000,null,o.value);await tick();o.clock.advance(1000);const report=await joined;assert.equal(report.cleanup.ok,false);if(!report.cleanup.ok){assert.equal(report.cleanup.error.kind,'Join');assert.equal(report.cleanup.error.taskError,reason);}
});
test('cancellation before the forced phase is a real join error, not silently ignored',async()=>{
 const o=options(),c=controlled(1);c.task.abort();const outcome=await c.task.join();assert.ok(!outcome.ok&&outcome.cancelled);const report=await joinGatewayTasksForCause([c.task],2000,null,o.value);assert.ok(!report.cleanup.ok);assert.equal(report.cleanup.error.kind,'Join');
});
test('same-text forged cancellation never gains owned cancellation status',async()=>{
 const o=options(),c=controlled(1),fake=new Error('Gateway task cancelled');c.reject(fake);const outcome=await c.task.join();assert.ok(!outcome.ok&&!outcome.cancelled);c.task.abort();const report=await joinGatewayTasksForCause([c.task],2000,null,o.value);assert.ok(!report.cleanup.ok);assert.equal(report.cleanup.error.taskError,fake);
});
test('trigger timeout enters fatal policy without pretending to abort or join the trigger',{timeout:5000},async()=>{
 const o=options(),c=controlled(7,false),input=[c.task],pending=joinGatewayTasksForCause(input,2000,7,o.value),rejected=assert.rejects(pending,e=>e===o.fatal);try{await tick();assert.equal(o.clock.scheduled[0],2000);o.clock.advance(2000);await rejected;assert.equal(o.fatals(),1);assert.equal(c.signal.aborted,false);assert.equal(c.task.peek(),undefined);}finally{c.resolve();await c.task.join();}
});
test('forced task still pending at final deadline enters fatal policy instead of success',{timeout:5000},async()=>{
 const o=options(),c=controlled(7,false),pending=joinGatewayTasksForCause([c.task],2000,null,o.value),rejected=assert.rejects(pending,e=>e===o.fatal);try{await tick();o.clock.advance(1000);await tick();assert.equal(c.signal.aborted,true);assert.equal(o.clock.scheduled.at(-1),2000);o.clock.advance(2000);await rejected;assert.equal(o.fatals(),1);}finally{c.resolve();await c.task.join();}
});
test('reporting failure cannot detach remaining task cleanup and preserves the completed report',{timeout:5000},async()=>{
 const o=options(),trigger=controlled(1),other=controlled(2),primary=new Error('primary'),logging=new Error('logging');trigger.reject(primary);let settled=false;const pending=joinGatewayTasksForCause([trigger.task,other.task],2000,1,{...o.value,reportTriggerFailure(){throw logging;}}),rejected=assert.rejects(pending,e=>e instanceof GatewayShutdownReportingError&&e.reportingError===logging&&e.report.trigger!==null&&!e.report.trigger.ok&&e.report.trigger.error.taskError===primary&&e.report.cleanup.ok).then(()=>{settled=true;});await tick();assert.equal(settled,false);other.resolve();await rejected;assert.equal(o.clock.waiting.size,0);
});
test('undefined rejection is retained as the first error rather than mistaken for no error',async()=>{
 const o=options(),c=controlled(1);c.reject(undefined);const report=await joinGatewayTasksForCause([c.task],2000,null,o.value);assert.ok(!report.cleanup.ok);assert.equal(report.cleanup.error.kind,'Join');assert.equal(report.cleanup.error.taskError,undefined);
});
test('duplicate handles and invalid shutdown arguments fail before consuming caller ownership',async()=>{
 const o=options(),c=controlled(1),input=[c.task,c.task];await assert.rejects(joinGatewayTasksForCause(input,2000,null,o.value),/unique/);assert.equal(input.length,2);const valid=[c.task];await assert.rejects(joinGatewayTasksForCause(valid,NaN,null,o.value));assert.equal(valid.length,1);await assert.rejects(joinGatewayTasksForCause(valid,2000,null,{...o.value,fatal:(async()=>{}) as never}),/fatal policy/);assert.equal(valid.length,1);c.resolve();await c.task.join();
});
test('first matching shard is the trigger even when two distinct tasks share an ID',async()=>{
 const o=options(),a=controlled(7),b=controlled(7),error=new Error('first duplicate ID');a.reject(error);b.resolve();const report=await joinGatewayTasksForCause([a.task,b.task],2000,7,o.value);assert.ok(report.trigger&&!report.trigger.ok);assert.equal(report.trigger.error.taskError,error);assert.equal(report.cleanup.ok,true);
});
test('task start errors are owned results and successful task objects are immutable',async()=>{
 const error=new Error('start');const bad=new GatewayTask(1,()=>{throw error;}),result=await bad.join();assert.ok(!result.ok);assert.equal(result.error,error);assert.equal(result.cancelled,false);const good=new GatewayTask(2,async()=>{});await good.join();assert.ok(Object.isFrozen(good));assert.ok(Object.isFrozen(good.peek()));assert.throws(()=>Object.defineProperty(good,'shard',{value:9}));
});
test('remaining budget shorter than one second forces cleanup immediately instead of spending the reserve',{timeout:5000},async()=>{
 const o=options(),c=controlled(1),pending=joinGatewayTasksForCause([c.task],500,null,o.value);await tick();try{assert.equal(o.clock.scheduled[0],0);const report=await pending;assert.equal(c.signal.aborted,true);assert.ok(!report.cleanup.ok);assert.equal(report.cleanup.error.kind,'Timeout');}finally{c.resolve();await pending;}
});
test('native timer cancellation removes its long deadline and preserves exact reason',async()=>{
 const abort=new AbortController(),reason=new Error('timer');const pending=nativeGatewayShutdownClock.sleepUntil(performance.now()+100000,abort.signal),rejected=assert.rejects(pending,e=>e===reason);abort.abort(reason);await rejected;await nativeGatewayShutdownClock.sleepUntil(performance.now()-1,new AbortController().signal);
});
test('a returning fatal policy is never converted into a successful shutdown report',{timeout:5000},async()=>{
 const o=options(),c=controlled(1,false),pending=joinGatewayTasksForCause([c.task],2000,1,{...o.value,fatal:(()=>undefined) as never}),rejected=assert.rejects(pending,/policy returned/);try{await tick();o.clock.advance(2000);await rejected;}finally{c.resolve();await c.task.join();}
});
test('subclass overrides cannot impersonate a completed owned Gateway task before actual work',()=>{
 let calls=0;class ForgedTask extends GatewayTask{override peek(){return Object.freeze({ok:true as const});}}
 assert.throws(()=>new ForgedTask(1,async()=>{calls++;}),/exact GatewayTask/);assert.equal(calls,0);assert.ok(Object.isFrozen(GatewayTask.prototype));
});
test('exposed owned join Promise cannot be overwritten to report fabricated completion',async()=>{
 const c=controlled(1),promise=c.task.join();try{assert.throws(()=>Object.defineProperty(promise,'then',{value:()=>Promise.resolve({ok:true})}),TypeError);assert.ok(Object.isFrozen(promise));}finally{c.resolve();await Promise.prototype.then.call(promise,()=>{});}
});
