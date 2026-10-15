import {AdmittedRecoverExecutor} from '../../../src/runtime/action-executor/recover-action.ts';
import {OwnedWorkerSlot,OwnedWorkerBusyError} from '../../../src/runtime/owned-worker-slot.ts';
import {it} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {dirname,join} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';import {BridgeState} from '../../../src/runtime/bridge-state.ts';import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';import {RuntimeCommandExecutor} from '../../../src/runtime/action-executor/command-executor.ts';import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';import {AppServerTurnBackend} from '../../../src/runtime/app-server-turn-backend.ts';import {createMutationCustodyFence} from '../../../src/runtime/mutation-custody-fence.ts';import {INTERVIEW_HEADER} from '../../../src/runtime/action-executor/interview-header.ts';import {actionExecutionErrorInfo} from '../../../src/runtime/action-executor/action-error.ts';import {joinDiagnosticReaders} from '../../../src/runtime/diagnostic-report.ts';
const actor={channelId:42n,userId:3n,discordMessageId:5n,autoQueueWhenBusy:false};
const code=`import readline from 'node:readline';const seen=[];let hangStart=false;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),reply=result=>emit({id:m.id,result});if(m.method==='initialized')return;if(m.method==='initialize'){reply({});return;}if(m.method==='fixture/seen'){reply(seen);return;}if(m.method==='fixture/hang-start'){hangStart=true;reply({});return;}seen.push({method:m.method,params:m.params});if(m.method==='thread/start'){if(!hangStart)reply({thread:{id:'created'}});}else if(m.method==='thread/resume')reply({thread:{id:m.params.threadId}});else if(m.method==='thread/read')reply({thread:{id:m.params.threadId,status:{type:'idle'},turns:[]}});else if(m.method==='turn/start')reply({turn:{id:'turn'}});else emit({id:m.id,error:{code:-9,message:'unsupported fixture call'}});});`;
async function fixture(native:boolean,run:(f:{path:string;bridge:BridgeState;queue:QueueStartCoordinator;executor:RuntimeCommandExecutor;server:PortableResidentLifecycle|null;starts:string[];notifications:()=>number;seen:()=>Promise<any[]>})=>Promise<void>,commandTimeoutMs=2000,script?:(codex:string)=>string){await storeFixture(async path=>{
 const codex=join(dirname(path),'codex.sqlite'),bridgePath=join(dirname(path),'bridge.json'),bridge=new BridgeState(bridgePath);bridge.setSelectedThreadId('root');const cd=new DatabaseSync(codex);try{cd.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);INSERT INTO threads(id,title,cwd,updated_at,archived,archived_at) VALUES('root','Root','/tmp',1,0,0)");}finally{cd.close();}
 const db=await openInitialized(path);try{db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime');INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");}finally{db.close();}
 const render=(e:unknown)=>e instanceof Error?e.message:'fixture error';const server=native?await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',script?.(codex)??code],environment:{}},clientInfo:{name:'command',title:'fixture',version:'1'}},render,{persistDeadWork(){},oldChildExited(){}},undefined,{renderError:render,fence:createMutationCustodyFence(path,'runtime',render)}):null;
 const backend=server===null?null:new AppServerTurnBackend(server,render,{resumeTimeoutMs:1000,historyTimeoutMs:1000}),starts:string[]=[];let notifications=0;
 const queue=new QueueStartCoordinator(path,backend??{generation:()=>1n,residentInstanceId:()=> 'resident',activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async(claim:{prompt:string})=>{starts.push(claim.prompt);return 'turn';}},{notifyDeliveryReady:()=>{notifications++;}});
 const executor=new RuntimeCommandExecutor({paths:{state:codex,mirror:path,bridge:bridgePath},bridge,server,backend,queue,render,preparePrompt:async p=>p+' enriched',mirror:null,reportNewAttempt:()=>{},resumeTimeoutMs:commandTimeoutMs});
 const seen=async()=>{if(server===null)return [];const a=server.admitResponse(server.generation());try{return await a.client.requestAdmitted(a.permit,'fixture/seen',{},1000) as any[];}finally{a.release();}};
 try{await run({path,bridge,queue,executor,server,starts,notifications:()=>notifications,seen});}finally{await server?.dispose();await joinDiagnosticReaders();}
});}
async function admit(path:string,kind:'Resume'|'Stop'|'Repair'|'Archive'|'Recover',event=5n){await state.admitIngress(path,{ingressId:`message:${event}`,kind:'message',eventId:event,applicationId:null,channelId:42n,ownerUserId:3n,sourceMessageId:event,targetThreadId:'root',canonicalOwner:null,now:1,payload:{version:1n,content:'!'+kind.toLowerCase(),plan:{Execute:{[kind]:{reference:null}}},lifecycle_binding:{target:'root',route:'Selected',command:{[kind]:{reference:null}}},stop_origin:{target:'root',stopRevision:0n}}});const db=await openInitialized(path);try{db.prepare("UPDATE discord_ingress_journal SET state='executing',phase='processing' WHERE ingress_id=?").run(`message:${event}`);}finally{db.close();}}
it('concrete message service functions invoke durable Ask queue and repeated message never dispatches twice',async()=>fixture(false,async f=>{
 const service=f.executor.messageServices();for(const name of ['targetThreadId','executeWithIngressContext','notifyDeliveryReady'])assert.equal(typeof Object.getOwnPropertyDescriptor(service,name)?.value,'function');assert.ok(Object.isFrozen(service));assert.equal(await service.targetThreadId(42n),'root');
 const first=await service.executeWithIngressContext({Ask:{prompt:'raw'}},actor,'message:5');assert.match(first.text,/In progress/);await service.executeWithIngressContext({Ask:{prompt:'raw'}},actor,'message:5');assert.deepEqual(f.starts,['raw enriched']);assert.equal((await state.listQueueJobs(f.path)).length,1);service.notifyDeliveryReady();assert.ok(f.notifications()>0);
}));
it('Interview reaches same durable queue with exact pinned header',async()=>fixture(false,async f=>{
 await f.executor.executeWithIngressContext({Interview:{prompt:'question'}},actor,'message:5');assert.deepEqual(f.starts,[INTERVIEW_HEADER+'question enriched']);
}));
it('New composition executes real native creation and first turn once with preserved origin',async t=>{const operations:string[]=[];const original=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){const operation=(args[1] as {operation?:unknown})?.operation;if(typeof operation==='string')operations.push(operation);if(String(args[0]).endsWith('/new-project-worker.ts'))operations.push('NewProjectCwd');return original.apply(this,args);});return fixture(true,async f=>{
 const action={New:{prompt:'raw'}};await f.executor.executeWithIngressContext(action,actor,'message:5');await f.executor.executeWithIngressContext(action,actor,'message:5');assert.deepEqual((await f.seen()).map(x=>x.method),['thread/start','turn/start']);assert.equal(f.bridge.selectedThreadId(),'created');const saved=await state.ingressByOrigin(f.path,5n);assert.equal(saved?.ownerUserId,3n);assert.equal(saved?.channelId,42n);assert.equal(saved?.state,'owned');assert.equal(operations.filter(x=>x==='AdmitWithIngress').length,1);assert.equal(operations.filter(x=>x==='IngressAdmit').length,1);assert.equal(operations.filter(x=>x==='IngressOrigin').length,2);assert.equal(operations.filter(x=>x==='IngressHold').length,0);for(const operation of ['IngressBegin','IngressCreation','IngressCreated','IngressRead','NewProjectCwd'])assert.equal(operations.filter(x=>x===operation).length,1,operation);
});});
it('admitted Resume dispatch reads exact original target without replaying prompt',async()=>fixture(true,async f=>{
 await admit(f.path,'Resume');const result=await f.executor.executeWithIngressContext({Resume:{reference:null}},actor,'message:5');assert.match(result.text,/already loaded/);assert.deepEqual((await f.seen()).map(x=>[x.method,x.params.threadId]),[['thread/read','root']]);
}));
it('Archive Resume Repair Stop route custody rejection before native effect for wrong actor or command',async()=>fixture(true,async f=>{
 await admit(f.path,'Resume');for(const action of [{Resume:{reference:null}},{Archive:{reference:null}},{Repair:{reference:null}},{Stop:{reference:null}}])await assert.rejects(f.executor.executeWithIngressContext(action,{...actor,userId:4n},'message:5'));assert.deepEqual(await f.seen(),[]);
}));
it('Stop shares queue lock registry and records acceptance without waiting on that busy lock',async()=>fixture(false,async f=>{
 await admit(f.path,'Stop');const lease=await f.queue.locks.acquire('root');try{const result=await f.executor.executeWithIngressContext({Stop:{reference:null}},actor,'message:5');assert.match(result.text,/Stop accepted for root/);assert.match(result.text,/Execution end is not confirmed/);lease.requireTarget('root');}finally{lease.release();}
}));
it('settings mutation cannot bypass missing frozen admission via ordinary settings execution',async()=>fixture(true,async f=>{
 await assert.rejects(f.executor.executeWithIngressContext({Settings:{reference:null,model:'m',effort:null,speed:null}},actor,'missing'),/admission record is missing/);assert.deepEqual(await f.seen(),[]);
}));
it('discard remains message processor-only and unimplemented recover/host paths never succeed silently',async()=>fixture(true,async f=>{
 await assert.rejects(f.executor.executeWithIngressContext({DiscardRequest:{job_id:'j'}},actor,'message:5'),/authenticated message custody/);for(const action of [{Recover:{reference:null}},'HostReboot','ForceRestartCodex'] as const)await assert.rejects(f.executor.executeWithIngressContext(action,actor,'message:5'),e=>actionExecutionErrorInfo(e)?.kind==='Unsupported');assert.deepEqual(await f.seen(),[]);
}));
it('preabort prevents queue and native effects, preserving exact reason',async()=>fixture(true,async f=>{
 const c=new AbortController(),reason=new Error('cancel');c.abort(reason);await assert.rejects(f.executor.executeWithIngressContext({New:{prompt:'raw'}},actor,'message:5',c.signal),e=>e===reason);assert.deepEqual(await f.seen(),[]);assert.deepEqual(await state.listQueueJobs(f.path),[]);
}));
it('admitted adapter refuses absent event identity instead of creating a new unrelated action admission',async()=>fixture(true,async f=>{
 await assert.rejects(f.executor.executeWithIngressContext({New:{prompt:'raw'}},{...actor,discordMessageId:null} as never,'message:5'),/event identity is required/);assert.deepEqual(await f.seen(),[]);assert.deepEqual(await state.listQueueJobs(f.path),[]);
}));

import {createServer} from 'node:http';
import {DiscordChannelClient} from '../../../src/discord/channel-client.ts';
import {createGatewayMessageHandler} from '../../../src/runtime/discord-runtime/message-handler.ts';
import {decodeGatewayMessage} from '../../../src/discord/gateway/decoded-message.ts';
import {InteractionAccessPolicy} from '../../../src/discord/interaction-access.ts';
import {SettingsTargetResolver} from '../../../src/runtime/settings-binding.ts';
import {ControlTurnVerifier} from '../../../src/runtime/action-executor/control-turn.ts';
import {AdmissionGate} from '../../../src/admission/drain-gate.ts';
type F=Parameters<Parameters<typeof fixture>[1]>[0];
async function pipeline(f:F,run:(p:{handle:(text:string,id?:number,signal?:AbortSignal)=>Promise<void>;posts:any[];atSend:Record<string,unknown>[];reports:string[]})=>Promise<void>){
 assert.ok(f.server);const posts:any[]=[],atSend:Record<string,unknown>[]=[],reports:string[]=[];
 const local=createServer((req,res)=>{let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
  try{posts.push(JSON.parse(body));const db=new DatabaseSync(f.path,{readOnly:true});try{atSend.push(db.prepare("SELECT state,phase,owner_id,outcome_json,confirmation_delivered FROM discord_ingress_journal WHERE ingress_id='message:5'").get()??{});}finally{db.close();}
   res.end(JSON.stringify({attachments:[],author:{id:'9',username:'fixture',discriminator:'0'},channel_id:'42',content:'',embeds:[],id:String(100+posts.length),type:0,mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false}));
  }catch{res.statusCode=500;res.end('{}');}
 });});await new Promise<void>(r=>local.listen(0,'127.0.0.1',r));
 const http=await DiscordChannelClient.create({token:null,testOrigin:`http://127.0.0.1:${(local.address() as {port:number}).port}/api/v10/`,report:()=>{}}),codex=join(dirname(f.path),'codex.sqlite');
 const handler=createGatewayMessageHandler({context:{database:f.path,server:f.server,http,config:{attachmentsEnabled:false,attachmentMaxBytes:100n,attachmentTextInlineMaxBytes:100n},attachmentRoot:dirname(f.path),attachmentTransport:{async get(){assert.fail('no fixture attachments');}},attachmentReport:()=>{},controlVerifier:new ControlTurnVerifier(f.path,f.server,f.bridge,f.queue.locks),services:f.executor.messageServices()},gate:new AdmissionGate(),classification:{enableMessageContent:true,plainAskMentionUserIds:new Set()},policy:new InteractionAccessPolicy({allowAllChannels:true,allowedChannelIds:[],allowedUserIds:[],mirroredChannelIds:[]}),resolver:new SettingsTargetResolver(codex,f.path,f.bridge),report:code=>{reports.push(code);}});
 const handle=async(text:string,id=5,signal=new AbortController().signal)=>handler(decodeGatewayMessage(JSON.stringify({attachments:[],author:{id:'3',username:'user',discriminator:'0',bot:false},channel_id:'42',content:text,embeds:[],id:String(id),mention_everyone:false,mention_roles:[],mentions:[],pinned:false,timestamp:'2020-01-01T00:00:00+00:00',tts:false,type:0})),{userId:9n,applicationId:4n},signal);
 try{await run({handle,posts,atSend,reports});}finally{await http.close();local.closeAllConnections();await new Promise<void>((r,j)=>local.close(e=>e?j(e):r()));assert.equal(http.activeRequests,0);assert.equal(http.ownedSockets,0);}
}
it('real gateway handler to concrete New executor persists ownership/result before HTTP acknowledgement and deduplicates delivery',async()=>fixture(true,f=>pipeline(f,async p=>{
 await p.handle('!new raw');await p.handle('!new raw');assert.deepEqual(p.reports,[]);assert.equal(p.posts.length,1);assert.match(p.posts[0].content,/In progress/);assert.ok(p.atSend[0]!.owner_id);assert.match(String(p.atSend[0]!.outcome_json),/In progress/);assert.equal(p.atSend[0]!.confirmation_delivered,0);assert.equal((await state.getIngress(f.path,'message:5'))?.confirmationDelivered,true);assert.deepEqual((await f.seen()).map(x=>x.method),['thread/start','turn/start']);
})));
it('real ordinary message pipeline reaches concrete durable queue without a replacement thread',async()=>fixture(true,f=>pipeline(f,async p=>{
 await p.handle('hello');assert.deepEqual(p.reports,[]);assert.equal(p.posts.length,1);const jobs=await state.listQueueJobs(f.path);assert.equal(jobs.length,1);assert.equal(jobs[0]!.targetThreadId,'root');assert.equal(jobs[0]!.prompt,'hello enriched');assert.equal((await state.getIngress(f.path,'message:5'))?.confirmationDelivered,true);assert.equal((await f.seen()).filter(x=>x.method==='turn/start').length,1);assert.ok((await f.seen()).every(x=>x.method!=='thread/start'));
})));
it('gateway admission freezes Resume and concrete lifecycle execution checks that same original target',async()=>fixture(true,f=>pipeline(f,async p=>{
 await p.handle('!resume');assert.deepEqual(p.reports,[]);assert.match(p.posts[0].content,/already loaded/);const original=await state.getIngress(f.path,'message:5');assert.equal(original?.targetThreadId,'root');assert.equal(original?.confirmationDelivered,true);assert.deepEqual((await f.seen()).map(x=>[x.method,x.params.threadId]),[['thread/read','root']]);
})));
it('gateway Stop remains actionable while the real shared queue target lock is held',async()=>fixture(true,f=>pipeline(f,async p=>{
 const lease=await f.queue.locks.acquire('root');try{await p.handle('!stop');assert.deepEqual(p.reports,[]);assert.match(p.posts[0].content,/Stop accepted for root/);assert.match(p.posts[0].content,/Execution end is not confirmed/);lease.requireTarget('root');assert.equal((await state.getIngress(f.path,'message:5'))?.confirmationDelivered,true);}finally{lease.release();}assert.deepEqual(await f.seen(),[]);
})));
it('gateway success-record failure cannot resend New or claim successful acknowledgement',async()=>fixture(true,f=>pipeline(f,async p=>{
 const db=await openInitialized(f.path);try{db.exec("CREATE TRIGGER reject_action_outcome BEFORE UPDATE OF outcome_json ON discord_ingress_journal WHEN NEW.phase='result_recorded' AND json_type(NEW.outcome_json,'$.response')='text' BEGIN SELECT RAISE(ABORT,'outcome blocked'); END");}finally{db.close();}
 await p.handle('!new raw');await p.handle('!new raw');assert.equal((await f.seen()).filter(x=>x.method==='thread/start').length,1);assert.equal((await f.seen()).filter(x=>x.method==='turn/start').length,1);assert.equal((await state.listQueueJobs(f.path)).length,1);assert.ok(p.posts.every(x=>!x.content.startsWith('In progress')));assert.equal((await state.getIngress(f.path,'message:5'))?.confirmationDelivered,false);assert.ok(p.reports.length>0);
})));
it('gateway cancellation after native creation dispatch preserves unknown attempt and cannot auto-recreate',async()=>fixture(true,f=>pipeline(f,async p=>{
 assert.ok(f.server);const slot=f.server.admitResponse(f.server.generation());try{await slot.client.requestAdmitted(slot.permit,'fixture/hang-start',{},1000);}finally{slot.release();}
 const c=new AbortController(),reason=new Error('runtime shutdown');const pending=p.handle('!new raw',5,c.signal),observed=assert.rejects(pending,e=>e===reason);
 try{const deadline=AbortSignal.timeout(8000);for(;;){if((await f.seen()).some(x=>x.method==='thread/start'))break;deadline.throwIfAborted();await new Promise<void>(r=>setTimeout(r,5));}c.abort(reason);await observed;}finally{c.abort(reason);await observed;}
 assert.equal(p.posts.length,0);assert.equal((await state.getIngress(f.path,'message:5'))?.state,'held');assert.deepEqual(await state.listQueueJobs(f.path),[]);await p.handle('!new raw');assert.equal((await f.seen()).filter(x=>x.method==='thread/start').length,1);
})));

it('concrete Repair installs native queue and intake preflight reads in that order',async t=>{
 const reads:string[]=[],original=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){const url=String(args[0]),operation=(args[1] as {operation?:unknown})?.operation;if(operation==='List'&&url.endsWith('/queue-runner/native-read-state-worker.ts'))reads.push('queue');if(operation==='List'&&url.endsWith('/prompt-intake/native-state-worker.ts'))reads.push('intake');return original.apply(this,args);});
 return fixture(true,async f=>{await admit(f.path,'Repair');await assert.rejects(f.executor.executeWithIngressContext({Repair:{reference:null}},actor,'message:5'),/unsupported fixture call/);assert.deepEqual(reads,['queue','intake']);assert.deepEqual((await f.seen()).map(v=>v.method),['thread/read','mcpServerStatus/list']);assert.equal(f.queue.locks.activeTargetCount,0);});
});

it('concrete basic target lookup and action selection both dispatch native MirrorTarget',async t=>{const operations:string[]=[],original=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){const op=(args[1] as {operation?:unknown})?.operation;if(op==='MirrorTarget')operations.push(op);return original.apply(this,args);});return fixture(false,async f=>{assert.equal(await f.executor.targetThreadId(42n),'root');assert.deepEqual(operations,['MirrorTarget']);await assert.rejects(f.executor.executeWithIngressContext({Steer:{prompt:'x'}},actor,'message:5'),/app.server|AppServer|앱서버|server/i);assert.ok(operations.length>=2);assert.deepEqual(f.starts,[]);});});

it('concrete Use resolves through native reader before persisting selected target',async t=>{let reads=0;const original=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){if(String(args[0]).endsWith('/codex-state/reference-worker.ts'))reads++;return original.apply(this,args);});return fixture(false,async f=>{const result=await f.executor.executeWithIngressContext({Use:{reference:'root'}},actor,'message:5');assert.match(result.text,/Selected Codex thread/);assert.equal(reads,1);assert.equal(f.bridge.selectedThreadId(),'root');assert.deepEqual(f.starts,[]);});});

it('concrete Archive preflight runs native queue intake and exact checks before inventory failure',async t=>{
 const reads:string[]=[],original=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){const url=String(args[0]),q=args[1] as {operation?:unknown;exact?:unknown};if(q.operation==='ArchiveUnfinished'&&url.endsWith('/prompt-intake/native-state-worker.ts'))reads.push('unfinished');if(q.operation==='List'&&url.endsWith('/queue-runner/native-read-state-worker.ts'))reads.push('queue');if(q.operation==='List'&&url.endsWith('/prompt-intake/native-state-worker.ts'))reads.push('intake');if(q.exact===true&&url.endsWith('/codex-state/reference-worker.ts'))reads.push('exact');return original.apply(this,args);});
 return fixture(true,async f=>{await admit(f.path,'Archive');await assert.rejects(f.executor.executeWithIngressContext({Archive:{reference:null}},actor,'message:5'),/unsupported fixture call/);assert.deepEqual(reads.slice(0,4),['unfinished','queue','intake','exact']);assert.ok(!(await f.seen()).some(x=>x.method==='thread/archive'));},20000);
});

it('concrete Context dispatch installs native limited inventory and eager probe before exact target read',async t=>{const modes:string[]=[],original=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){const q=args[1] as {contextRead?:unknown;exact?:unknown};if(typeof q.contextRead==='string')modes.push(q.contextRead);else if(q.exact===true)modes.push('Exact');return original.apply(this,args);});await fixture(false,async f=>{const all=await f.executor.executeWithIngressContext({Context:{all_threads:true,refresh:false,limit:1n}},actor,'message:5');assert.match(all.text,/root \| Root/);assert.deepEqual(modes,['ContextRecent']);modes.length=0;const one=await f.executor.executeWithIngressContext({Context:{all_threads:false,refresh:false,limit:1n}},actor,'message:5');assert.match(one.text,/root \| Root/);assert.deepEqual(modes,['ContextProbe','Exact']);assert.equal(f.bridge.selectedThreadId(),'root');assert.deepEqual(f.starts,[]);});});

it('concrete runtime message binding uses native open-selected, original reference and independent exact read',async t=>{const modes:string[]=[],original=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){const q=args[1] as any;if(q.openSelected===true)modes.push('OpenSelected');else if(q.exact===true)modes.push('Exact');else if(typeof q.reference==='string')modes.push('Resolve');else if(q.operation==='MirrorTarget')modes.push('MirrorTarget');return original.apply(this,args);});await fixture(false,async f=>{const binding=f.executor.messageRuntimeBinding();const explicit=await binding.resolver.bind({Settings:{reference:'root',model:'gpt',effort:null,speed:null}},42n);assert.equal(explicit!.target,'root');assert.deepEqual(modes,['OpenSelected','Resolve','Exact']);modes.length=0;const selected=await binding.resolver.bindLifecycle({Stop:{reference:null}},42n);assert.equal(selected!.target,'root');assert.deepEqual(modes,['OpenSelected','MirrorTarget','Exact','MirrorTarget']);assert.equal(f.bridge.selectedThreadId(),'root');assert.deepEqual(f.starts,[]);});});

it('installed Use and New write Bridge only through actual native worker',async t=>{
 let armed=false;const operations:string[]=[],run=OwnedWorkerSlot.prototype.run;
 for(const name of ['setSelectedThreadId','rememberThreadSettings','applyThreadFork','clearSelectedIfInScope'] as const){const original=BridgeState.prototype[name];t.mock.method(BridgeState.prototype,name,function(this:BridgeState,...args:unknown[]){assert.equal(armed,false,'main-thread Bridge mutation: '+name);return Reflect.apply(original,this,args);});}
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).endsWith('/bridge-state-native-worker.ts')){const q=args[1] as {operation:{kind:string}};operations.push(q.operation.kind);}return run.apply(this,args);});
 await fixture(true,async f=>{armed=true;try{await f.executor.executeWithIngressContext({Use:{reference:'root'}},actor,'message:5');await f.executor.executeWithIngressContext({New:{prompt:'native bridge'}},{...actor,discordMessageId:6n},'message:6');}finally{armed=false;}
 assert.equal(operations.filter(x=>x==='Select').length,2);assert.equal(f.bridge.selectedThreadId(),'created');assert.equal((await f.seen()).filter(x=>x.method==='thread/start').length,1);assert.equal((await f.seen()).filter(x=>x.method==='turn/start').length,1);
 });
});

it('installed Stop final guard performs native selection reads without main-thread Bridge read',async t=>{
 let armed=false,selectedReads=0;const read=BridgeState.prototype.selectedThreadId,run=OwnedWorkerSlot.prototype.run;
 t.mock.method(BridgeState.prototype,'selectedThreadId',function(this:BridgeState){assert.equal(armed,false,'main-thread selected read');return read.call(this);});
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).endsWith('/bridge-state-native-worker.ts')&&(args[1] as {operation:{kind:string}}).operation.kind==='Selected')selectedReads++;return run.apply(this,args);});
 await fixture(true,async f=>{await admit(f.path,'Stop');armed=true;try{const result=await f.executor.executeWithIngressContext({Stop:{reference:null}},actor,'message:5');assert.match(result.text,/Stop accepted for root/);}finally{armed=false;}assert.ok(selectedReads>=2);assert.deepEqual(await f.seen(),[]);assert.equal(f.queue.locks.activeTargetCount,0);});
});

function writeFlowCode(codex:string):string{return `import readline from 'node:readline';import {DatabaseSync} from 'node:sqlite';const file=${JSON.stringify(codex)},seen=[];let model='old';const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),reply=result=>emit({id:m.id,result});if(m.method==='initialized')return;if(m.method==='initialize'){reply({});return;}if(m.method==='fixture/seen'){reply(seen);return;}seen.push({method:m.method,params:m.params});if(m.method==='thread/resume')reply({thread:{id:m.params.threadId},model,reasoningEffort:'medium',serviceTier:null});else if(m.method==='thread/read')reply({thread:{id:m.params.threadId,status:{type:'idle'},turns:[]}});else if(m.method==='thread/list')reply({data:[],nextCursor:null});else if(m.method==='thread/archive'){const db=new DatabaseSync(file);try{db.prepare('UPDATE threads SET archived=1,archived_at=2 WHERE id=?').run(m.params.threadId);}finally{db.close();}reply({});}else if(m.method==='model/list')reply({data:['old','new'].map(model=>({model,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium'}]}))});else if(m.method==='thread/settings/update'){model=m.params.model;emit({method:'thread/settings/updated',params:{threadId:m.params.threadId,threadSettings:{model,effort:'medium',serviceTier:null}}});reply({});}else emit({id:m.id,error:{code:-9,message:'unsupported write-flow fixture call'}});});`;}

it('installed Open Resume Settings and Archive await real shared native mutations',async t=>{
 let armed=false;const operations:string[]=[],slots=new Set<OwnedWorkerSlot>(),run=OwnedWorkerSlot.prototype.run;
 for(const name of ['setSelectedThreadId','rememberThreadSettings','applyThreadFork','clearSelectedIfInScope'] as const){const original=BridgeState.prototype[name];t.mock.method(BridgeState.prototype,name,function(this:BridgeState,...args:unknown[]){assert.equal(armed,false,'main-thread mutation '+name);return Reflect.apply(original,this,args);});}
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).endsWith('/bridge-state-native-worker.ts')){slots.add(this);operations.push((args[1] as {operation:{kind:string}}).operation.kind);}return run.apply(this,args);});
 await fixture(true,async f=>{
  armed=true;try{
   await f.executor.executeWithIngressContext({Open:{reference:'root',abort:false}},actor,'message:5');
   await admit(f.path,'Resume',6n);await f.executor.executeWithIngressContext({Resume:{reference:null}},{...actor,discordMessageId:6n},'message:6');
   const action={Settings:{reference:null,model:'new',effort:null,speed:null}},binding=await f.executor.messageRuntimeBinding().resolver.bind(action,42n);assert.ok(binding);
   await state.admitIngress(f.path,{ingressId:'message:7',kind:'message',eventId:7n,applicationId:null,channelId:42n,ownerUserId:3n,sourceMessageId:7n,targetThreadId:'root',canonicalOwner:null,now:2,payload:{version:1n,content:'!model new',plan:{Execute:action},settings_binding:binding,stop_origin:{target:'root',stopRevision:0n}}});
   const db=await openInitialized(f.path);try{db.exec("UPDATE discord_ingress_journal SET state='executing',phase='processing' WHERE ingress_id='message:7'");}finally{db.close();}
   await f.executor.executeWithIngressContext(action,{...actor,discordMessageId:7n},'message:7');
   const finished=await openInitialized(f.path);try{finished.exec("UPDATE discord_ingress_journal SET state='completed' WHERE ingress_id IN ('message:6','message:7')");}finally{finished.close();}
   await admit(f.path,'Archive',8n);await f.executor.executeWithIngressContext({Archive:{reference:null}},{...actor,discordMessageId:8n},'message:8');
  }finally{armed=false;}
  assert.equal(slots.size,1);assert.equal(operations.filter(x=>x==='Select').length,2);assert.equal(operations.filter(x=>x==='Remember').length,1);assert.equal(operations.filter(x=>x==='ClearScope').length,1);
  assert.equal(f.bridge.selectedThreadId(),null);assert.equal(f.bridge.threadSettings('root').model,'new');assert.equal((await f.seen()).filter(x=>x.method==='thread/settings/update').length,1);assert.equal((await f.seen()).filter(x=>x.method==='thread/archive').length,1);assert.equal(f.queue.locks.activeTargetCount,0);
 },20000,writeFlowCode);
});

it('unknown late native Bridge write after New creation cannot recreate the original thread',async t=>{
 const run=OwnedWorkerSlot.prototype.run;let forced=0;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).endsWith('/bridge-state-native-worker.ts')&&(args[1] as {operation:{kind:string}}).operation.kind==='Select'){forced++;args[2]=1;}return run.apply(this,args);});
 await fixture(true,async f=>{await assert.rejects(f.executor.executeWithIngressContext({New:{prompt:'held after native write'}},actor,'message:5'));assert.equal(forced,1);assert.equal(f.bridge.selectedThreadId(),'created');assert.equal((await f.seen()).filter(x=>x.method==='turn/start').length,0);const original=(await state.ingressByOrigin(f.path,5n))!.ownerId;assert.ok(original);const second=await f.executor.executeWithIngressContext({New:{prompt:'held after native write'}},actor,'message:5').then(value=>({value}),error=>({error}));assert.ok(second);assert.equal((await f.seen()).filter(x=>x.method==='thread/start').length,1);assert.equal((await f.seen()).filter(x=>x.method==='turn/start').length,1);await f.executor.executeWithIngressContext({New:{prompt:'held after native write'}},actor,'message:5');assert.equal((await f.seen()).filter(x=>x.method==='thread/start').length,1);assert.equal((await f.seen()).filter(x=>x.method==='turn/start').length,1);assert.equal((await state.ingressByOrigin(f.path,5n))!.ownerId,original);assert.equal(forced,1);assert.equal(f.queue.locks.activeTargetCount,0);});
});

it('installed active and archived lists read selection only through shared native owner',async t=>{
 let armed=false,selectedReads=0;const original=BridgeState.prototype.selectedThreadId,run=OwnedWorkerSlot.prototype.run;
 t.mock.method(BridgeState.prototype,'selectedThreadId',function(this:BridgeState){assert.equal(armed,false,'list main-thread Bridge read');return original.call(this);});
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).endsWith('/bridge-state-native-worker.ts')&&(args[1] as {operation:{kind:string}}).operation.kind==='Selected')selectedReads++;return run.apply(this,args);});
 await fixture(false,async f=>{armed=true;try{const active=await f.executor.executeWithIngressContext({List:{limit:1n}},actor,'message:5');assert.match(active.text,/root/);const db=new DatabaseSync(join(dirname(f.path),'codex.sqlite'));try{db.exec("UPDATE threads SET archived=1,archived_at=1 WHERE id='root'");}finally{db.close();}const archived=await f.executor.executeWithIngressContext({ArchivedList:{limit:1n}},actor,'message:6');assert.match(archived.text,/root/);}finally{armed=false;}assert.equal(selectedReads,2);assert.deepEqual(f.starts,[]);});
});

it('installed control verifier uses exact native terminal evidence after real active cache observation',async t=>{
 let reads=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).endsWith('/control-evidence-native-worker.ts'))reads++;return run.apply(this,args);});
 const script=()=>code.replace("if(m.method==='fixture/seen')", "if(m.method==='fixture/seed'){emit({method:'turn/started',params:{threadId:'root',turnId:'v'}});reply({});return;}if(m.method==='fixture/seen')");
 await fixture(true,async f=>{const server=f.server!,verifier=f.executor.messageRuntimeBinding().controlVerifier;await assert.rejects(verifier.owned('root'),/no currently owned/);assert.equal(reads,0);const a=server.admitResponse(server.generation());try{await a.client.requestAdmitted(a.permit,'fixture/seed',{},1000);}finally{a.release();}
 assert.deepEqual(await verifier.control(42n,'root','v'),['v',server.generation()]);assert.equal(reads,1);
 const db=await openInitialized(f.path);try{db.exec("INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload,resident_owner) VALUES('root','v',-9,'{}','other')");}finally{db.close();}
 await assert.rejects(verifier.owned('root','v'),/turn completed/);assert.equal(reads,2);assert.deepEqual(await f.seen(),[]);
 },20000,script);
});

it('Recover command uses original native custody and explicit startup controller',async()=>fixture(false,async f=>{
 const cmd={Recover:{reference:'root'}},order:string[]=[];
 await state.admitIngress(f.path,{ingressId:'message:5',kind:'message',eventId:5n,applicationId:null,channelId:42n,ownerUserId:3n,sourceMessageId:5n,targetThreadId:'root',canonicalOwner:null,now:1,payload:{version:1n,plan:{Execute:cmd},lifecycle_binding:{target:'root',route:'Explicit',command:cmd}}});
 await state.beginIngressExecution(f.path,'message:5','processing','root',2);
 const op='b'.repeat(32),controller={inspect:async(thread:string)=>{order.push('inspect');assert.equal(thread,'root');return {ThreadId:'root',State:'tools_recovery',RecoveryIdentity:'host'};},start:async(thread:string,identity:string)=>{order.push('start');assert.equal(thread,'root');assert.equal(identity,'host');return {Operation:op,ReceiptPath:'/repo/maintenance_backups/desktop-recovery/'+op+'/receipt.json'};},join:async()=>{order.push('join');}};
 f.executor.configureRecovery(new AdmittedRecoverExecutor(f.path,'/repo','posix',controller));
 const result=await f.executor.executeWithIngressContext(cmd,actor,'message:5');assert.match(result.text,/이전 요청의 취소 기록을 저장했습니다/);assert.match(result.text,/아직 재시작 완료가 확인된 상태는 아닙니다/);assert.equal(result.waitsForFinal,false);assert.deepEqual(order,['inspect','start','join']);
 await assert.rejects(f.executor.executeWithIngressContext(cmd,actor,'message:5'));assert.deepEqual(order,['inspect','start','join']);
}));
it('Recover startup configuration refuses foreign database and replacement',async()=>fixture(false,async f=>{
 const controller={inspect:async()=>({}),start:async()=>({}),join:async()=>{}};
 assert.throws(()=>f.executor.configureRecovery(new AdmittedRecoverExecutor(f.path+'.foreign','/repo','posix',controller)),/database differs/);
 f.executor.configureRecovery(new AdmittedRecoverExecutor(f.path,'/repo','posix',controller));assert.throws(()=>f.executor.configureRecovery(new AdmittedRecoverExecutor(f.path,'/repo','posix',controller)),/already configured/);
}));
it('gateway Recover confirms dispatched receipt under occupied target lock without replay',async()=>fixture(true,f=>pipeline(f,async p=>{
 let starts=0;const op='c'.repeat(32);f.executor.configureRecovery(new AdmittedRecoverExecutor(f.path,'/repo','posix',{inspect:async thread=>({ThreadId:thread,State:'tools_recovery',RecoveryIdentity:'host'}),start:async()=>{starts++;return {Operation:op,ReceiptPath:'/repo/maintenance_backups/desktop-recovery/'+op+'/receipt.json'};},join:async()=>{}}));
 const lease=await f.queue.locks.acquire('root');try{await p.handle('!recover root');await p.handle('!recover root');assert.deepEqual(p.reports,[]);assert.equal(starts,1);assert.equal(p.posts.length,1);assert.match(p.posts[0].content,/이전 요청의 취소 기록을 저장했습니다/);assert.match(p.posts[0].content,/아직 재시작 완료가 확인된 상태는 아닙니다/);assert.equal((await state.getIngress(f.path,'message:5'))?.confirmationDelivered,true);}finally{lease.release();}
})));
it('gateway Recover dispatch failure cannot retry original controller operation',async()=>fixture(true,f=>pipeline(f,async p=>{
 let starts=0;f.executor.configureRecovery(new AdmittedRecoverExecutor(f.path,'/repo','posix',{inspect:async thread=>({ThreadId:thread,State:'tools_recovery',RecoveryIdentity:'host'}),start:async()=>{starts++;throw new Error('dispatch result lost');},join:async()=>{}}));
 await p.handle('!recover root');await p.handle('!recover root');assert.equal(starts,1);assert.ok(p.posts.every(x=>!String(x.content).startsWith('이전 요청의 취소 기록을 저장했습니다')));assert.notEqual((await state.getIngress(f.path,'message:5'))?.phase,'processing');
})));
it('gateway Recover outcome persistence failure never redispatches the original request',async()=>fixture(true,f=>pipeline(f,async p=>{
 let starts=0;const op='d'.repeat(32);f.executor.configureRecovery(new AdmittedRecoverExecutor(f.path,'/repo','posix',{inspect:async thread=>({ThreadId:thread,State:'tools_recovery',RecoveryIdentity:'host'}),start:async()=>{starts++;return {Operation:op,ReceiptPath:'/repo/maintenance_backups/desktop-recovery/'+op+'/receipt.json'};},join:async()=>{}}));
 const db=await openInitialized(f.path);try{db.exec("CREATE TRIGGER reject_recover_outcome BEFORE UPDATE OF outcome_json ON discord_ingress_journal WHEN NEW.phase='result_recorded' AND json_type(NEW.outcome_json,'$.response')='text' BEGIN SELECT RAISE(ABORT,'outcome blocked'); END");}finally{db.close();}
 await p.handle('!recover root');await p.handle('!recover root');assert.equal(starts,1);assert.ok(p.posts.every(x=>!String(x.content).startsWith('이전 요청의 취소 기록을 저장했습니다')));assert.equal((await state.getIngress(f.path,'message:5'))?.confirmationDelivered,false);assert.ok(p.reports.length>0);
})));

it('Recover selected route uses the command executor shared native Bridge owner',async()=>fixture(false,async f=>{
 await admit(f.path,'Recover');let starts=0;const op='e'.repeat(32);
 const recovery=new AdmittedRecoverExecutor(f.path,'/repo','posix',{inspect:async thread=>({ThreadId:thread,State:'tools_recovery',RecoveryIdentity:'host'}),start:async thread=>{assert.equal(thread,'root');starts++;return {Operation:op,ReceiptPath:'/repo/maintenance_backups/desktop-recovery/'+op+'/receipt.json'};},join:async()=>{}});
 f.executor.configureRecovery(recovery);
 const result=await f.executor.executeWithIngressContext({Recover:{reference:null}},actor,'message:5');assert.equal(starts,1);assert.match(result.text,/receipt.json/);
}));

import {queueJob} from '../../helpers/queue-job.ts';
async function retractQueue(path:string){for(const [jobId,createdAt,discordMessageId] of [['older',1,101n],['latest',2,102n]] as const)await state.enqueue(path,queueJob({jobId,targetThreadId:'root',channelId:42n,ownerUserId:3n,discordMessageId,createdAt}));}
it('installed Retract uses the actual pinned native cancellation lane with original ingress identity',async t=>{
 const requests:any[]=[],run=OwnedWorkerSlot.prototype.run,prepare=DatabaseSync.prototype.prepare;let armed=false;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).endsWith('/retract-write-native-worker.ts'))requests.push(args[1]);return run.apply(this,args);});
 t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){if(armed&&(/SELECT job_id,kind,discord_message_id,eligible/.test(sql)||/DELETE FROM codex_turn_queue/.test(sql)))assert.fail('Retract synchronous store execution on main event loop');return prepare.call(this,sql);});
 await fixture(false,async f=>{await retractQueue(f.path);armed=true;let result;try{result=await f.executor.executeWithIngressContext({Retract:{reference:null}},actor,'message:5');}finally{armed=false;}
 assert.equal(result.text,'Retracted unstarted request latest for root.');assert.equal(requests.length,1);assert.equal(requests[0].path,f.path);assert.deepEqual({...requests[0].operation,now:0},{ingressKey:'message:5',eventId:5n,target:'root',channelId:42n,ownerUserId:3n,now:0,requireMirror:false});assert.deepEqual((await state.listQueueJobs(f.path)).map(r=>r.jobId),['older']);assert.deepEqual(f.starts,[]);
 });
});
it('gateway Retract confirms only the committed cancellation and duplicate ingress cannot cancel the next request',async t=>{
 let submitted=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).endsWith('/retract-write-native-worker.ts'))submitted++;return run.apply(this,args);});
 await fixture(true,f=>pipeline(f,async p=>{await retractQueue(f.path);const lease=await f.queue.locks.acquire('root');try{await p.handle('!retract');await p.handle('!retract');}finally{lease.release();}
 assert.equal(submitted,1);assert.equal(p.posts.length,1);assert.equal(p.posts[0].content,'Retracted unstarted request latest for root.');assert.equal((await state.getIngress(f.path,'message:5'))?.confirmationDelivered,true);assert.deepEqual((await state.listQueueJobs(f.path)).map(r=>r.jobId),['older']);assert.deepEqual(await f.seen(),[]);
 }));
});
it('gateway Retract lost committed reply holds original ingress and never retries cancel-latest',async t=>{
 let submitted=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(String(args[0]).endsWith('/retract-write-native-worker.ts')){submitted++;return task.then(()=>{throw new Error('lost Retract acknowledgement');});}return task;});
 await fixture(true,f=>pipeline(f,async p=>{await retractQueue(f.path);await p.handle('!retract');const original=await state.getIngress(f.path,'message:5');assert.equal(original?.state,'held');assert.equal(original?.eventId,5n);assert.equal(original?.confirmationDelivered,false);await p.handle('!retract');assert.equal(submitted,1);assert.deepEqual((await state.listQueueJobs(f.path)).map(r=>r.jobId),['older']);assert.ok(p.posts.every(x=>!String(x.content).startsWith('Retracted unstarted')));assert.deepEqual(await f.seen(),[]);
 }));
});

it('actual Runners and SavedRequest commands share native display owner and preserve captured actor, no RPC or effects',async t=>{
 const operations:string[]=[],original=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof original>){if(String(args[0]).endsWith('/runner-inspection-native-worker.ts'))operations.push((args[1] as {operation:string}).operation);return original.apply(this,args);});
 await fixture(true,async f=>{
  const db=await openInitialized(f.path);try{db.exec(`INSERT INTO discord_ingress_journal(ingress_id,kind,channel_id,owner_user_id,payload_json,state,phase,created_at,updated_at) VALUES('inspect-original','message',42,3,'{"prompt":"private saved content","token":"hidden"}','held','claimed',0,0)`);}finally{db.close();}
  for(const method of ['getIngressForOwnerReadonly','listIngressesForOwner','runnerTargetCounts','listQueueJobs','listPendingDeliveries','listPromptIntakes','unknownDeliveryReceiptCount','blockedDeliveryReceiptCount','executionHoldReason'] as const)t.mock.method(state,method,()=>{throw new Error('Main-thread display store fallback is forbidden');});
  const action={SavedRequest:{request_id:'inspect-original'}},context={...actor},pending=f.executor.executeWithIngressContext(action,context,'display-only');action.SavedRequest.request_id='other';context.userId=4n;context.channelId=43n;
  await assert.rejects(f.executor.executeWithIngressContext('Runners',actor,'overlap'),OwnedWorkerBusyError);
  const detail=await pending;assert.match(detail.text,/private saved content/);assert.ok(!detail.text.includes('hidden'));assert.equal(detail.waitsForFinal,false);assert.equal(detail.ui,null);
  const runners=await f.executor.executeWithIngressContext('Runners',actor,'display-only');assert.match(runners.text,/owned_active_turn: unknown/);assert.match(runners.text,/inspect-original \| status: saved/);assert.deepEqual(operations,['Detail','Global','TargetCounts','Summary']);assert.deepEqual(await f.seen(),[]);assert.deepEqual(f.starts,[]);assert.equal(f.notifications(),0);
  const after=new DatabaseSync(f.path);try{assert.equal(after.prepare("SELECT state FROM discord_ingress_journal WHERE ingress_id='inspect-original'").get()?.state,'held');assert.equal(after.prepare('SELECT COUNT(*) AS n FROM codex_turn_queue').get()?.n,0);}finally{after.close();}
 });
});

it('actual command Stop uses one native acceptance submission with no synchronous acceptance or interrupt fallback',async t=>{
 for(const name of ['acceptRunningStop','acceptUnresolvedStop'] as const)t.mock.method(state,name,()=>{throw new Error('main-thread Stop acceptance forbidden');});
 const run=OwnedWorkerSlot.prototype.run;let submissions=0;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).includes('stop-acceptance-native-worker'))submissions++;return run.apply(this,args);});
 await fixture(true,async f=>{await admit(f.path,'Stop');const result=await f.executor.executeWithIngressContext({Stop:{reference:null}},actor,'message:5');assert.match(result.text,/Stop accepted for root/);assert.equal(submissions,1);assert.deepEqual(await f.seen(),[]);assert.equal((await state.getIngress(f.path,'message:5'))!.phase,'stop_accepted');});
});
it('actual command Stop lost native acknowledgement retains original ingress and cannot return accepted or fallback interrupt',async t=>{
 for(const name of ['acceptRunningStop','acceptUnresolvedStop'] as const)t.mock.method(state,name,()=>{throw new Error('main-thread Stop fallback forbidden');});
 const run=OwnedWorkerSlot.prototype.run;let submissions=0;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(!String(args[0]).includes('stop-acceptance-native-worker'))return task;submissions++;return task.then(()=>{throw new Error('lost acknowledgement after real exit');});});
 await fixture(true,async f=>{await admit(f.path,'Stop');await assert.rejects(f.executor.executeWithIngressContext({Stop:{reference:null}},actor,'message:5'),(error:any)=>error.name==='NativeStopAcceptanceUnknownError'&&error.ingressKey==='message:5'&&error.operationId==='stop:message:5');assert.equal(submissions,1);assert.deepEqual(await f.seen(),[]);const saved=await state.getIngress(f.path,'message:5');assert.equal(saved!.phase,'stop_accepted');assert.equal(saved!.confirmationDelivered,false);const db=await openInitialized(f.path);try{assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_stop_revision_receipts').get()!.n,1);}finally{db.close();}});
});

import {acceptRunningStop as seedRunningStop} from '../../../src/store/stop-control-admission.ts';
import {NativeStopClaimUnknownError} from '../../../src/runtime/action-executor/stop-dispatch-native.ts';
const stopDispatchCode=code.replace("seen.push({method:m.method", "if(m.method==='fixture/seed'){emit({method:'turn/started',params:{threadId:'root',turnId:'V'}});reply({});return;}seen.push({method:m.method");
async function seedStopDispatch(f:F){
 assert.ok(f.server);const admission=f.server.admitResponse(f.server.generation());try{await admission.client.requestAdmitted(admission.permit,'fixture/seed',{},1000);}finally{admission.release();}
 const db=await openInitialized(f.path);try{db.prepare("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('dispatch-job','root',42,3,?,'original',0,1,'running',1,'V','[]',1,1)").run(f.server.generation());}finally{db.close();}
 return seedRunningStop(f.path,{target:'root',channel:42n,owner:3n},{target:'root',route:'Selected',command:{Stop:{reference:null}}},null,f.server.instanceId,f.server.generation(),()=>{})!;
}
it('actual factory Stop workers use native claim/error writes with synchronous methods poisoned and one interrupt',async t=>{
 for(const name of ['claimStopControl','recordStopControlError','pendingStopControlsAfter'] as const)t.mock.method(state,name,()=>{throw new Error('main-thread Stop dispatch persistence forbidden');});
 const operations:string[]=[],run=OwnedWorkerSlot.prototype.run,completion=OwnedWorkerSlot.prototype.runControlCompletion;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(String(args[0]).includes('stop-dispatch-native-worker'))operations.push((args[1] as any).operation);return run.apply(this,args);});
 t.mock.method(OwnedWorkerSlot.prototype,'runControlCompletion',function(this:OwnedWorkerSlot,...args:Parameters<typeof completion>){if(String(args[0]).includes('stop-dispatch-native-worker'))operations.push((args[1] as any).operation);return completion.apply(this,args);});
 await fixture(true,async f=>{const original=await seedStopDispatch(f),reports:unknown[]=[],worker=f.executor.createStopControlWorker(e=>{reports.push(e);});assert.equal(await worker.process(),1);assert.deepEqual(operations,['Claim','Error']);assert.equal((await f.seen()).filter(row=>row.method==='turn/interrupt').length,1);assert.equal(reports.length,1);assert.equal(state.stopControlPhase(f.path,original.operation_id),'unknown');assert.equal(await worker.process(),0);assert.equal(await f.executor.createStopControlWorker(()=>{}).process(),0);assert.deepEqual(operations,['Claim','Error']);},2000,()=>stopDispatchCode);
});
it('actual factory shares a sticky uncertain-claim barrier across cursor cycles and new workers after committed or rolled-back lost ACK',async t=>{
 for(const rollback of [false,true]){
 const run=OwnedWorkerSlot.prototype.run;let claims=0;const mock=t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(String(args[0]).includes('stop-dispatch-native-worker')){claims++;return task.then(()=>{throw new Error('lost native claim acknowledgement');});}return task;});
 try{await fixture(true,async f=>{const original=await seedStopDispatch(f);if(rollback){const db=await openInitialized(f.path);try{db.exec("CREATE TRIGGER stop_rollback AFTER UPDATE OF claim_token ON cdr_stop_controls BEGIN SELECT RAISE(ABORT,'rollback'); END");}finally{db.close();}}
 const reports:unknown[]=[],first=f.executor.createStopControlWorker(e=>{reports.push(e);});let error:unknown;await assert.rejects(first.process(),e=>{error=e;return e instanceof NativeStopClaimUnknownError;});if(rollback){const db=await openInitialized(f.path);try{db.exec('DROP TRIGGER stop_rollback');}finally{db.close();}}
 for(let n=0;n<3;n++)await assert.rejects(first.process(),e=>e===error);const second=f.executor.createStopControlWorker(e=>{reports.push(e);});await assert.rejects(second.process(),e=>e===error);assert.equal(first.cursor,1n);assert.equal(second.cursor,0n);assert.equal(reports.length,1);assert.equal(claims,1);assert.equal(state.stopControlPhase(f.path,original.operation_id),rollback?'accepted':'dispatching');assert.equal((await f.seen()).some(row=>row.method==='turn/interrupt'),false);
 },2000,()=>stopDispatchCode);}finally{mock.mock.restore();}
 }
});

import {NativePromptIntakeUnavailableError} from '../../../src/runtime/prompt-intake/native-state.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
type AdmissionKind='Settings'|'Stop'|'Resume'|'Archive';
const admittedAction=(kind:AdmissionKind)=>kind==='Settings'?{Settings:{reference:null,model:'new',effort:null,speed:null}}:{[kind]:{reference:null}} as {Stop:{reference:null}}|{Resume:{reference:null}}|{Archive:{reference:null}};
async function admitReadCommand(f:F,kind:AdmissionKind){
 if(kind!=='Settings'){await admit(f.path,kind);return;}
 const action=admittedAction(kind),binding=await f.executor.messageRuntimeBinding().resolver.bind(action,42n);assert.ok(binding);
 await state.admitIngress(f.path,{ingressId:'message:5',kind:'message',eventId:5n,applicationId:null,channelId:42n,ownerUserId:3n,sourceMessageId:5n,targetThreadId:'root',canonicalOwner:null,now:1,payload:{version:1n,content:'!model new',plan:{Execute:action},settings_binding:binding,stop_origin:{target:'root',stopRevision:0n}}});
 const db=new DatabaseSync(f.path);try{db.exec("UPDATE discord_ingress_journal SET state='executing',phase='processing' WHERE ingress_id='message:5'");}finally{db.close();}
}
for(const kind of ['Settings','Stop','Resume','Archive'] as const)it(`installed ${kind} uses native admission and route reads with all synchronous facade reads poisoned`,async t=>{
 let armed=false;const operations:string[]=[],run=OwnedWorkerSlot.prototype.run;
 for(const name of ['getIngress','ingressByOrigin','mirroredThreadId'] as const){const original=state[name];t.mock.method(state,name,(...args:unknown[])=>{assert.equal(armed,false,`main-thread ${name}`);return Reflect.apply(original,undefined,args);});}
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(armed&&String(args[0]).endsWith('/prompt-intake/native-state-worker.ts'))operations.push((args[1] as {operation:string}).operation);return run.apply(this,args);});
 await fixture(true,async f=>{await admitReadCommand(f,kind);armed=true;let result;try{result=await f.executor.executeWithIngressContext(admittedAction(kind),actor,'message:5');}finally{armed=false;}
  assert.match(result.text,kind==='Settings'?/모델이 변경되었습니다: new/:kind==='Stop'?/Stop accepted for root/:kind==='Resume'?/already loaded/:/Archived Codex thread root/);
  assert.equal(operations.filter(x=>x==='IngressRead').length,kind==='Settings'?2:1);assert.equal(operations.filter(x=>x==='IngressOrigin').length,kind==='Archive'?2:0);assert.ok(operations.includes('MirrorTarget'));assert.equal(ownedWorkerUsage().Control,0);assert.equal(f.queue.locks.activeTargetCount,0);
  const calls=(await f.seen()).map(row=>row.method);if(kind==='Stop')assert.deepEqual(calls,[]);if(kind==='Resume')assert.deepEqual(calls,['thread/read']);if(kind==='Archive')assert.equal(calls.filter(x=>x==='thread/archive').length,1);if(kind==='Settings')assert.equal(calls.filter(x=>x==='thread/settings/update').length,1);
 },20000,writeFlowCode);
});
for(const kind of ['Settings','Stop','Resume','Archive'] as const)it(`installed ${kind} propagates unavailable native admission without null, fallback or effect`,async t=>{
 let armed=false,reads=0;const run=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args);if(armed&&String(args[0]).endsWith('/prompt-intake/native-state-worker.ts')&&(args[1] as {operation:string}).operation==='IngressRead'){reads++;return task.then(()=>{throw new Error('lost native read after exit');});}return task;});
 await fixture(true,async f=>{await admitReadCommand(f,kind);const before=await state.getIngress(f.path,'message:5');armed=true;try{await assert.rejects(f.executor.executeWithIngressContext(admittedAction(kind),actor,'message:5'),e=>e instanceof NativePromptIntakeUnavailableError&&e.operation==='IngressRead');}finally{armed=false;}
  assert.equal(reads,1);assert.deepEqual(await f.seen(),[]);assert.deepEqual(await state.getIngress(f.path,'message:5'),before);assert.equal(ownedWorkerUsage().Control,0);assert.equal(f.queue.locks.activeTargetCount,0);assert.equal(await state.archiveTargetFenced(f.path,'root'),false);
 },20000,writeFlowCode);
});
for(const item of [{kind:'Settings',operation:'IngressRead',index:2,held:0},{kind:'Stop',operation:'MirrorTarget',index:1,held:0},{kind:'Resume',operation:'MirrorTarget',index:2,held:1},{kind:'Archive',operation:'IngressOrigin',index:2,held:1}] as const)it(`installed ${item.kind} cancellation joins blocked ${item.operation} before releasing custody or starting successor work`,async t=>{
 let armed=false,count=0,blocker:DatabaseSync|undefined,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;}),operations:string[]=[],run=OwnedWorkerSlot.prototype.run;
 t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(armed){const url=String(args[0]),q=args[1] as {path:string;operation:string};operations.push(url+':'+String(q.operation));if(url.endsWith('/prompt-intake/native-state-worker.ts')&&q.operation===item.operation&&++count===item.index){blocker=new DatabaseSync(q.path);blocker.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');const task=run.apply(this,args);entered();return task;}}return run.apply(this,args);});
 await fixture(true,async f=>{await admitReadCommand(f,item.kind);const before=await state.getIngress(f.path,'message:5'),cancel=new AbortController(),reason=new Error('cancel blocked admission read');let settled=false;armed=true;
  const pending=f.executor.executeWithIngressContext(admittedAction(item.kind),actor,'message:5',cancel.signal),rejected=assert.rejects(pending,e=>e===reason);void pending.then(()=>{settled=true;},()=>{settled=true;});
  try{await started;const atCancel=operations.length,seenBefore=await f.seen();cancel.abort(reason);await new Promise(r=>setTimeout(r,100));assert.equal(settled,false);assert.equal(ownedWorkerUsage().Control,1);assert.equal(f.queue.locks.activeTargetCount,item.held);assert.equal(operations.length,atCancel);
   blocker!.exec('ROLLBACK');await rejected;assert.equal(ownedWorkerUsage().Control,0);assert.equal(f.queue.locks.activeTargetCount,0);assert.equal(operations.length,atCancel);assert.deepEqual(await f.seen(),seenBefore);assert.deepEqual(await state.getIngress(f.path,'message:5'),before);assert.equal(await state.archiveTargetFenced(f.path,'root'),false);
  }finally{armed=false;cancel.abort(reason);if(blocker?.isTransaction)blocker.exec('ROLLBACK');await pending.catch(()=>{});blocker?.close();}
 },20000,writeFlowCode);
});
it('installed Settings retains first native ingress stop origin across the second admission read',async t=>{
 let armed=false,reads=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const task=run.apply(this,args),q=args[1] as {path:string;operation:string};if(armed&&String(args[0]).endsWith('/prompt-intake/native-state-worker.ts')&&q.operation==='IngressRead'&&++reads===1)return task.then(value=>{const db=new DatabaseSync(q.path);try{db.exec("UPDATE cdr_stop_clock SET revision=1; INSERT INTO cdr_stop_revision_receipts VALUES('later-stop','root',1,'{}'); INSERT INTO cdr_stop_revisions VALUES('root',1,'later-stop'); UPDATE discord_ingress_journal SET payload_json=json_set(payload_json,'$.stop_origin.stopRevision',1)");}finally{db.close();}return value;});return task;});
 await fixture(true,async f=>{await admitReadCommand(f,'Settings');armed=true;try{await assert.rejects(f.executor.executeWithIngressContext(admittedAction('Settings'),actor,'message:5'),/predates stop|revision evidence/);}finally{armed=false;}assert.equal(reads,2);assert.ok((await f.seen()).every(row=>row.method!=='thread/resume'&&row.method!=='thread/settings/update'));assert.equal(f.bridge.threadSettings('root').model,null);assert.equal(f.queue.locks.activeTargetCount,0);},20000,writeFlowCode);
});
it('installed Archive reparses original event content again immediately before reservation',async t=>{
 let armed=false,origins=0,reservations=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const q=args[1] as {path:string;operation:string};if(armed){if(String(args[0]).includes('archive-write-native-worker'))reservations++;if(String(args[0]).endsWith('/prompt-intake/native-state-worker.ts')&&q.operation==='IngressOrigin'&&++origins===2){const db=new DatabaseSync(q.path);try{db.exec("UPDATE discord_ingress_journal SET payload_json=json_set(payload_json,'$.content','!stop') WHERE ingress_id='message:5'");}finally{db.close();}}}return run.apply(this,args);});
 await fixture(true,async f=>{await admitReadCommand(f,'Archive');armed=true;try{await assert.rejects(f.executor.executeWithIngressContext(admittedAction('Archive'),actor,'message:5'),/original command/);}finally{armed=false;}assert.equal(origins,2);assert.equal(reservations,0);assert.ok((await f.seen()).every(row=>row.method!=='thread/archive'));assert.equal(await state.archiveTargetFenced(f.path,'root'),false);assert.equal(f.queue.locks.activeTargetCount,0);},20000,writeFlowCode);
});
it('installed Archive admission deadline cannot release an active native read or submit a successor',async t=>{
 let armed=false,reads=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){if(armed)reads++;return run.apply(this,args);});
 await fixture(true,async f=>{await admitReadCommand(f,'Archive');const blocker=new DatabaseSync(f.path);blocker.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');let settled=false;armed=true;
  const pending=f.executor.executeWithIngressContext(admittedAction('Archive'),actor,'message:5'),rejected=assert.rejects(pending,/archive operation timed out; no archive was sent/);void pending.then(()=>{settled=true;},()=>{settled=true;});
  try{await new Promise(r=>setTimeout(r,300));assert.equal(settled,false);assert.equal(reads,1);assert.equal(ownedWorkerUsage().Control,1);assert.equal(f.queue.locks.activeTargetCount,0);blocker.exec('ROLLBACK');await rejected;assert.equal(reads,1);assert.equal(ownedWorkerUsage().Control,0);assert.deepEqual(await f.seen(),[]);assert.equal(await state.archiveTargetFenced(f.path,'root'),false);}
  finally{armed=false;if(blocker.isTransaction)blocker.exec('ROLLBACK');await pending.catch(()=>{});blocker.close();}
 },200,writeFlowCode);
});
it('installed Archive final native event-origin lookup must still own the same request ID',async t=>{
 let armed=false,origins=0;const run=OwnedWorkerSlot.prototype.run;t.mock.method(OwnedWorkerSlot.prototype,'run',function(this:OwnedWorkerSlot,...args:Parameters<typeof run>){const q=args[1] as {path:string;operation:string};if(armed&&String(args[0]).endsWith('/prompt-intake/native-state-worker.ts')&&q.operation==='IngressOrigin'&&++origins===2){const db=new DatabaseSync(q.path);try{db.exec("UPDATE discord_ingress_journal SET ingress_id='changed-original' WHERE ingress_id='message:5'");}finally{db.close();}}return run.apply(this,args);});
 await fixture(true,async f=>{await admitReadCommand(f,'Archive');armed=true;try{await assert.rejects(f.executor.executeWithIngressContext(admittedAction('Archive'),actor,'message:5'),/archive original admission changed/);}finally{armed=false;}assert.equal(origins,2);assert.ok((await f.seen()).every(row=>row.method!=='thread/archive'));assert.equal(await state.archiveTargetFenced(f.path,'root'),false);assert.equal(f.queue.locks.activeTargetCount,0);},20000,writeFlowCode);
});
