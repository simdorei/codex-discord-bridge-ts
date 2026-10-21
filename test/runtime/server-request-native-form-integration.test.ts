import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,realpathSync,lstatSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import type {DatabaseSync} from 'node:sqlite';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {startRuntimeResident} from '../../src/runtime/discord-runtime/resident-startup.ts';
import {ServerRequestDelivery} from '../../src/runtime/server-request-delivery.ts';
import {runServerRequestWorker,type ServerRequestWorkerReport} from '../../src/runtime/server-request-worker.ts';
import {createNativePromptAuthorityReads} from '../../src/runtime/server-prompt-authority-reads.ts';
import {PromptAuthorityError} from '../../src/runtime/server-prompt-authority.ts';
import {ownedWorkerUsage} from '../../src/runtime/owned-worker-slot.ts';
import {isOwnedMutationOutcomeUnknown} from '../../src/app-server/maintenance-attempt.ts';
import {ServerRequestOccurrence} from '../../src/protocol/ids.ts';
import {sha256SerdeValue} from '../../src/core/serde-json.ts';
import type {PendingServerRequest} from '../../src/app-server/server-request-state.ts';
import type {DiscordReceiptTransport} from '../../src/runtime/completion/receipt-sender.ts';
import {instrumentStoreWorker,waitTrace,releaseTrace} from '../helpers/store-authority-worker-fixture.ts';

// Installed-core integration only: genuine startup custody, resident child,
// original serial receiver, native observations/response completion/receipts.
// Transport callbacks are passive witnesses. No HTTP, live computer/browser,
// operational singleton, persistent-resident activation or full-root claim.
const child="import readline from 'node:readline';const answers=[],emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method===undefined&&m.id==='approval'){answers.push(m);return;}if(m.method==='ask'){emit({method:'turn/started',params:{threadId:'T',turnId:'V'}});emit({id:'approval',method:m.params.method,params:m.params.params});}if(m.id!==undefined)emit({id:m.id,result:m.method==='answers'?answers:{}});});";
const form=(connector:'computer-use'|'browser',risk='low',dataEntry=false)=>({method:'mcpServer/elicitation/request',params:{threadId:'T',turnId:'V',mode:connector==='browser'?'openai/form':'form',serverName:'node_repl',_meta:{codex_approval_kind:'mcp_tool_call',connector_id:connector,riskLevel:risk},requestedSchema:{type:'object',properties:dataEntry?{answer:{type:'string'}}:{},required:dataEntry?['answer']:[]}}});
const approval={method:'item/commandExecution/requestApproval',params:{threadId:'T',turnId:'V'}};
function idle(){assert.deepEqual(ownedWorkerUsage(),{Background:0,Control:0,Bridge:0,Observation:0,Discovery:0,Maintenance:0});}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function until(check:()=>boolean){const deadline=performance.now()+5000;while(!check()){assert.ok(performance.now()<deadline,'bounded original-work observation');await new Promise(resolve=>setTimeout(resolve,5));}}
async function bounded<T>(promise:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Bounded integration observation timed out')),5000);})]);}finally{clearTimeout(timer);}}

async function fixture(signal:AbortSignal,run:(f:{owner:Awaited<ReturnType<typeof startRuntimeResident>>;db:DatabaseSync;path:string;stop:AbortController;reports:ServerRequestWorkerReport[];call:(method:string,params?:unknown)=>Promise<unknown>;ask:(input:typeof approval)=>Promise<PendingServerRequest>;start:(transport:DiscordReceiptTransport)=>Promise<void>;getEnded:()=>boolean;recover:(transport:DiscordReceiptTransport)=>Promise<void>})=>Promise<void>){
 const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,'cdr-native-form-')),initial=realpathSync(root),identity=lstatSync(root),path=join(root,'store.sqlite');
 let owner:Awaited<ReturnType<typeof startRuntimeResident>>|undefined,db:DatabaseSync|undefined,clean=false;
 const stop=new AbortController(),reports:ServerRequestWorkerReport[]=[];let running:Promise<void>|undefined,ended=false;
 try{
  owner=await startRuntimeResident({process:{executable:process.execPath,arguments:['--no-strip-types','--input-type=module','-e',child],environment:{}},clientInfo:{name:'native-form-integration',title:'Fixture',version:'971'}},path,'runtime',null,()=> 'safe fixture',signal);
  const server=owner,receiver=server.subscribeServerRequests(),observer=server.subscribeServerRequests();
  const call=async(method:string,params:unknown={})=>{const admission=server.admitResponse(1n);try{return await admission.client.requestAdmitted(admission.permit,method,params,2000);}finally{admission.release();}};
  try{
   db=await openInitialized(path);db.exec("INSERT INTO codex_turn_queue(job_id,target_thread_id,channel_id,owner_user_id,app_server_generation,prompt,queued,ack_sent,state,attempt_count,turn_id,baseline_turn_ids,created_at,updated_at) VALUES('job','T',42,3,1,'input',0,1,'running',1,'V','[]',1,1); INSERT INTO mirror_threads VALUES('T','P','title',10,42,1)");
   const delivery=(transport:DiscordReceiptTransport)=>new ServerRequestDelivery(path,server,transport,true,createNativePromptAuthorityReads(path));
   await run({owner:server,db,path,stop,reports,call,
    ask:async input=>{await call('ask',input);const event=await bounded(observer.receive(signal));assert.equal(event.kind,'Request');if(event.kind!=='Request')throw new Error('Expected original request');assert.equal(event.generation,1n);return event.request;},
    start:transport=>{assert.equal(running,undefined);running=runServerRequestWorker(receiver,server,delivery(transport),stop.signal,event=>{reports.push(event);}).finally(()=>{ended=true;});void running.catch(()=>undefined);return running;},
    getEnded:()=>ended,recover:transport=>delivery(transport).recover(),
   });
  }finally{stop.abort(new Error('Fixture shutdown'));try{await running;if(running!==undefined)assert.equal(receiver.tryReceive().kind,'Closed');}finally{if(running===undefined)receiver.dispose();observer.dispose();}}
  await server.dispose();assert.equal(server.lifecycleSnapshot().processId,null);idle();clean=true;
 }finally{
  stop.abort(new Error('Fixture cleanup'));
  try{await running;}finally{try{await owner?.dispose();if(owner!==undefined){assert.equal(owner.lifecycleSnapshot().processId,null);idle();clean=true;}}finally{db?.close();}}
  // A failed owned join/disposal retains its root. Process supervisor closure
  // alone never grants logical root-cleanup permission.
  if(clean){assert.equal(realpathSync(root),initial);assert.equal(dirname(initial),parent);const current=lstatSync(root);assert.equal(current.isSymbolicLink(),false);assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);rmSync(root,{recursive:true});}
 }
}

function responseRow(db:DatabaseSync,owner:string,request:PendingServerRequest,result:unknown){
 const rows=db.prepare('SELECT request_key,runtime_id,resident_owner,generation,target_thread_id,turn_id,job_id,authority_json,response_sha256,phase FROM cdr_server_responses').all();assert.equal(rows.length,1);const row=rows[0]!;
 const occurrence=Array.from(ServerRequestOccurrence.prototype.asBytes.call(request.occurrence),v=>BigInt(v));
 assert.equal(row.request_key,sha256SerdeValue(['runtime',owner,1n,request.id,occurrence]));
 assert.equal(row.response_sha256,sha256SerdeValue({id:request.id,result}));
 assert.equal(row.runtime_id,'runtime');assert.equal(row.resident_owner,owner);assert.equal(row.generation,1);assert.equal(row.target_thread_id,'T');assert.equal(row.turn_id,'V');assert.equal(row.job_id,'job');assert.equal(row.phase,'flushed');
 const authority=JSON.parse(String(row.authority_json)) as {request_sha256:string};assert.equal(authority.request_sha256,sha256SerdeValue({id:request.id,occurrence,method:request.method,params:request.params}));
}

for(const [connector,risk,action,recovery] of [['computer-use','low','accept',true],['browser','low','accept',false],['computer-use','low','cancel',false]] as const)test(`original native serial form: ${connector} ${risk}${action==='cancel'?' data-entry':''} -> ${action}${recovery?' through initial recovery':''}`,{timeout:20000},async t=>fixture(t.signal,async f=>{
 let sends=0;const transport:DiscordReceiptTransport={async sendValidated(){sends++;return 91n;}};
 if(!recovery)void f.start(transport);
 const request=await f.ask(form(connector,risk,action==='cancel'));if(recovery)void f.start(transport);
 await until(()=>f.db.prepare("SELECT count(*) AS n FROM cdr_server_responses WHERE phase='flushed'").get()!.n===1&&ownedWorkerUsage().Control===0);
 const result={action,content:action==='accept'?{}:null,_meta:null};assert.deepEqual(await f.call('answers'),[{id:'approval',result}]);responseRow(f.db,f.owner.instanceId,request,result);
 assert.equal(f.owner.pendingServerRequests('T').length,0);assert.equal(sends,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM codex_delivery_receipts').get()!.n,0);
 f.stop.abort(new Error('Normal loop shutdown'));await until(f.getEnded);await f.recover(transport);assert.deepEqual(await f.call('answers'),[{id:'approval',result}]);assert.equal(sends,0);
 // Initial recovery may consume the same occurrence before its already-buffered
 // event is visited. The original loop rejects that stale event; never replays.
 assert.ok(f.reports.every(e=>e.kind==='Error'&&e.error instanceof PromptAuthorityError));idle();
}));

for(const recovery of [true,false])test(`original native form ${recovery?'initial recovery':'live event'} cancellation waits for committed completion worker exit and never replays`,{timeout:20000},async t=>fixture(t.signal,async f=>{
 const trace=new SharedArrayBuffer(8),restore=instrumentStoreWorker({match:'native-response-completion-worker'+(import.meta.url.endsWith('.js')?'.js':'.ts'),trace});
 let sends=0;const transport:DiscordReceiptTransport={async sendValidated(){sends++;return 92n;}};
 try{
  if(!recovery)void f.start(transport);
  const request=await f.ask(form('browser'));if(recovery)void f.start(transport);await waitTrace(trace);
  const result={action:'accept',content:{},_meta:null};responseRow(f.db,f.owner.instanceId,request,result);assert.deepEqual(await f.call('answers'),[{id:'approval',result}]);assert.equal(ownedWorkerUsage().Control,1);
  f.stop.abort(new Error('Shutdown during actual completion join'));await new Promise(resolve=>setImmediate(resolve));assert.equal(f.getEnded(),false);assert.equal(ownedWorkerUsage().Control,1);
  releaseTrace(trace);restore();await until(f.getEnded);idle();assert.equal(sends,0);assert.equal(f.owner.pendingServerRequests('T').length,0);
  // Recovery preserves its own cancellation boundary before retaining a failure.
  // Live event processing instead reports the joined native Unknown unchanged.
  if(recovery)assert.deepEqual(f.reports,[]);else{assert.equal(f.reports.length,1);const report=f.reports[0]!;assert.ok(report.kind==='Error'&&isOwnedMutationOutcomeUnknown(report.error));}
  responseRow(f.db,f.owner.instanceId,request,result);
  await f.recover(transport);assert.deepEqual(await f.call('answers'),[{id:'approval',result}]);assert.equal(sends,0);
 }finally{releaseTrace(trace);restore();}
}));

test('original native non-form serial delivery joins late passive acceptance and its durable receipt on shutdown',{timeout:20000},async t=>fixture(t.signal,async f=>{
 const entered=deferred(),release=deferred(),aborted=deferred();let sends=0,reason:unknown;
 const transport:DiscordReceiptTransport={async sendValidated(_request,signal){sends++;assert.ok(signal);assert.equal(f.db.prepare('SELECT message_id FROM codex_delivery_receipts').get()!.message_id,null);const abort=()=>{reason=signal.reason;aborted.resolve();};signal.addEventListener('abort',abort,{once:true});try{entered.resolve();await release.promise;return 93n;}finally{signal.removeEventListener('abort',abort);}}};
 try{
  const request=await f.ask(approval);void f.start(transport);await bounded(entered.promise);const stop=new Error('Stop passive delivery');f.stop.abort(stop);await bounded(aborted.promise);assert.equal(reason,stop);assert.equal(f.getEnded(),false);
  release.resolve();await until(f.getEnded);assert.equal(sends,1);assert.deepEqual(await f.call('answers'),[]);assert.equal(f.db.prepare('SELECT message_id FROM codex_delivery_receipts').get()!.message_id,'93');assert.equal(f.db.prepare('SELECT count(*) AS n FROM cdr_server_responses').get()!.n,0);
  const pending=f.owner.pendingServerRequests('T');assert.equal(pending.length,1);assert.equal(pending[0]!.occurrence.equals(request.occurrence),true);assert.equal(f.reports.length,0);
  await f.recover(transport);assert.equal(sends,1,'a recreated delivery reuses the original native receipt');idle();
 }finally{release.resolve();}
}));
