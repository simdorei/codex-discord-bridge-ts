import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {ownedWorkerModuleUrl} from '../../src/runtime/owned-worker-slot.ts';
const entry=fileURLToPath(ownedWorkerModuleUrl(new URL('../../src/cli/maintenance-main.ts',import.meta.url),import.meta.url));
async function run(args:string[],env:NodeJS.ProcessEnv={}){
 const child=spawn(process.execPath,['--no-strip-types',entry,...args],{env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const timer=setTimeout(()=>child.kill('SIGKILL'),10000);try{const code=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});return {code,stdout,stderr};}finally{clearTimeout(timer);}
}
test('compiled maintenance entry help runs without credentials or gateway',async()=>{const r=await run(['--help']);assert.equal(r.code,0);assert.match(r.stdout,/TypeScript runtime/);assert.match(r.stdout,/--check-config/);});
test('compiled maintenance config validation does not print bot token',async()=>{const secret='fixture-only-do-not-print';const r=await run(['--check-config'],{DISCORD_BOT_TOKEN:secret,DISCORD_ALLOW_ALL_CHANNELS:'1'});assert.equal(r.code,0);assert.match(r.stdout,/config_valid token=\[REDACTED\]/);assert.ok(!(r.stdout+r.stderr).includes(secret));});
test('compiled maintenance default gateway plan is explicitly unsupported',async()=>{const r=await run([],{DISCORD_BOT_TOKEN:'fixture-only',DISCORD_ALLOW_ALL_CHANNELS:'1'});assert.equal(r.code,2);assert.equal(r.stdout,'');assert.match(r.stderr,/maintenance_unsupported/);});
test('compiled maintenance unknown admin is not silently successful',async()=>{const r=await run(['--admin','unknown']);assert.equal(r.code,2);assert.equal(r.stdout,'');});
test('compiled maintenance malformed arguments return failure without echoing input',async()=>{const secret='fixture-secret-argument';const r=await run(['--'+secret]);assert.equal(r.code,1);assert.equal(r.stdout,'');assert.ok(!r.stderr.includes(secret));assert.match(r.stderr,/maintenance_failed/);});
