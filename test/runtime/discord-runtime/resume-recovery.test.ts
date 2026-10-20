import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {dirname,join} from 'node:path';import {readFileSync,existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {activate,begin,check} from '../../../src/store/mutation-attempt.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
import {startRuntimeFoundation} from '../../../src/runtime/discord-runtime/startup-foundation.ts';import {ResumeRecoveryUnconfirmed} from '../../../src/runtime/discord-runtime/resume-recovery.ts';import {AppServerTurnBackend} from '../../../src/runtime/app-server-turn-backend.ts';import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const script=`import fs from 'node:fs';import readline from 'node:readline';fs.writeFileSync(process.env.PID,String(process.pid));const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(process.env.LOG,JSON.stringify(m)+'\\n');if(m.id===undefined)return;let result={};if(m.method==='thread/read'){if(process.env.MODE==='hold')return;if(process.env.MODE==='error'){emit({id:m.id,error:{code:-1,message:'fixture unreadable'}});return;}result={thread:{id:m.params.threadId,status:{type:process.env.MODE==='active'?'active':'idle'}}};}if(m.method==='thread/turns/list')result=process.env.MODE==='malformed'?{data:[]}:{data:[],nextCursor:null};if(m.method==='thread/resume')result={thread:{id:m.params.threadId}};emit({id:m.id,result});});`;
async function prepare(path:string,method='thread/resume'){
 await activate(path,'old-runtime');begin(path,{runtimeId:'old-runtime',ownerId:'old-resident',generation:1n,attemptId:'prior',wireId:'wire',method,targetThreadId:'A',scoped:true,payload:null});const stateDb=join(dirname(path),'codex.sqlite'),db=new DatabaseSync(stateDb);db.exec('CREATE TABLE preserved(value)');db.close();return {stateDb,mirrorDb:path};
}
function config(path:string,mode='normal'){return {process:{executable:process.execPath,arguments:['--input-type=module','-e',script],environment:{PID:join(dirname(path),'pid'),LOG:join(dirname(path),'calls.jsonl'),MODE:mode}},clientInfo:{name:'resume-recovery-fixture',title:'fixture',version:'1'}};}
const render=(e:unknown)=>e instanceof Error?e.message:'opaque';const limits={maxRows:128,maxBytes:1048576};
function calls(path:string){return readFileSync(join(dirname(path),'calls.jsonl'),'utf8').trim().split('\n').map(s=>JSON.parse(s));}
test('actual startup observes new resident then commits resume retirement before returning and never replays prompt',async()=>storeFixture(async path=>{
 const paths=await prepare(path),result=await startRuntimeFoundation(paths,config(path),'new-runtime',null,render,limits);
 try{
  assert.equal(result.resumeRecovery.scanned,1);assert.equal(result.resumeRecovery.recovered,1);assert.equal(result.resumeRecovery.held,0);check(path,'new-runtime','A');let observed=calls(path);assert.deepEqual(observed.filter(c=>c.method.startsWith('thread/')).map(c=>c.method),['thread/read','thread/turns/list']);assert.equal(observed.find(c=>c.method==='thread/read').params.includeTurns,false);assert.deepEqual(observed.find(c=>c.method==='thread/turns/list').params,{threadId:'A',limit:1,sortDirection:'desc',itemsView:'notLoaded',cursor:null});
  const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_resume_restart_recoveries').get()!.n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM codex_mutation_attempts').get()!.n,0);}finally{db.close();}
  await new AppServerTurnBackend(result.owner,render).resumeThread('A');observed=calls(path);assert.equal(observed.filter(c=>c.method==='thread/resume').length,1);assert.equal(observed.find(c=>c.method==='thread/resume').params.excludeTurns,true);assert.equal(observed.filter(c=>c.method==='turn/start').length,0);
 }finally{await result.owner.dispose();}assert.equal(ownedWorkerUsage().Control,0);
}));
for(const mode of ['active','error','malformed'])test(`actual startup keeps old resume held for ${mode} observation`,async()=>storeFixture(async path=>{
 const paths=await prepare(path),result=await startRuntimeFoundation(paths,config(path,mode),'new-runtime',null,render,limits);try{assert.equal(result.resumeRecovery.recovered,0);assert.equal(result.resumeRecovery.held,1);assert.throws(()=>check(path,'new-runtime','A'));assert.equal(calls(path).filter(c=>['thread/resume','turn/start'].includes(c.method)).length,0);}finally{await result.owner.dispose();}assert.equal(ownedWorkerUsage().Control,0);
}));
test('startup never offers turn/start evidence to resume retirement',async()=>storeFixture(async path=>{
 const paths=await prepare(path,'turn/start'),result=await startRuntimeFoundation(paths,config(path),'new-runtime',null,render,limits);try{assert.equal(result.resumeRecovery.scanned,0);assert.throws(()=>check(path,'new-runtime','A'));assert.equal(calls(path).filter(c=>c.method.startsWith('thread/')).length,0);}finally{await result.owner.dispose();}
}));
test('native recovery write failure stops startup, joins worker and reaps actual resident',async()=>storeFixture(async path=>{
 const paths=await prepare(path),db=await openInitialized(path);db.exec("CREATE TRIGGER reject_resume BEFORE INSERT ON cdr_resume_restart_recoveries BEGIN SELECT RAISE(ABORT,'fixture');END");db.close();await assert.rejects(startRuntimeFoundation(paths,config(path),'new-runtime',null,render,limits),ResumeRecoveryUnconfirmed);const pid=Number(readFileSync(join(dirname(path),'pid'),'utf8'));assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==='ESRCH');assert.equal(ownedWorkerUsage().Control,0);assert.throws(()=>check(path,'new-runtime','A'));
}));
test('preabort cannot start a resident or change original prepared attempt',async()=>storeFixture(async path=>{
 const paths=await prepare(path),a=new AbortController(),reason={stop:true};a.abort(reason);await assert.rejects(startRuntimeFoundation(paths,config(path),'new-runtime',null,render,limits,10000,a.signal),e=>e===reason);assert.equal(existsSync(join(dirname(path),'pid')),false);assert.throws(()=>check(path,'old-runtime','A'));
}));

test('cancellation during actual observation joins cleanup and cannot clear the original attempt',async()=>storeFixture(async path=>{
 const paths=await prepare(path),a=new AbortController(),reason={stop:true};const task=startRuntimeFoundation(paths,config(path,'hold'),'new-runtime',null,render,limits,10000,a.signal),rejected=assert.rejects(task,e=>e===reason);const until=Date.now()+8000;
 while(!existsSync(join(dirname(path),'calls.jsonl'))||!calls(path).some(c=>c.method==='thread/read')){if(Date.now()>=until){a.abort(reason);await rejected;assert.fail('fixture observation not reached');}await new Promise(r=>setTimeout(r,10));}
 a.abort(reason);await rejected;const pid=Number(readFileSync(join(dirname(path),'pid'),'utf8'));assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==='ESRCH');assert.equal(ownedWorkerUsage().Control,0);const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT count(*) AS n FROM codex_mutation_attempts').get()!.n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_resume_restart_recoveries').get()!.n,0);}finally{db.close();}
}));
