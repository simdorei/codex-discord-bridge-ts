import test from 'node:test';import assert from 'node:assert/strict';import {existsSync} from 'node:fs';import {join,dirname} from 'node:path';import {setImmediate as tick} from 'node:timers/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {historyPollTargets,boundedHistoryPollTargetsIn} from '../../../src/store/history-targets.ts';
import {readHistoryTargetsOffThread,NativeHistoryTargetError} from '../../../src/runtime/discord-runtime/native-history-targets.ts';
import {ownedWorkerUsage,OwnedWorkerBusyError,OwnedWorkerTimeoutError} from '../../../src/runtime/owned-worker-slot.ts';
const limits={maxRows:100,timeoutMs:5000};
const project=(key:string,value:string,time:number)=>`INSERT INTO mirror_projects(project_key,project_name,discord_channel_id,updated_at)VALUES('${key}','p',${value},${time});`;
const thread=(key:string,value:string,time:number)=>`INSERT INTO mirror_threads(codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at)VALUES('${key}','p','t',1,${value},${time});`;
async function seed(path:string,sql:string){const db=await openInitialized(path);try{db.exec(sql);}finally{db.close();}}
test('native existing-store targets preserve exact source ordering, duplicates and integer range',()=>storeFixture(async path=>{
 await seed(path,project('b','8',5)+project('a','7',5)+project('zero','0',8)+thread('a','9223372036854775807',7)+thread('dup','7',8));const allowed=new Set([3n,2n,0n,(1n<<64n)-1n]);
 const expected=await historyPollTargets(path,allowed,3n),pending=readHistoryTargetsOffThread(path,allowed,3n,limits);assert.equal(ownedWorkerUsage().Background,1);allowed.clear();await tick();const actual=await pending;assert.deepEqual(actual,expected);assert.equal(Object.isFrozen(actual),true);assert.ok(actual.every(Object.isFrozen));assert.equal(ownedWorkerUsage().Background,0);
}));
test('scan budget counts duplicate and zero rows, rejects partial lists, accepts exact boundary',()=>storeFixture(async path=>{
 await seed(path,project('a','1',3)+project('b','1',2)+project('c','0',1)+thread('last','2',1));await assert.rejects(readHistoryTargetsOffThread(path,new Set(),null,{...limits,maxRows:3}),NativeHistoryTargetError);assert.deepEqual(await readHistoryTargetsOffThread(path,new Set(),null,{...limits,maxRows:4}),[{source:'MirrorProject',channelId:1n},{source:'MirrorThread',channelId:2n}]);
}));
test('50 completed targets stop before corrupt trailing rows and bypass absent lower-priority tables',()=>storeFixture(async path=>{
 await seed(path,Array.from({length:50},(_,i)=>project(String(i),String(i+1),100-i)).join('')+project('bad',"'bad'",0));assert.equal((await readHistoryTargetsOffThread(path,new Set(),null,{...limits,maxRows:50})).length,50);
 const db=await openInitialized(path);try{db.exec('DROP TABLE mirror_projects;DROP TABLE mirror_threads');}finally{db.close();}assert.equal((await readHistoryTargetsOffThread(path,new Set(Array.from({length:50},(_,i)=>BigInt(i+1))),null,{...limits,maxRows:1})).length,50);
}));
test('invalid storage classes including large blob fail closed without returning partial targets',()=>storeFixture(async path=>{
 for(const value of ['-1',"'invalid'",'1.5','zeroblob(1048576)']){await seed(path,'DELETE FROM mirror_projects;'+project('bad',value,1));await assert.rejects(readHistoryTargetsOffThread(path,new Set([1n]),null,limits),NativeHistoryTargetError);}
}));
test('borrowed bounded leaf preserves caller transaction and rollback',()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{db.exec('BEGIN');db.exec(project('a','7',1));assert.deepEqual(boundedHistoryPollTargetsIn(db,new Set(),null,1),[{source:'MirrorProject',channelId:7n}]);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');assert.deepEqual(boundedHistoryPollTargetsIn(db,new Set(),null,1),[]);}finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}));
test('missing database and preabort never initialize a new store',()=>storeFixture(async path=>{
 const missing=join(dirname(path),'missing-history.sqlite'),controller=new AbortController(),reason=new Error('stop');controller.abort(reason);await assert.rejects(readHistoryTargetsOffThread(missing,new Set(),null,limits,controller.signal),e=>e===reason);assert.equal(existsSync(missing),false);await assert.rejects(readHistoryTargetsOffThread(missing,new Set(),null,limits),NativeHistoryTargetError);assert.equal(existsSync(missing),false);
}));
test('same-slot overload rejects without queue and timeout retains ownership until exit',()=>storeFixture(async path=>{
 await seed(path,project('a','1',1));const first=readHistoryTargetsOffThread(path,new Set(),null,limits);await assert.rejects(readHistoryTargetsOffThread(path,new Set(),null,limits),OwnedWorkerBusyError);await first;await assert.rejects(readHistoryTargetsOffThread(path,new Set(),null,{...limits,timeoutMs:1}),OwnedWorkerTimeoutError);assert.equal(ownedWorkerUsage().Background,0);assert.equal((await readHistoryTargetsOffThread(path,new Set(),null,limits)).length,1);
}));
test('passive invalid config rejects before native submission with zero getter or proxy calls',()=>storeFixture(async path=>{
 let hooks=0;const proxy=new Proxy(new Set<bigint>(),{get(){hooks++;throw Error('trap');}});await assert.rejects(readHistoryTargetsOffThread(path,proxy,null,limits),TypeError);await assert.rejects(readHistoryTargetsOffThread(path,new Set(),null,{get maxRows(){hooks++;return 1;},timeoutMs:1}),TypeError);await assert.rejects(readHistoryTargetsOffThread(path,new Set(Array.from({length:4097},(_,i)=>BigInt(i))),null,limits),RangeError);assert.equal(hooks,0);assert.equal(ownedWorkerUsage().Background,0);
}));
