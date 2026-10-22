import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
test('quoted task executables are parsed without admitting unrelated tasks',{skip:process.platform!=='win32'},async()=>{
 const script=`
$ErrorActionPreference='Stop'
$source=Get-Content -Raw -Encoding UTF8 $env:CDR_TEST_CUTOVER
$marker="if (" + [char]36 + "p.action -eq 'inventory')"
$prefix=$source.Substring(0,$source.IndexOf($marker))
$payload=@{state=@{root='C:\\fixture';binary='C:\\fixture\\cdr-runtime.exe'}} | ConvertTo-Json -Compress
. ([scriptblock]::Create($prefix)) -Payload ([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload)))
if(Owned-LegacyAction ([pscustomobject]@{Execute='"C:\\Program Files\\AMD\\AMDAutoUpdate.exe"';Arguments='';WorkingDirectory=''})){throw 'Unrelated task accepted'}
if(-not(Owned-LegacyAction ([pscustomobject]@{Execute='"C:\\fixture\\cdr-runtime.exe"';Arguments='';WorkingDirectory='C:\\fixture'}))){throw 'Quoted owned binary rejected'}
if(Owned-LegacyAction ([pscustomobject]@{Execute='"C:\\fixture\\cdr-runtime.exe"';Arguments='';WorkingDirectory='C:\\other'})){throw 'Foreign directory accepted'}
$s | Add-Member -NotePropertyName entry -NotePropertyValue 'C:\\package\\entry.mjs'
$s | Add-Member -NotePropertyName env -NotePropertyValue 'C:\\fixture\\.env'
foreach($command in @('rehearse-mirror-migration','migrate-mirror-cursors')) {
 $argsForMigration=Migration-Arguments $command
 if($argsForMigration[-2] -ne '--legacy-mirror-policy' -or $argsForMigration[-1] -ne 'strict'){throw 'Omitted policy did not stay strict'}
}
$s | Add-Member -NotePropertyName legacyMirrorPolicy -NotePropertyValue 'rust-preserve'
foreach($command in @('rehearse-mirror-migration','migrate-mirror-cursors')) {
 $argsForMigration=Migration-Arguments $command
 if($argsForMigration[2] -ne $command -or $argsForMigration[-1] -ne 'rust-preserve'){throw 'Policy did not reach native admin command'}
}
$s.legacyMirrorPolicy='invalid';$rejected=$false;try{Migration-Arguments 'migrate-mirror-cursors'}catch{$rejected=$true}
if(-not $rejected){throw 'Unknown recorded policy accepted'}
Write-Output 'verified'
`;
 const result=await promisify(execFile)(join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,env:{...process.env,CDR_TEST_CUTOVER:join(process.cwd(),'scripts/CdrRuntimeCutover.ps1')}});
 assert.match(result.stdout,/verified/);
});
