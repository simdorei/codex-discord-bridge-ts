import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {runAdmin,adminDatabase} from '../../src/cli/admin.ts';
import {WindowsRuntimeInstance} from '../../src/runtime/windows/windows-runtime-instance.ts';
import {readBoundMirrorCursor} from '../../src/store/mirror-cursor-journal.ts';
import {observeMirrorCursorContinuity} from '../../src/runtime/session-mirror/continuity-observation.ts';
import {verifyInstallInventory} from '../../src/cli/admin-files.ts';
import {AdminArgs} from '../../src/cli/admin-args.ts';
import {sendAdminAttachments} from '../../src/cli/admin-http.ts';
import {runOwnedCommand} from '../../src/runtime/windows/owned-command.ts';
import {createHash} from 'node:crypto';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
import {selectDelivery} from '../../src/store/delivery.ts';
import {finalRecoveryAuthorizedIn,validateFinalRecoveryClaimIn} from '../../src/store/final-recovery-claims.ts';
import {inspectLifecycleIntent} from '../../src/cli/admin-intent.ts';
import {pathToFileURL} from 'node:url';
const windows={skip:process.platform!=='win32',timeout:30000};
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');
test('packaged Pro manifest and explicit skill input share the installed plugin, preserving a local override',windows,()=>storeFixture(async path=>{
 const {runtimePluginPaths}=await import(pathToFileURL(join(process.cwd(),'dist/src/pro/plugin-paths.js')).href);
 const root=dirname(path),packaged=await runtimePluginPaths(root);
 assert.equal(resolve(packaged.proSkill),join(process.cwd(),'plugins/codex-discord-remote/skills/ask-chatgpt-pro/SKILL.md'));
 assert.equal(JSON.parse(await readFile(packaged.manifest,'utf8')).name,'codex-discord-remote');
 assert.match(await readFile(packaged.proSkill,'utf8'),/ask-chatgpt-pro/);
 const local=join(root,'plugins/codex-discord-remote');await mkdir(join(local,'.codex-plugin'),{recursive:true});await writeFile(join(local,'.codex-plugin/plugin.json'),'{}');
 const override=await runtimePluginPaths(root);assert.equal(resolve(override.manifest),join(local,'.codex-plugin/plugin.json'));assert.equal(resolve(override.proSkill),join(local,'skills/ask-chatgpt-pro/SKILL.md'));
}));
async function savedFinalFixture(path:string){
 const db=await openInitialized(path),key=serializeSerdeValue([42n,'message/error/v1','inbound-message/11/error-report',0n]);
 db.exec("INSERT INTO mirror_threads VALUES ('thread','project','title',100,42,1); INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('delivery','job','thread','turn',42,'Saved answer',1,1); INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,owner_kind,owner_id,confirmation_delivered,created_at,updated_at) VALUES ('message:11','message',11,42,3,'{}','owned','durable_prompt','thread','prompt','job',0,1,1)");
 db.prepare('INSERT INTO codex_delivery_receipts(receipt_key,content_hash,message_id) VALUES (?,?,?)').run(key,'error-hash','123');db.close();
 return {delivery_id:'delivery',job_id:'job',thread_id:'thread',turn_id:'turn',channel_id:42n,original_sha256:digest('Saved answer'),ingress_id:'message:11',error_receipt_key:key,error_message_id:'123',error_sha256:'error-hash'};
}
test('saved-final authorization is idempotent, rollback-safe and rechecks exact evidence',windows,()=>storeFixture(async path=>{
 const request=await savedFinalFixture(path),apply=()=>adminDatabase({path,command:'authorize-saved-final',request:serializeSerdeValue(request)});
 const db=new DatabaseSync(path);try{
  db.exec("CREATE TRIGGER fail_grant BEFORE INSERT ON cdr_final_recovery BEGIN SELECT RAISE(ABORT,'fixture failure'); END");await assert.rejects(apply(),/fixture failure/);assert.equal(selectDelivery(db,'delivery').content,'Saved answer');db.exec('DROP TRIGGER fail_grant');
  await apply();await apply();const saved=selectDelivery(db,'delivery');assert.ok(saved.content.endsWith('Saved answer'));assert.equal(finalRecoveryAuthorizedIn(db,saved),true);assert.equal(db.prepare('SELECT count(*) n FROM cdr_final_recovery').get()!.n,1);
  const key=serializeSerdeValue([42n,'completion/v1','delivery',0n]),guard={jobId:'job',threadId:'thread',turnId:'turn'};validateFinalRecoveryClaimIn(db,key,digest(saved.content),guard);assert.throws(()=>validateFinalRecoveryClaimIn(db,key,'changed',guard));
  db.exec('UPDATE discord_ingress_journal SET owner_user_id=4');assert.throws(()=>finalRecoveryAuthorizedIn(db,saved));assert.throws(()=>validateFinalRecoveryClaimIn(db,key,digest(saved.content),guard));assert.equal(db.prepare('SELECT count(*) n FROM codex_turn_queue').get()!.n,0);
 }finally{db.close();}
}));
for(const corruption of ['intent','error','source','payload','progress'])test('saved-final refuses '+corruption+' without changing saved text',windows,()=>storeFixture(async path=>{
 const r=await savedFinalFixture(path),db=new DatabaseSync(path);try{
  if(corruption==='intent')db.prepare('INSERT INTO codex_delivery_receipts(receipt_key,content_hash) VALUES (?,?)').run(serializeSerdeValue([999n,'completion/v1','delivery',99n]),'hash');
  else if(corruption==='error')r.error_message_id='other';else if(corruption==='source')r.ingress_id='message:12';else if(corruption==='payload')r.original_sha256='wrong';else db.exec("INSERT INTO codex_commentary_outbox(delivery_key,job_id,target_thread_id,turn_id,channel_id,text) VALUES ('progress','job','thread','turn',42,'before final')");
  await assert.rejects(adminDatabase({path,command:'authorize-saved-final',request:serializeSerdeValue(r)}));assert.equal(selectDelivery(db,'delivery').content,'Saved answer');assert.equal(db.prepare('SELECT count(*) n FROM cdr_final_recovery').get()!.n,0);
 }finally{db.close();}
}));
test('lifecycle diagnostic distinguishes bound stored intent without granting replay',()=>{
 const meta={kind:'message',event_id:11n,source_message_id:11n,ingress_id:'message:11',channel_id:42n,owner_user_id:3n,owner_kind:null,owner_id:null,thread_id:'thread'},command={Stop:{reference:null}},payload={version:1n,plan:{Execute:command},lifecycle_binding:{target:'thread',route:'Mapped',command}};
 const report=inspectLifecycleIntent(meta,serializeSerdeValue(payload));assert.equal(report.stored_custody_consistent,true);assert.equal(report.replay_authorized,false);assert.equal(report.live_route_verified,false);assert.equal(inspectLifecycleIntent({...meta,thread_id:'changed'},serializeSerdeValue(payload)).stored_custody_consistent,false);assert.equal(inspectLifecycleIntent(meta,'bad').payload_status,'invalid');
});
test('install configuration preserves unrelated settings and setup dry-run never connects',windows,()=>storeFixture(async path=>{
 const root=dirname(path);await writeFile(join(root,'.env'),'# keep\r\nDISCORD_BOT_TOKEN=secret-fixture\r\nCODEX_HOME=old\r\n');
 const result=await runAdmin(['configure-install','--codex-home',join(root,'한글 home'),'--codex-exe',process.execPath],new Map(),root,'test');
 assert.ok(!result.includes('secret-fixture'));const text=await readFile(join(root,'.env'),'utf8');assert.ok(text.includes('# keep'));assert.ok(text.includes('DISCORD_BOT_TOKEN=secret-fixture'));assert.ok(text.includes('CODEX_HOME='+join(root,'한글 home')));
 assert.match(await runAdmin(['setup-discord','--dry-run','--bot-id','123'],new Map(),root,'test'),/client_id=123/);
 await assert.rejects(runAdmin(['configure-install','--codex-home','bad\nTOKEN=injected'],new Map(),root,'test'),/Invalid environment/);
 assert.equal(await readFile(join(root,'.env'),'utf8'),text);
}));
test('plugin installation verification rejects duplicate or wrong repository registrations',windows,()=>storeFixture(async path=>{
 const root=dirname(path),m=join(root,'markets.json'),p=join(root,'plugins.json'),f=join(root,'manifest.json');
 const record={name:'market',root};await writeFile(m,JSON.stringify({marketplaces:[record]}));await writeFile(p,JSON.stringify({installed:[{pluginId:'plugin',installed:true,enabled:true,version:'1'}]}));await writeFile(f,'{"version":"1"}');
 assert.equal(await verifyInstallInventory(root,m,p,f,'market','plugin'),'1');await writeFile(m,JSON.stringify({marketplaces:[record,record]}));await assert.rejects(verifyInstallInventory(root,m,p,f,'market','plugin'),/unique/);
}));
test('legacy mirror migration backs up, preserves cursor and rejects concurrent runtime',windows,()=>storeFixture(async path=>{
 const root=dirname(path),log=join(root,'rollout.jsonl');await writeFile(log,'{"type":"old"}\n');const db=await openInitialized(path);
 db.prepare('INSERT INTO codex_session_mirror_offsets(codex_thread_id,rollout_path,cursor,updated_at,turn_context) VALUES(?,?,?,?,?)').run('thread',log,15,1,'turn');db.close();
 // The exact prefix is 15 UTF-8 bytes; no replay/reset is allowed by cutover.
 assert.equal((await readFile(log)).length,15);
 const env=new Map([['CODEX_DISCORD_MIRROR_DB',path]]),args=['migrate-mirror-cursors'];const live=await WindowsRuntimeInstance.acquire(root);
 try{await assert.rejects(runAdmin(args,env,root,'test'));}finally{await live.release();}
 const report=JSON.parse(await runAdmin(args,env,root,'test'));assert.deepEqual(report.migrated,['thread']);assert.deepEqual(report.held,[]);assert.equal(report.replayAuthorized,false);
 const before=new DatabaseSync(report.backup,{readOnly:true});assert.equal(before.prepare('SELECT cursor FROM codex_session_mirror_offsets').get()!.cursor,15);assert.equal(before.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='cdr_ts_mirror_cursor_anchors_v1'").get()!.n,0);before.close();
 const after=new DatabaseSync(path);const bound=readBoundMirrorCursor(after,'thread')!;assert.equal(bound.anchor.version,3);assert.equal(bound.anchor.offset,15n);assert.equal(bound.turn,'turn');after.close();
 await writeFile(log,'{"type":"NEW"}\nappend\n');await assert.rejects(observeMirrorCursorContinuity(bound.anchor));
 const held=JSON.parse(await runAdmin(args,env,root,'test'));assert.deepEqual(held.migrated,[]);assert.equal(held.held[0].thread,'thread');
}));
test('read-only admin compatibility never migrates unknown schema and inspection hashes prompt data',windows,()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();const report=await adminDatabase({path,command:'check-recovery-compatibility'});assert.equal(report.compatible,true);assert.equal(report.admission_authorized,false);
 const inspected=await adminDatabase({path,command:'inspect-async-recovery',thread:'none'});assert.equal(inspected.read_only,true);assert.equal(inspected.execution_authorized,false);assert.equal(inspected.jobs.rows.length,0);
 const other=new DatabaseSync(path);other.exec('PRAGMA user_version=99');other.close();await assert.rejects(adminDatabase({path,command:'check-recovery-compatibility'}),/Unsupported store schema/);const check=new DatabaseSync(path);assert.equal(check.prepare('PRAGMA user_version').get()!.user_version,99);check.close();
}));
test('attachment CLI makes exactly one upload and preserves an uncertain outcome',windows,t=>storeFixture(async path=>{
 const root=dirname(path),file=join(root,'한글.txt');await writeFile(file,'hello');let calls=0;
 t.mock.method(globalThis,'fetch',async(url:unknown,init:any)=>{calls++;assert.equal(url,'https://discord.com/api/v10/channels/123/messages');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bot fixture-only');assert.ok(init.body instanceof FormData);const payload=JSON.parse(String(init.body.get('payload_json')));assert.deepEqual(payload.allowed_mentions,{parse:[]});return new Response(JSON.stringify({id:'456',channel_id:'123'}),{status:200});});
 const args=AdminArgs.parse(['send-attachment','--channel-id','123',file]);assert.match(await sendAdminAttachments(args,'fixture-only','123'),/message_id=456/);assert.equal(calls,1);
 t.mock.method(globalThis,'fetch',async()=>{calls++;throw new Error('SECRET MUST NOT LEAK');});await assert.rejects(sendAdminAttachments(args,'fixture-only','123'),e=>e instanceof Error&&e.message.includes('unconfirmed')&&!e.message.includes('SECRET'));assert.equal(calls,2);
}));
test('bundled recovery PowerShell parses without running any recovery effects',windows,async()=>{
 const scripts=['CdrDesktopRecovery.ps1','CdrOwnedProcesses.ps1','CdrToolsRecovery.ps1','Invoke-CdrDesktopRecovery.ps1','Test-NativeWorkspace.ps1'].map(name=>join(process.cwd(),'scripts',name));
 scripts.push(...['status.ps1','restart.ps1','qa-smoke.ps1'].map(name=>join(process.cwd(),'plugins','codex-discord-remote','scripts',name)));
 const payload=Buffer.from(JSON.stringify(scripts)).toString('base64');
 const script=`$ErrorActionPreference='Stop'; $files=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json; foreach($file in $files){$tokens=$null; $errors=$null; [void][Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors); if($errors.Count){throw ($errors|Out-String)}}; 'PARSE_OK'`;
 const result=await runOwnedCommand({executable:join(process.env.SystemRoot!,'System32','WindowsPowerShell','v1.0','powershell.exe'),arguments:['-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],environment:{}},{timeoutMs:15000,maxBytes:65536});assert.equal(result.exitCode,0,result.stderr.toString());assert.match(result.stdout.toString(),/PARSE_OK/);
});
