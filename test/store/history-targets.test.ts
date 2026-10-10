import assert from 'node:assert/strict';import {it} from 'node:test';import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';import {historyPollTargets} from '../../src/store/history-targets.ts';
async function seed(path:string,sql:string){const db=await openInitialized(path);try{db.exec(sql);}finally{db.close();}}
const project=(key:string,id:string,time:number)=>`INSERT INTO mirror_projects(project_key,project_name,discord_channel_id,updated_at) VALUES('${key}','p',${id},${time});`;
const thread=(key:string,id:string,time:number)=>`INSERT INTO mirror_threads(codex_thread_id,project_key,thread_title,discord_channel_id,discord_thread_id,updated_at) VALUES('${key}','p','t',1,${id},${time});`;
it('startup and sorted allowed channels win duplicates before project/thread recency',()=>storeFixture(async path=>{
 await seed(path,project('b','8',5)+project('a','7',5)+project('c','3',9)+thread('b','12',5)+thread('a','11',5)+thread('c','7',9));
 const out=await historyPollTargets(path,new Set([4n,3n,0n,2n]),3n);assert.deepEqual(out,[{source:'Startup',channelId:3n},{source:'Allowed',channelId:2n},{source:'Allowed',channelId:4n},{source:'MirrorProject',channelId:7n},{source:'MirrorProject',channelId:8n},{source:'MirrorThread',channelId:11n},{source:'MirrorThread',channelId:12n}]);assert.equal(Object.isFrozen(out),true);assert.equal(out.every(Object.isFrozen),true);
}));
it('50 allowed targets mask corrupt later project and thread rows',()=>storeFixture(async path=>{
 await seed(path,project('bad',"'not-an-id'",1)+thread('bad',"'bad'",1));const out=await historyPollTargets(path,new Set(Array.from({length:60},(_,i)=>BigInt(60-i))),null);assert.equal(out.length,50);assert.deepEqual(out.map(v=>v.channelId),Array.from({length:50},(_,i)=>BigInt(i+1)));
}));
it('lazy project scan stops at 50 unique rows before an invalid later row and threads',()=>storeFixture(async path=>{
 await seed(path,Array.from({length:50},(_,i)=>project(String(i),String(i+1),100-i)).join('')+project('bad',"'invalid'",0)+thread('bad',"'bad'",1));assert.equal((await historyPollTargets(path,new Set(),null)).length,50);
}));
it('zero is skipped, duplicates do not exhaust the cap and i64 max stays exact',()=>storeFixture(async path=>{
 await seed(path,project('b','0',9)+project('c','5',8)+project('d','5',7)+thread('e','9223372036854775807',6));assert.deepEqual((await historyPollTargets(path,new Set(),0n)).map(v=>v.channelId),[5n,(1n<<63n)-1n]);assert.equal((await historyPollTargets(path,new Set([(1n<<64n)-1n]),null))[0]!.channelId,(1n<<64n)-1n);
}));
it('negative, text, floating point and blob reached rows fail closed rather than being skipped',()=>storeFixture(async path=>{
 for(const value of ['-1',"'text'",'1.5',"X'01'"]){await seed(path,'DELETE FROM mirror_projects;'+project('bad',value,1));await assert.rejects(historyPollTargets(path,new Set(),null));}
}));
it('invalid set inputs reject without coercion or proxy traps',()=>storeFixture(async path=>{
 let hooks=0;const proxy=new Proxy(new Set(),{get(){hooks++;throw Error('trap');}});await assert.rejects(historyPollTargets(path,proxy as never,null),TypeError);assert.equal(hooks,0);await assert.rejects(historyPollTargets(path,new Set([-1n]),null),TypeError);await assert.rejects(historyPollTargets(path,new Set(),1n<<64n),TypeError);
}));
