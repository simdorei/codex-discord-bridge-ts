import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {dirname,join} from 'node:path';import {existsSync,readFileSync} from 'node:fs';
import {PortableAppServerSession} from '../../../src/app-server/portable-session.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {runOwnedRestartReadiness as run,RestartReadinessStartupTimeoutError,RestartReadinessCleanupError} from '../../../src/runtime/restart-readiness/owned-readiness.ts';
import {RestartReadinessDeadlineError} from '../../../src/runtime/restart-readiness/wait.ts';
import {InvalidThreadStateError} from '../../../src/restart/thread-state.ts';
function fixture(path:string,mode:'ready'|'blocked'|'bad'|'silent'='ready'){
 const pid=join(dirname(path),'pid');const code=`import fs from 'node:fs';import readline from 'node:readline';fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(${JSON.stringify(mode)}==='silent')return;if(m.method==='initialize')emit({id:m.id,result:{}});else if(m.method==='thread/read'){if(m.params.includeTurns!==false){emit({id:m.id,error:{code:-1,message:'turns requested'}});return;}emit({id:m.id,result:{thread:{id:${JSON.stringify(mode)}==='bad'?'wrong':m.params.threadId,updatedAt:0,status:${JSON.stringify(mode)}==='blocked'?{type:'active',activeFlags:[]}:{type:'idle'}}}});}});`;
 return {pid,config:{process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'readiness',title:'fixture',version:'1'}}};
}
const options={quietSeconds:0n,waitSeconds:0n,requestTimeoutMs:2000,startupTimeoutMs:5000,closeTimeoutMs:8000};
function setup(path:string){const db=new DatabaseSync(path);db.exec("CREATE TABLE mirror_threads(codex_thread_id);INSERT INTO mirror_threads VALUES('a');CREATE TABLE codex_turn_queue(job_id,target_thread_id,state,turn_id,last_error);");db.close();}
function exited(pid:string){assert.ok(existsSync(pid));assert.throws(()=>process.kill(Number(readFileSync(pid,'utf8')),0),{code:'ESRCH'});}
test('owned temporary readiness client resolves only after actual native child and pipes are closed',{timeout:15000},async t=>storeFixture(async p=>{setup(p);const f=fixture(p);const before=readFileSync(p);await run(p,f.config,options,t.signal);exited(f.pid);assert.deepEqual(readFileSync(p),before);}));
for(const mode of ['blocked','bad'] as const)test(`owned inspection ${mode} failure still joins actual temporary native client`,{timeout:15000},async t=>storeFixture(async p=>{setup(p);const f=fixture(p,mode);await assert.rejects(run(p,f.config,options,t.signal),mode==='blocked'?RestartReadinessDeadlineError:InvalidThreadStateError);exited(f.pid);}));
test('missing database remains absent and temporary child is disposed on store failure',{timeout:15000},async t=>storeFixture(async p=>{const f=fixture(p);await assert.rejects(run(p,f.config,options,t.signal));assert.equal(existsSync(p),false);exited(f.pid);}));
test('startup timeout cancels unanswered initialize and joins real owned cleanup before returning',{timeout:15000},async t=>storeFixture(async p=>{setup(p);const f=fixture(p,'silent');await assert.rejects(run(p,f.config,{...options,startupTimeoutMs:1000},t.signal),RestartReadinessStartupTimeoutError);exited(f.pid);}));
test('invalid options and preabort do not spawn the native fixture',async()=>storeFixture(async p=>{const f=fixture(p),stop=new AbortController(),reason=new Error('stop');stop.abort(reason);await assert.rejects(run(p,f.config,options,stop.signal),e=>e===reason);await assert.rejects(run(p,f.config,{...options,closeTimeoutMs:-1}),RangeError);assert.equal(existsSync(f.pid),false);assert.equal(existsSync(p),false);}));

test('cleanup failure outranks inspection failure and retains the exact session for explicit disposal retry',{timeout:15000},async t=>storeFixture(async p=>{
 setup(p);const f=fixture(p,'bad'),original=PortableAppServerSession.prototype.dispose,sentinel=new Error('fixture close failure');let retained:PortableAppServerSession|undefined;
 PortableAppServerSession.prototype.dispose=async function(){retained=this;throw sentinel;};
 try{await assert.rejects(run(p,f.config,options,t.signal),e=>{assert.ok(e instanceof RestartReadinessCleanupError);assert.equal(e.session,retained);assert.equal(e.errors[0],sentinel);assert.ok(e.errors[1] instanceof InvalidThreadStateError);return true;});assert.ok(retained);assert.equal(retained.resourcesClosed,false);}
 finally{PortableAppServerSession.prototype.dispose=original;if(retained)await original.call(retained);}exited(f.pid);
}));
test('process configuration and scalar options are captured before native startup awaits',{timeout:15000},async t=>storeFixture(async p=>{
 setup(p);const f=fixture(p),o={...options};const work=run(p,f.config,o,t.signal);f.config.process.executable='/not-the-owned-executable';f.config.process.arguments.splice(0);o.requestTimeoutMs=0;o.quietSeconds=18446744073709551615n;await work;exited(f.pid);
}));
