import {it} from 'node:test';import assert from 'node:assert/strict';
import {parseBridgeInboundMessage} from '../../src/remote-agent/bridge-inbound.ts';
import type {BridgeInboundMessage} from '../../src/remote-agent/bridge-inbound.ts';
import {serializeBridgeInboundMessage} from '../../src/remote-agent/bridge-serialize.ts';
import {RemoteProtocolError} from '../../src/remote-agent/handshake.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const decode=(v:unknown)=>parseBridgeInboundMessage(serializeSerdeValue(v),12000000);
const wid='termwin_'+'a'.repeat(16),oid='twobs_'+'a'.repeat(16),window={terminal_window_id:wid,window_id:1n,process_id:2n,shell:'cmd',cwd:'/',title:'x'};
it('project upsert dates normalize offsets and nanoseconds to Chrono wire text without mutating DTOs',()=>{
 const value=decode({type:'project_upsert',project_scope:'x'.repeat(12),binding_id:'x'.repeat(16),thread_id:'',project_name:'x',expires_at:'2026-10-11T09:00:00.1234+09:00'});
 const before=structuredClone(value),wire=serializeBridgeInboundMessage(value,1000);assert.ok(wire.includes('2026-10-11T00:00:00.123400Z'));assert.deepEqual(structuredClone(value),before);assert.deepEqual(parseBridgeInboundMessage(wire,1000),value);
});
it('terminal capture and action receipt timestamps become wire strings including retained leap seconds',()=>{
 const outputs=[{kind:'terminal_window_capture',window,observation_id:oid,identity_digest:'a'.repeat(64),rect:{left:0n,top:0n,width:1n,height:1n},data_base64:'123456789012',captured_at:'2016-12-31T23:59:60.5Z'},{kind:'terminal_window_action',window,receipt:{receipt_id:'twrcpt_'+'a'.repeat(16),terminal_window_id:wid,identity_digest:'a'.repeat(64),action:'activate',activated:true,completed_at:'+10000-01-01T00:00:00Z'}}];
 for(const output of outputs){const value=decode({type:'project_operation_result',request_id:'',output}),wire=serializeBridgeInboundMessage(value,3000);assert.deepEqual(parseBridgeInboundMessage(wire,3000),value);assert.equal(wire.includes('"nanosecond"'),false);}
});
it('lossless integers Unicode and escaped content round-trip at the exact final byte boundary',()=>{
 const value=decode({type:'write_file_result',request_id:'😀\n',output:{path:'한글',sha256:'',bytes_written:18446744073709551615n,created:false}}),wire=serializeBridgeInboundMessage(value,1000),bytes=Buffer.byteLength(wire);
 assert.equal(serializeBridgeInboundMessage(value,bytes),wire);assert.throws(()=>serializeBridgeInboundMessage(value,bytes-1),RangeError);assert.deepEqual(parseBridgeInboundMessage(wire,bytes),value);
});
it('active caller objects are refused without getter proxy or toJSON execution',()=>{
 let hooks=0;const bad={type:'project_session_result',get request_id(){hooks++;return '';}};
 assert.throws(()=>serializeBridgeInboundMessage(bad as BridgeInboundMessage,1000));
 const proxy=new Proxy({type:'project_session_result',request_id:''},{ownKeys(){hooks++;return [];}});assert.throws(()=>serializeBridgeInboundMessage(proxy as BridgeInboundMessage,1000));
 const toJSON={type:'project_session_result',request_id:'',toJSON(){hooks++;return {};}};assert.throws(()=>serializeBridgeInboundMessage(toJSON as BridgeInboundMessage,1000));assert.equal(hooks,0);
});
it('outgoing fail-closed profile refuses invalid fields and semantic failures before returning bytes',()=>{
 const unknown={type:'project_session_result',request_id:'',extra:true};assert.throws(()=>serializeBridgeInboundMessage(unknown as BridgeInboundMessage,1000),RemoteProtocolError);
 const invalid={type:'operation_error',request_id:'',error_code:'',message:'x'};assert.throws(()=>serializeBridgeInboundMessage(invalid as BridgeInboundMessage,1000),e=>e instanceof RemoteProtocolError&&e.kind==='Validation');
 const cyclic:Record<string,unknown>={type:'project_session_result',request_id:''};cyclic.self=cyclic;assert.throws(()=>serializeBridgeInboundMessage(cyclic as unknown as BridgeInboundMessage,1000));
});
