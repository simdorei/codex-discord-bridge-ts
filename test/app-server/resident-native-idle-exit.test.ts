import test from 'node:test';import assert from 'node:assert/strict';import {setTimeout as delay} from 'node:timers/promises';
import {PortableResidentLifecycle} from '../../src/app-server/portable-resident-lifecycle.ts';import {PortableAppServerSession} from '../../src/app-server/portable-session.ts';
import {pinResidentNativeIdle,type ResidentNativeIdle} from '../../src/app-server/resident-native-idle.ts';
import {initializeRuntimeCustody} from '../../src/runtime/runtime-custody.ts';import {installRuntimeIdleJournal} from '../../src/runtime/idle-release-journal.ts';import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';import {storeFixture} from '../helpers/store-fixture.ts';
const code="import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:{}})+'\\n');});";
const config={process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'exit-contract',title:'Fixture',version:'1'}};
const base=()=>({before:async()=>null,transition:async()=>{throw new Error('unused');},close:async()=>{}});
async function fixture(run:(owner:PortableResidentLifecycle,events:string[])=>Promise<void>,native:(events:string[])=>ResidentNativeIdle,exit?:(owner:string,generation:bigint)=>void){await storeFixture(async path=>{
 const events:string[]=[],custody=await initializeRuntimeCustody(path,'runtime',null,()=> 'safe');const owner=await PortableResidentLifecycle.start(config,()=> 'safe',{persistDeadWork:custody.persistDeadWork,oldChildExited(id,g){events.push('legacy');exit?.(id,g);}},undefined,{fence:custody.fence,renderError:()=> 'safe',nativeIdle:native(events)});
 installRuntimeIdleJournal(owner,path,()=> 'safe');try{await run(owner,events);}finally{await owner.dispose();}
});}
test('optional capability is pinned; own-data Promise/void contract is enforced',async()=>{
 const source={...base(),settleExitedOwner:async()=>{}},pinned=pinResidentNativeIdle(source);source.settleExitedOwner=async()=>{throw new Error('mutated');};await pinned.settleExitedOwner!('owner',1n);assert.equal(pinResidentNativeIdle(base()).settleExitedOwner,undefined);
 assert.throws(()=>pinResidentNativeIdle({...base(),get settleExitedOwner(){throw new Error('must not invoke accessor');}} as any),/own native idle/);
 await assert.rejects(pinResidentNativeIdle({...base(),settleExitedOwner:(()=>undefined) as any}).settleExitedOwner!('owner',1n),/Promise/);
 await assert.rejects(pinResidentNativeIdle({...base(),settleExitedOwner:(async()=>true) as any}).settleExitedOwner!('owner',1n),/void/);
 await assert.rejects(PortableResidentLifecycle.start(config,()=> 'safe',{persistDeadWork(){},oldChildExited:async()=>{}}),/synchronous/);
});
test('native settlement replaces journal fallback and closes only after original settlement',async t=>{
 let fallback=0;t.mock.method(state,'settleExitedIdleOwnerExisting',()=>{fallback++;});await fixture(async(owner,events)=>{await owner.close();assert.deepEqual(events,['legacy','settle','close']);assert.equal(fallback,0);await owner.close();await owner.dispose();assert.deepEqual(events,['legacy','settle','close']);},events=>({...base(),settleExitedOwner:async()=>{events.push('settle');},close:async()=>{events.push('close');}}));
});
test('missing explicit native settlement preserves synchronous fallback ordered after legacy',async t=>{
 let events:string[]=[];t.mock.method(state,'settleExitedIdleOwnerExisting',()=>{events.push('fallback');});await fixture(async(owner,list)=>{events=list;await owner.close();assert.deepEqual(events,['legacy','fallback','close']);},list=>({...base(),close:async()=>{list.push('close');}}));
});
test('failed settlement retains open owner and exact generation for explicit terminal retry',async()=>{
 let calls=0,closed=false;const expected:{owner:string;generation:bigint}[]=[];await fixture(async(owner,events)=>{await assert.rejects(owner.close(),/lost acknowledgement/);assert.equal(closed,false);assert.equal(owner.generation(),1n);assert.throws(()=>owner.admitRequest(),/closed/);await owner.close();assert.equal(closed,true);assert.deepEqual(expected,[{owner:owner.instanceId,generation:1n},{owner:owner.instanceId,generation:1n}]);assert.deepEqual(events,['legacy','settle','legacy','settle','close']);await owner.close();assert.equal(calls,2);},events=>({...base(),settleExitedOwner:async(owner,generation)=>{assert.equal(closed,false);events.push('settle');expected.push({owner,generation});if(++calls===1)throw new Error('lost acknowledgement');},close:async()=>{closed=true;events.push('close');}}));
});
test('confirmed exact settlement is cached across later native close failure',async()=>{
 let closes=0,settles=0,closed=false;await fixture(async(owner,events)=>{await assert.rejects(owner.close(),/close failure/);await owner.close();await owner.close();assert.equal(settles,1);assert.deepEqual(events,['legacy','settle','close','close']);},events=>({...base(),settleExitedOwner:async()=>{assert.equal(closed,false);settles++;events.push('settle');},close:async()=>{closed=true;events.push('close');if(++closes===1)throw new Error('close failure');}}));
});
test('unconfirmed process exit never grants close success or invokes settlement',async t=>{
 await fixture(async(owner,events)=>{const mock=t.mock.getter(PortableAppServerSession.prototype,'processExitConfirmed',()=>false);await assert.rejects(owner.close(),/exact owned child exit/);assert.deepEqual(events,[]);assert.throws(()=>owner.admitRequest(),/closed/);mock.mock.restore();await owner.close();assert.deepEqual(events,['legacy','settle','close']);},events=>({...base(),settleExitedOwner:async()=>{events.push('settle');},close:async()=>{events.push('close');}}));
});
test('supervisor queued behind failed explicit settlement cannot replay; only explicit retry advances',async()=>{
 let reject!:()=>void,started!:()=>void,calls=0;const began=new Promise<void>(r=>{started=r;}),held=new Promise<void>((_r,j)=>{reject=()=>j(new Error('unconfirmed'));});
 await fixture(async(owner)=>{const first=owner.forceRestartIfQuiescent(),failed=assert.rejects(first,/unconfirmed/);await began;const stop=new AbortController(),supervisor=owner.runRestartSupervisor(stop.signal,()=>{});try{await delay(20);reject();await failed;await delay(600);assert.equal(calls,1);assert.equal(owner.generation(),1n);assert.equal(await owner.restartIfQuiescent(),true);assert.equal(calls,2);assert.equal(owner.generation(),2n);}finally{stop.abort();await supervisor;}},()=>({...base(),settleExitedOwner:async()=>{if(++calls===1){started();await held;}}}));
});
test('caller abort after settlement starts is observed only after cleanup and confirmed result is cached',async()=>{
 let release!:()=>void,started!:()=>void,calls=0;const held=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{started=r;});await fixture(async owner=>{const controller=new AbortController(),pending=owner.forceRestartIfQuiescent(controller.signal);let done=false;const result=pending.then(()=>{done=true;return null;},e=>{done=true;return e;});await began;controller.abort(new Error('caller aborted'));await delay(20);assert.equal(done,false);release();assert.match((await result as Error).message,/caller aborted/);assert.equal(owner.generation(),1n);assert.equal(await owner.restartIfQuiescent(),true);assert.equal(calls,1);},()=>({...base(),settleExitedOwner:async()=>{calls++;started();await held;}}));
});
