import {it} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {dirname,join} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';import {BridgeState} from '../../../src/runtime/bridge-state.ts';import {QueueStartCoordinator} from '../../../src/runtime/queue-runner/start-coordinator.ts';import {RuntimeCommandExecutor} from '../../../src/runtime/action-executor/command-executor.ts';import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';import {AppServerTurnBackend} from '../../../src/runtime/app-server-turn-backend.ts';import {createMutationCustodyFence} from '../../../src/runtime/mutation-custody-fence.ts';import {INTERVIEW_HEADER} from '../../../src/runtime/action-executor/interview-header.ts';import {actionExecutionErrorInfo} from '../../../src/runtime/action-executor/action-error.ts';import {joinDiagnosticReaders} from '../../../src/runtime/diagnostic-report.ts';
const actor={channelId:42n,userId:3n,discordMessageId:5n,autoQueueWhenBusy:false};
const code=`import readline from 'node:readline';const seen=[];let hangStart=false;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line),reply=result=>emit({id:m.id,result});if(m.method==='initialized')return;if(m.method==='initialize'){reply({});return;}if(m.method==='fixture/seen'){reply(seen);return;}if(m.method==='fixture/hang-start'){hangStart=true;reply({});return;}seen.push({method:m.method,params:m.params});if(m.method==='thread/start'){if(!hangStart)reply({thread:{id:'created'}});}else if(m.method==='thread/resume')reply({thread:{id:m.params.threadId}});else if(m.method==='thread/read')reply({thread:{id:m.params.threadId,status:{type:'idle'},turns:[]}});else if(m.method==='turn/start')reply({turn:{id:'turn'}});else emit({id:m.id,error:{code:-9,message:'unsupported fixture call'}});});`;
async function fixture(native:boolean,run:(f:{path:string;bridge:BridgeState;queue:QueueStartCoordinator;executor:RuntimeCommandExecutor;server:PortableResidentLifecycle|null;starts:string[];notifications:()=>number;seen:()=>Promise<any[]>})=>Promise<void>){await storeFixture(async path=>{
 const codex=join(dirname(path),'codex.sqlite'),bridgePath=join(dirname(path),'bridge.json'),bridge=new BridgeState(bridgePath);bridge.setSelectedThreadId('root');const cd=new DatabaseSync(codex);try{cd.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);INSERT INTO threads(id,title,cwd,updated_at,archived,archived_at) VALUES('root','Root','/tmp',1,0,0)");}finally{cd.close();}
 const db=await openInitialized(path);try{db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime');INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");}finally{db.close();}
 const render=(e:unknown)=>e instanceof Error?e.message:'fixture error';const server=native?await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'command',title:'fixture',version:'1'}},render,{persistDeadWork(){},oldChildExited(){}},undefined,{renderError:render,fence:createMutationCustodyFence(path,'runtime',render)}):null;
 const backend=server===null?null:new AppServerTurnBackend(server,render,{resumeTimeoutMs:1000,historyTimeoutMs:1000}),starts:string[]=[];let notifications=0;
 const queue=new QueueStartCoordinator(path,backend??{generation:()=>1n,residentInstanceId:()=> 'resident',activeTurnId:async()=>null,resumeThread:async()=>{},readTurns:async()=>[],startClaimedTurn:async(claim:{prompt:string})=>{starts.push(claim.prompt);return 'turn';}},{notifyDeliveryReady:()=>{notifications++;}});
 const executor=new RuntimeCommandExecutor({paths:{state:codex,mirror:path,bridge:bridgePath},bridge,server,backend,queue,render,preparePrompt:async p=>p+' enriched',mirror:null,reportNewAttempt:()=>{},resumeTimeoutMs:2000});
 const seen=async()=>{if(server===null)return [];const a=server.admitResponse(server.generation());try{return await a.client.requestAdmitted(a.permit,'fixture/seen',{},1000) as any[];}finally{a.release();}};
 try{await run({path,bridge,queue,executor,server,starts,notifications:()=>notifications,seen});}finally{await server?.dispose();await joinDiagnosticReaders();}
});}
async function admit(path:string,kind:'Resume'|'Stop'|'Repair'|'Archive',event=5n){await state.admitIngress(path,{ingressId:`message:${event}`,kind:'message',eventId:event,applicationId:null,channelId:42n,ownerUserId:3n,sourceMessageId:event,targetThreadId:'root',canonicalOwner:null,now:1,payload:{version:1n,content:'!'+kind.toLowerCase(),plan:{Execute:{[kind]:{reference:null}}},lifecycle_binding:{target:'root',route:'Selected',command:{[kind]:{reference:null}}},stop_origin:{target:'root',stopRevision:0n}}});const db=await openInitialized(path);try{db.prepare("UPDATE discord_ingress_journal SET state='executing',phase='processing' WHERE ingress_id=?").run(`message:${event}`);}finally{db.close();}}
it('concrete message service functions invoke durable Ask queue and repeated message never dispatches twice',async()=>fixture(false,async f=>{
 const service=f.executor.messageServices();for(const name of ['targetThreadId','executeWithIngressContext','notifyDeliveryReady'])assert.equal(typeof Object.getOwnPropertyDescriptor(service,name)?.value,'function');assert.ok(Object.isFrozen(service));assert.equal(await service.targetThreadId(42n),'root');
 const first=await service.executeWithIngressContext({Ask:{prompt:'raw'}},actor,'message:5');assert.match(first.text,/In progress/);await service.executeWithIngressContext({Ask:{prompt:'raw'}},actor,'message:5');assert.deepEqual(f.starts,['raw enriched']);assert.equal((await state.listQueueJobs(f.path)).length,1);service.notifyDeliveryReady();assert.ok(f.notifications()>0);
}));
it('Interview reaches same durable queue with exact pinned header',async()=>fixture(false,async f=>{
 await f.executor.executeWithIngressContext({Interview:{prompt:'question'}},actor,'message:5');assert.deepEqual(f.starts,[INTERVIEW_HEADER+'question enriched']);
}));
it('New composition executes real native creation and first turn once with preserved origin',async()=>fixture(true,async f=>{
 const action={New:{prompt:'raw'}};await f.executor.executeWithIngressContext(action,actor,'message:5');await f.executor.executeWithIngressContext(action,actor,'message:5');assert.deepEqual((await f.seen()).map(x=>x.method),['thread/start','turn/start']);assert.equal(f.bridge.selectedThreadId(),'created');const saved=await state.ingressByOrigin(f.path,5n);assert.equal(saved?.ownerUserId,3n);assert.equal(saved?.channelId,42n);assert.equal(saved?.state,'owned');
}));
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
 try{for(let i=0;;i++){if((await f.seen()).some(x=>x.method==='thread/start'))break;if(i===100)throw Error('native creation was not observed');await new Promise<void>(r=>setTimeout(r,5));}c.abort(reason);await observed;}finally{c.abort(reason);}
 assert.equal(p.posts.length,0);assert.equal((await state.getIngress(f.path,'message:5'))?.state,'held');assert.deepEqual(await state.listQueueJobs(f.path),[]);await p.handle('!new raw');assert.equal((await f.seen()).filter(x=>x.method==='thread/start').length,1);
})));
