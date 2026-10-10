import assert from 'node:assert/strict';import {it} from 'node:test';import {setImmediate as tick} from 'node:timers/promises';import {spawn} from 'node:child_process';
import {completeBeforeRuntimeShutdownDeadline as complete,RUNTIME_SHUTDOWN_TIMEOUT_MS,NON_HEARTBEAT_RESERVE_MS,HEARTBEAT_JOIN_RESERVE_MS} from '../../../src/runtime/discord-runtime/shutdown-deadline.ts';
class Clock{time=0;waiter:(()=>void)|undefined;cleaned=false;now=()=>this.time;sleepUntil=(_deadline:number,signal:AbortSignal):Promise<void>=>new Promise((resolve,reject)=>{const clean=()=>{this.cleaned=true;this.waiter=undefined;signal.removeEventListener('abort',abort);};const abort=()=>{clean();reject(signal.reason);};this.waiter=()=>{clean();resolve();};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
it('source reserves remain 30s total, 15s non-heartbeat reserve and 1s final heartbeat',()=>{assert.deepEqual([RUNTIME_SHUTDOWN_TIMEOUT_MS,NON_HEARTBEAT_RESERVE_MS,HEARTBEAT_JOIN_RESERVE_MS],[30000,15000,1000]);});
it('actual completion and rejection retain exact values and join cancelled timer',async()=>{
 for(const reject of [false,true]){const clock=new Clock(),value={};const operation=reject?Promise.reject(value):Promise.resolve(value);const pending=complete(100,'app-server',operation,{clock,fatal:()=>{assert.fail();}});if(reject)await assert.rejects(pending,e=>e===value);else assert.equal(await pending,value);assert.equal(clock.cleaned,true);assert.equal(clock.waiter,undefined);}
});
it('hard expiry invokes fatal while resistant operation remains uncompleted, then test joins it',async()=>{
 const clock=new Clock(),fatal=new Error('fatal');let finish!:()=>void,ended=false;const operation=new Promise<void>(r=>finish=r).finally(()=>{ended=true;});const pending=complete(100,'app-server',operation,{clock,fatal:component=>{assert.equal(component,'app-server');throw fatal;}});const rejected=assert.rejects(pending,e=>e===fatal);
 try{await tick();clock.waiter!();await rejected;assert.equal(ended,false);}finally{finish();await operation;}assert.equal(ended,true);
});
it('clock failure fails closed and a returning fatal callback cannot fake success',async()=>{
 let finish!:()=>void;const operation=new Promise<void>(r=>finish=r);try{await assert.rejects(complete(100,'app-server',operation,{clock:{now:()=>0,sleepUntil:async()=>{throw Error('clock failed');}},fatal:(()=>undefined) as never}),/policy returned/);}finally{finish();await operation;}
});
it('thenables and invalid deadlines cannot execute active hooks',async()=>{
 let hooks=0;await assert.rejects(complete(100,'app-server',{then(){hooks++;}} as never),TypeError);assert.equal(hooks,0);await assert.rejects(complete(NaN,'app-server',Promise.resolve()),TypeError);await assert.rejects(complete(100,'bad\nlabel',Promise.resolve()),TypeError);
});
it('default fatal policy actually terminates only the owned inert child process',async()=>{
 const url=new URL('../../../src/runtime/discord-runtime/shutdown-deadline.ts',import.meta.url).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {completeBeforeRuntimeShutdownDeadline as complete} from ${JSON.stringify(url)}; await complete(performance.now()+25,'owned-probe',new Promise(()=>{})); console.log('INVALID_SUCCESS');`],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');child.stdout.on('data',s=>out+=s);child.stderr.on('data',s=>err+=s);let timer:ReturnType<typeof setTimeout>|undefined;
 try{const result=await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('owned deadline probe hung'));},5000);});assert.ok(result.signal!==null||result.code!==0);assert.match(err,/fatal_runtime_shutdown_timeout component=owned-probe/);assert.equal(out.includes('INVALID_SUCCESS'),false);}finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise<void>(r=>child.once('close',()=>r()));}}
});
