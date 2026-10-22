import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {executeCutover,runCutoverCli,type CutoverState,type CutoverAction} from '../../src/cli/cutover.ts';
import {cutoverControlState,nativeCutoverCommand,requireWindowsCommandCapacity,validateCutoverCommandCapacity} from '../../src/cli/cutover-command.ts';
import {runOwnedCommand} from '../../src/runtime/windows/owned-command.ts';
import {storeFixture} from '../helpers/store-fixture.ts';

const state=(root='C:\\fixture'):CutoverState=>({version:1,operation:'fixture',phase:'inventoried',root,
 entry:join(root,'entry.mjs'),node:process.execPath,binary:join(root,'cdr-runtime.exe'),env:join(root,'.env'),
 taskName:'CodexDiscordTS-fixture',taskExecute:'C:\\Windows\\System32\\wscript.exe',taskArguments:'quoted "한글 path" \\',
 disableText:'owned-disable',stopText:'owned-stop',inventory:{tasks:[],legacyIdentity:'1|2'},backup:null,target:null,legacyMirrorPolicy:'rust-preserve'});
const largeReport=()=>({policy:'rust-preserve',migrated:['good'],already:[],held:[],inactivePreserved:[],
 deferred:[{thread:'held',reason:'diagnostic'.repeat(100000)}],historicalDeliveryVerified:false});

test('large journal evidence cannot enlarge native control commands or mutate the journal',()=>{
 const value=state();value.mirrorMigration=largeReport();value.backup='backup'.repeat(10000);value.target={evidence:'health'.repeat(100000)};
 const before=JSON.stringify(value),control=cutoverControlState(value);
 assert.deepEqual(Object.keys(control).sort(),['root','entry','node','binary','env','taskName','taskExecute','taskArguments','disableText','stopText','inventory','legacyMirrorPolicy'].sort());
 for(const action of ['install-target','start-target','observe-target','stop-target','restore-legacy'] as CutoverAction[]){
  const command=nativeCutoverCommand(action,value,'C:\\script space\\cutover.ps1','powershell.exe');
  assert.ok(requireWindowsCommandCapacity(command.executable,command.arguments)<3000);
  const decoded=JSON.parse(Buffer.from(command.arguments.at(-1)!,'base64').toString('utf8'));
  assert.equal(decoded.action,action);assert.deepEqual(decoded.state,control);
 }
 assert.equal(JSON.stringify(value),before);
});

test('Windows limit includes quotes, escaped trailing backslashes, UTF-16 pairs and NUL',()=>{
 assert.equal(requireWindowsCommandCapacity('x',['한글😀']),7);
 assert.equal(requireWindowsCommandCapacity('x',['a b\\']),10);
 assert.equal(requireWindowsCommandCapacity('x',['a'.repeat(32764)]),32767);
 assert.throws(()=>requireWindowsCommandCapacity('x',['a'.repeat(32765)]),/32768/);
 assert.throws(()=>requireWindowsCommandCapacity('x',['bad\0arg']),/NUL/);
});

test('oversized required control data is rejected without truncating or changing it',()=>{
 const value=state();value.inventory={required:'x'.repeat(40000)};const before=JSON.stringify(value);
 assert.throws(()=>validateCutoverCommandCapacity(value,'C:\\script.ps1','powershell.exe'),/control data was not truncated/);
 assert.equal(JSON.stringify(value),before);
});

test('CLI rejects oversized recovery control inputs before rewriting the journal',{skip:process.platform!=='win32'},()=>storeFixture(async path=>{
 const root=await realpath(dirname(path)),value=state(root);value.phase='recovery_required';value.inventory={required:'x'.repeat(40000)};
 const journal=join(root,'.cdr-ts-cutover.json'),before=JSON.stringify(value);await writeFile(journal,before);
 await assert.rejects(runCutoverCli(['--recover-cutover','--runtime-root',root],value.entry),/32767 UTF-16/);
 assert.equal(await readFile(journal,'utf8'),before);
}));

test('real owned Windows transport still launches install and both rollback actions after a large migration result',{skip:process.platform!=='win32',timeout:30000},()=>storeFixture(async path=>{
 const root=dirname(path),script=join(root,'payload 한글 fixture.ps1'),powershell=join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe');
 await writeFile(script,`param([string]$Payload)
$ErrorActionPreference='Stop'
$OutputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=$OutputEncoding
$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))|ConvertFrom-Json
if($null -ne $p.state.PSObject.Properties['mirrorMigration']){throw 'Journal report leaked into command'}
if($p.state.legacyMirrorPolicy -ne 'rust-preserve'){throw 'Policy was lost'}
if($p.state.disableText -ne 'owned-disable' -or $p.state.stopText -ne 'owned-stop'){throw 'Marker ownership lost'}
@{action=$p.action;root=$p.state.root;taskArguments=$p.state.taskArguments}|ConvertTo-Json -Compress
`);
 const value=state(root),report=largeReport(),calls:CutoverAction[]=[],saved:CutoverState[]=[];
 const perform=async(action:CutoverAction,s:CutoverState)=>{
  const command=nativeCutoverCommand(action,s,script,powershell);
  const result=await runOwnedCommand(command,{timeoutMs:10000,maxBytes:65536});
  assert.equal(result.exitCode,0,result.stderr.toString());const received=JSON.parse(result.stdout.toString());
  assert.equal(received.action,action);assert.equal(received.root,root);assert.equal(received.taskArguments,value.taskArguments);calls.push(action);
  if(action==='rehearse-store')return {ready:true,policy:'rust-preserve'};
  if(action==='backup')return 'verified.sqlite';
  if(action==='migrate-store')return report;
  if(action==='install-target')throw new Error('Injected install failure after native transport decoded');
  return null;
 };
 await assert.rejects(executeCutover(value,{perform,save:async s=>{saved.push(structuredClone(s));}}),/source configuration was restored/);
 assert.equal(value.phase,'rolled_back');assert.equal(value.failurePhase,'installing_target');
 assert.deepEqual(calls.slice(-3),['install-target','stop-target','restore-legacy']);
 assert.deepEqual(saved.at(-1)!.mirrorMigration,report);assert.deepEqual(value.mirrorMigration,report);
 // The very same large retained journal remains recoverable on a later run.
 calls.length=0;await executeCutover(value,{perform,save:async()=>{}},true);
 assert.deepEqual(calls,['stop-target','restore-legacy']);assert.deepEqual(value.mirrorMigration,report);
}));
