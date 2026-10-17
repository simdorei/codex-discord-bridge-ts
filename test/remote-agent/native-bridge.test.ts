import {it} from 'node:test';import assert from 'node:assert/strict';
import {decodeBridgeMessageOffThread,decodeGatewayMessageOffThread} from '../../src/remote-agent/native-decode.ts';
import {RemoteProtocolError} from '../../src/remote-agent/handshake.ts';
import {OwnedWorkerBusyError} from '../../src/runtime/owned-worker-slot.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const decode=(v:unknown)=>decodeBridgeMessageOffThread(serializeSerdeValue(v),12000000);
it('all nine bridge message envelopes decode through the fixed native worker',async()=>{
 const fixtures=[{type:'hello',protocol_version:10n,device_id:''},{type:'project_upsert',project_scope:'x'.repeat(12),binding_id:'x'.repeat(16),thread_id:'',project_name:'x',expires_at:'2026-10-11T00:00:00Z'},{type:'project_info_result',request_id:'',output:{root:'',thread_id:''}},{type:'list_files_result',request_id:'',output:{files:[],truncated:false}},{type:'read_file_result',request_id:'',output:{path:'',content:'',sha256:'',start_line:1n,end_line:0n,total_lines:0n,truncated:false,redacted:false}},{type:'write_file_result',request_id:'',output:{path:'',sha256:'',bytes_written:18446744073709551615n,created:false}},{type:'project_operation_result',request_id:'',output:{kind:'computer_stop',message:''}},{type:'project_session_result',request_id:''},{type:'operation_error',request_id:'',error_code:'x',message:'x'}];
 for(const v of fixtures){const got=await decode(v);assert.equal(got.type,v.type);assert.equal(Object.isFrozen(got),true);}
});
it('native output family semantic checks and exact protocol version errors survive IPC',async()=>{
 await assert.rejects(decode({type:'project_operation_result',request_id:'x',output:{kind:'code_search',matches:[{path:'',line:0n,snippet:''}]}}),e=>e instanceof RemoteProtocolError&&e.kind==='Validation');
 await assert.rejects(decode({type:'project_operation_result',request_id:'x',output:{kind:'terminal_window_close',terminal_window_id:'bad'}}),e=>e instanceof RemoteProtocolError&&e.kind==='Validation');
 await assert.rejects(decode({type:'hello',protocol_version:18446744073709551615n,device_id:''}),e=>e instanceof RemoteProtocolError&&e.received===18446744073709551615n);
});
it('bridge and gateway decoders share admission without a hidden wait queue',async()=>{
 const first=decode({type:'project_session_result',request_id:''});await assert.rejects(decodeGatewayMessageOffThread('{"type":"hello_ack"}',1000),OwnedWorkerBusyError);await first;
 assert.equal((await decodeGatewayMessageOffThread('{"type":"hello_ack"}',1000)).type,'hello_ack');
});
it('large valid output text parses off-thread while the main timer continues',async()=>{
 const raw=serializeSerdeValue({type:'project_operation_result',request_id:'',output:{kind:'git_push',remote:'',branch:'',output:'x'.repeat(4000000)}});let ticks=0;const timer=setInterval(()=>{ticks++;},1);
 try{const result=await decodeBridgeMessageOffThread(raw,5000000);assert.equal(result.type,'project_operation_result');if(result.type==='project_operation_result'&&result.output.kind==='git_push')assert.equal(result.output.output.length,4000000);assert.ok(ticks>0);}finally{clearInterval(timer);}
});
it('result graph profile rejects excessive node count and releases native ownership for a later frame',async()=>{
 const raw=serializeSerdeValue({type:'list_files_result',request_id:'',output:{files:Array.from({length:1500},()=>({path:'',size_bytes:0n})),truncated:false}});
 await assert.rejects(decodeBridgeMessageOffThread(raw,200000),RangeError);assert.equal((await decode({type:'project_session_result',request_id:''})).type,'project_session_result');
});
