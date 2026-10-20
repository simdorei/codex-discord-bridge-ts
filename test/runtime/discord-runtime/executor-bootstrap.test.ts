import {NativePromptIntakeUnavailableError} from '../../../src/runtime/prompt-intake/native-state.ts';
import {selectJob} from '../../../src/store/queue-read.ts';
import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {join,dirname} from 'node:path';import {existsSync,mkdirSync,symlinkSync,writeFileSync} from 'node:fs';
import {joinRuntimePath} from '../../../src/runtime/runtime-paths/path-text.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';import {startRuntimeFoundation} from '../../../src/runtime/discord-runtime/startup-foundation.ts';import {buildRuntimeCommandExecutor,type RuntimeExecutorBootstrapOptions} from '../../../src/runtime/discord-runtime/executor-bootstrap.ts';import {AdmissionGate} from '../../../src/admission/drain-gate.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';
const render=(e:unknown)=>e instanceof Error?e.message:'opaque';const limits={maxRows:128,maxBytes:1048576};
const script="import readline from'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({id:m.id,result:m.method==='turn/start'?{turn:{id:JSON.stringify(m.params.input)}}:{}})+'\\n');});";
async function fixture(body:(paths:{root:string;stateDb:string;mirrorDb:string;bridgeState:string},owner:Awaited<ReturnType<typeof startRuntimeFoundation>>['owner'])=>Promise<void>,seed?:(path:string)=>Promise<void>){await storeFixture(async mirrorDb=>{
 const root=dirname(mirrorDb),stateDb=join(root,'codex.sqlite'),db=new DatabaseSync(stateDb);db.exec('CREATE TABLE original(value)');db.close();if(seed)await seed(mirrorDb);
 const foundation=await startRuntimeFoundation({stateDb,mirrorDb},{process:{executable:process.execPath,arguments:['--input-type=module','-e',script],environment:{}},clientInfo:{name:'executor-fixture',title:'fixture',version:'1'}},'runtime',null,render,limits);
 try{await body({root,stateDb,mirrorDb,bridgeState:join(root,'bridge.json')},foundation.owner);}finally{await foundation.owner.dispose();}
});}
const options=()=>({render,preparePrompt:async()=>assert.fail('no eligible intake should preprocess'),mirror:null,reportNewAttempt:()=>{},resumeTimeoutMs:1000,historyTimeoutMs:1000,reportPolicyFailure:()=>{},notifyDeliveryReady:()=>{}} satisfies RuntimeExecutorBootstrapOptions);
async function held(path:string){await state.admitPromptIntake(path,{jobId:'held',targetThreadId:'thread',channelId:1n,ownerUserId:2n,discordMessageId:null,rawPrompt:'keep original',autoQueueWhenBusy:true,requireCurrentMirror:false,createdAt:1});const db=await openInitialized(path);try{db.exec("UPDATE codex_prompt_intakes SET claim_token='prior',claim_expires_at=9999999999");}finally{db.close();}}
test('actual foundation and executor bootstrap share one native resident, queue and central action services',async()=>fixture(async(paths,owner)=>{
 const pid=owner.lifecycleSnapshot().processId;let wakes=0;const o=options();o.notifyDeliveryReady=()=>{wakes++;};const result=await buildRuntimeCommandExecutor(paths,owner,new AdmissionGate(),o);
 assert.equal(result.restarted,false);assert.equal(result.queue.dbPath,paths.mirrorDb);assert.equal(result.backend.residentInstanceId(),owner.instanceId);assert.equal(owner.lifecycleSnapshot().processId,pid);assert.deepEqual(result.intakes,{releasedClaims:0n,recovered:0});assert.equal(result.bridge.path(),paths.bridgeState);assert.equal(existsSync(paths.bridgeState),false);
 result.executor.messageServices().notifyDeliveryReady();assert.equal(wakes,1);
}));
test('startup intake release retains retirement execution hold and cannot call preprocessor or start a turn',async()=>fixture(async(paths,owner)=>{
 const result=await buildRuntimeCommandExecutor(paths,owner,new AdmissionGate(),options());assert.deepEqual(result.intakes,{releasedClaims:1n,recovered:0});const saved=await state.getPromptIntake(paths.mirrorDb,'held');assert.equal(saved?.rawPrompt,'keep original');assert.equal(saved?.claimToken,null);assert.notEqual(await state.executionHoldReason(paths.mirrorDb,'held'),null);
},held));
test('all path and function bindings survive caller mutation across queue recovery awaits',async()=>fixture(async(paths,owner)=>{
 const original=paths.bridgeState,o=options();let wakes=0;o.notifyDeliveryReady=()=>{wakes++;};const pending=buildRuntimeCommandExecutor(paths,owner,new AdmissionGate(),o);paths.bridgeState=join(paths.root,'foreign.json');o.notifyDeliveryReady=()=>assert.fail('replaced callback');const result=await pending;
 assert.equal(result.bridge.path(),original);result.queue.notifyDeliveryReady();assert.equal(wakes,1);assert.equal(existsSync(paths.bridgeState),false);
}));
test('intake startup failure returns to caller without silently disposing borrowed resident or granting recovery',async()=>fixture(async(paths,owner)=>{
 const db=await openInitialized(paths.mirrorDb);try{db.exec("CREATE TRIGGER reject_release BEFORE UPDATE OF claim_token ON codex_prompt_intakes BEGIN SELECT RAISE(ABORT,'reject old lease release');END");}finally{db.close();}
 await assert.rejects(state.releaseAllPromptIntakeClaims(paths.mirrorDb),/reject old lease release/);
 await assert.rejects(buildRuntimeCommandExecutor(paths,owner,new AdmissionGate(),options()),e=>e instanceof NativePromptIntakeUnavailableError&&e.operation==='ReleaseAll');assert.equal(owner.lifecycleSnapshot().healthy,true);assert.equal((await state.getPromptIntake(paths.mirrorDb,'held'))?.claimToken,'prior');
},held));
test('missing explicit preprocessing and accessor options reject without callback execution',async()=>fixture(async(paths,owner)=>{
 await assert.rejects(buildRuntimeCommandExecutor(paths,owner,new AdmissionGate(),{...options(),preparePrompt:undefined} as never),TypeError);let hooks=0;const o=options();Object.defineProperty(o,'render',{get(){hooks++;return render;}});await assert.rejects(buildRuntimeCommandExecutor(paths,owner,new AdmissionGate(),o),TypeError);assert.equal(hooks,0);
}));

test('mandatory null timeouts reject before policy installation or any startup recovery writes',async()=>fixture(async(paths,owner)=>{
 await assert.rejects(buildRuntimeCommandExecutor(paths,owner,new AdmissionGate(),{...options(),resumeTimeoutMs:null} as never),RangeError);
 const db=new DatabaseSync(paths.mirrorDb,{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cdr_async_recovery_policies').get()!.n,0);}finally{db.close();}
}));

test('executor sends exact native Pro skill path in the owned claimed turn request',async()=>fixture(async(paths,owner)=>{
 mkdirSync(paths.root+'/physical/child',{recursive:true});symlinkSync(paths.root+'/physical/child',paths.root+'/alias',process.platform==='win32'?'junction':'dir');
 const rawRoot=paths.root+'/alias/..',platform=process.platform==='win32'?'win32':'posix',plugin=joinRuntimePath(rawRoot,'plugins/codex-discord-remote',platform);
 mkdirSync(joinRuntimePath(plugin,'.codex-plugin',platform),{recursive:true});writeFileSync(joinRuntimePath(plugin,'.codex-plugin/plugin.json',platform),'{}');
 const result=await buildRuntimeCommandExecutor({...paths,root:rawRoot},owner,new AdmissionGate(),options());
 const db=await openInitialized(paths.mirrorDb);try{
 db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,execution_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('path-job','T',42,3,1,1,'$ask-chatgpt-pro [@Chrome](plugin://chrome@openai-bundled)',0,1,'starting',1,'[]',1,1)");
 const input=JSON.parse(await result.backend.startClaimedTurn(selectJob(db,'path-job')));
 assert.deepEqual(input[1],{type:'skill',name:'ask-chatgpt-pro',path:joinRuntimePath(plugin,'skills/ask-chatgpt-pro/SKILL.md',platform)});
 }finally{db.close();result.disposeReceivers();}
}));

test('explicit startup recovery executor is installed once and bound to the mirror database',async()=>fixture(async(paths,owner)=>{
 const {AdmittedRecoverExecutor}=await import('../../../src/runtime/action-executor/recover-action.ts');
 const recovery=new AdmittedRecoverExecutor(paths.mirrorDb,paths.root,process.platform==='win32'?'win32':'posix',{inspect:async()=>assert.fail('startup must not inspect'),start:async()=>assert.fail('startup must not restart'),join:async()=>{}});
 const input={...options(),recovery};const pending=buildRuntimeCommandExecutor(paths,owner,new AdmissionGate(),input);
 input.recovery=new AdmittedRecoverExecutor(join(paths.root,'foreign.sqlite'),paths.root,process.platform==='win32'?'win32':'posix',{inspect:async()=>assert.fail(),start:async()=>assert.fail(),join:async()=>{}});
 const result=await pending;
 assert.throws(()=>result.executor.configureRecovery(recovery),/already configured/);
 result.disposeReceivers();
}));
test('wrong-database recovery is rejected before queue recovery writes',async()=>fixture(async(paths,owner)=>{
 const {AdmittedRecoverExecutor}=await import('../../../src/runtime/action-executor/recover-action.ts');
 const recovery=new AdmittedRecoverExecutor(join(paths.root,'foreign.sqlite'),paths.root,process.platform==='win32'?'win32':'posix',{inspect:async()=>assert.fail(),start:async()=>assert.fail(),join:async()=>{}});
 await assert.rejects(buildRuntimeCommandExecutor(paths,owner,new AdmissionGate(),{...options(),recovery}),/database differs/);
 const db=new DatabaseSync(paths.mirrorDb,{readOnly:true});try{assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cdr_async_recovery_policies').get()!.n,0);}finally{db.close();}
}));
test('recovery accessors and forged recovery owners reject before use',async()=>fixture(async(paths,owner)=>{
 let hooks=0;const input={...options()};Object.defineProperty(input,'recovery',{get(){hooks++;throw new Error('active');}});
 await assert.rejects(buildRuntimeCommandExecutor(paths,owner,new AdmissionGate(),input),TypeError);assert.equal(hooks,0);
 await assert.rejects(buildRuntimeCommandExecutor(paths,owner,new AdmissionGate(),{...options(),recovery:{}} as never),TypeError);
}));

test('proxy bootstrap options reject without reflective hooks',async()=>{
 const {captureRuntimeExecutorOptions}=await import('../../../src/runtime/discord-runtime/executor-bootstrap.ts');
 let hooks=0;const proxy=new Proxy(options(),{getOwnPropertyDescriptor(){hooks++;throw new Error('proxy hook');}});
 assert.throws(()=>captureRuntimeExecutorOptions(proxy),TypeError);assert.equal(hooks,0);
});
