import {it} from 'node:test';import assert from 'node:assert/strict';
import {parseBridgeHello as bridge,parseGatewayAcknowledgement as gateway,serializeBridgeHello,RemoteProtocolError} from '../../src/remote-agent/handshake.ts';
const max=65536;
const kind=(expected:string)=>(e:unknown)=>e instanceof RemoteProtocolError&&e.kind===expected;
it('protocol ten hello is exact and empty device ID remains source-valid',()=>{
 for(const id of ['device-a','','기기😀','line\nquote"']){const raw=serializeBridgeHello(id),v=bridge(raw,max);assert.deepEqual(v,{type:'hello',protocol_version:10n,device_id:id});assert.ok(Object.isFrozen(v));}
 assert.equal(serializeBridgeHello('a'),'{"type":"hello","protocol_version":10,"device_id":"a"}');
});
it('unsupported unsigned version is rejected before envelope shape validation',()=>{
 for(const raw of ['{"protocol_version":9}','{"type":"unknown","protocol_version":18446744073709551615}']){
  assert.throws(()=>gateway(raw,max),kind('UnsupportedVersion'));assert.throws(()=>bridge(raw,max),kind('UnsupportedVersion'));
 }
});
it('hello ack defaults missing version, but null, floats, exponents and signed forms do not default',()=>{
 assert.deepEqual(gateway('{"type":"hello_ack"}',max),{type:'hello_ack',protocol_version:10n});
 for(const v of ['null','10.0','1e1','-0','-1','"10"','true','18446744073709551616'])assert.throws(()=>gateway('{"type":"hello_ack","protocol_version":'+v+'}',max),kind('Json'));
 assert.throws(()=>bridge('{"type":"hello","device_id":"a"}',max),kind('Json'));
});
it('unknown fields and non-message roots fail closed',()=>{
 for(const raw of ['null','[]','{"type":"hello_ack","extra":true}','{"type":"hello_ack","__proto__":{}}'])assert.throws(()=>gateway(raw,max),kind('Json'));
 assert.throws(()=>bridge('{"type":"hello","protocol_version":10,"device_id":"a","extra":1}',max),kind('Json'));
});
it('project acknowledgement binding is counted in Unicode scalars with original scope semantics',()=>{
 for(const n of [16,64])assert.deepEqual(gateway(JSON.stringify({type:'project_ack',project_scope:'',binding_id:'😀'.repeat(n)}),max),{type:'project_ack',project_scope:'',binding_id:'😀'.repeat(n)});
 for(const n of [15,65])assert.throws(()=>gateway(JSON.stringify({type:'project_ack',project_scope:'s',binding_id:'😀'.repeat(n)}),max),kind('Validation'));
 assert.throws(()=>gateway(JSON.stringify({type:'project_ack',project_scope:'s',binding_id:'a'.repeat(16),protocol_version:10}),max),kind('Json'));
});
it('serde Value duplicate keys preserve last value after validating the complete input',()=>{
 assert.deepEqual(gateway('{"type":"hello_ack","protocol_version":9,"protocol_version":10}',max),{type:'hello_ack',protocol_version:10n});
 assert.throws(()=>gateway('{"type":"hello_ack","protocol_version":10,"protocol_version":9}',max),kind('UnsupportedVersion'));
 assert.throws(()=>bridge('{"type":"hello","protocol_version":10,"device_id":"\\ud800","device_id":"a"}',max),kind('Json'));
});
it('wire byte limit is UTF8-sensitive and no unsafe payload coercion occurs',()=>{
 const raw=serializeBridgeHello('😀');assert.equal(bridge(raw,Buffer.byteLength(raw)).device_id,'😀');assert.throws(()=>bridge(raw,Buffer.byteLength(raw)-1),RangeError);
 let hooks=0;assert.throws(()=>gateway({toString(){hooks++;return '{}';}} as unknown as string,max),TypeError);assert.equal(hooks,0);
 assert.throws(()=>gateway('{}',12000001),RangeError);
 const escaped=serializeBridgeHello('\u0000');assert.equal(serializeBridgeHello('\u0000',Buffer.byteLength(escaped)),escaped);assert.throws(()=>serializeBridgeHello('\u0000',Buffer.byteLength(escaped)-1),RangeError);
});
