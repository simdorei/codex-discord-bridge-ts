import {it} from 'node:test';import assert from 'node:assert/strict';
import {snapshotRuntimeCommand,snapshotActionContext} from '../../../src/runtime/action-executor/command-snapshot.ts';
import type {CommandAction} from '../../../src/runtime/command-plan.ts';
const snapshot=(v:unknown)=>snapshotRuntimeCommand(v as CommandAction);
it('command inventory accepts every source variant with exact bigint fields and explicit nullable options',()=>{
 const all:unknown[]=['Help','Where','Doctor','Approval','Runners','MirrorCheck','QaButtons','RestartCodex','ForceRestartCodex','Identity','Resources','HostReboot'];
 for(const kind of ['List','ArchivedList'])all.push({[kind]:{limit:0xffffffffn}});
 for(const kind of ['Use','DeleteArchivePreview','DeleteArchiveConfirm'])all.push({[kind]:{reference:'한글😀'}});
 for(const kind of ['Status','Retract','Stop','Recover','Repair','Archive','Resume'])all.push({[kind]:{reference:null}});
 for(const kind of ['New','Ask','Interview','Steer'])all.push({[kind]:{prompt:'p'}});
 all.push({Settings:{reference:null,model:null,effort:null,speed:null}},{AutoReserve:{reference:null,enabled:false}},{Context:{all_threads:true,refresh:false,limit:0n}},{Usage:{days:30n}},{SavedRequest:{request_id:'r'}},{DiscardRequest:{job_id:'j'}},{MirrorInspect:{limit:null,list:false}},{BridgeSync:{limit:-(1n<<63n)}},{Open:{reference:'t',abort:true}},{SettingsOptions:{reference:null,field:null}});
 assert.equal(all.length,38);for(const input of all){const out=snapshot(input);assert.deepEqual(out,input);if(typeof out==='object'){assert.notEqual(out,input);assert.ok(Object.isFrozen(out));assert.ok(Object.isFrozen(Object.values(out)[0]));}}
});
it('command rejects extra variants, unknown fields, absent options and lossy numeric replacements',()=>{
 for(const input of [null,[],{},'toString','DiscoverCodex',{toString:{}},{List:{limit:1n},Use:{reference:'t'}},{List:{limit:1}},{List:{limit:-1n}},{List:{limit:1n<<32n}},{BridgeSync:{limit:1n<<63n}},{Status:{}},{Status:{reference:undefined}},{Status:{reference:null,extra:1}},{Settings:{reference:null,model:null,effort:null,x:null}},{Open:{reference:'t',abort:1}},{Ask:{prompt:'\ud800'}}])assert.throws(()=>snapshot(input),TypeError);
});
it('getter and Proxy command descriptions never execute application hooks',()=>{
 let called=0;const get={};Object.defineProperty(get,'Use',{enumerable:true,get(){called++;return {reference:'t'};}});assert.throws(()=>snapshot(get));assert.equal(called,0);
 const proxy=new Proxy({Use:{reference:'t'}},{get(){called++;return null;},ownKeys(){called++;return [];}});assert.throws(()=>snapshot(proxy));assert.equal(called,0);
});
it('actor snapshot isolates exact bigint identity and original queue policy',()=>{
 const input={channelId:9007199254740993n,userId:7n,discordMessageId:null,autoQueueWhenBusy:true};const out=snapshotActionContext(input);input.channelId=1n;assert.equal(out.channelId,9007199254740993n);assert.ok(Object.isFrozen(out));
 for(const bad of [{...input,userId:1},{...input,channelId:1n<<64n},{...input,discordMessageId:-1n},{...input,autoQueueWhenBusy:'true'},{...input,extra:1}])assert.throws(()=>snapshotActionContext(bad as never));
});
