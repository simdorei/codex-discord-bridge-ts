import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {dirname,join} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {startRuntimeFoundation} from '../../../src/runtime/discord-runtime/startup-foundation.ts';
import {buildRuntimeCommandExecutor} from '../../../src/runtime/discord-runtime/executor-bootstrap.ts';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';
import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
const render=(e:unknown)=>e instanceof Error?e.message:'opaque';
const script=`import readline from 'node:readline';
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
if(m.method==='model/list'){send({method:'startup/observation',params:{marker:'during-intake'}});send({id:'approval-1',method:'item/commandExecution/requestApproval',params:{threadId:'thread'}});}
send({id:m.id,result:{}});});`;
async function fixture(body:(paths:{root:string;stateDb:string;mirrorDb:string;bridgeState:string},owner:PortableResidentLifecycle)=>Promise<void>){await storeFixture(async mirrorDb=>{
 const root=dirname(mirrorDb),stateDb=join(root,'codex.sqlite'),db=new DatabaseSync(stateDb);db.exec('CREATE TABLE original(value)');db.close();
 const {owner}=await startRuntimeFoundation({stateDb,mirrorDb},{process:{executable:process.execPath,arguments:['--input-type=module','-e',script],environment:{}},clientInfo:{name:'subscriptions',title:'fixture',version:'1'}},'runtime',null,render,{maxRows:128,maxBytes:1048576});
 try{await body({root,stateDb,mirrorDb,bridgeState:join(root,'bridge.json')},owner);}finally{await owner.dispose();}
});}
const options=()=>({render,preparePrompt:async(_raw:string)=>{throw new Error('defer');},mirror:null,reportNewAttempt:()=>{},reportPolicyFailure:()=>{},notifyDeliveryReady:()=>{},resumeTimeoutMs:1000,historyTimeoutMs:1000});

test('startup retains native notifications and approval requests emitted during intake recovery',async()=>fixture(async(paths,owner)=>{
 await state.admitPromptIntake(paths.mirrorDb,{jobId:'intake',targetThreadId:'thread',channelId:1n,ownerUserId:2n,discordMessageId:null,rawPrompt:'original',autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:1});
 const o=options();let prepares=0;o.preparePrompt=async()=>{prepares++;await owner.request('model/list',{},1000,owner.generation());throw new Error('defer fixture preparation');};
 const result=await buildRuntimeCommandExecutor(paths,owner,new AdmissionGate(),o);
 try{
  assert.equal(prepares,1);assert.equal(result.intakes.recovered,0);
  const signal=AbortSignal.timeout(1000),n=await result.completionReceiver.receive(signal),r=await result.serverRequestReceiver.receive(signal);
  assert.equal(n.kind,'Notification');if(n.kind==='Notification'){assert.equal(n.generation,1n);assert.equal(n.notification.method,'startup/observation');assert.deepEqual(n.notification.params,{marker:'during-intake'});}
  assert.equal(r.kind,'Request');if(r.kind==='Request'){assert.equal(r.generation,1n);assert.equal(r.request.id,'approval-1');assert.equal(r.request.method,'item/commandExecution/requestApproval');}
  assert.equal((await state.getPromptIntake(paths.mirrorDb,'intake'))?.rawPrompt,'original');
  assert.equal(owner.pendingServerRequests().length,1); // Reading the stream does not approve/respond.
 }finally{result.disposeReceivers();}
 assert.deepEqual(result.completionReceiver.tryReceive(),{kind:'Closed'});assert.deepEqual(result.serverRequestReceiver.tryReceive(),{kind:'Closed'});result.disposeReceivers();assert.equal(owner.lifecycleSnapshot().healthy,true);
}));

test('failed intake recovery releases both exact subscriptions without closing borrowed resident',async()=>fixture(async(paths,owner)=>{
 const db=await openInitialized(paths.mirrorDb);db.exec("CREATE TRIGGER reject_release BEFORE UPDATE OF claim_token ON codex_prompt_intakes BEGIN SELECT RAISE(ABORT,'release blocked');END");db.close();
 await state.admitPromptIntake(paths.mirrorDb,{jobId:'intake',targetThreadId:'thread',channelId:1n,ownerUserId:2n,discordMessageId:null,rawPrompt:'original',autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:1});
 const p=PortableResidentLifecycle.prototype,originalN=p.subscribeNotifications,originalR=p.subscribeServerRequests;
 const seen:Array<ReturnType<typeof originalN>|ReturnType<typeof originalR>>=[];
 p.subscribeNotifications=function(){const r=originalN.call(this);seen.push(r);return r;};p.subscribeServerRequests=function(){const r=originalR.call(this);seen.push(r);return r;};
 try{await assert.rejects(buildRuntimeCommandExecutor(paths,owner,new AdmissionGate(),options()),/release blocked/);}finally{p.subscribeNotifications=originalN;p.subscribeServerRequests=originalR;}
 assert.equal(seen.length,2);for(const r of seen)assert.deepEqual(r.tryReceive(),{kind:'Closed'});assert.equal(owner.lifecycleSnapshot().healthy,true);
}));

test('second subscription failure disposes first and preserves original error before queue writes',async()=>fixture(async(paths,owner)=>{
 const p=PortableResidentLifecycle.prototype,originalN=p.subscribeNotifications,originalR=p.subscribeServerRequests,primary=new Error('subscribe failed');let captured:ReturnType<typeof originalN>|undefined;
 p.subscribeNotifications=function(){return captured=originalN.call(this);};p.subscribeServerRequests=function(){throw primary;};
 try{await assert.rejects(buildRuntimeCommandExecutor(paths,owner,new AdmissionGate(),options()),e=>e===primary);}finally{p.subscribeNotifications=originalN;p.subscribeServerRequests=originalR;}
 assert.ok(captured);assert.deepEqual(captured.tryReceive(),{kind:'Closed'});assert.equal(owner.lifecycleSnapshot().healthy,true);
 const db=new DatabaseSync(paths.mirrorDb,{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cdr_async_recovery_policies').get()!.n,0);}finally{db.close();}
}));
