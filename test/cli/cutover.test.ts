import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,resolve} from 'node:path';
import {executeCutover,type CutoverState,type CutoverAction} from '../../src/cli/cutover.ts';
const state=():CutoverState=>({version:1,operation:'fixture',phase:'inventoried',root:'C:\\fixture',entry:'C:\\package\\bin.mjs',node:'C:\\node.exe',binary:'C:\\fixture\\cdr-runtime.exe',env:'C:\\fixture\\.env',taskName:'CodexDiscordTS-fixture',taskArguments:'fixture',disableText:'owned',stopText:'owned',inventory:{tasks:[],legacyIdentity:'1|2'},backup:null,target:null});
test('cutover persists each boundary, keeps backup and observes target before declaring completion',async()=>{
 const calls:string[]=[],saved:CutoverState[]=[];let persisted='';const value=await executeCutover(state(),{save:async s=>{persisted=s.phase;saved.push({...s});},perform:async action=>{calls.push(action);if(action==='prepare')assert.equal(persisted,'disabling_source');if(action==='start-target')assert.equal(persisted,'starting_target');return action==='backup'?'verified.sqlite':action==='observe-target'?{identity:'2|3'}:null;}});
 assert.equal(value.phase,'complete');assert.equal(value.backup,'verified.sqlite');assert.deepEqual(calls,['preflight','backup','prepare','stop-legacy','migrate-store','install-target','start-target','observe-target']);assert.equal(saved.at(-1)?.phase,'complete');
});
for(const failure of ['prepare','stop-legacy','migrate-store','install-target','start-target','observe-target'] as CutoverAction[])test('cutover '+failure+' failure proves target stop before restoring legacy tasks, without overwriting DB',async()=>{
 const calls:string[]=[],s=state();await assert.rejects(executeCutover(s,{save:async()=>{},perform:async action=>{calls.push(action);if(action===failure)throw Error('fixture failure');return action==='backup'?'verified.sqlite':null;}}),/source configuration was restored/);
 assert.equal(s.phase,'rolled_back');assert.deepEqual(calls.slice(-2),['stop-target','restore-legacy']);assert.equal(s.backup,'verified.sqlite');
});
test('unconfirmed target shutdown retains the source fence and recovery journal',async()=>{
 const calls:string[]=[],s=state();await assert.rejects(executeCutover(s,{save:async()=>{},perform:async action=>{calls.push(action);if(action==='observe-target'||action==='stop-target')throw Error('still running');return action==='backup'?'verified.sqlite':null;}}),/explicit recovery/);
 assert.equal(s.phase,'recovery_required');assert.ok(!calls.includes('restore-legacy'));
 const resumed:string[]=[];await executeCutover(s,{save:async()=>{},perform:async action=>{resumed.push(action);}},true);assert.deepEqual(resumed,['stop-target','restore-legacy']);assert.equal(s.phase,'rolled_back');
});

test('native rollback launches through Task Scheduler, preserves an existing process and refuses stale task ownership',{skip:process.platform!=='win32'},async()=>{
 const script=`
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:CDR_FIXTURE_CUTOVER_SCRIPT,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Script parse failed' }
$fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Start-RestoredLegacy'},$true)
if ($null -eq $fn) { throw 'Native rollback entry is missing' }
Invoke-Expression $fn.Extent.Text
$script:starts=0; $script:waits=0; $script:running=$false; $script:stale=$false
function Assert-Task($Record) { if($script:stale){throw 'stale fixture task'}; return $Record }
function Legacy-Process { if($script:running){ return @{Id=123} }; return $null }
function Start-ScheduledTask { param($TaskPath,$TaskName) if($TaskPath -ne '\\fixture\\' -or $TaskName -ne 'legacy-watchdog'){throw 'Wrong task selected'}; $script:starts++ }
function Wait-Healthy([bool]$Target) { if($Target){throw 'Observed target instead of source'}; $script:waits++ }
$record=@{path='\\fixture\\';name='legacy-watchdog'}
Start-RestoredLegacy $record
if($script:starts -ne 1 -or $script:waits -ne 1){throw 'Task launch was not observed'}
$script:running=$true; Start-RestoredLegacy $record
if($script:starts -ne 1 -or $script:waits -ne 2){throw 'Existing source was relaunched'}
$script:stale=$true; $rejected=$false; try { Start-RestoredLegacy $record } catch { $rejected=$true }
if(-not $rejected -or $script:starts -ne 1 -or $script:waits -ne 2){throw 'Stale ownership accepted'}
$rejected=$false; try { Start-RestoredLegacy $null } catch { $rejected=$true }; if(-not $rejected){throw 'Missing restart task accepted'}
@{starts=$script:starts;waits=$script:waits;staleRejected=$true}|ConvertTo-Json -Compress
`;
 const result=await promisify(execFile)(join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,CDR_FIXTURE_CUTOVER_SCRIPT:resolve('scripts/CdrRuntimeCutover.ps1')},windowsHide:true,timeout:10000});
 assert.deepEqual(JSON.parse(result.stdout.replace(/^\uFEFF/u,'')),{starts:1,waits:2,staleRejected:true});
});
test('native cutover accepts its recorded GUI launcher and legacy Node action but rejects an altered task',{skip:process.platform!=='win32'},async()=>{
 const script=`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:CDR_FIXTURE_CUTOVER_SCRIPT,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Script parse failed'}
$fn=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-TargetTask'},$true)
Invoke-Expression $fn.Extent.Text
$Root='C:\\fixture'
$s=[pscustomobject]@{taskName='fixture';node='C:\\node.exe';taskArguments='encoded fixture'}
$script:task=[pscustomobject]@{Actions=@([pscustomobject]@{Execute=$s.node;Arguments=$s.taskArguments;WorkingDirectory=$Root})}
function Get-ScheduledTask { param($TaskName,$ErrorAction) if($TaskName -ne 'fixture'){throw 'Wrong task'};return $script:task }
[void](Assert-TargetTask)
$s|Add-Member -NotePropertyName taskExecute -NotePropertyValue 'C:\\Windows\\System32\\wscript.exe'
$script:task.Actions[0].Execute=$s.taskExecute
[void](Assert-TargetTask)
$script:task.Actions[0].Arguments='foreign'
$rejected=$false;try{[void](Assert-TargetTask)}catch{$rejected=$true}
if(-not $rejected){throw 'Foreign launcher accepted'}
'BOUND'
`;
 const result=await promisify(execFile)(join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...process.env,CDR_FIXTURE_CUTOVER_SCRIPT:resolve('scripts/CdrRuntimeCutover.ps1')},windowsHide:true,timeout:10000});
 assert.match(result.stdout,/BOUND/u);
});
