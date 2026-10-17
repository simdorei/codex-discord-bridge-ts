import {it} from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {fingerprintGatewayCommand} from '../../src/remote-agent/command-fingerprint.ts';
import {fingerprintGatewayCommandOffThread,decodeGatewayMessageOffThread} from '../../src/remote-agent/native-decode.ts';
import {parseGatewayCommand} from '../../src/remote-agent/gateway-command.ts';import type {GatewayCommand} from '../../src/remote-agent/gateway-command.ts';
import {OwnedWorkerBusyError} from '../../src/runtime/owned-worker-slot.ts';
const parse=(v:object)=>parseGatewayCommand(JSON.stringify({request_id:'r',thread_id:'t',...v}),12000000,0);
it('independent canonical literal goldens include null, UTF8, exact u64 and Chrono expiry formatting',async()=>{
 const write=parse({type:'write_file',path:'a',content:'한글'}),golden='14ed8d9dd8862d4fefa5462f7e563865e24f246693288b06e5bc5cec47c37db4';assert.equal(fingerprintGatewayCommand(write,12000000),golden);assert.equal(await fingerprintGatewayCommandOffThread(write,12000000),golden);
 const device=parseGatewayCommand('{"type":"device_session","request_id":"r","thread_id":"t","computer_session_id":"abcdefghijklmnop","computer_session_generation":18446744073709551615,"working_directory":"/f","expires_at":"2026-10-11T00:00:00.123000000Z"}',12000000,0);assert.equal(await fingerprintGatewayCommandOffThread(device,12000000),'63111f5306d4b50c0df024b620951df98921a98a12ee8d671a88171201f88928');
});
it('only root request/deadline are excluded; nested same-name keys, session and content remain significant',()=>{
 const base={type:'project_operation',operation:{kind:'terminal_exec',command:'x',environment:{request_id:'nested',deadline_at:'nested'}}},a=parse(base),f=fingerprintGatewayCommand(a,12000000);
 assert.equal(fingerprintGatewayCommand(parse({...base,request_id:'different',deadline_at:'2030-01-01T00:00:00Z'}),12000000),f);
 assert.notEqual(fingerprintGatewayCommand(parse({...base,operation:{...base.operation,environment:{...base.operation.environment,request_id:'changed'}}}),12000000),f);
 assert.notEqual(fingerprintGatewayCommand(parse({...base,computer_session_id:'abcdefghijklmnop'}),12000000),f);
 assert.notEqual(fingerprintGatewayCommand(parse({...base,operation:{...base.operation,command:'different'}}),12000000),f);
});
it('native large-content hashing lets timers run and shares busy ownership with native gateway decoding',async()=>{
 const command=parse({type:'write_file',path:'a',content:'x'.repeat(1000000)});let ticks=0;const timer=setInterval(()=>ticks++,1);
 try{const pending=fingerprintGatewayCommandOffThread(command,12000000);await assert.rejects(decodeGatewayMessageOffThread('{"type":"hello_ack"}',12000000),OwnedWorkerBusyError);const actual=await pending;const canonical='{"computer_session_id":null,"content":"'+'x'.repeat(1000000)+'","expected_sha256":null,"path":"a","thread_id":"t","type":"write_file"}';assert.equal(actual,createHash('sha256').update(canonical).digest('hex'));assert.ok(ticks>0);}finally{clearInterval(timer);}
 assert.equal((await decodeGatewayMessageOffThread('{"type":"hello_ack"}',12000000)).type,'hello_ack');
});
it('mutable/active DTOs and pre-aborted input are rejected without caller hooks',async()=>{
 const c=parse({type:'write_file',path:'a',content:''});await assert.rejects(fingerprintGatewayCommandOffThread({...c},12000000),TypeError);let hooks=0;const active=Object.freeze({...c,get content(){hooks++;return '';}}) as GatewayCommand;await assert.rejects(fingerprintGatewayCommandOffThread(active,12000000),TypeError);assert.equal(hooks,0);
 const stop=new AbortController(),reason=new Error('stopped');stop.abort(reason);await assert.rejects(fingerprintGatewayCommandOffThread(c,12000000,stop.signal),e=>e===reason);
});
it('too-small final wire budget rejects and actual native owner is released for the next request',async()=>{
 const c=parse({type:'write_file',path:'a',content:'x'.repeat(1000)});await assert.rejects(fingerprintGatewayCommandOffThread(c,100),RangeError);assert.equal((await decodeGatewayMessageOffThread('{"type":"hello_ack"}',1000)).type,'hello_ack');
});
