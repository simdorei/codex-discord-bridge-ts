import test from 'node:test';
import assert from 'node:assert/strict';
import {BridgeBroker} from '../../src/mcp-server/broker.ts';
import {parseBridgeInboundMessage,type BridgeResult} from '../../src/remote-agent/bridge-inbound.ts';
const project=(binding='binding-a-12345678')=>({scope:'scope-project-aaaa',binding,thread:'thread-a',name:'fixture',expires:Date.now()+3600000});
const result=(input:unknown)=>parseBridgeInboundMessage(JSON.stringify(input),12000000) as BridgeResult;
test('broker never replays pending work and restores only the exact binding on reconnect',async()=>{
 const broker=new BridgeBroker(5000),frames:any[]=[],first=broker.attach('pc',raw=>frames.push(JSON.parse(raw)),()=>{}),p=project();broker.upsert(first,p);
 const selecting=broker.selectProject('session','principal',p.scope);let command=frames.at(-1);broker.complete(first,result({type:'project_session_result',request_id:command.request_id}));await selecting;
 const pending=broker.command('session','principal',{type:'project_info'},'project_info_result');const abandoned=frames.at(-1);broker.detach(first);await assert.rejects(pending,/not replayed/);
 const second=broker.attach('pc',raw=>frames.push(JSON.parse(raw)),()=>{});broker.upsert(second,p);const resume=broker.resume(second,p);command=frames.at(-1);assert.equal(command.type,'project_session');assert.ok(command.computer_session_generation>frames[0].computer_session_generation);
 broker.complete(first,result({type:'project_session_result',request_id:command.request_id}));broker.complete(second,result({type:'project_session_result',request_id:command.request_id}));assert.equal(await resume,true);assert.equal(frames.filter(c=>c.request_id===abandoned.request_id).length,1);
 await assert.rejects(broker.command('session','other-principal',{type:'project_info'},'project_info_result'),/principal/);
 broker.detach(second);const third=broker.attach('pc',raw=>frames.push(JSON.parse(raw)),()=>{}),replacement=project('binding-b-12345678');broker.upsert(third,replacement);assert.equal(await broker.resume(third,replacement),false);await assert.rejects(broker.command('session','principal',{type:'project_info'},'project_info_result'),/Select a project/);broker.close();
});
test('broker cancellation and selection failures do not transfer authority or leak pending request capacity',async()=>{
 const broker=new BridgeBroker(5000),frames:any[]=[],connection=broker.attach('pc',raw=>frames.push(JSON.parse(raw)),()=>{}),other=broker.attach('other',()=>{},()=>{}),p=project();broker.upsert(connection,p);assert.throws(()=>broker.upsert(other,p),/another device/);
 const failed=broker.selectProject('session','owner',p.scope);broker.complete(connection,result({type:'operation_error',request_id:frames.at(-1).request_id,error_code:'fixture',message:'refused'}));await assert.rejects(failed,/refused/);await assert.rejects(broker.command('session','owner',{type:'project_info'},'project_info_result'),/Select a project/);
 const selected=broker.selectProject('session','owner',p.scope);broker.complete(connection,result({type:'project_session_result',request_id:frames.at(-1).request_id}));await selected;
 for(let i=0;i<40;i++){const controller=new AbortController(),request=broker.command('session','owner',{type:'project_info'},'project_info_result',controller.signal);controller.abort();await assert.rejects(request,/cancelled/);}
 const next=broker.command('session','owner',{type:'project_info'},'project_info_result');broker.complete(other,result({type:'project_info_result',request_id:frames.at(-1).request_id,output:{root:'wrong',thread_id:'thread-a'}}));broker.complete(connection,result({type:'project_info_result',request_id:frames.at(-1).request_id,output:{root:'correct',thread_id:'thread-a'}}));assert.equal((await next as any).root,'correct');broker.close();
});
