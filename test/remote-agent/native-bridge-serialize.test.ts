import {it} from 'node:test';import assert from 'node:assert/strict';
import {serializeBridgeMessageOffThread,decodeGatewayMessageOffThread} from '../../src/remote-agent/native-decode.ts';
import {parseBridgeInboundMessage} from '../../src/remote-agent/bridge-inbound.ts';
import type {BridgeInboundMessage} from '../../src/remote-agent/bridge-inbound.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
import {OwnedWorkerBusyError} from '../../src/runtime/owned-worker-slot.ts';
const parse=(v:unknown)=>parseBridgeInboundMessage(serializeSerdeValue(v),12000000);
it('native bridge serializer preserves lossless typed fields and UTC datetime wire format',async()=>{
 const value=parse({type:'project_upsert',project_scope:'x'.repeat(12),binding_id:'x'.repeat(16),thread_id:'',project_name:'x',expires_at:'2016-12-31T23:59:60.123456789Z'});
 const wire=await serializeBridgeMessageOffThread(value,1000);assert.ok(wire.includes('23:59:60.123456789Z'));assert.deepEqual(parseBridgeInboundMessage(wire,1000),value);
});
it('large escaped content serializes off-thread without counting the IPC envelope as a second JSON encoding',async()=>{
 const value=parse({type:'project_operation_result',request_id:'',output:{kind:'git_push',remote:'',branch:'',output:'"'.repeat(1500000)}});let ticks=0;const timer=setInterval(()=>{ticks++;},1);
 try{const wire=await serializeBridgeMessageOffThread(value,3100000);assert.ok(ticks>0);const round=parseBridgeInboundMessage(wire,3100000);assert.equal(round.type,'project_operation_result');if(round.type==='project_operation_result'&&round.output.kind==='git_push')assert.equal(round.output.output.length,1500000);}finally{clearInterval(timer);}
});
it('mutable active or opaque DTOs reject before native clone without getter or proxy execution',async()=>{
 let hooks=0;const mutable={type:'project_session_result',request_id:''};await assert.rejects(serializeBridgeMessageOffThread(mutable as BridgeInboundMessage,1000),TypeError);
 const active=Object.freeze({type:'project_session_result',get request_id(){hooks++;return '';}});await assert.rejects(serializeBridgeMessageOffThread(active as BridgeInboundMessage,1000),TypeError);
 const proxy=new Proxy(Object.freeze(mutable),{get(){hooks++;return '';}});await assert.rejects(serializeBridgeMessageOffThread(proxy as BridgeInboundMessage,1000),TypeError);assert.equal(hooks,0);
});
it('encoding shares native admission with decoding and frees ownership after oversized output fails',async()=>{
 const value=parse({type:'project_session_result',request_id:'x'}),first=serializeBridgeMessageOffThread(value,1000);
 await assert.rejects(decodeGatewayMessageOffThread('{"type":"hello_ack"}',1000),OwnedWorkerBusyError);await first;
 await assert.rejects(serializeBridgeMessageOffThread(value,1),RangeError);
 assert.equal((await decodeGatewayMessageOffThread('{"type":"hello_ack"}',1000)).type,'hello_ack');
});
it('preabort preserves exact reason and timeout waits for actual native ownership release',async()=>{
 const value=parse({type:'project_session_result',request_id:''}),controller=new AbortController(),reason=new Error('cancel');controller.abort(reason);
 await assert.rejects(serializeBridgeMessageOffThread(value,1000,controller.signal),e=>e===reason);
 await assert.rejects(serializeBridgeMessageOffThread(value,1000,undefined,1));
 assert.equal(typeof await serializeBridgeMessageOffThread(value,1000),'string');
});
