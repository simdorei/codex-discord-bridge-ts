import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,readFileSync} from 'node:fs';
import {PortableAppServerSession} from '../../src/app-server/portable-session.ts';
import {ownedRequestFailure,type OwnedAsyncRequestHooks} from '../../src/app-server/request-client.ts';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {createMutationCustodyFence} from '../../src/runtime/mutation-custody-fence.ts';
import {NativeMutationOwner,type NativeMutationReceipt} from '../../src/runtime/native-mutation-owner.ts';
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}
async function session(log:string){
 const code=`import readline from 'node:readline';import {appendFileSync} from 'node:fs';const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='initialized')return;if(m.method!=='initialize')appendFileSync(${JSON.stringify(log)},JSON.stringify(m)+'\\n');emit({id:m.id,result:m.method==='initialize'?{}:'reply'});});`;
 return (await PortableAppServerSession.startObserved({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'fixture',title:'Fixture',version:'1'}},()=>({value:null,dispose(){}}),()=> 'safe')).session;
}
function hooks<T>(value:T):OwnedAsyncRequestHooks<T>{return {check:async()=>value,validate(){},dispose:async()=>{},writeStarted(){},writeComplete(){}};}
function frames(log:string){return existsSync(log)?readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];}
test('actual native session retains exact receipt through validation, wire and response',async()=>storeFixture(async path=>{
 const log=path+'.frames',s=await session(log),p=s.residentClient(),permit=p.admitOperation(),wait=deferred<object>(),entered=deferred<void>(),value={},events:string[]=[];
 const h=hooks(value);h.check=()=>{events.push('check');entered.resolve();return wait.promise;};h.validate=v=>{assert.equal(v,value);events.push('validate');};h.writeStarted=()=>{events.push('started');};h.writeComplete=v=>{assert.equal(v,value);events.push('complete');};
 try{assert.equal(typeof p.requestAdmittedWithOwnedPreflight,'function');const request=p.requestAdmittedWithOwnedPreflight!(permit,'thread/settings/update',{threadId:'T'},5000,h);await entered.promise;assert.deepEqual(frames(log),[]);wait.resolve(value);assert.equal(await request,'reply');assert.deepEqual(events,['check','validate','started','complete']);assert.equal(frames(log).length,1);}finally{permit.release();await s.dispose();}
}));
test('foreign actual-session permit is rejected before any native preflight',async()=>storeFixture(async path=>{
 const a=await session(path+'.a'),b=await session(path+'.b'),pa=a.residentClient(),pb=b.residentClient(),permit=pa.admitOperation();let checks=0;const h=hooks({});h.check=async()=>{checks++;return {};};
 try{await assert.rejects(pb.requestAdmittedWithOwnedPreflight!(permit,'thread/settings/update',{},5000,h),/owned client permit/);assert.equal(checks,0);assert.deepEqual(frames(path+'.b'),[]);}finally{permit.release();await a.dispose();await b.dispose();}
}));
test('native session sealing during wait refuses late wire and joins exact disposal',async()=>storeFixture(async path=>{
 const log=path+'.frames',s=await session(log),p=s.residentClient(),permit=p.admitOperation(),wait=deferred<object>(),entered=deferred<void>(),cleanup=deferred<void>(),disposed=deferred<void>(),value={};let settled=false;
 const h=hooks(value);h.check=()=>{entered.resolve();return wait.promise;};h.dispose=async v=>{assert.equal(v,value);disposed.resolve();await cleanup.promise;};
 try{const task=p.requestAdmittedWithOwnedPreflight!(permit,'thread/settings/update',{},5000,h);void task.then(()=>{settled=true;},()=>{settled=true;});const rejected=assert.rejects(task,/closed/);await entered.promise;p.sealAdmissions();wait.resolve(value);await disposed.promise;assert.equal(settled,false);cleanup.resolve();await rejected;assert.deepEqual(frames(log),[]);}finally{permit.release();await s.dispose();}
}));
test('actual native session deadline expiry never sends a late mutation frame',async()=>storeFixture(async path=>{
 const log=path+'.frames',s=await session(log),p=s.residentClient(),permit=p.admitOperation(),wait=deferred<object>(),entered=deferred<void>();let disposed=0;const h=hooks({});h.check=()=>{entered.resolve();return wait.promise;};h.dispose=async()=>{disposed++;};
 try{const task=p.requestAdmittedWithOwnedPreflight!(permit,'thread/settings/update',{},50,h),rejected=assert.rejects(task,e=>ownedRequestFailure(e)?.kind==='Timeout');await entered.promise;await new Promise(r=>setTimeout(r,80));wait.resolve({});await rejected;assert.equal(disposed,1);assert.deepEqual(frames(log),[]);}finally{permit.release();await s.dispose();}
}));
test('actual session and native DB claim bind the same wire and commit only observed reply',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime')");const origin=createMutationCustodyFence(path,'runtime',()=> 'safe').requestOrigin('thread/settings/update',{threadId:'T'});
 const log=path+'.frames',s=await session(log),p=s.residentClient(),permit=p.admitOperation(),owner=new NativeMutationOwner(path,'runtime',x=>x);let written=false,receipt:NativeMutationReceipt|undefined;
 const h:OwnedAsyncRequestHooks<NativeMutationReceipt>={check:wire=>owner.begin({ownerId:'original',generation:1n,attemptId:'original-attempt',wire,method:'thread/settings/update',params:{threadId:'T'},scoped:true,origin}),validate(){p.requireOwnedAdmission(permit);},dispose:async r=>{if(!written)await owner.finish(r,'not_sent');},writeStarted(){written=true;},writeComplete(r){receipt=r;}};
 try{assert.equal(await p.requestAdmittedWithOwnedPreflight!(permit,'thread/settings/update',{threadId:'T'},5000,h),'reply');assert.equal(written,true);assert.ok(receipt);assert.equal(db.prepare('SELECT state FROM codex_mutation_attempts').get()!.state,'prepared');await owner.finish(receipt,'reply_ok');const row=db.prepare('SELECT wire_id,state FROM codex_mutation_attempts').get()!;assert.equal(row.wire_id,JSON.stringify(frames(log)[0].id));assert.equal(row.state,'reply_ok');}finally{await owner.close();permit.release();await s.dispose();db.close();}
}));
