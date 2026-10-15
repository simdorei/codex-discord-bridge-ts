import {createNativeQueueReadState} from '../../../src/runtime/queue-runner/native-read-state.ts';
import {type AdmissionReads} from '../../../src/runtime/action-executor/admission-read-state.ts';
import {createNativePromptIntakeState} from '../../../src/runtime/prompt-intake/native-state.ts';
import assert from 'node:assert/strict';import {it} from 'node:test';import {join,dirname} from 'node:path';import {readFile,readdir,mkdir,writeFile,symlink} from 'node:fs/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {BridgeState} from '../../../src/runtime/bridge-state.ts';import {TargetLocks} from '../../../src/core/keyed-locks.ts';import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';import {createMutationCustodyFence} from '../../../src/runtime/mutation-custody-fence.ts';import {AdmittedRepairExecutor,REPAIR_INIT,REPAIR_PROBE} from '../../../src/runtime/action-executor/repair-action.ts';
import {installRuntimeIdleJournal} from '../../../src/runtime/idle-release-journal.ts';
import {AdmittedStopExecutor} from '../../../src/runtime/action-executor/stop-custody.ts';
import {StopActionExecutor} from '../../../src/runtime/action-executor/stop-action.ts';
const actor={channelId:1n,userId:2n,discordMessageId:3n},render=(e:unknown)=>e instanceof Error?e.message:'fixture error';
async function fixture(mode:string,run:(f:{path:string;bridge:BridgeState;locks:TargetLocks;server:PortableResidentLifecycle;action:AdmittedRepairExecutor;sql:(s:string)=>Promise<void>;raw:(method:string)=>Promise<any>;admit:(event:bigint)=>Promise<void>;receipt:()=>Promise<any>;replacement:()=>Promise<PortableResidentLifecycle>;admission:AdmissionReads})=>Promise<void>){await storeFixture(async path=>{
 if(mode==='native-path'){const root=dirname(path);await mkdir(root+'/physical/child',{recursive:true});await symlink(root+'/physical/child',root+'/alias','dir');path=root+'/alias/../store.sqlite';}
 const bridge=new BridgeState(join(dirname(path),'bridge.json')),locks=new TargetLocks();bridge.setSelectedThreadId('T');
 const sql=async(s:string)=>{const db=await openInitialized(path);try{db.exec(s);}finally{db.close();}};
 const admit=async(event:bigint)=>{await state.admitIngress(path,{ingressId:'message:'+event,kind:'message',eventId:event,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:event,targetThreadId:'T',canonicalOwner:null,now:Number(event),payload:{version:1n,plan:{Execute:{Repair:{reference:null}}},lifecycle_binding:{target:'T',route:'Selected',command:{Repair:{reference:null}}},stop_origin:{target:'T',stopRevision:0n}}});await sql("UPDATE discord_ingress_journal SET state='executing',phase='processing' WHERE ingress_id='message:"+event+"'");};
 await admit(3n);await sql("INSERT INTO codex_mutation_runtime VALUES(1,'runtime');INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");
 const code=`import readline from 'node:readline';const mode=${JSON.stringify(mode)},seen=[];let held=null,inventory=null;const text=t=>({content:[{type:'text',text:t}]}),emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l),reply=x=>emit({id:m.id,result:x});if(m.method==='initialize'){reply({});return;}if(m.method==='initialized')return;if(m.method==='seen'){reply(seen);return;}if(m.method==='release'){inventory?.();held?.();reply(true);return;}seen.push({method:m.method,params:m.params});if(m.method==='thread/read')reply({thread:{id:mode==='wrong-id'?'other':m.params.threadId,status:{type:mode==='busy'?'active':'idle'},fixtureSession:'protected-other'}});else if(m.method==='mcpServerStatus/list'){const out=()=>reply({data:mode==='missing'||mode==='pages'?[]:[{name:'node_repl',runtimeStatus:'connected',tools:{js:{name:'js'},js_reset:{name:'js_reset'}}}],nextCursor:mode==='pages'?'more':null});if(mode==='gate-inventory')inventory=out;else out();}else if(m.method==='mcpServer/tool/call'){const stage=m.params.tool==='js_reset'?'reset':m.params.arguments.code.includes('cdrRepair')?'probe':'initialize';if(stage==='reset'&&(mode==='timeout'||mode==='late-reset')){held=()=>reply(text('js kernel reset'));return;}if(mode===stage+'-remote'){emit({id:m.id,error:{code:-32001,message:'definite failure'}});return;}if(mode===stage+'-error'){reply({isError:true,content:[{type:'text',text:'native pipe fixture'}]});return;}if(mode===stage+'-malformed'){reply({isError:'false',content:[]});return;}if(mode===stage+'-no-content'){reply({});return;}if(stage==='reset')reply(text(mode==='reset-format'?'different':'js kernel reset'));else if(stage==='initialize')reply({content:[]});else reply(text(mode==='probe-format'?'{"cdrRepair":"ready","apps":-1}':'{"cdrRepair":"ready","apps":0}'));}else reply({});});`;
 const start=async()=>PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'repair',title:'fixture',version:'1'}},render,{persistDeadWork(){},oldChildExited(){}},undefined,{renderError:render,fence:createMutationCustodyFence(path,'runtime',render)});
 const server=await start(),replacements:PortableResidentLifecycle[]=[],admission=createNativePromptIntakeState(path);
 installRuntimeIdleJournal(server,path,render);
 const replacement=async()=>{const native=await start();replacements.push(native);installRuntimeIdleJournal(native,path,render);return native;};
 const raw=async(method:string)=>{const a=server.admitResponse(server.generation());try{return await a.client.requestAdmitted(a.permit,method,{},1000);}finally{a.release();}};
 const receipt=async()=>{const folder=join(dirname(path),'maintenance_backups','tool-repair'),files=await readdir(folder);assert.equal(files.length,1);return JSON.parse(await readFile(join(folder,files[0]!),'utf8'));};
 try{await run({path,bridge,locks,server,sql,raw,admit,receipt,replacement,admission,action:new AdmittedRepairExecutor(path,bridge,server,locks,render,{totalMs:25000,callMs:250,lockMs:100},{listFiltered:createNativeQueueReadState(path).listFiltered,listPromptIntakes:admission.listPromptIntakes},undefined,admission)});}finally{const results=await Promise.allSettled([server,...replacements].map(native=>native.dispose()));for(const result of results)if(result.status==='rejected')throw result.reason;}
});}
async function waitFor(f:{raw:(m:string)=>Promise<any>},method:string):Promise<void>{for(let i=0;i<200;i++){if((await f.raw('seen')).some((v:any)=>v.method===method))return;await new Promise(r=>setTimeout(r,5));}throw Error('fixture did not observe '+method);}
it('native preflight: admitted repair performs exact reset/init/probe once without turn start, restart or other-target effects',async()=>fixture('ready',async f=>{
 const generation=f.server.generation(),result=await f.action.execute(actor,null,'message:3');assert.match(result.text,/도구 복구 완료/);assert.equal(f.server.generation(),generation);const seen=await f.raw('seen');assert.deepEqual(seen.map((v:any)=>v.method),['thread/read','mcpServerStatus/list','mcpServer/tool/call','mcpServer/tool/call','mcpServer/tool/call']);assert.ok(seen.every((v:any)=>v.params.threadId==='T'));assert.equal(seen[2].params.tool,'js_reset');assert.equal(seen[3].params.arguments.code,REPAIR_INIT);assert.equal(seen[4].params.arguments.code,REPAIR_PROBE);assert.equal(f.locks.activeTargetCount,0);assert.equal((await f.receipt()).phase,'verified');
 const cold=new AdmittedRepairExecutor(f.path,f.bridge,f.server,new TargetLocks(),render,undefined,undefined,undefined,f.admission);await assert.rejects(cold.execute(actor,null,'message:3'),/envelope differs/);assert.equal((await f.raw('seen')).length,5);
}));
it('native preflight: busy, foreign identity and unsupported inventory never reset; inventory stops at four pages',async()=>{
 for(const mode of ['busy','wrong-id','missing','pages'])await fixture(mode,async f=>{await assert.rejects(f.action.execute(actor,null,'message:3'));const seen=await f.raw('seen');assert.equal(seen.filter((v:any)=>v.method==='mcpServer/tool/call').length,0);assert.equal(seen.filter((v:any)=>v.method==='mcpServerStatus/list').length,mode==='pages'?4:mode==='missing'?1:0);assert.equal(f.locks.activeTargetCount,0);});
});
it('native preflight: definite stage failures retain correct receipt and never continue to a later effect',async()=>{
 for(const [mode,stage,count] of [['reset-error','reset',1],['reset-format','reset',1],['reset-remote','reset',1],['initialize-malformed','initialize',2],['initialize-no-content','initialize',2],['initialize-error','initialize',2],['probe-error','probe',3],['probe-format','probe',3]] as const)await fixture(mode,async f=>{
  await assert.rejects(f.action.execute(actor,null,'message:3'),new RegExp(stage));const saved=await f.receipt();assert.equal(saved.stage,stage);assert.equal(saved.phase,'failed');assert.equal(saved.app_restarted,false);assert.equal((await f.raw('seen')).filter((v:any)=>v.method==='mcpServer/tool/call').length,count);assert.equal(f.locks.activeTargetCount,0);
 });
});
it('native preflight: queued original is preserved and prevents even repair preflight RPC',async()=>fixture('ready',async f=>{
 await f.sql("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('j','T',1,2,1,'p',1,1,'pending',0,'[]',1,1)");const before=await state.listQueueJobs(f.path);await assert.rejects(f.action.execute(actor,null,'message:3'),/진행 중/);assert.deepEqual(await state.listQueueJobs(f.path),before);assert.deepEqual(await f.raw('seen'),[]);
}));
it('native preflight: busy lock deadline never releases another owner; archive arriving during lock wait blocks reset',async()=>{
 await fixture('ready',async f=>{const lease=await f.locks.acquire('T');try{await assert.rejects(f.action.execute(actor,null,'message:3'),/진행 중/);lease.requireTarget('T');assert.deepEqual(await f.raw('seen'),[]);}finally{lease.release();}});
 await fixture('ready',async f=>{const lease=await f.locks.acquire('T'),pending=f.action.execute(actor,null,'message:3'),failure=assert.rejects(pending,/archive fence/);try{await new Promise(r=>setTimeout(r,20));await f.sql("INSERT INTO codex_archive_fences VALUES('T','archive',NULL,'attempted')");}finally{lease.release();}await failure;assert.deepEqual(await f.raw('seen'),[]);assert.equal(await state.archiveTargetFenced(f.path,'T'),true);});
});
it('native preflight: selection drift during inventory wait refuses reset and preserves claimed original',async()=>fixture('gate-inventory',async f=>{
 const pending=f.action.execute(actor,null,'message:3'),failure=assert.rejects(pending,/target changed/);await waitFor(f,'mcpServerStatus/list');f.bridge.setSelectedThreadId('other');await f.raw('release');await failure;assert.equal((await f.raw('seen')).filter((v:any)=>v.method==='mcpServer/tool/call').length,0);assert.equal(f.locks.activeTargetCount,0);assert.equal((await state.getIngress(f.path,'message:3'))!.phase,'recovery_claimed');
}));
it('native preflight: receipt creation failure cannot send the first reset or overwrite blocking evidence',async()=>fixture('ready',async f=>{
 const folder=join(dirname(f.path),'maintenance_backups');await mkdir(folder);await writeFile(join(folder,'tool-repair'),'preserved');await assert.rejects(f.action.execute(actor,null,'message:3'));assert.equal(await readFile(join(folder,'tool-repair'),'utf8'),'preserved');assert.equal((await f.raw('seen')).filter((v:any)=>v.method==='mcpServer/tool/call').length,0);assert.equal(f.locks.activeTargetCount,0);
}));
it('native preflight: flushed timeout holds only original target and cold coordinator cannot resend unknown reset',async()=>fixture('timeout',async f=>{
 await assert.rejects(f.action.execute(actor,null,'message:3'),/reset/);assert.equal((await f.receipt()).phase,'outcome_unknown');assert.equal(f.locks.tryAcquire('T'),undefined);const other=f.locks.tryAcquire('other')!;other.release();assert.equal(f.server.lifecycleSnapshot().quarantined,false);
 const value:any=await f.server.request('thread/read',{threadId:'other'},1000,f.server.generation());assert.equal(value.thread.fixtureSession,'protected-other');await f.admit(4n);const cold=new AdmittedRepairExecutor(f.path,f.bridge,f.server,new TargetLocks(),render,{totalMs:1000,callMs:250,lockMs:100},undefined,undefined,f.admission);await assert.rejects(cold.execute({...actor,discordMessageId:4n},null,'message:4'));assert.equal((await f.raw('seen')).filter((v:any)=>v.params.tool==='js_reset').length,1);assert.equal((await f.receipt()).phase,'outcome_unknown');
}));
it('native preflight: cancel after reset flush and late reply do not clear durable mutation hold or claim',async()=>fixture('late-reset',async f=>{
 const c=new AbortController(),reason=new Error('cancel after flush'),pending=f.action.execute(actor,null,'message:3',c.signal),failure=assert.rejects(pending,e=>e===reason);await waitFor(f,'mcpServer/tool/call');c.abort(reason);await failure;assert.equal(f.locks.tryAcquire('T'),undefined);await f.raw('release');await new Promise(r=>setTimeout(r,10));assert.equal((await f.receipt()).phase,'outcome_unknown');assert.equal((await state.getIngress(f.path,'message:3'))!.phase,'recovery_claimed');assert.throws(()=>state.checkMutationCustody(f.path,'runtime','T'));assert.doesNotThrow(()=>state.checkMutationCustody(f.path,'runtime','other'));
}));
it('native preflight: fresh native instance with the same numeric generation is not old-child exit proof',async()=>fixture('timeout',async f=>{
 await assert.rejects(f.action.execute(actor,null,'message:3'),/reset/);const saved=await f.receipt(),newServer=await f.replacement();assert.notEqual(newServer.instanceId,f.server.instanceId);assert.equal(newServer.generation(),f.server.generation());
 const original:any=await f.server.request('thread/read',{threadId:'other'},1000,f.server.generation());assert.equal(original.thread.fixtureSession,'protected-other');
 await f.admit(4n);const cold=new AdmittedRepairExecutor(f.path,f.bridge,newServer,new TargetLocks(),render,{totalMs:1000,callMs:250,lockMs:100},undefined,undefined,f.admission);await assert.rejects(cold.execute({...actor,discordMessageId:4n},null,'message:4'));
 const admission=newServer.admitResponse(newServer.generation());try{const seen:any=await admission.client.requestAdmitted(admission.permit,'seen',{},1000);assert.equal(seen.filter((v:any)=>v.params.tool==='js_reset').length,0);}finally{admission.release();}
 assert.deepEqual(await f.receipt(),saved);assert.equal((await f.raw('seen')).filter((v:any)=>v.params.tool==='js_reset').length,1);
}));
it('native preflight: new admitted Stop during inventory revokes old repair without waiting behind its target lock',async()=>fixture('gate-inventory',async f=>{
 const pending=f.action.execute(actor,null,'message:3'),failure=assert.rejects(pending,/predates stop|held/);await waitFor(f,'mcpServerStatus/list');
 await f.sql("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('new-request','T',1,2,1,'preserve',1,1,'pending',0,'[]',1,1)");
 await state.admitIngress(f.path,{ingressId:'message:5',kind:'message',eventId:5n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:5n,targetThreadId:'T',canonicalOwner:null,now:5,payload:{version:1n,plan:{Execute:{Stop:{reference:null}}},lifecycle_binding:{target:'T',route:'Selected',command:{Stop:{reference:null}}}}});
 await f.sql("UPDATE discord_ingress_journal SET state='executing',phase='processing' WHERE ingress_id='message:5'");
 const stop=new AdmittedStopExecutor(f.path,f.bridge,new StopActionExecutor(f.path,f.server,f.bridge,f.locks,render)),started=performance.now();
 assert.match((await stop.execute({...actor,discordMessageId:5n},null,'message:5')).text,/Stop accepted/);assert.ok(performance.now()-started<1000);assert.equal(f.locks.tryAcquire('T'),undefined);
 const storedStop=await state.getIngress(f.path,'message:5');assert.equal(storedStop!.phase,'stop_accepted');await f.raw('release');await failure;
 assert.deepEqual(await state.getIngress(f.path,'message:5'),storedStop);assert.equal((await state.listQueueJobs(f.path))[0]!.jobId,'new-request');assert.equal((await f.raw('seen')).filter((v:any)=>v.params.tool==='js_reset').length,0);
 // A mutation-fence error is not this guard's owned rejected-before-send flag.
 // Preserve the source conservative lease; elapsed time cannot release it.
 assert.equal(f.locks.tryAcquire('T'),undefined);assert.equal((await f.receipt()).phase,'outcome_unknown');
}));

it('native preflight: repair receipt remains beside the actual native store through symlink-parent traversal',async()=>fixture('native-path',async f=>{
 const result=await f.action.execute(actor,null,'message:3');assert.match(result.text,/도구 복구 완료/);
 const directory=dirname(f.path)+'/maintenance_backups/tool-repair';const files=await readdir(directory);assert.equal(files.length,1);
 const receipt=JSON.parse(await readFile(directory+'/'+files[0],'utf8'));assert.equal(receipt.phase,'verified');assert.equal(receipt.thread_id,'T');
 await assert.rejects(readdir(join(dirname(f.path),'maintenance_backups/tool-repair')),{code:'ENOENT'});
 assert.equal((await f.raw('seen')).filter((v:any)=>v.method==='mcpServer/tool/call').length,3);
}));

it('native preflight port captures functions once and preserves queued short circuit',async()=>fixture('ready',async f=>{
 await f.sql("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,baseline_turn_ids,created_at,updated_at) VALUES('j','T',1,2,1,'p',1,1,'pending',0,'[]',1,1)");
 const queue=createNativeQueueReadState(f.path),calls:string[]=[];
 const reads={async listFiltered(path:string,target:string|null,generation:bigint|null){calls.push('queue');assert.deepEqual([path,target,generation],[f.path,'T',null]);return queue.listFiltered(path,target,generation);},async listPromptIntakes(){calls.push('intake');throw Error('must be skipped');}};
 const action=new AdmittedRepairExecutor(f.path,f.bridge,f.server,f.locks,render,undefined,reads,undefined,f.admission);
 reads.listFiltered=async()=>{throw Error('late replacement');};
 await assert.rejects(action.execute(actor,null,'message:3'),/진행 중/);assert.deepEqual(calls,['queue']);assert.deepEqual(await f.raw('seen'),[]);assert.equal(f.locks.activeTargetCount,0);
}));
it('native preflight first and second read errors retain identity and send no RPC',async()=>{
 for(const failing of ['queue','intake'])await fixture('ready',async f=>{
  const calls:string[]=[],reason=new Error(failing),queue=createNativeQueueReadState(f.path);
  const action=new AdmittedRepairExecutor(f.path,f.bridge,f.server,f.locks,render,undefined,{async listFiltered(path,target,generation){calls.push('queue');if(failing==='queue')throw reason;return queue.listFiltered(path,target,generation);},async listPromptIntakes(){calls.push('intake');throw reason;}},undefined,f.admission);
  await assert.rejects(action.execute(actor,null,'message:3'),e=>e===reason);assert.deepEqual(calls,failing==='queue'?['queue']:['queue','intake']);assert.deepEqual(await f.raw('seen'),[]);assert.equal(f.locks.activeTargetCount,0);
 });
});
it('native preflight cancellation waits its pending read before releasing target lock',async()=>fixture('ready',async f=>{
 let observed!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>observed=r),gate=new Promise<void>(r=>release=r),queue=createNativeQueueReadState(f.path),intake=createNativePromptIntakeState(f.path),c=new AbortController(),reason=new Error('cancel read');let finished=false;
 const action=new AdmittedRepairExecutor(f.path,f.bridge,f.server,f.locks,render,undefined,{async listFiltered(path,target,generation){const rows=await queue.listFiltered(path,target,generation);observed();await gate;return rows;},listPromptIntakes:intake.listPromptIntakes},undefined,f.admission);
 const task=action.execute(actor,null,'message:3',c.signal);void task.then(()=>finished=true,()=>finished=true);const failure=assert.rejects(task,e=>e===reason);
 try{await Promise.race([entered,task.then(()=>{throw Error('ended before read');})]);c.abort(reason);await new Promise(r=>setImmediate(r));assert.equal(finished,false);assert.equal(f.locks.tryAcquire('T'),undefined);assert.deepEqual(await f.raw('seen'),[]);}finally{release();await failure;}
 assert.equal(f.locks.activeTargetCount,0);assert.deepEqual(await f.raw('seen'),[]);
}));
it('native preflight selection drift while read awaits is rejected before first RPC',async()=>fixture('ready',async f=>{
 let observed!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>observed=r),gate=new Promise<void>(r=>release=r),queue=createNativeQueueReadState(f.path),intake=createNativePromptIntakeState(f.path);
 const action=new AdmittedRepairExecutor(f.path,f.bridge,f.server,f.locks,render,undefined,{async listFiltered(path,target,generation){const rows=await queue.listFiltered(path,target,generation);observed();await gate;return rows;},listPromptIntakes:intake.listPromptIntakes},undefined,f.admission);
 const task=action.execute(actor,null,'message:3'),failure=assert.rejects(task,/target changed/);
 try{await Promise.race([entered,task.then(()=>{throw Error('ended before read');})]);f.bridge.setSelectedThreadId('other');}finally{release();await failure;}
 assert.deepEqual(await f.raw('seen'),[]);assert.equal(f.locks.activeTargetCount,0);
}));
it('Repair read port rejects accessors without executing them',async()=>fixture('ready',async f=>{
 let calls=0;const reads={get listFiltered(){calls++;return state.listFiltered;},listPromptIntakes:state.listPromptIntakes};
 assert.throws(()=>new AdmittedRepairExecutor(f.path,f.bridge,f.server,f.locks,render,undefined,reads,undefined,f.admission),TypeError);assert.equal(calls,0);assert.deepEqual(await f.raw('seen'),[]);
}));

it('native admission captures original functions and actor before awaiting, ignoring later property replacement',async()=>fixture('ready',async f=>{
 const input={...actor},calls:unknown[][]=[],admission:AdmissionReads={...f.admission,getIngress:async function(this:unknown,path,key){assert.equal(this,undefined);calls.push([path,key]);const row=await f.admission.getIngress(path,key);input.channelId=9n;input.userId=9n;input.discordMessageId=9n;return row;}};
 const action=new AdmittedRepairExecutor(f.path,f.bridge,f.server,f.locks,render,undefined,undefined,undefined,admission);
 for(const key of ['getIngress','ingressByOrigin','mirroredThreadId'] as const)Object.defineProperty(admission,key,{get(){assert.fail('late admission property must not be read');}});
 assert.match((await action.execute(input,null,'message:3')).text,/도구 복구 완료/);assert.deepEqual(calls,[[f.path,'message:3']]);assert.equal((await f.raw('seen')).filter((v:any)=>v.method==='mcpServer/tool/call').length,3);
}));
it('Repair rejects accessor, generator and proxy admission ports without invoking their hooks',async()=>fixture('ready',async f=>{
 let hooks=0;const construct=(admission:AdmissionReads)=>new AdmittedRepairExecutor(f.path,f.bridge,f.server,f.locks,render,undefined,undefined,undefined,admission);
 for(const key of ['getIngress','ingressByOrigin','mirroredThreadId'] as const){
  assert.throws(()=>construct(Object.defineProperty({...f.admission},key,{get(){hooks++;return async()=>null;}})),TypeError);
  for(const value of [null,function*(){hooks++;},new Proxy(()=>{hooks++;},{apply(){hooks++;}})])assert.throws(()=>construct({...f.admission,[key]:value} as AdmissionReads),TypeError);
 }
 assert.throws(()=>construct(new Proxy(f.admission,{getOwnPropertyDescriptor(){hooks++;return undefined;}})),TypeError);assert.equal(hooks,0);assert.deepEqual(await f.raw('seen'),[]);assert.equal((await state.getIngress(f.path,'message:3'))!.phase,'processing');
}));
it('Repair refuses non-Promise admission results without thenable assimilation, fallback or claim',async()=>fixture('ready',async f=>{
 let hooks=0;const thenable={then(){hooks++;}},proxy=new Proxy(Promise.resolve(null),{get(){hooks++;return undefined;}}),before=await state.getIngress(f.path,'message:3');
 for(const value of [null,thenable,proxy]){
  const admission={...f.admission,getIngress:()=>value} as unknown as AdmissionReads,action=new AdmittedRepairExecutor(f.path,f.bridge,f.server,f.locks,render,undefined,undefined,undefined,admission);
  await assert.rejects(action.execute(actor,null,'message:3'),/admission read Promise/);assert.deepEqual(await state.getIngress(f.path,'message:3'),before);
 }
 assert.equal(hooks,0);assert.deepEqual(await f.raw('seen'),[]);assert.equal(f.locks.activeTargetCount,0);
}));
it('Repair preserves the exact admission read error and never calls a preflight or acquires custody',async()=>fixture('ready',async f=>{
 const reason=new Error('native admission unavailable'),before=await state.getIngress(f.path,'message:3'),admission={...f.admission,getIngress:async()=>{throw reason;}};
 const action=new AdmittedRepairExecutor(f.path,f.bridge,f.server,f.locks,render,undefined,{async listFiltered(){assert.fail('no queue read');},async listPromptIntakes(){assert.fail('no intake read');}},undefined,admission);
 await assert.rejects(action.execute(actor,null,'message:3'),e=>e===reason);assert.deepEqual(await state.getIngress(f.path,'message:3'),before);assert.deepEqual(await f.raw('seen'),[]);assert.equal(f.locks.activeTargetCount,0);
}));
for(const [label,input,reference,key] of [
 ['wrong actor',{...actor,userId:9n},null,'message:3'],['wrong channel',{...actor,channelId:9n},null,'message:3'],['wrong event',{...actor,discordMessageId:9n},null,'message:3'],['wrong reference',actor,'T','message:3'],['missing admission',actor,null,'message:missing'],
] as const)it(`native Repair admission refuses ${label} without claiming or sending RPC`,async()=>fixture('ready',async f=>{
 const before=await state.getIngress(f.path,'message:3');await assert.rejects(f.action.execute(input,reference,key),/envelope differs|record is missing/);assert.deepEqual(await state.getIngress(f.path,'message:3'),before);assert.deepEqual(await f.raw('seen'),[]);assert.equal(f.locks.activeTargetCount,0);
}));
for(const [label,change] of [
 ['foreign source event',"source_message_id=99"],['changed owner',"owner_id='foreign'"],['nonexecuting state',"state='held'"],['changed phase',"phase='changed'"],['wrong command',"payload_json=json_set(payload_json,'$.plan.Execute',json('{\"Recover\":{\"reference\":null}}'))"],['missing legacy binding',"payload_json=json_remove(payload_json,'$.lifecycle_binding')"],['changed target',"target_thread_id='other'"],['changed binding command',"payload_json=json_set(payload_json,'$.lifecycle_binding.command',json('{\"Recover\":{\"reference\":null}}'))"],
] as const)it(`native Repair admission refuses ${label} and preserves the original record`,async()=>fixture('ready',async f=>{
 await f.sql('UPDATE discord_ingress_journal SET '+change);const before=await state.getIngress(f.path,'message:3');await assert.rejects(f.action.execute(actor,null,'message:3'));assert.deepEqual(await state.getIngress(f.path,'message:3'),before);assert.deepEqual(await f.raw('seen'),[]);assert.equal(f.locks.activeTargetCount,0);
}));
it('native Repair admission retains exact actor and event IDs above the safe Number range',async()=>fixture('ready',async f=>{
 const id=9007199254740993n,key='message:'+id;await f.sql(`UPDATE discord_ingress_journal SET ingress_id='${key}',event_id=${id},source_message_id=${id},channel_id=${id},owner_user_id=${id}`);
 assert.match((await f.action.execute({channelId:id,userId:id,discordMessageId:id},null,key)).text,/도구 복구 완료/);const row=await state.getIngress(f.path,key);assert.equal(row!.channelId,id);assert.equal(row!.ownerUserId,id);assert.equal(row!.eventId,id);assert.equal(row!.sourceMessageId,id);assert.equal(row!.phase,'recovery_claimed');assert.ok((await f.raw('seen')).every((v:any)=>v.params.threadId==='T'));
}));
it('changed admission after the native read is refused by the existing one-use claim without a replacement read',async()=>fixture('ready',async f=>{
 let reads=0;const admission={...f.admission,async getIngress(path:string,key:string){reads++;const row=await f.admission.getIngress(path,key);await f.sql('UPDATE discord_ingress_journal SET owner_user_id=99');return row;}};
 const action=new AdmittedRepairExecutor(f.path,f.bridge,f.server,f.locks,render,undefined,undefined,undefined,admission);await assert.rejects(action.execute(actor,null,'message:3'),/admission changed/);assert.equal(reads,1);const row=await state.getIngress(f.path,'message:3');assert.equal(row!.ownerUserId,99n);assert.equal(row!.phase,'processing');assert.deepEqual(await f.raw('seen'),[]);
}));
it('native Repair admission keeps a stale original Stop revision and refuses reset before dispatch',async()=>fixture('ready',async f=>{
 await f.sql("UPDATE cdr_stop_clock SET revision=1;INSERT INTO cdr_stop_revision_receipts VALUES('later-stop','T',1,'{}');INSERT INTO cdr_stop_revisions VALUES('T',1,'later-stop')");
 await assert.rejects(f.action.execute(actor,null,'message:3'),/predates stop|revision evidence/);
 // Existing read-only status and inventory checks precede the mutation fence.
 // The original Stop revision must still prevent every reset/init/probe call.
 const seen=await f.raw('seen');assert.deepEqual(seen.map((v:any)=>v.method),['thread/read','mcpServerStatus/list']);assert.ok(seen.every((v:any)=>v.params.threadId==='T'));assert.equal(seen.filter((v:any)=>v.method==='mcpServer/tool/call').length,0);
 // This mutation-fence error is not RecoveryGuard's owned pre-send rejection.
 // Preserve the existing conservative lease and uncertain-outcome receipt.
 assert.equal((await state.getIngress(f.path,'message:3'))!.phase,'recovery_claimed');assert.equal(f.locks.tryAcquire('T'),undefined);assert.equal(f.locks.activeTargetCount,1);assert.equal((await f.receipt()).phase,'outcome_unknown');
}));
