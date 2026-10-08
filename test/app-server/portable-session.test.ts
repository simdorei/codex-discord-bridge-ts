import assert from "node:assert/strict";
import {test} from "node:test";
import {PortableAppServerSession,type PortableSessionConfig} from "../../src/app-server/portable-session.ts";
import {AppServerRequestError} from "../../src/app-server/request-client.ts";
import {BroadcastClosedError} from "../../src/app-server/broadcast.ts";
function config(mode="normal"):PortableSessionConfig{
  const code=`import readline from 'node:readline';const mode=${JSON.stringify(mode)};const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');const lines=readline.createInterface({input:process.stdin,crlfDelay:Infinity});lines.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize'){emit({method:'initializeSeen'});if(mode==='hang')return;if(mode==='error')emit({id:m.id,error:{code:-1,message:'fixture failed'}});else emit({id:m.id,result:{}});}else if(m.method==='initialized'){emit({method:'turn/started',params:{threadId:'t',turnId:'v'}});emit({id:'approval',method:'approval',params:{threadId:'t',turnId:'v'}});}else if(m.method==='read')emit({id:m.id,result:'native reply'});else if(m.method==='bad')process.stdout.write(Buffer.from([255,10]));else if(m.id==='approval')emit({method:'answered'});});lines.on('close',()=>process.stderr.write('final diagnostic\\n'));`;
  return {process:{executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{}},clientInfo:{name:"fixture",title:"Fixture",version:"0.1.0"}};
}
const render=()=>"safe diagnostic";
test("one owned session binds native startup, event subscriptions, requests and responses",{timeout:10000},async t=>{
  const {session,observer}=await PortableAppServerSession.startObserved(config(),session=>{const notifications=session.subscribeNotifications(),requests=session.subscribeServerRequests();return {value:{notifications,requests},dispose(){notifications.dispose();requests.dispose();}};},render,t.signal);t.after(()=>session.dispose());
  assert.equal(session.lifecycleSnapshot().healthy,true);assert.equal(await session.request("read",{},1000),"native reply");const request=await observer.value.requests.receive(t.signal);assert.equal(session.activeTurnId("t"),"v");await session.respondCurrent(request.id,request.occurrence,{approved:true});
  let method="";while(method!=="answered")method=(await observer.value.notifications.receive(t.signal)).method;assert.equal(session.pendingServerRequests().length,0);
  await session.dispose();assert.equal(session.resourcesClosed,true);assert.equal(session.processExitConfirmed,true);assert.ok(session.diagnosticSnapshot().lines.includes("final diagnostic"));await assert.rejects(observer.value.notifications.receive(),BroadcastClosedError);observer.dispose();await assert.rejects(session.request("read",{},1000),/closed/);
});
test("native startup error cleans the privately-owned session and installed observer",{timeout:10000},async t=>{
  let captured:PortableAppServerSession|undefined,disposed=0;
  await assert.rejects(PortableAppServerSession.startObserved(config("error"),session=>{captured=session;return {value:null,dispose(){disposed++;}};},render,t.signal),error=>error instanceof AppServerRequestError&&error.detail.kind==="Remote");assert.equal(disposed,1);assert.equal(captured!.resourcesClosed,true);assert.equal(captured!.lifecycleSnapshot().initialized,false);
});
test("native invalid UTF-8 closes the session and forbids new requests",{timeout:10000},async t=>{
  const {session,observer}=await PortableAppServerSession.startObserved(config(),()=>({value:null,dispose(){}}),render,t.signal);t.after(()=>session.dispose());await assert.rejects(session.request("bad",{},1000),error=>error instanceof AppServerRequestError&&error.detail.kind==="TransportClosed");assert.equal(session.lifecycleSnapshot().healthy,false);await assert.rejects(session.request("read",{},1000),/closed/);await session.dispose();assert.equal(session.resourcesClosed,true);observer.dispose();
});
test("unexpected diagnostic renderer failure seals transport and remains visible after cleanup",{timeout:10000},async t=>{
  const sentinel={},result=await PortableAppServerSession.startObserved(config(),()=>({value:null,dispose(){}}),()=>{throw sentinel;},t.signal),session=result.session;t.after(async()=>{try{await session.dispose();}catch{assert.equal(session.resourcesClosed,true);}});
  await assert.rejects(session.request("bad",{},1000),error=>error instanceof AppServerRequestError&&error.detail.kind==="TransportClosed"&&error.detail.reason==="app-server stdout handler failed");await assert.rejects(session.dispose(),error=>error instanceof AggregateError&&error.errors.includes(sentinel));assert.equal(session.resourcesClosed,true);assert.equal(session.lifecycleSnapshot().healthy,false);result.observer.dispose();
});
test("native factory startup cancellation retains owner until observer and process cleanup finish",{timeout:10000},async t=>{
  const abort=new AbortController(),reason={canceled:true};let captured:PortableAppServerSession|undefined,disposed=false;
  let installed!:()=>void;const ready=new Promise<void>(resolve=>{installed=resolve;});let notifications:ReturnType<PortableAppServerSession["subscribeNotifications"]>;
  const starting=PortableAppServerSession.startObserved(config("hang"),session=>{captured=session;notifications=session.subscribeNotifications();installed();return {value:null,dispose(){disposed=true;notifications.dispose();}};},render,abort.signal);
  const rejected=assert.rejects(starting,error=>error===reason);t.after(async()=>{if(captured)await captured.dispose();});await ready;
  assert.equal((await notifications!.receive(t.signal)).method,"initializeSeen");abort.abort(reason);await rejected;
  assert.equal(disposed,true);assert.equal(captured!.resourcesClosed,true);assert.equal(captured!.processExitConfirmed,true);assert.equal(captured!.lifecycleSnapshot().initialized,false);
});
test("separate native sessions cannot answer each other's identical request IDs",{timeout:10000},async t=>{
  const observe=(session:PortableAppServerSession)=>{const requests=session.subscribeServerRequests();return {value:requests,dispose(){requests.dispose();}};};
  const a=await PortableAppServerSession.startObserved(config(),observe,render,t.signal);t.after(()=>a.session.dispose());
  const b=await PortableAppServerSession.startObserved(config(),observe,render,t.signal);t.after(()=>b.session.dispose());
  const requestA=await a.observer.value.receive(t.signal),requestB=await b.observer.value.receive(t.signal);assert.equal(requestA.id,requestB.id);
  await assert.rejects(a.session.respondCurrent(requestA.id,requestB.occurrence,true),/stale/);assert.equal(a.session.pendingServerRequests().length,1);assert.equal(b.session.pendingServerRequests().length,1);
  await a.session.respondCurrent(requestA.id,requestA.occurrence,true);assert.equal(a.session.pendingServerRequests().length,0);assert.equal(b.session.pendingServerRequests().length,1);
  await a.session.dispose();assert.equal(await b.session.request("read",{},1000),"native reply");assert.equal(b.session.lifecycleSnapshot().healthy,true);await b.session.respondCurrent(requestB.id,requestB.occurrence,true);await b.session.dispose();a.observer.dispose();b.observer.dispose();
});
