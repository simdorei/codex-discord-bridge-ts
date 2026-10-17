import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';
import {inspectRestartReadiness as inspect,inspectRuntimeRestartReadiness,type RestartInspectionPorts} from '../../../src/runtime/restart-readiness/inspect.ts';
import {waitRuntimeRestartReadiness} from '../../../src/runtime/restart-readiness/wait.ts';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
const snap=()=>({targetThreadIds:['a','b'],blockers:[],observations:[] as string[]});
const reply=(id:string)=>({thread:{id,updatedAt:0n,status:{type:'idle'}}});
function ports(events:string[]=[],overrides:Partial<RestartInspectionPorts>={}):RestartInspectionPorts{return {snapshot:async()=>{events.push('snapshot');return snap();},readThread:async(t,ms)=>{events.push(`read:${t}:${ms}`);return reply(t);},nowSeconds:()=>{events.push('now');return 100n;},...overrides};}
test('normal restart inspection uses one wall sample and exact before/read/after order',async()=>{const events:string[]=[];assert.deepEqual(await inspect(ports(events),10n,1234),{status:'Ready'});assert.deepEqual(events,['snapshot','now','read:a:1234','read:b:1234','snapshot']);});
test('first durable blocker masks clock/RPC and first thread blocker masks later reads and second snapshot',async()=>{
 const events:string[]=[];assert.deepEqual(await inspect(ports(events,{snapshot:async()=>({...snap(),blockers:['held']}),nowSeconds:()=>{throw Error('masked');}}),0n,1000),{status:'Blocked',reason:'held'});assert.deepEqual(events,[]);
 const observed:string[]=[];const result=await inspect(ports(observed,{readThread:async id=>{observed.push(id);return {thread:{id,updatedAt:0n,status:{type:'active',activeFlags:[]}}};}}),0n,1000);assert.deepEqual(result,{status:'Blocked',reason:'thread a is active'});assert.deepEqual(observed,['snapshot','now','a']);
});
test('durable drift and mutated earlier snapshot cannot be approved as Ready',async()=>{let reads=0;const first=snap();const result=await inspect(ports([],{snapshot:async()=>++reads===1?first:{...snap(),observations:['changed']},readThread:async id=>{first.observations.push('changed');return reply(id);}}),0n,1000);assert.deepEqual(result,{status:'Blocked',reason:'Rust durable restart state changed during app-server inspection'});});
test('callbacks are captured before await and errors/cancellation keep exact identity',async()=>{
 let release!:()=>void;const pending=new Promise<void>(r=>release=r),p=ports([],{snapshot:async()=>{await pending;return snap();}});const work=inspect(p,0n,1000);(p as {readThread:unknown}).readThread=()=>assert.fail('replacement');release();assert.deepEqual(await work,{status:'Ready'});
 const sentinel={failure:true};await assert.rejects(inspect(ports([],{readThread:async()=>{throw sentinel;}}),0n,1000),e=>e===sentinel);
 const stop=new AbortController(),reason=new Error('stop');let read=0;await assert.rejects(inspect(ports([],{snapshot:async()=>{stop.abort(reason);return snap();},readThread:async id=>{read++;return reply(id);}}),0n,1000,stop.signal),e=>e===reason);assert.equal(read,0);
});
test('invalid clocks, active callbacks, thenables and excessive metadata cannot yield Ready',async()=>{
 let hooks=0;const p=ports();Object.defineProperty(p,'readThread',{get(){hooks++;return ()=>{};}});await assert.rejects(inspect(p,0n,1000),TypeError);assert.equal(hooks,0);
 await assert.rejects(inspect(ports([],{nowSeconds:()=>-1n}),0n,1000),RangeError);await assert.rejects(inspect(ports([],{snapshot:(()=>({then(){hooks++;}})) as never}),0n,1000),TypeError);assert.equal(hooks,0);
 await assert.rejects(inspect(ports([],{readThread:async id=>({...reply(id),extra:'x'.repeat(65536)})}),0n,1000),RangeError);
});
for(const [change,configured] of [[false,true],[true,true],[false,false]] as const)test(`actual native RPC plus central SQLite restart inspection, durable change=${change}, configured=${configured}`,{timeout:10000},async t=>storeFixture(async path=>{
 const db=new DatabaseSync(path);db.exec("CREATE TABLE mirror_threads(codex_thread_id);INSERT INTO mirror_threads VALUES('a');CREATE TABLE codex_turn_queue(job_id,target_thread_id,state,turn_id,last_error);");db.close();
 const code=`import readline from 'node:readline';import {DatabaseSync} from 'node:sqlite';const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')emit({id:m.id,result:{}});else if(m.method==='thread/read'){if(m.params.includeTurns!==false){emit({id:m.id,error:{code:-1,message:'turns requested'}});return;}if(${change}){const db=new DatabaseSync(${JSON.stringify(path)});db.exec("INSERT INTO mirror_threads VALUES('b')");db.close();}emit({id:m.id,result:{thread:{id:m.params.threadId,updatedAt:0,status:{type:'idle'}}}});}});`;
 const owner=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'readiness',title:'fixture',version:'1'}},()=> 'fixture',{persistDeadWork(){},oldChildExited(){}},t.signal,configured?{fence:null,renderError:()=> 'fixture'}:null);
 try{if(!configured){await assert.rejects(inspectRuntimeRestartReadiness(path,owner,0n,2000,t.signal),/resident dispatch adapter is not installed/);return;}const result=await inspectRuntimeRestartReadiness(path,owner,0n,2000,t.signal);assert.equal(result.status,change?'Blocked':'Ready');if(change&&result.status==='Blocked')assert.match(result.reason,/durable restart state changed/);assert.equal(owner.lifecycleSnapshot().healthy,true);if(!change)await waitRuntimeRestartReadiness(path,owner,0n,0n,2000,t.signal);}finally{await owner.dispose();}
}));
