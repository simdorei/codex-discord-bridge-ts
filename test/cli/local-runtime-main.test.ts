import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ownedWorkerModuleUrl} from '../../src/runtime/owned-worker-slot.ts';
const entry=fileURLToPath(ownedWorkerModuleUrl(new URL('../../src/cli/local-runtime-main.ts',import.meta.url),import.meta.url));
async function run(args:string[],env:NodeJS.ProcessEnv={}){
 const child=spawn(process.execPath,['--no-strip-types',entry,...args],{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);try{const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});return {code,stdout,stderr};}finally{clearTimeout(timer);}
}
test('compiled local entry help executes before token validation or gateway startup',async()=>{const r=await run(['--help']);assert.equal(r.code,0);assert.match(r.stdout,/TypeScript runtime/);});
test('local entry check-config never exposes token',async()=>{const token='local-fixture-secret-only';const r=await run(['--check-config'],{DISCORD_BOT_TOKEN:token,DISCORD_ALLOW_ALL_CHANNELS:'1'});assert.equal(r.code,0);assert.match(r.stdout,/config_valid/);assert.ok(!(r.stdout+r.stderr).includes(token));});
test('local entry refuses default session mirror rather than silently omitting it',async()=>{const r=await run([],{DISCORD_BOT_TOKEN:'offline-fixture',DISCORD_ALLOW_ALL_CHANNELS:'1'});assert.equal(r.code,2);assert.match(r.stderr,/unsupported_profile/);assert.equal(r.stdout,'');});
test('local entry refuses host commands even when session mirror is disabled',async()=>{const r=await run([],{DISCORD_BOT_TOKEN:'offline-fixture',DISCORD_ALLOW_ALL_CHANNELS:'1',DISCORD_SESSION_MIRROR:'0',DISCORD_ENABLE_HOST_COMMANDS:'1'});assert.equal(r.code,2);assert.match(r.stderr,/unsupported_profile/);});
test('local entry rejects unknown admin with no successful output',async()=>{const r=await run(['--admin','unknown']);assert.equal(r.code,2);assert.equal(r.stdout,'');assert.match(r.stderr,/unsupported_admin/);});
test('local entry argument error does not print untrusted values',async()=>{const secret='not-a-real-secret';const r=await run(['--'+secret]);assert.equal(r.code,1);assert.ok(!r.stderr.includes(secret));});
