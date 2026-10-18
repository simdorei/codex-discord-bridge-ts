import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {runWindowsSupervisor,requestSupervisor,supervisorStatus} from '../../src/runtime/windows/supervisor.ts';
import {startupScript,startupTaskName} from '../../src/cli/windows-control.ts';
async function until<T>(fn:()=>Promise<T|false>):Promise<T>{const deadline=Date.now()+20000;for(;;){try{const v=await fn();if(v!==false)return v;}catch{}if(Date.now()>deadline)throw new Error('Fixture wait timed out');await sleep(30);}}
test('owned watchdog drains, force-replaces and stops only its fixture runtime',{skip:process.platform!=='win32',timeout:60000},async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'cdr-watchdog-'))),entry=join(root,'fixture.mjs'),stop=new AbortController();
 const instance=new URL('../../src/runtime/windows/windows-runtime-instance.js',import.meta.url).href;
 await writeFile(entry,`import {WindowsRuntimeInstance} from ${JSON.stringify(instance)}; import {readFile,writeFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {join} from 'node:path';const root=process.cwd(),owner=await WindowsRuntimeInstance.acquire(root);await owner.publishMarker('identity','version=1\\nruntime_id='+randomUUID()+'\\npid='+process.pid+'\\nstate=open\\n');const read=async name=>{try{return await readFile(join(root,'.codex_discord_rust.'+name),'utf8');}catch{return null;}};process.stdout.write('fixture-ready\\n');for(;;){if(await read('stop')!==null)break;const prepare=await read('drain.prepare');if(prepare!==null){await owner.publishMarker('ack',prepare);if(await read('restart')===prepare)break;}await new Promise(r=>setTimeout(r,20));}await owner.release();`);
 const task=runWindowsSupervisor({root,entry,arguments:[],environment:{SystemRoot:process.env.SystemRoot??'C:\\Windows'},signal:stop.signal,clearStop:true,restartDelayMs:10});void task.catch(()=>{});
 const ready=async(old=0)=>Promise.race([until(async()=>{const s=await supervisorStatus(root);const text=await readFile(join(root,'.codex_discord_rust.drain.identity'),'utf8');return s.childPid!==null&&s.childPid!==old&&text.includes('pid='+s.childPid+'\n')?s:false;}),task.then(()=>{throw new Error('Watchdog exited before fixture ready');})]);
 try{const first=await ready();await assert.rejects(requestSupervisor(root,'force_restart',undefined,'foreign-generation'));const graceful=await requestSupervisor(root,'restart');const second=await ready(first.childPid!);assert.notEqual(second.childPid,first.childPid);assert.equal(JSON.parse(await readFile(graceful.receipt,'utf8')).phase,'exited');const force=await requestSupervisor(root,'force_restart');const third=await ready(second.childPid!);assert.notEqual(third.childPid,second.childPid);assert.equal(JSON.parse(await readFile(force.receipt,'utf8')).forced,true);await requestSupervisor(root,'stop');await task;await assert.rejects(supervisorStatus(root));assert.match(await readFile(join(root,'.codex_discord_rust.stop'),'utf8'),/stop/);}
 finally{stop.abort();await task.catch(()=>{});assert.equal(dirname(root),await realpath(tmpdir()));await rm(root,{recursive:true,force:true});}
});
test('scheduled task command is user-scoped, hidden and quotes literal paths without executing it',()=>{
 const root='C:\\project with space',entry='C:\\npm & literal\\bin.mjs';const script=startupScript(root,entry,'C:\\node\\node.exe',['--env','C:\\my settings\\.env']);assert.match(script,/-LogonType Interactive -RunLevel Limited/);assert.match(script,/-Hidden/);assert.match(script,/FromBase64String/);assert.ok(!script.includes(entry));assert.equal(startupTaskName(root),startupTaskName(root.toUpperCase()));assert.match(startupScript(root,entry,'node',[],true),/Unregister-ScheduledTask/);
});
