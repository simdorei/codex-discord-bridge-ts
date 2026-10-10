import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {readMirrorCreationIn} from '../../../src/store/mirror-creation.ts';
import {mirrorThreadChannels} from '../../../src/store/mirror-mapping.ts';
import {TargetLocks} from '../../../src/core/keyed-locks.ts';
import {NewThreadMirrorLink,newMirrorThreadName,type NewMirrorTransport,type MirrorChannel} from '../../../src/runtime/mirror-sync/new-mirror-link.ts';
const origin:MirrorChannel={id:2n,guildId:1n,parentId:null,kind:0n,name:'project',archived:false};const created:MirrorChannel={id:3n,guildId:1n,parentId:2n,kind:11n,name:'hello',archived:false};
async function fixture(run:(path:string,db:DatabaseSync)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{await run(path,db);}finally{db.close();}});}
function remote(overrides:Partial<NewMirrorTransport>={}):NewMirrorTransport {return {channel:async id=>id===2n?origin:null,createThread:async()=>created,updateThread:async()=>{},...overrides};}
const pause=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
test('new linker creates one room, commits mapping, and consumes durable creation without global cleanup',async()=>fixture(async(path,db)=>{
 db.exec("INSERT INTO mirror_projects VALUES('/project','p',2,1)");const calls:string[]=[];const link=new NewThreadMirrorLink(path,remote({channel:async id=>{calls.push(`read:${id}`);return id===2n?origin:created;},createThread:async(g,p,n)=>{calls.push(`create:${g}:${p}:${n}`);assert.equal(readMirrorCreationIn(db,'thread')?.phase,'attempted');return created;}}),new TargetLocks(),1n,()=>1);
 assert.equal(await link.linkNewThread(2n,'thread','hello','/project'),3n);assert.deepEqual(calls,['read:2','create:1:2:hello']);assert.equal(readMirrorCreationIn(db,'thread'),null);assert.deepEqual(await mirrorThreadChannels(path,'thread'),[2n,3n]);
 calls.length=0;assert.equal(await link.linkNewThread(2n,'thread','hello','/project'),3n);assert.deepEqual(calls,['read:2','read:3']);
}));
test('unknown remote outcome retains attempt and repeat cannot issue a second create',async()=>fixture(async(path,db)=>{
 let creates=0;const failure=new Error('unknown response'),link=new NewThreadMirrorLink(path,remote({createThread:async()=>{creates++;throw failure;}}),new TargetLocks());await assert.rejects(link.linkNewThread(2n,'thread','hello','/project'),e=>e===failure);assert.equal(readMirrorCreationIn(db,'thread')?.phase,'attempted');await assert.rejects(link.linkNewThread(2n,'thread','hello','/project'),/outcome is unknown/);assert.equal(creates,1);assert.equal(await mirrorThreadChannels(path,'thread'),null);
}));
test('mapping failure retains known room and retry reads exact confirmation instead of recreating',async()=>fixture(async(path,db)=>{
 let creates=0;db.exec("CREATE TRIGGER reject_attach BEFORE INSERT ON mirror_threads BEGIN SELECT RAISE(ABORT,'fixture mapping rejected'); END");const link=new NewThreadMirrorLink(path,remote({channel:async id=>id===2n?origin:created,createThread:async()=>{creates++;return created;}}),new TargetLocks());await assert.rejects(link.linkNewThread(2n,'thread','hello','/project'),/fixture mapping rejected/);assert.equal(readMirrorCreationIn(db,'thread')?.channel,3n);db.exec('DROP TRIGGER reject_attach');assert.equal(await link.linkNewThread(2n,'thread','hello','/project'),3n);assert.equal(creates,1);
}));
test('confirmed room disappears or changes identity and no substitute is created',async()=>fixture(async(path,db)=>{
 db.exec("INSERT INTO cdr_mirror_thread_creations VALUES('thread','token',1,2,NULL,NULL,'confirmed',3)");let creates=0;const base={createThread:async()=>{creates++;return created;}};let link=new NewThreadMirrorLink(path,remote(base),new TargetLocks());await assert.rejects(link.linkNewThread(2n,'thread','hello','/project'),/unavailable; creation will not be repeated/);link=new NewThreadMirrorLink(path,remote({...base,channel:async id=>id===2n?origin:{...created,id:4n}}),new TargetLocks());await assert.rejects(link.linkNewThread(2n,'thread','hello','/project'),/response identity changed/);assert.equal(creates,0);
}));
test('wrong guild, parent or room kind fails before confirmation and preserves unknown custody',async()=>fixture(async(path,db)=>{
 for(const [thread,response] of [['g',{...created,guildId:9n}],['p',{...created,parentId:9n}],['k',{...created,kind:12n}]] as const){const link=new NewThreadMirrorLink(path,remote({createThread:async()=>response}),new TargetLocks());await assert.rejects(link.linkNewThread(2n,thread,'hello','/project'),/wrong guild, kind, or parent/);assert.equal(readMirrorCreationIn(db,thread)?.phase,'attempted');}
}));
test('origin and frozen project constraints stop remote creation before attempt',async()=>fixture(async(path,db)=>{
 let creates=0;const transport=remote({createThread:async()=>{creates++;return created;}});await assert.rejects(new NewThreadMirrorLink(path,transport,new TargetLocks(),9n).linkNewThread(2n,'thread','hello','/project'),/wrong guild/);
 db.exec("INSERT INTO mirror_projects VALUES('/other','p',2,1)");await assert.rejects(new NewThreadMirrorLink(path,transport,new TargetLocks()).linkNewThread(2n,'thread','hello','/project'),/project changed/);assert.equal(creates,0);assert.equal(readMirrorCreationIn(db,'thread'),null);
}));
test('thread origin selects its parent; existing archived room updates without creating',async()=>fixture(async(path,db)=>{
 db.exec("INSERT INTO mirror_threads VALUES('thread','p','old',2,3,1)");const calls:string[]=[];const link=new NewThreadMirrorLink(path,remote({channel:async id=>id===8n?{...created,id:8n}:{...created,archived:true,name:'old'},createThread:async()=>{throw new Error('must not create');},updateThread:async(c,n)=>{calls.push(`${c.id}:${n}`);}}),new TargetLocks());assert.equal(await link.linkNewThread(8n,'thread','hello','/project'),3n);assert.deepEqual(calls,['3:hello']);
}));
test('cancellation joins uncooperative remote create, retains known return, and then releases shared lock',async()=>fixture(async(path,db)=>{
 const entered=pause(),release=pause(),locks=new TargetLocks(),abort=new AbortController(),reason=new Error('shutdown');const link=new NewThreadMirrorLink(path,remote({createThread:async()=>{entered.resolve();await release.promise;return created;}}),locks);const work=link.linkNewThread(2n,'thread','hello','/project',abort.signal),rejected=assert.rejects(work,e=>e===reason);await entered.promise;abort.abort(reason);assert.equal(locks.activeTargetCount,1);assert.equal(readMirrorCreationIn(db,'thread')?.phase,'attempted');release.resolve();await rejected;assert.equal(locks.activeTargetCount,0);assert.equal(readMirrorCreationIn(db,'thread')?.channel,3n);assert.equal(await mirrorThreadChannels(path,'thread'),null);
}));
test('cancelled lock waiter sends nothing and never releases current owner',async()=>fixture(async(path)=>{
 const locks=new TargetLocks(),owner=await locks.acquire('mirror-sync-operation');let calls=0;const abort=new AbortController(),reason=new Error('cancel waiter'),link=new NewThreadMirrorLink(path,remote({channel:async()=>{calls++;return origin;}}),locks);const work=link.linkNewThread(2n,'thread','hello','/project',abort.signal),rejected=assert.rejects(work,e=>e===reason);abort.abort(reason);await rejected;assert.equal(calls,0);assert.equal(locks.activeTargetCount,1);owner.release();assert.equal(locks.activeTargetCount,0);
}));
test('thread names preserve Rust whitespace and UTF16 boundaries',()=>{
 assert.equal(newMirrorThreadName(' \u0085hello\nworld ','abcdef'),'hello world');assert.equal(newMirrorThreadName('\u0085','😀abcdefgh'),'codex-😀abcdefg');assert.equal(newMirrorThreadName('\ufeff','id'),'\ufeff');assert.equal(newMirrorThreadName('a'.repeat(89)+'😀','id'),'a'.repeat(89));assert.equal(newMirrorThreadName('😀'.repeat(46),'id'),'😀'.repeat(45));
});
