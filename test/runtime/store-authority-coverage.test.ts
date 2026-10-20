import {storeFixture} from '../helpers/store-fixture.ts';
import {writeFileSync} from 'node:fs';
import {auditStoreAuthoritySyntax} from '../helpers/store-authority-ast-audit.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {readdirSync,readFileSync,existsSync} from 'node:fs';import {dirname,join,relative,resolve} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {storeWorkerManifest,storeWorkerClassification} from '../../src/runtime/store-worker-manifest.ts';import {ownedWorkerModuleUrl} from '../../src/runtime/owned-worker-slot.ts';
function files(root:string,extension:string):string[]{const result:string[]=[];for(const entry of readdirSync(root,{withFileTypes:true})){const path=join(root,entry.name);if(entry.isDirectory())result.push(...files(path,extension));else if(entry.name.endsWith(extension))result.push(path);}return result;}
function repository():string{let root=dirname(fileURLToPath(import.meta.url));while(!existsSync(join(root,'package.json'))){const next=dirname(root);assert.notEqual(next,root);root=next;}return root;}
function audit(root:string,extension:'.ts'|'.js'){
 const all=files(root,extension),native:string[]=[],urls=new Set<string>(),writerFactories:string[]=[],sideChannel:string[]=[],backups:string[]=[],lifetimeBypasses:string[]=[];
 for(const path of all){const text=readFileSync(path,'utf8'),name=relative(root,path).replaceAll('\\','/');
  for(const match of text.matchAll(/new\s+Worker\s*\(/g))native.push(name);
  for(const match of text.matchAll(/new\s+URL\s*\(\s*['"]([^'"]*worker\.(?:ts|js))['"]\s*,\s*import\.meta\.url\s*\)/g)){const url=new URL(match[1]!,pathToFileURL(path));urls.add(ownedWorkerModuleUrl(url,pathToFileURL(path).href).href);}
  for(const match of text.matchAll(/new\s+DatabaseSync\s*\(([^;]+?)(?:;|$)/g))assert.match(match[1]!,/readOnly\s*:\s*true/,name+' raw writable DatabaseSync');
  if(/extends\s+DatabaseSync/.test(text))writerFactories.push(name);
  if(/(?:get|set)EnvironmentData/.test(text))sideChannel.push(name);
  if(/DatabaseSync\.prototype\s*(?:\.\s*(?:close|open)|\[\s*Symbol\.dispose)/.test(text))lifetimeBypasses.push(name);
  if(/\b(?:backup|sqliteBackup)\s*\(/.test(text))backups.push(name);
  assert.doesNotMatch(text,/\b(?:ATTACH\s+DATABASE|VACUUM\s+(?:\w+\s+)?INTO)\b/i,name+' unexpected writable attached destination');
 }
 assert.deepEqual(native,['runtime/owned-worker-slot'+extension]);assert.deepEqual(writerFactories,['store/authority-connection'+extension]);assert.deepEqual(sideChannel,['runtime/store-worker-authority'+extension]);assert.deepEqual(lifetimeBypasses,[]);
 assert.deepEqual(backups.sort(),['runtime/archive-delete/backup-core','runtime/archive-delete/preparation-worker','store/cutover-backup-worker','store/owned-driver'].map(x=>x+extension).sort());
 const manifest=storeWorkerManifest(),mapped=manifest.map(x=>new URL(relative(fileURLToPath(new URL('../../src/',import.meta.url)),fileURLToPath(x.url)).replace(/\.(?:ts|js)$/,extension),pathToFileURL(root+'/')).href);
 assert.equal(urls.size,83);assert.deepEqual([...urls].sort(),mapped.sort());assert.equal(manifest.filter(x=>x.field!==null).length,49);
 const actualWriters=manifest.filter(x=>x.field!==null).map(x=>[relative(fileURLToPath(new URL('../../src/',import.meta.url)),fileURLToPath(x.url)).replace(/\.js$/,'.ts'),x.field]);
 assert.deepEqual(actualWriters,expectedWriters);
 auditStoreAuthoritySyntax(root,all);
 for(const item of manifest)assert.notEqual(storeWorkerClassification(new URL(item.url)),undefined);
}

test('source and emitted graphs have a closed 83-module inventory and no writable/worker/lifecycle bypass',()=>{
 const root=repository();audit(join(root,'src'),'.ts');const current=fileURLToPath(new URL('../../src/',import.meta.url));if(import.meta.url.endsWith('.js'))audit(current,'.js');
});

// Independent reviewed whole-module inventory from the Stage A design audit.
const expectedWriters=[
 ['runtime/action-executor/archive-write-native-worker.ts','path'],
 ['runtime/action-executor/busy-create-native-worker.ts','path'],
 ['runtime/action-executor/control-evidence-native-worker.ts','path'],
 ['runtime/action-executor/retract-write-native-worker.ts','path'],
 ['runtime/action-executor/steer-origin-native-worker.ts','path'],
 ['runtime/action-executor/stop-acceptance-native-worker.ts','path'],
 ['runtime/action-executor/stop-dispatch-native-worker.ts','path'],
 ['runtime/action-executor/stop-pending-native-worker.ts','path'],
 ['runtime/archive-delete/preparation-worker.ts','mirror'],
 ['runtime/async-question-publication-native-worker.ts','path'],
 ['runtime/completion/native-final-state-worker.ts','path'],
 ['runtime/completion/native-heads-worker.ts','path'],
 ['runtime/completion/native-history-read-worker.ts','path'],
 ['runtime/completion/native-http-payload-worker.ts','path'],
 ['runtime/completion/native-idle-inventory-worker.ts','path'],
 ['runtime/completion/native-observed-payload-worker.ts','path'],
 ['runtime/completion/native-owner-read-worker.ts','path'],
 ['runtime/completion/native-progress-state-worker.ts','path'],
 ['runtime/completion/native-receipt-store-worker.ts','path'],
 ['runtime/completion/native-typing-worker.ts','path'],
 ['runtime/component-worker/async-choice-native-worker.ts','path'],
 ['runtime/component-worker/busy-claim-native-worker.ts','path'],
 ['runtime/component-worker/standard-claim-native-worker.ts','path'],
 ['runtime/component-worker/recovery-decision-native-worker.ts','path'],
 ['runtime/discord-runtime/ingress-recovery-worker.ts','path'],
 ['runtime/discord-runtime/reserve-retirement-worker.ts','path'],
 ['runtime/discord-runtime/resume-recovery-worker.ts','path'],
 ['runtime/discord-runtime/storage-preparation-worker.ts','mirrorDb'],
 ['runtime/mirror-sync/archived-native-worker.ts','mirror'],
 ['runtime/mirror-sync/source-scope-worker.ts','mirror'],
 ['runtime/mirror-sync/store-native-worker.ts','path'],
 ['runtime/message-worker/abandonment-proposal-native-worker.ts','path'],
 ['runtime/message-worker/native-journal-worker.ts','path'],
 ['runtime/interaction-worker/native-journal-worker.ts','path'],
 ['runtime/native-custody-read-worker.ts','path'],
 ['runtime/native-dead-generation-worker.ts','path'],
 ['runtime/native-idle-before-worker.ts','path'],
 ['runtime/native-mutation-worker.ts','path'],
 ['runtime/native-observation-ledger-worker.ts','path'],
 ['runtime/new-reply/store-worker.ts','path'],
 ['runtime/prompt-intake/native-state-worker.ts','path'],
 ['runtime/queue-runner/native-attempt-worker.ts','path'],
 ['runtime/queue-runner/native-read-state-worker.ts','path'],
 ['runtime/queue-runner/native-submission-worker.ts','path'],
 ['runtime/session-mirror/cursor-store-worker.ts','path'],
 ['runtime/session-mirror/receipt-store-worker.ts','path'],
 ['runtime/session-mirror/startup-intent-store-worker.ts','path'],
 ['runtime/writer-recovery/native-repair-worker.ts','path'],
 ['runtime/writer-recovery/native-worker.ts','path'],
];

test('syntax audit rejects aliases, constructor escape, dynamic native loads, reexports and prototype close bypass',async()=>storeFixture(async path=>{
 const root=dirname(path),file=join(root,'fixture.ts');
 for(const source of [
  "import {Worker as NativeWorker} from 'node:worker_threads';new NativeWorker('x');",
  "import {DatabaseSync as DB} from 'node:sqlite';new DB('x');",
  "import * as sqlite from 'node:sqlite';new sqlite.DatabaseSync('x');",
  "import {DatabaseSync} from 'node:sqlite';const DB=DatabaseSync;",
  "export {DatabaseSync} from 'node:sqlite';",
  "await import('node:worker_threads');",
  "await import('node:sqlite');",
  "import {DatabaseSync} from 'node:sqlite';DatabaseSync.prototype.close.call({});",
  "import {DatabaseSync} from 'node:sqlite';new DatabaseSync('x',{readOnly:false});",
  "import {createRequire} from 'node:module';const r=createRequire(import.meta.url);",
  "process.getBuiltinModule('node:sqlite');",
 ]){writeFileSync(file,source);assert.throws(()=>auditStoreAuthoritySyntax(root,[file]));}
}));
