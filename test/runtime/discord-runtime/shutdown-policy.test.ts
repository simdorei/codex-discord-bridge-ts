import {GatewayShutdownError} from '../../../src/discord/gateway/shutdown.ts';
import assert from 'node:assert/strict';import {it} from 'node:test';
import {resolveRuntimeShutdown,validateRuntimeDrainCleanup,RuntimeEarlyExitError,type RuntimeCleanupResults} from '../../../src/runtime/discord-runtime/shutdown-policy.ts';
import {RuntimeMonitoredWorker,RuntimeWorkerExitChannel} from '../../../src/runtime/discord-runtime/monitored-worker.ts';
const ok={ok:true} as const,bad=<T>(error:T)=>({ok:false,error} as const);
function reports():RuntimeCleanupResults{return {gateway:{trigger:null,cleanup:ok},workers:{trigger:null,cleanup:ok},heartbeat:ok,serverClose:ok};}
it('normal control preserves worker/gateway/heartbeat/server cleanup priority and ignores triggers',()=>{
 const a={},b={},c={},d={};for(const [input,expected] of [[{...reports(),workers:{trigger:bad('ignored'),cleanup:bad(a)},gateway:{trigger:null,cleanup:bad(b)},heartbeat:bad(c),serverClose:bad(d)},a],[{...reports(),gateway:{trigger:null,cleanup:bad(b)},heartbeat:bad(c),serverClose:bad(d)},b],[{...reports(),heartbeat:bad(c),serverClose:bad(d)},c],[{...reports(),serverClose:bad(d)},d]] as const){const out=resolveRuntimeShutdown({kind:'Control',result:ok},input as RuntimeCleanupResults);assert.equal(out.result.ok,false);if(!out.result.ok)assert.equal(out.result.error,expected);assert.deepEqual(out.secondary,[]);}
 assert.deepEqual(resolveRuntimeShutdown({kind:'Control',result:ok},reports()).result,ok);
});
it('control error identity wins and all cleanup errors remain ordered secondary facts',()=>{
 const primary={},errors=[{},new GatewayShutdownError('Join',{}),{},{}] as const;const out=resolveRuntimeShutdown({kind:'Control',result:bad(primary)},{gateway:{trigger:null,cleanup:bad(errors[1])},workers:{trigger:null,cleanup:bad(errors[0])},heartbeat:bad(errors[2]),serverClose:bad(errors[3])});assert.equal(out.result.ok,false);if(!out.result.ok)assert.equal(out.result.error,primary);assert.deepEqual(out.secondary.map(v=>v.component),['workers','gateway','heartbeat','app-server']);out.secondary.forEach((v,i)=>assert.equal(v.error,errors[i]));
});
it('unexpected clean worker exit stays fatal even when cleanup also fails',()=>{
 const out=resolveRuntimeShutdown({kind:'Worker',worker:'completion'},{...reports(),workers:{trigger:ok,cleanup:bad('cleanup')}});assert.equal(out.result.ok,false);if(!out.result.ok){assert.ok(out.result.error instanceof RuntimeEarlyExitError);assert.equal(out.result.error.message,'runtime worker completion exited before shutdown');}assert.equal(out.secondary[0]!.error,'cleanup');
});
it('exact triggering worker and shard failures survive unchanged',()=>{
 const error={};for(const cause of [{kind:'Worker',worker:'message'},{kind:'GatewayShard',shard:3}] as const){const out=resolveRuntimeShutdown(cause,{...reports(),workers:{trigger:bad(error),cleanup:ok},gateway:{trigger:bad(error) as never,cleanup:ok}});assert.equal(out.result.ok,false);if(!out.result.ok)assert.equal(out.result.error,error);}
});
it('heartbeat trigger uses heartbeat result only and never duplicates it as secondary',()=>{
 const error={};const out=resolveRuntimeShutdown({kind:'Worker',worker:'heartbeat'},{...reports(),heartbeat:bad(error),workers:{trigger:bad('wrong'),cleanup:ok}});if(out.result.ok)assert.fail();assert.equal(out.result.error,error);assert.deepEqual(out.secondary,[]);const clean=resolveRuntimeShutdown({kind:'Worker',worker:'heartbeat'},reports());if(clean.result.ok)assert.fail();assert.equal((clean.result.error as RuntimeEarlyExitError).identity,'heartbeat');
});
it('closed monitors and clean shard exits are explicit fatal causes',()=>{
 for(const cause of [{kind:'WorkerMonitorClosed'},{kind:'GatewayMonitorClosed'},{kind:'GatewayShard',shard:9}] as const){const out=resolveRuntimeShutdown(cause,reports());if(out.result.ok)assert.fail();assert.equal((out.result.error as RuntimeEarlyExitError).kind,cause.kind);}
});
it('drain cleanup never substitutes successful trigger for failed cleanup',()=>{
 const error={};const out=validateRuntimeDrainCleanup({trigger:null,cleanup:ok},{trigger:ok,cleanup:bad(error)},ok);if(out.ok)assert.fail();assert.equal(out.error,error);assert.deepEqual(validateRuntimeDrainCleanup({trigger:bad('trigger') as never,cleanup:ok},{trigger:bad('trigger'),cleanup:ok},ok),ok);
});
it('passive result handling does not inspect error getters and rejects active result accessors',()=>{
 let calls=0;const raw={get stack(){calls++;throw Error();},get message(){calls++;throw Error();}};const out=resolveRuntimeShutdown({kind:'Control',result:bad(raw)},reports());if(out.result.ok)assert.fail();assert.equal(out.result.error,raw);assert.equal(calls,0);assert.throws(()=>resolveRuntimeShutdown({kind:'Control',result:{get ok(){calls++;return true as const;}}},reports()),TypeError);assert.equal(calls,0);
});
it('actual monitored Promise failure remains the exact shutdown primary after join',async()=>{
 const notifier=new RuntimeWorkerExitChannel(),error=new Error('actual worker'),worker=new RuntimeMonitoredWorker('message',notifier,async()=>({ok:false,error}));const joined=await worker.join();notifier.close();assert.equal(joined.kind,'Returned');if(joined.kind!=='Returned')assert.fail();const out=resolveRuntimeShutdown({kind:'Worker',worker:'message'},{...reports(),workers:{trigger:joined.result,cleanup:ok}});if(out.result.ok)assert.fail();assert.equal(out.result.error,error);
});
