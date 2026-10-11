import assert from 'node:assert/strict';import {test} from 'node:test';
import {parseGatewayCommand} from '../../src/remote-agent/gateway-command.ts';
import {RemoteProtocolError} from '../../src/remote-agent/handshake.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const budget=12000000,base={request_id:'',thread_id:''},session='s'.repeat(16),parse=(v:unknown,now=0)=>parseGatewayCommand(serializeSerdeValue(v),budget,now);
const fail=(v:unknown,kind:'Json'|'Validation'|'UnsupportedVersion',detail?:string)=>assert.throws(()=>parse(v),(e:unknown)=>e instanceof RemoteProtocolError&&e.kind===kind&&(detail===undefined||e.message.includes(detail)));
test('all seven gateway commands retain exact typed fields, source defaults and frozen ownership',()=>{
 assert.deepEqual(parse({type:'project_info',...base}),{type:'project_info',...base,deadline_at:{seconds:60n,nanosecond:0n},computer_session_id:null});
 assert.equal(parse({type:'list_files',...base,pattern:'*',limit:500n}).type,'list_files');
 const read=parse({type:'read_file',...base,path:'a',start_line:18446744073709551615n,max_lines:1n});if(read.type!=='read_file')throw Error('variant');assert.equal(read.start_line,18446744073709551615n);
 const write=parse({type:'write_file',...base,path:'a',content:''});if(write.type!=='write_file')throw Error('variant');assert.equal(write.expected_sha256,null);
 const operation=parse({type:'project_operation',...base,operation:{kind:'terminal_exec',command:'x'}});if(operation.type!=='project_operation'||operation.operation.kind!=='terminal_exec')throw Error('variant');assert.equal(operation.operation.timeout_seconds,300n);assert.ok(Object.isFrozen(operation.operation));
 assert.equal(parse({type:'project_session',...base,computer_session_id:session,computer_session_generation:1n}).type,'project_session');
 const device=parse({type:'device_session',...base,computer_session_id:session,computer_session_generation:18446744073709551615n,working_directory:'C:/x',expires_at:'1970-1-1T0:0:0UTC'});assert.equal(device.type,'device_session');assert.ok(Object.isFrozen(device)&&Object.isFrozen(device.deadline_at));
});
test('missing deadlines get sixty seconds regardless of operation timeout; explicit dates keep exact nanoseconds',()=>{
 assert.deepEqual(parse({type:'project_info',...base},-1).deadline_at,{seconds:59n,nanosecond:999000000n});
 assert.deepEqual(parse({type:'project_info',...base,deadline_at:'1970-1-1T0:0:60.123456789Z'}).deadline_at,{seconds:59n,nanosecond:1123456789n});
 const op=parse({type:'project_operation',...base,operation:{kind:'terminal_exec',command:'x',timeout_seconds:3600n}});assert.equal(op.deadline_at.seconds,60n);
 assert.equal(parse({type:'project_info',...base,deadline_at:'1969-12-31T23:59:59Z'}).deadline_at.seconds,-1n);
 for(const deadline_at of [null,0n,'2026-02-30T00:00:00Z','not-date'])fail({type:'project_info',...base,deadline_at},'Json');
 assert.throws(()=>parse({type:'project_info',...base},NaN),RangeError);
});
test('session semantics precede operation semantics but all wire fields deserialize first',()=>{
 const request={type:'project_operation',...base,computer_session_id:'bad',operation:{kind:'terminal_exec',command:''}};
 fail(request,'Validation','computer_session_id:');
 fail({...request,computer_session_id:session},'Validation','command:');
 fail({...request,operation:{kind:'terminal_exec',command:'',timeout_seconds:null}},'Json');
 fail({...request,operation:{kind:'computer_activate',window_id:0n}},'Validation','computer_session_id:');
 fail({...request,operation:{kind:'computer_activate',window_id:'x'}},'Json');
});
test('gateway wire version preflight retains unsigned-version priority and denies extra version fields',()=>{
 for(const protocol_version of [0n,9n,11n,18446744073709551615n])fail({protocol_version},'UnsupportedVersion');
 fail({type:'project_info',...base,protocol_version:10n},'Json');
 fail({type:'project_info',...base,kind:'extra'},'Json');
 for(const protocol_version of [null,'9',true])fail({type:'project_info',...base,protocol_version},'Json');
 assert.throws(()=>parseGatewayCommand('{"protocol_version":9.0}',budget),(e:unknown)=>e instanceof RemoteProtocolError&&e.kind==='Json');
});
test('source session nullability, exact u16/u64 bounds and unknown fields reject bad wire shapes',()=>{
 assert.equal(parse({type:'project_info',...base,computer_session_id:null}).computer_session_id,null);
 fail({type:'project_session',...base,computer_session_id:null,computer_session_generation:1n},'Json');
 for(const computer_session_generation of [0n])fail({type:'project_session',...base,computer_session_id:session,computer_session_generation},'Validation','computer_session_generation:');
 for(const v of [{type:'project_info',thread_id:'x'},{type:'read_file',...base,path:'x',start_line:-1n,max_lines:1n},{type:'list_files',...base,pattern:'*',limit:65536n},{type:'write_file',...base,path:'x',content:'',extra:null},{type:'device_session',...base,computer_session_id:session,computer_session_generation:1n,working_directory:'x'}])fail(v,'Json');
 for(const computer_session_id of ['s'.repeat(15),'😀'.repeat(65)])fail({type:'project_info',...base,computer_session_id},'Validation','computer_session_id:');
 assert.equal(parse({type:'project_info',...base,computer_session_id:'😀'.repeat(64)}).type,'project_info');
});
test('gateway path/count limits and write digest scalar-length contract differ from file-change hex contract',()=>{
 fail({type:'list_files',...base,pattern:'',limit:0n},'Validation','pattern:');fail({type:'list_files',...base,pattern:'*',limit:501n},'Validation','limit:');
 fail({type:'read_file',...base,path:'x',start_line:0n,max_lines:0n},'Validation','start_line:');fail({type:'read_file',...base,path:'x',start_line:1n,max_lines:501n},'Validation','max_lines:');
 assert.equal(parse({type:'write_file',...base,path:'x',content:'',expected_sha256:'😀'.repeat(64)}).type,'write_file');
 fail({type:'write_file',...base,path:'x',content:'',expected_sha256:'a'.repeat(63)},'Validation','expected_sha256:');
 fail({type:'device_session',...base,computer_session_id:session,computer_session_generation:0n,working_directory:'',expires_at:'1970-1-1T0:0:0Z'},'Validation','computer_session_generation:');
 fail({type:'device_session',...base,computer_session_id:session,computer_session_generation:1n,working_directory:'',expires_at:'1970-1-1T0:0:0Z'},'Validation','working_directory:');
});
