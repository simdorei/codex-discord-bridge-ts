import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {windowsDpapiProtector} from '../../src/runtime/windows/dpapi.ts';
import {claimWindowsRestartHandoff,writeWindowsRestartHandoff} from '../../src/remote-agent/restart-handoff-persistence.ts';
const windows={skip:process.platform!=='win32'};
test('native current-user DPAPI round trip and tamper rejection',windows,async()=>{
 const p=windowsDpapiProtector(),plain=Buffer.from('secret project binding');const cipher=await p.protect(plain);
 assert.ok(!Buffer.from(cipher).includes(plain));assert.deepEqual(Buffer.from(await p.unprotect(cipher)),plain);
 const corrupt=Buffer.from(cipher);corrupt[corrupt.length-1]=corrupt[corrupt.length-1]!^1;await assert.rejects(async()=>p.unprotect(corrupt));
});
test('protected restart handoff is bound to gateway/device and claimed once',windows,async()=>{
 const root=await mkdtemp(join(tmpdir(),'cdr-dpapi-'));try{
 const path=join(root,'handoff.json'),binding={bridgeUrl:'wss://example.invalid/bridge',deviceId:'fixture-device'},now={seconds:1800000000n,nanosecond:0n};
 const projects=[{threadId:'fixture-thread',root,expiresAt:{seconds:1800000600n,nanosecond:0n}}];
 assert.equal(await writeWindowsRestartHandoff(path,projects,binding,now),true);const text=await readFile(path,'utf8');assert.ok(!text.includes('fixture-thread'));
 assert.deepEqual(await claimWindowsRestartHandoff(true,path,binding,now),projects);assert.deepEqual(await claimWindowsRestartHandoff(true,path,binding,now),[]);
 await writeFile(path,text);await assert.rejects(claimWindowsRestartHandoff(true,path,{...binding,deviceId:'different'},now));await assert.rejects(readFile(path));
 }finally{await rm(root,{recursive:true,force:true});}
});
