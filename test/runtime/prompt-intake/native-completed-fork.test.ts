import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,symlinkSync,readFileSync} from 'node:fs';
import {dirname,join,relative} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {ensureForkHandoffTable} from '../../../src/store/fork-handoff-admission.ts';
import {completedAppServerForkTargetForSource as compatibility,completedAppServerForkTargetForSourceExisting as existing,DeadGenerationTargetHeldError} from '../../../src/store/fork-completed-target.ts';
import {createNativePromptIntakeState,NativePromptIntakeUnavailableError} from '../../../src/runtime/prompt-intake/native-state.ts';
import {OwnedWorkerSlot,OwnedWorkerBudgetError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
function edit<T>(path:string,run:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return run(db);}finally{db.close();}}
async function setup(path:string){const db=await openInitialized(path);try{ensureForkHandoffTable(db);}finally{db.close();}}
function fork(db:DatabaseSync,source:string,target:string|null){db.prepare(`INSERT INTO codex_thread_fork_handoffs(handoff_id,source_thread_id,expected_generation,discord_channel_id,discord_thread_id,quarantine_reason,last_fork_error,fork_failure_ambiguous,observed_target_thread_id,target_thread_id,completed_generation,created_at,completed_at) VALUES(?,?,9007199254740993,9007199254740994,9007199254740995,'reason','failed',1,?,?,?,0,?)`).run('h:'+source,source,target,target,target===null?null:9007199254740996n,target===null?null:1);}
test('native completed lookup shares exact completed predicate, null absence, text and fresh per-call snapshots',async()=>storeFixture(async path=>{
 await setup(path);edit(path,db=>{fork(db,'source','target');fork(db,'failed',null);fork(db,' padded ',' 한국어😀 ');fork(db,'','');});const native=createNativePromptIntakeState(path);
 for(const [source,target] of [['source','target'],['failed',null],['absent',null],[' padded ',' 한국어😀 '],['padded',null],['','']] as const){assert.equal(existing(path,source),target);assert.equal(await native.completedAppServerForkTargetForSource(path,source),target);assert.equal(await compatibility(path,source),target);}
 edit(path,db=>db.exec("UPDATE codex_thread_fork_handoffs SET observed_target_thread_id='new',target_thread_id='new' WHERE source_thread_id='source'"));assert.equal(await native.completedAppServerForkTargetForSource(path,'source'),'new');assert.equal(ownedWorkerUsage().Control,0);
}));
test('native completed lookup preserves source-only hold check before target decoding and typed refusal identity',async()=>storeFixture(async path=>{
 await setup(path);edit(path,db=>{fork(db,'source','target');db.exec("INSERT INTO codex_dead_generation_holds VALUES('target','runtime',9007199254740993,0)");});const native=createNativePromptIntakeState(path);
 assert.equal(await native.completedAppServerForkTargetForSource(path,'source'),'target');await assert.rejects(native.completedAppServerForkTargetForSource(path,'target'),e=>e instanceof DeadGenerationTargetHeldError&&e.targetThreadId==='target');
 edit(path,db=>{db.exec("INSERT INTO codex_dead_generation_holds VALUES('source','runtime',1,0);PRAGMA ignore_check_constraints=ON;UPDATE codex_thread_fork_handoffs SET target_thread_id=x'ff',observed_target_thread_id=x'ff'");});
 assert.throws(()=>existing(path,'source'),DeadGenerationTargetHeldError);await assert.rejects(native.completedAppServerForkTargetForSource(path,'source'),e=>e instanceof DeadGenerationTargetHeldError&&e.targetThreadId==='source');
}));
test('native completed lookup never creates missing store or repairs missing optional schema/current catalog',async()=>storeFixture(async path=>{
 const native=createNativePromptIntakeState(path);assert.throws(()=>existing(path,'source'));await assert.rejects(native.completedAppServerForkTargetForSource(path,'source'),NativePromptIntakeUnavailableError);assert.equal(existsSync(path),false);
 const db=await openInitialized(path);db.close();const before=readFileSync(path);await assert.rejects(native.completedAppServerForkTargetForSource(path,'source'),NativePromptIntakeUnavailableError);assert.deepEqual(readFileSync(path),before);
 edit(path,db=>{ensureForkHandoffTable(db);db.exec('DROP INDEX codex_prompt_intakes_message_id');});const missing=readFileSync(path);await assert.rejects(native.completedAppServerForkTargetForSource(path,'source'),NativePromptIntakeUnavailableError);assert.deepEqual(readFileSync(path),missing);
}));
test('existing-only completed read leaves all rows and legacy optional index byte unchanged',async()=>storeFixture(async path=>{
 await setup(path);edit(path,db=>{fork(db,'source','target');db.exec('CREATE INDEX codex_thread_fork_handoffs_observed_target ON codex_thread_fork_handoffs(observed_target_thread_id)');});const before=readFileSync(path);
 assert.equal(existing(path,'source'),'target');assert.equal(await createNativePromptIntakeState(path).completedAppServerForkTargetForSource(path,'source'),'target');assert.deepEqual(readFileSync(path),before);
}));
for(const encoding of ['UTF-8','UTF-16le','UTF-16be'])test(`native completed lookup keeps strict ${encoding} target decoder`,async()=>storeFixture(async path=>{
 edit(path,db=>db.exec(`PRAGMA encoding='${encoding}';CREATE TABLE encoding_sentinel(x)`));await setup(path);edit(path,db=>fork(db,'source','한국어🎯'));const native=createNativePromptIntakeState(path);assert.equal(await native.completedAppServerForkTargetForSource(path,'source'),'한국어🎯');
 for(const invalid of ['NULL',"x'ff'",encoding==='UTF-8'?"CAST(x'ff' AS TEXT)":encoding==='UTF-16le'?"CAST(x'00d8' AS TEXT)":"CAST(x'd800' AS TEXT)"]){edit(path,db=>db.exec(`PRAGMA ignore_check_constraints=ON;UPDATE codex_thread_fork_handoffs SET target_thread_id=${invalid},observed_target_thread_id=${invalid}`));assert.throws(()=>existing(path,'source'));await assert.rejects(native.completedAppServerForkTargetForSource(path,'source'),NativePromptIntakeUnavailableError);assert.equal(await native.completedAppServerForkTargetForSource(path,'absent'),null);}
}));
test('native completed lookup validates bounded passive source and exact installation path before admission',async t=>storeFixture(async path=>{
 let hooks=0,workers=0;const native=createNativePromptIntakeState(path);t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>{workers++;return null;});
 for(const source of [undefined,null,1,1n,{toString(){hooks++;return 'source';}},new Proxy({}, {get(){hooks++;}}),'\ud800'])await assert.rejects(native.completedAppServerForkTargetForSource(path,source as string),TypeError);
 await assert.rejects(native.completedAppServerForkTargetForSource(path,'a'.repeat(65537)),RangeError);await assert.rejects(native.completedAppServerForkTargetForSource(path+'x','source'),TypeError);
 for(const bad of ['\ud800','nul\0path','a'.repeat(32769)])assert.throws(()=>createNativePromptIntakeState(bad));assert.equal(hooks,0);assert.equal(workers,0);assert.equal(existsSync(path),false);
}));
test('native completed lookup binds operation, source, exact null/text and held source without accepting malformed wire',async t=>{
 let raw:unknown; t.mock.method(OwnedWorkerSlot.prototype,'run',async()=>raw);const native=createNativePromptIntakeState('db'),good={ok:true,operation:'CompletedForkTarget',value:{id:'source',target:null}};
 for(raw of [{ok:false},{ok:null,operation:'CompletedForkTarget',kind:'DeadTargetHeld',id:'source',target:'source'},{...good,operation:'Canonicalize'},{...good,value:{id:'other',target:null}},{...good,value:{id:'source'}},...([1,1n,false,{},'\ud800','a'.repeat(65537)]).map(target=>({...good,value:{id:'source',target}})),{ok:false,operation:'CompletedForkTarget',kind:'DeadTargetHeld',id:'other',target:'source'},{ok:false,operation:'CompletedForkTarget',kind:'DeadTargetHeld',id:'source',target:'other'},{...good,padding:'a'.repeat(16*1024*1024)}])await assert.rejects(native.completedAppServerForkTargetForSource('db','source'),NativePromptIntakeUnavailableError);
 raw=good;assert.equal(await native.completedAppServerForkTargetForSource('db','source'),null);raw={...good,value:{id:'source',target:''}};assert.equal(await native.completedAppServerForkTargetForSource('db','source'),'');raw={ok:false,operation:'CompletedForkTarget',kind:'DeadTargetHeld',id:'source',target:'source'};await assert.rejects(native.completedAppServerForkTargetForSource('db','source'),DeadGenerationTargetHeldError);
});
test('native completed lookup pins cwd while preserving native symlink-parent and URI-special path spelling',async()=>storeFixture(async path=>{
 const root=dirname(path),actual=join(root,'actual'),nested=join(actual,'nested');mkdirSync(nested,{recursive:true});symlinkSync(nested,join(root,'link'));const file=join(actual,'fork ?#%.sqlite');await setup(file);edit(file,db=>fork(db,'source','target'));
 const spelling=relative(process.cwd(),root)+'/link/../fork ?#%.sqlite',native=createNativePromptIntakeState(spelling),old=process.cwd();try{process.chdir(root);assert.equal(await native.completedAppServerForkTargetForSource(spelling,'source'),'target');}finally{process.chdir(old);}assert.equal(existsSync(join(root,'fork ?#%.sqlite')),false);
}));
test('native completed lookup retains original IMMEDIATE lock profile, responsive timers and Control slot through deadline and actual exit',async()=>storeFixture(async path=>{
 await setup(path);edit(path,db=>fork(db,'source','target'));const blocker=new DatabaseSync(path);blocker.exec('PRAGMA journal_mode=DELETE;BEGIN IMMEDIATE');const native=createNativePromptIntakeState(path,30),pending=native.completedAppServerForkTargetForSource(path,'source'),rejected=assert.rejects(pending,NativePromptIntakeUnavailableError);let settled=false,ticks=0;void pending.then(()=>{settled=true;},()=>{settled=true;});const timer=setInterval(()=>{ticks++;},5);
 try{await new Promise(r=>setTimeout(r,180));assert.ok(ticks>2);assert.equal(settled,false);assert.equal(ownedWorkerUsage().Control,1);await assert.rejects(native.completedAppServerForkTargetForSource(path,'absent'),OwnedWorkerBudgetError);assert.equal(ownedWorkerUsage().Background,0);blocker.exec('ROLLBACK');await rejected;assert.equal(ownedWorkerUsage().Control,0);assert.equal(existing(path,'source'),'target');}finally{clearInterval(timer);if(blocker.isTransaction)blocker.exec('ROLLBACK');await pending.catch(()=>{});blocker.close();}
}));
