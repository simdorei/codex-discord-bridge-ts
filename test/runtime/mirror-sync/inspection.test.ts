import {it} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {dirname,join} from 'node:path';import {writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {TargetLocks} from '../../../src/core/keyed-locks.ts';import {MirrorInspector,joinMirrorInspectionReader,mirrorInspectionReaderBusy} from '../../../src/runtime/mirror-sync/inspection.ts';import type {MirrorChannel} from '../../../src/runtime/mirror-sync/new-mirror-link.ts';
type F={mirror:string;codex:string;channels:Map<bigint,MirrorChannel>;calls:bigint[];locks:TargetLocks;inspector:MirrorInspector};
async function fixture(run:(f:F)=>Promise<void>){await storeFixture(async mirror=>{
 const codex=join(dirname(mirror),'codex.sqlite'),rollout=join(dirname(mirror),'rollout.jsonl');writeFileSync(rollout,'{}\n');let db=new DatabaseSync(mirror);try{db.exec("CREATE TABLE mirror_threads(codex_thread_id,thread_title,discord_channel_id,discord_thread_id,project_key);CREATE TABLE mirror_projects(project_key,discord_channel_id);INSERT INTO mirror_projects VALUES('/p',10);INSERT INTO mirror_threads VALUES('root','Root',10,20,'/p'),('mapped-child','Child',10,21,'/p')");}finally{db.close();}
 db=new DatabaseSync(codex);try{db.exec("CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER,source TEXT,thread_source TEXT)");const q=db.prepare("INSERT INTO threads VALUES(?,?,'/p',1,?,NULL,NULL,0,0,0,'app-server',?)");q.run('root','Root',rollout,'user');q.run('mapped-child','Child',rollout,'subagent');q.run('unmapped-child','Not a root',rollout,'subagent');}finally{db.close();}
 const channels=new Map<bigint,MirrorChannel>([[10n,{id:10n,guildId:9n,parentId:99n,kind:0n,name:'project',archived:false}],[20n,{id:20n,guildId:9n,parentId:10n,kind:11n,name:'root',archived:false}],[21n,{id:21n,guildId:9n,parentId:10n,kind:11n,name:'child',archived:false}]]),calls:bigint[]=[],locks=new TargetLocks(),inspector=new MirrorInspector(codex,mirror,{channel:async id=>{calls.push(id);return channels.get(id)??null;}},locks,9n);
 try{await run({mirror,codex,channels,calls,locks,inspector});}finally{await joinMirrorInspectionReader();assert.equal(locks.activeTargetCount,0);}
});}
it('read-only inspector includes interactive roots and mapped active children but excludes unrelated subagents',async()=>fixture(async f=>{
 const before=readFileSync(f.mirror),result=await f.inspector.inspect(42n,null,true);assert.match(result,/status: ok\nexpected_threads: 2\ntargets: 2/);assert.ok(!result.includes('unmapped-child'));assert.deepEqual(f.calls,[10n,21n,20n]);assert.deepEqual(readFileSync(f.mirror),before);assert.match(result,/writer ownership not verified/);assert.equal(mirrorInspectionReaderBusy(),false);
}));
it('zero display limit still checks every mapped remote room and reports issues outside displayed rows',async()=>fixture(async f=>{
 f.channels.set(20n,{...f.channels.get(20n)!,parentId:999n});const result=await f.inspector.inspect(42n,0n,false);assert.match(result,/status: issues_found/);assert.match(result,/remote_errors: 1/);assert.match(result,/details: 0\/1 \(limit affects display only\)/);assert.deepEqual(f.calls,[10n,21n,20n]);assert.ok(!result.includes('wrong guild'));
}));
it('missing mappings rollouts stale IDs duplicate rooms and project mismatches cannot produce healthy status',async()=>fixture(async f=>{
 let db=new DatabaseSync(f.codex);try{db.exec("UPDATE threads SET rollout_path='/absent';INSERT INTO threads VALUES('new-root','New','/p',2,'/absent',NULL,NULL,0,0,0,'cli','user')");}finally{db.close();}db=new DatabaseSync(f.mirror);try{db.exec("INSERT INTO mirror_threads VALUES('gone','Gone'||char(10)||'line',11,20,'/missing')");}finally{db.close();}
 const result=await f.inspector.inspect(42n,null,false);assert.match(result,/missing_mapping: 1/);assert.match(result,/duplicate_rooms: 1/);assert.match(result,/stale_mappings: 1/);assert.match(result,/missing_rollouts: 3/);assert.match(result,/missing_project_mapping: 1/);assert.match(result,/Gone line/);assert.match(result,/status: issues_found/);
}));
it('missing or over-budget local inventory fails whole inspection before any remote lookup',async()=>fixture(async f=>{
 const absent=f.mirror+'.missing',inspector=new MirrorInspector(f.codex,absent,{channel:async()=>{assert.fail('remote read before local inventory');}},f.locks,9n);await assert.rejects(inspector.inspect(42n,null,false));assert.equal(existsSync(absent),false);
 const db=new DatabaseSync(f.mirror);try{db.prepare("UPDATE mirror_threads SET thread_title=? WHERE codex_thread_id='root'").run('x'.repeat(4*1024*1024));}finally{db.close();}await assert.rejects(f.inspector.inspect(42n,0n,false),/4 MiB transfer budget/);assert.deepEqual(f.calls,[]);
}));
it('lock deadline never cancels or releases another mirror operation owner',async()=>fixture(async f=>{
 const lease=await f.locks.acquire('mirror-sync-operation'),inspect=new MirrorInspector(f.codex,f.mirror,{channel:async()=>{assert.fail('remote call while waiting');}},f.locks,9n,{totalMs:200,lockMs:20});try{await assert.rejects(inspect.inspect(42n,null,false),/phase=lock_wait/);lease.requireTarget('mirror-sync-operation');assert.equal(f.locks.activeTargetCount,1);}finally{lease.release();}
}));
it('caller cancellation joins outstanding remote read before releasing shared operation owner',async()=>fixture(async f=>{
 let entered!:()=>void,finish!:()=>void;const started=new Promise<void>(r=>entered=r),done=new Promise<void>(r=>finish=r);let calls=0;
 const inspector=new MirrorInspector(f.codex,f.mirror,{channel:async()=>{calls++;entered();await done;return null;}},f.locks,9n),controller=new AbortController(),reason=new Error('cancel inspection');const pending=inspector.inspect(42n,null,false,controller.signal),observed=assert.rejects(pending,e=>e===reason);
 try{await started;controller.abort(reason);await new Promise<void>(r=>setImmediate(r));assert.equal(f.locks.tryAcquire('mirror-sync-operation'),undefined);finish();await observed;assert.equal(calls,1);}finally{finish();}
}));
it('unknown guild requires exact origin identity and wrong returned identity remains an error',async()=>fixture(async f=>{
 const calls:bigint[]=[],inspect=new MirrorInspector(f.codex,f.mirror,{channel:async id=>{calls.push(id);return {...f.channels.get(10n)!,id:99n};}},f.locks);await assert.rejects(inspect.inspect(42n,null,false),/response identity differs/);assert.deepEqual(calls,[42n]);
}));
it('pre-abort starts no worker or remote read',async()=>fixture(async f=>{
 const c=new AbortController(),reason=new Error('already cancelled');c.abort(reason);await assert.rejects(f.inspector.inspect(42n,null,false,c.signal),e=>e===reason);assert.equal(mirrorInspectionReaderBusy(),false);assert.deepEqual(f.calls,[]);
}));
it('rollout existence is observed after guild discovery, preserving the source remote-to-filesystem order',async()=>fixture(async f=>{
 const rollout=join(dirname(f.mirror),'rollout.jsonl');unlinkSync(rollout);const inspector=new MirrorInspector(f.codex,f.mirror,{channel:async id=>{if(id===42n){writeFileSync(rollout,'{}');return {id:42n,guildId:9n,parentId:null,kind:0n,name:'origin',archived:false};}return f.channels.get(id)??null;}},f.locks);
 const result=await inspector.inspect(42n,null,false);assert.match(result,/status: ok/);assert.match(result,/missing_rollouts: 0/);
}));
