import assert from 'node:assert/strict';import {test} from 'node:test';
import {decodeGatewayMessageOffThread as decode,decodeProjectOperationOffThread} from '../../src/remote-agent/native-decode.ts';
import {parseGatewayInboundMessage as parse} from '../../src/remote-agent/gateway-inbound.ts';
import {RemoteProtocolError} from '../../src/remote-agent/handshake.ts';
import {ownedWorkerUsage,OwnedWorkerBusyError} from '../../src/runtime/owned-worker-slot.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const budget=12000000,base={request_id:'r',thread_id:'t',deadline_at:'1970-1-1T0:0:0.123456789UTC'},session='s'.repeat(16);
test('native gateway envelope decodes both acknowledgements and all seven source command kinds',async()=>{
 const messages=[{type:'hello_ack'},{type:'project_ack',project_scope:'',binding_id:session},{type:'project_info',...base},{type:'list_files',...base,pattern:'*',limit:1n},{type:'read_file',...base,path:'x',start_line:18446744073709551615n,max_lines:1n},{type:'write_file',...base,path:'x',content:''},{type:'project_operation',...base,operation:{kind:'terminal_exec',command:'echo 안녕'}},{type:'project_session',...base,computer_session_id:session,computer_session_generation:1n},{type:'device_session',...base,computer_session_id:session,computer_session_generation:1n,working_directory:'x',expires_at:'1970-1-1T0:0:60.5Z'}];
 for(const value of messages){const raw=serializeSerdeValue(value),result=await decode(raw,budget);assert.deepEqual(result,structuredClone(parse(raw,budget,0)));assert.ok(Object.isFrozen(result));if('deadline_at'in result)assert.ok(Object.isFrozen(result.deadline_at));assert.equal(ownedWorkerUsage().Background,0);}
});
test('native gateway version preflight preserves exact unsigned value and failure category',async()=>{
 for(const raw of ['{"protocol_version":0}','{"protocol_version":18446744073709551615}','{"type":"hello_ack","protocol_version":11}','{"type":"project_ack","protocol_version":9}']){
  let expected:unknown;try{parse(raw,budget);}catch(e){expected=e;}assert.ok(expected instanceof RemoteProtocolError);
  await assert.rejects(decode(raw,budget),(e:unknown)=>e instanceof RemoteProtocolError&&e.kind==='UnsupportedVersion'&&e.received===expected.received&&e.message===expected.message);
 }
 for(const raw of ['{"protocol_version":9.0}','{"type":"hello_ack","protocol_version":null}','{"type":"hello_ack","extra":1}','{"type":"project_info","request_id":"r","thread_id":"t","deadline_at":null}'])await assert.rejects(decode(raw,budget),(e:unknown)=>e instanceof RemoteProtocolError&&e.kind==='Json');
});
test('nested gateway validation keeps session-before-operation error order in the actual native path',async()=>{
 const value={type:'project_operation',...base,computer_session_id:'bad',operation:{kind:'terminal_exec',command:''}};
 await assert.rejects(decode(serializeSerdeValue(value),budget),(e:unknown)=>e instanceof RemoteProtocolError&&e.kind==='Validation'&&e.message.includes('computer_session_id:'));
 await assert.rejects(decode(serializeSerdeValue({...value,operation:{kind:'terminal_exec',command:'',timeout_seconds:null}}),budget),(e:unknown)=>e instanceof RemoteProtocolError&&e.kind==='Json');
});
test('native gateway and operation parsers share the same owned slot rather than creating competing queues',async()=>{
 const raw=serializeSerdeValue({type:'project_info',...base}),first=decode(raw,budget);
 await assert.rejects(decodeProjectOperationOffThread('{"kind":"computer_stop"}',budget),OwnedWorkerBusyError);await first;
 const second=decodeProjectOperationOffThread('{"kind":"computer_stop"}',budget);await assert.rejects(decode(raw,budget),OwnedWorkerBusyError);await second;assert.equal(ownedWorkerUsage().Background,0);
 const c=new AbortController(),reason=new Error('abort gateway decode'),pending=decode(raw,budget,c.signal);c.abort(reason);await assert.rejects(pending,e=>e===reason);assert.equal(ownedWorkerUsage().Background,0);
});
test('native default deadline is sampled during decode while explicit old deadlines remain data',async()=>{
 const before=Date.now(),result=await decode('{"type":"project_info","request_id":"r","thread_id":"t"}',budget),after=Date.now();
 assert.equal(result.type,'project_info');if(result.type!=='project_info')throw Error('variant');const ms=result.deadline_at.seconds*1000n+result.deadline_at.nanosecond/1000000n;assert.ok(ms>=BigInt(before+60000)&&ms<=BigInt(after+60000));
 const old=await decode(serializeSerdeValue({type:'project_info',...base}),budget);if(old.type!=='project_info')throw Error('variant');assert.equal(old.deadline_at.seconds,0n);assert.equal(old.deadline_at.nanosecond,123456789n);
});
test('large valid gateway write is decoded off-thread and returned immutable without executing a write',async()=>{
 const raw=serializeSerdeValue({type:'write_file',...base,path:'does-not-exist',content:'😀'.repeat(1048576)});let ticks=0;const timer=setInterval(()=>ticks++,2);
 try{const result=await decode(raw,Buffer.byteLength(raw));assert.equal(result.type,'write_file');if(result.type==='write_file')assert.equal(result.content.length,2097152);assert.ok(ticks>1);}finally{clearInterval(timer);}
 assert.equal(ownedWorkerUsage().Background,0);
});
