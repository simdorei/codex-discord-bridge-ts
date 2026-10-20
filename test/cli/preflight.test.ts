import {it} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,realpath,rm} from 'node:fs/promises';import {join,dirname} from 'node:path';import {tmpdir} from 'node:os';
import {prepareStartup} from '../../src/cli/preflight.ts';import {CliError} from '../../src/cli/startup.ts';import {RuntimeConfigError} from '../../src/config/runtime.ts';
async function fixture(body:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'cdr-preflight-owned-')),id=await realpath(root);try{await body(root);}finally{assert.equal(await realpath(root),id);assert.equal(dirname(root),tmpdir());await rm(root,{recursive:true});}}
it('admin and help precede all environment access while normal parse errors retain CLI identity',async()=>{
 let hooks=0;const poisoned=new Proxy(new Map<string,string>(),{get(){hooks++;throw new Error('no env access');}});assert.deepEqual(await prepareStartup(['--admin','--unknown'],poisoned,'\u0000'),{kind:'admin',args:['--unknown']});const help=await prepareStartup(['--help','--env','/unused'],poisoned,'\u0000');assert.equal(help.kind,'output');assert.equal(hooks,0);await assert.rejects(prepareStartup(['--unknown'],poisoned,'\u0000'),CliError);
});
it('restart readiness reads environment but intentionally precedes all RuntimeConfig validation',async()=>fixture(async root=>{
 await writeFile(join(root,'.env'),'DISCORD_ALLOWED_CHANNEL_IDS=invalid\n');const prepared=await prepareStartup(['--restart-readiness','--restart-quiet-seconds','0'],new Map(),join(root,'bridge.ts'));assert.equal(prepared.kind,'restartReadiness');if(prepared.kind==='restartReadiness'){assert.equal(prepared.args.restartQuietSeconds,0n);assert.equal(prepared.environment.get('DISCORD_ALLOWED_CHANNEL_IDS'),'invalid');assert.equal(Object.isFrozen(prepared.args),true);}
}));
it('check-config wins over backup and emits redacted summary after actual native file merge',async()=>fixture(async root=>{
 await writeFile(join(root,'.env'),'DISCORD_BOT_TOKEN=fixture-do-not-display\nDISCORD_ALLOW_ALL_CHANNELS=1\n');const prepared=await prepareStartup(['--backup-store','--check-config'],new Map(),join(root,'bridge.ts'));assert.equal(prepared.kind,'output');if(prepared.kind==='output'){assert.ok(prepared.text.startsWith('config_valid token=[REDACTED]'));assert.equal(prepared.text.includes('fixture-do-not-display'),false);}
}));
it('backup and gateway both require configuration and return distinct owned plans without executing them',async()=>fixture(async root=>{
 await assert.rejects(prepareStartup(['--backup-store'],new Map(),join(root,'bridge.ts')),RuntimeConfigError);
 const env=new Map([['DISCORD_BOT_TOKEN','fixture-only'],['DISCORD_ALLOW_ALL_CHANNELS','1']]);const backup=await prepareStartup(['--backup-store'],env,join(root,'bridge.ts')),gateway=await prepareStartup(['--no-message-content'],env,join(root,'bridge.ts'));assert.equal(backup.kind,'backupStore');assert.equal(gateway.kind,'gateway');if(gateway.kind==='gateway'){assert.equal(gateway.config.enableMessageContent,false);assert.notEqual(gateway.environment,env);}
}));
