import assert from "node:assert/strict";
import {test,type TestContext} from "node:test";
import {OwnedPortableAppServerProcess} from "../../src/app-server/portable-process.ts";
import {ClientLifecycle} from "../../src/app-server/client-lifecycle.ts";
import {ClientRuntimeState} from "../../src/app-server/runtime-state.ts";
import {PendingResponses} from "../../src/app-server/pending-responses.ts";
import {ClientCloseCoordinator} from "../../src/app-server/close-coordinator.ts";
import {ClientProcessCloser} from "../../src/app-server/process-close.ts";
import {AppServerWriter} from "../../src/app-server/writer.ts";
import {AppServerRequestClient,AppServerRequestError} from "../../src/app-server/request-client.ts";
import {AppServerResponseClient} from "../../src/app-server/response-client.ts";
import {TransportLineDispatcher} from "../../src/app-server/transport-dispatch.ts";
import {BoundedDiagnostics} from "../../src/app-server/diagnostics.ts";
import {FatalUtf8LineReader} from "../../src/app-server/line-reader.ts";
import {NodeAppServerInput} from "../../src/app-server/node-streams.ts";
import {drainStdout,drainStderr} from "../../src/app-server/transport-drain.ts";
import {initializeObserved} from "../../src/app-server/startup-handshake.ts";
import type {PendingServerRequest} from "../../src/app-server/server-request-state.ts";
const info={name:"fixture",title:"Owned test helper",version:"0.1.0"};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
async function fixture(t:TestContext,mode:"normal"|"init-failure"|"hang"){
  // Local generated protocol fixture only: never Codex, authentication or a network service.
  const code=`import readline from 'node:readline';
const mode=${JSON.stringify(mode)};const emit=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize'){emit({method:'test/initializeSeen'});if(mode==='hang')return;if(mode==='init-failure'){emit({id:m.id,error:{code:-32001,message:'fixture initialize failure'}});return;}emit({id:m.id,result:{ready:true}});}
 else if(m.method==='initialized'){emit({method:'turn/started',params:{threadId:'thread',turnId:'turn'}});emit({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'thread',turnId:'turn'}});}
 else if(m.method==='thread/read')emit({id:m.id,result:{threadId:m.params.threadId,source:'native helper'}});
 else if(m.method==='bad/input')process.stdout.write(Buffer.from([255,10]));
 else if(m.id==='approval')emit({method:'test/responseSeen',params:m.result});
});lines.on('close',()=>process.stderr.write('helper complete\\n'));`;
  const native=await OwnedPortableAppServerProcess.spawn({executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}});let tasks:Promise<void>[]=[];
  t.after(async()=>{await native.forceDispose();await Promise.allSettled(tasks);});
  const gate=new ClientLifecycle(),state=new ClientRuntimeState(native.processId),pending=new PendingResponses(gate),logical=new ClientCloseCoordinator(gate,state,pending),writer=new AppServerWriter(native.input,logical),client=new AppServerRequestClient(gate,pending,writer),diagnostics=new BoundedDiagnostics();
  const requests:PendingServerRequest[]=[],initializeSeen=deferred(),approval=deferred(),responseSeen=deferred();
  const enqueueRequest=(r:PendingServerRequest)=>{requests.push(r);approval.resolve();};
  const dispatcher=new TransportLineDispatcher(gate,state,pending,diagnostics,{enqueueServerRequest:enqueueRequest,enqueueNotification:n=>{if(n.method==="test/initializeSeen")initializeSeen.resolve();if(n.method==="test/responseSeen")responseSeen.resolve();},renderParseError:stage=>`${stage} parse failure`});
  const responder=new AppServerResponseClient(gate,state,writer,enqueueRequest),closer=new ClientProcessCloser(logical,state,writer,native,async input=>{assert.ok(input instanceof NodeAppServerInput);try{await input.shutdown();}finally{await input.destroyAndJoin();}});
  tasks=[drainStdout(new FatalUtf8LineReader(native.stdout),dispatcher,logical,diagnostics,()=>"invalid native output"),drainStderr(new FatalUtf8LineReader(native.stderr),diagnostics,()=>"stderr error")];for(const task of tasks)void task.catch(()=>undefined);
  const cleanupOwned=async()=>{await closer.close();for(const result of await Promise.allSettled(tasks))if(result.status==="rejected")throw result.reason;await native.forceDispose();};
  return {native,gate,state,pending,logical,client,responder,diagnostics,requests,initializeSeen,approval,responseSeen,cleanupOwned};
}
test("native helper handshake, request, current-turn response and graceful close compose",{timeout:10000},async t=>{
  const f=await fixture(t,"normal");let disposed=0;
  const observer=await initializeObserved(f,info,()=>({value:"observer",dispose(){disposed++;}}),t.signal);assert.equal(observer.value,"observer");assert.equal(f.state.snapshot().healthy,true);assert.equal(f.state.snapshot().generation,1n);assert.equal(disposed,0);
  assert.deepEqual(await f.client.request("thread/read",{threadId:"thread"},1000),{threadId:"thread",source:"native helper"});await f.approval.promise;
  const request=f.requests[0]!;assert.equal(f.state.activeTurnId("thread"),"turn");await f.responder.respondCurrent(request.id,request.occurrence,{approved:true});await f.responseSeen.promise;
  assert.equal(f.state.hasUnsettledServerRequests,false);assert.equal(f.pending.size,0);assert.equal(f.gate.snapshot().inFlight,0n);
  await f.cleanupOwned();assert.equal(f.state.processExitConfirmed,true);assert.equal(f.native.exitConfirmed,true);assert.equal(f.native.stdioClosed,true);assert.equal(await f.gate.waitClosed(),"closed by client");assert.ok(f.diagnostics.snapshot().lines.includes("helper complete"));observer.dispose();assert.equal(disposed,1);
});
test("native initialization failure reaps helper and disposes observer before rejection",{timeout:10000},async t=>{
  const f=await fixture(t,"init-failure");let disposed=0;
  await assert.rejects(initializeObserved(f,info,()=>({value:null,dispose(){disposed++;}}),t.signal),error=>error instanceof AppServerRequestError&&error.detail.kind==="Remote"&&error.detail.code===-32001n);
  assert.equal(disposed,1);assert.equal(f.native.exitConfirmed,true);assert.equal(f.native.stdioClosed,true);assert.equal(f.state.snapshot().initialized,false);assert.equal(f.state.snapshot().generation,0n);assert.equal(f.gate.snapshot().inFlight,0n);assert.equal(f.pending.size,0);
});
test("native startup cancellation after initialize receipt joins owned cleanup",{timeout:10000},async t=>{
  const f=await fixture(t,"hang"),abort=new AbortController(),reason={canceled:true};let disposed=0;
  const startup=initializeObserved(f,info,()=>({value:null,dispose(){disposed++;}}),abort.signal),rejected=assert.rejects(startup,error=>error===reason);await f.initializeSeen.promise;abort.abort(reason);await rejected;
  assert.equal(disposed,1);assert.equal(f.native.exitConfirmed,true);assert.equal(f.native.stdioClosed,true);assert.equal(f.state.snapshot().initialized,false);assert.equal(f.gate.snapshot().inFlight,0n);assert.equal(f.pending.size,0);
});
test("invalid native UTF-8 closes transport, rejects pending request and prevents reuse",{timeout:10000},async t=>{
  const f=await fixture(t,"normal"),observer=await initializeObserved(f,info,()=>({value:null,dispose(){}}),t.signal);
  await assert.rejects(f.client.request("bad/input",{},1000),error=>error instanceof AppServerRequestError&&error.detail.kind==="TransportClosed"&&error.detail.reason==="app-server stdout read failed");
  await assert.rejects(f.client.request("thread/read",{},1000),/closed/);assert.equal(f.state.snapshot().healthy,false);assert.equal(f.pending.size,0);assert.equal(f.gate.snapshot().inFlight,0n);assert.ok(f.diagnostics.snapshot().lines.includes("stdout read failed: invalid native output"));await f.cleanupOwned();assert.equal(f.native.exitConfirmed,true);observer.dispose();
});
