import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {loadRuntimeConfig,mergeEnvText} from '../../src/config/runtime.ts';
import {runOwnedCommand} from '../../src/runtime/windows/owned-command.ts';
import {storeFixture} from '../helpers/store-fixture.ts';

test('shipped fresh-install template preserves Rust mirroring and notice behavior with only token and channel',async()=>{
 const env=new Map([['DISCORD_BOT_TOKEN','INSTALL_DEFAULTS_FIXTURE'],['DISCORD_ALLOWED_CHANNEL_IDS','123']]);
 mergeEnvText(env,await readFile(join(process.cwd(),'.env.example'),'utf8'));
 const config=loadRuntimeConfig(env);
 assert.equal(config.sessionMirror,true);
 assert.equal(config.startupNotify,true);
 assert.equal(config.historyPollIntervalNs,15000000000n);
 assert.equal(config.startupChannelId,123n);
 assert.equal(config.guildId,null);
 assert.equal(config.enableMessageContent,true);
 assert.equal(config.attachmentsEnabled,true);
 assert.equal(config.streamCommentary,true);
});

const windows={skip:process.platform!=='win32',timeout:30000};
function repair(root:string){
 return runOwnedCommand({executable:join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),arguments:['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(process.cwd(),'scripts/Restore-RustDefaults.ps1'),'-RuntimeRoot',root],environment:{}},{timeoutMs:15000,maxBytes:65536});
}
test('alpha.5 repair restores only the two installation defaults, backs up exact bytes and is idempotent',windows,()=>storeFixture(async path=>{
 const root=dirname(path),file=join(root,'.env');
 const original=Buffer.from('\ufeff# 사용자 설정\nDISCORD_BOT_TOKEN=PRIVATE_FIXTURE_TOKEN\nDISCORD_ALLOWED_CHANNEL_IDS=123,456\nCODEX_HOME=C:\\사용자\\codex\nCODEX_REMOTE_MCP_DEVICE_TOKEN=PRIVATE_REMOTE_FIXTURE\nDISCORD_SESSION_MIRROR=0\nDISCORD_SESSION_MIRROR=0\nDISCORD_STARTUP_NOTIFY=0\nDISCORD_HISTORY_POLL_SECONDS=0\n');
 await writeFile(file,original);await writeFile(path,'untouched database fixture');
 const first=await repair(root);assert.equal(first.exitCode,0,first.stderr.toString());
 assert.ok(!Buffer.concat([first.stdout,first.stderr]).toString().includes('PRIVATE_'));
 const result=await readFile(file,'utf8'),env=new Map<string,string>();mergeEnvText(env,result);
 assert.equal(env.get('DISCORD_SESSION_MIRROR'),'1');assert.equal(env.get('DISCORD_STARTUP_NOTIFY'),'1');
 assert.equal(result.match(/^DISCORD_SESSION_MIRROR=/gm)?.length,1);
 assert.equal(env.get('DISCORD_BOT_TOKEN'),'PRIVATE_FIXTURE_TOKEN');
 assert.equal(env.get('DISCORD_ALLOWED_CHANNEL_IDS'),'123,456');assert.equal(env.get('CODEX_HOME'),'C:\\사용자\\codex');
 assert.equal(env.get('CODEX_REMOTE_MCP_DEVICE_TOKEN'),'PRIVATE_REMOTE_FIXTURE');assert.equal(env.get('DISCORD_HISTORY_POLL_SECONDS'),'0');
 assert.ok(result.includes('# 사용자 설정'));assert.equal(await readFile(path,'utf8'),'untouched database fixture');
 const backups=(await readdir(root)).filter(name=>name.startsWith('.env.before-rust-defaults-'));assert.equal(backups.length,1);
 assert.deepEqual(await readFile(join(root,backups[0]!)),original);
 const second=await repair(root);assert.equal(second.exitCode,0,second.stderr.toString());assert.match(second.stdout.toString(),/already set/);
 assert.equal(await readFile(file,'utf8'),result);assert.deepEqual((await readdir(root)).filter(name=>name.startsWith('.env.before-rust-defaults-')),backups);
}));

test('repair refuses missing settings without creating a runtime configuration',windows,()=>storeFixture(async path=>{
 const root=dirname(path),result=await repair(root);assert.notEqual(result.exitCode,0);assert.deepEqual(await readdir(root),[]);
}));
