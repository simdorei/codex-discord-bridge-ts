import {it} from 'node:test';import assert from 'node:assert/strict';
import {parseBridgeInboundMessage} from '../../src/remote-agent/bridge-inbound.ts';
import {RemoteProtocolError} from '../../src/remote-agent/handshake.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const parse=(v:unknown)=>parseBridgeInboundMessage(serializeSerdeValue(v),12000000);
function fails(v:unknown,kind='Json'){assert.throws(()=>parse(v),e=>e instanceof RemoteProtocolError&&e.kind===kind);}
const read={type:'read_file_result',request_id:'',output:{path:'',content:'',sha256:'not a hash',start_line:1n,end_line:0n,total_lines:0n,truncated:false,redacted:false}};
const upsert={type:'project_upsert',project_scope:'s'.repeat(12),binding_id:'b'.repeat(16),thread_id:'',project_name:'p',expires_at:'2026-10-11T00:00:00.123456789Z'};
it('all nine bridge envelope shapes decode flattened result variants without inventing request identity requirements',()=>{
 const fixtures=[{type:'hello',protocol_version:10n,device_id:''},upsert,{type:'project_info_result',request_id:'',output:{root:'',thread_id:''}},{type:'list_files_result',request_id:'',output:{files:[{path:'',size_bytes:18446744073709551615n}],truncated:false}},read,{type:'write_file_result',request_id:'',output:{path:'',sha256:'',bytes_written:0n,created:false}},{type:'project_operation_result',request_id:'',output:{kind:'git_push',remote:'',branch:'',output:''}},{type:'project_session_result',request_id:''},{type:'operation_error',request_id:'',error_code:'x',message:'x'}];
 for(const fixture of fixtures){const actual=parse(fixture);assert.equal(actual.type,fixture.type);assert.equal(Object.isFrozen(actual),true);}
 const value=parse(upsert);if(value.type==='project_upsert')assert.equal(value.expires_at.nanosecond,123456789n);
 fails({type:'result',result:read});
});
it('all three project output families dispatch validation after complete envelope decoding',()=>{
 for(const output of [{kind:'code_search',matches:[{path:'',line:1n,snippet:''}]},{kind:'computer_stop',message:''},{kind:'terminal_window_close',terminal_window_id:'termwin_'+'a'.repeat(16)}])assert.equal(parse({type:'project_operation_result',request_id:'',output}).type,'project_operation_result');
 fails({type:'project_operation_result',request_id:'',output:{kind:'code_search',matches:[{path:'',line:0n,snippet:''}]}},'Validation');
 fails({type:'project_operation_result',request_id:'',output:{kind:'computer_stop',stopped:false,message:''}},'Validation');
 fails({type:'project_operation_result',request_id:'',output:{kind:'terminal_window_close',terminal_window_id:'bad'}},'Validation');
 fails({type:'project_operation_result',request_id:0n,output:{kind:'computer_stop',stopped:false,message:''}},'Json');
});
it('version preflight rejects exact unsigned version before unknown envelope shape',()=>{
 assert.throws(()=>parse({type:'unknown',protocol_version:18446744073709551615n}),e=>e instanceof RemoteProtocolError&&e.kind==='UnsupportedVersion'&&e.received===18446744073709551615n);
 fails({type:'project_session_result',request_id:'',protocol_version:10n});
 for(const raw of ['10.0','1e1','null','-0','-1'])assert.throws(()=>parseBridgeInboundMessage('{"type":"hello","device_id":"","protocol_version":'+raw+'}',1000),e=>e instanceof RemoteProtocolError&&e.kind==='Json');
});
it('read-file start line is the only semantic line constraint and wire shapes stay strict',()=>{
 assert.equal(parse(read).type,'read_file_result');fails({...read,output:{...read.output,start_line:0n}},'Validation');
 fails({...read,output:{...read.output,start_line:0n,redacted:null}},'Json');
 fails({...read,output:{...read.output,kind:'extra'}});fails({...read,unexpected:true});
});
it('project and error scalar lengths are exact while malformed datetime remains a structural failure',()=>{
 fails({...upsert,project_scope:'short'},'Validation');fails({...upsert,binding_id:'short'},'Validation');fails({...upsert,project_name:''},'Validation');
 fails({...upsert,project_scope:'short',expires_at:'bad'},'Json');
 const error={type:'operation_error',request_id:'',error_code:'😀'.repeat(100),message:'😀'.repeat(1000)};assert.equal(parse(error).type,'operation_error');
 fails({...error,error_code:'😀'.repeat(101)},'Validation');fails({...error,message:'😀'.repeat(1001)},'Validation');
 fails({...error,error_code:''},'Validation');fails({...error,message:''},'Validation');
});
it('unknown discriminator prototype strings and over-budget frames fail without partial results',()=>{
 fails({type:'__proto__'});fails({type:'constructor'});fails({type:'project_operation_result',request_id:'x',output:{kind:'computer_nonexistent'}});
 const raw=serializeSerdeValue(read);assert.throws(()=>parseBridgeInboundMessage(raw,Buffer.byteLength(raw)-1),RangeError);
});
