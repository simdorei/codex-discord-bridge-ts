import {it} from 'node:test';import assert from 'node:assert/strict';import {setImmediate as tick} from 'node:timers/promises';
import {RemoteTextReader,RemoteFrameError} from '../../src/remote-agent/frame-reader.ts';
import type {RemoteSocketFrame} from '../../src/remote-agent/frame-reader.ts';
import {decodeGatewayMessageOffThread} from '../../src/remote-agent/native-decode.ts';
function deferred<T>(){let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};}
it('ping is echoed before text while pong and raw frames are ignored without consuming another message',async()=>{
 const bytes=new Uint8Array([1,2,3]),frames:RemoteSocketFrame[]=[{type:'ping',payload:bytes},{type:'pong'},{type:'frame'},{type:'text',text:'{"type":"hello_ack"}'}],sent:number[][]=[];
 const reader=new RemoteTextReader(async()=>frames.shift()??null,async payload=>{assert.notEqual(payload,bytes);sent.push([...payload]);});
 const raw=await reader.receiveText(true);assert.equal(raw,'{"type":"hello_ack"}');assert.deepEqual(sent,[[1,2,3]]);
 assert.equal((await decodeGatewayMessageOffThread(raw!,1000)).type,'hello_ack');assert.equal(await reader.receiveText(false),null);
});
it('close before hello errors while EOF remains null and later close is normal',async()=>{
 await assert.rejects(new RemoteTextReader(async()=>({type:'close'}),async()=>{}).receiveText(true),e=>e instanceof RemoteFrameError&&e.kind==='ClosedBeforeHello');
 assert.equal(await new RemoteTextReader(async()=>null,async()=>{}).receiveText(true),null);
 assert.equal(await new RemoteTextReader(async()=>({type:'close'}),async()=>{}).receiveText(false),null);
 await assert.rejects(new RemoteTextReader(async()=>({type:'binary'}),async()=>{}).receiveText(false),e=>e instanceof RemoteFrameError&&e.kind==='UnsupportedBinary');
});
it('one receive owner retains its pending IO until settlement after cancellation',async()=>{
 const gate=deferred<RemoteSocketFrame|null>(),controller=new AbortController(),reason=new Error('cancel');let calls=0;
 const reader=new RemoteTextReader(async()=>{calls++;return gate.promise;},async()=>{}),first=reader.receiveText(false,controller.signal);
 controller.abort(reason);await assert.rejects(reader.receiveText(false),/already pending/);assert.equal(calls,1);gate.resolve(null);await assert.rejects(first,e=>e===reason);
 assert.equal(await reader.receiveText(false),null);assert.equal(calls,2);
});
it('raw receive and pong failures propagate unchanged and release only settled ownership',async()=>{
 const sentinel=Object.freeze({error:'receive'}),reader=new RemoteTextReader(async()=>{throw sentinel;},async()=>{});await assert.rejects(reader.receiveText(false),e=>e===sentinel);
 const pong=new Error('pong');await assert.rejects(new RemoteTextReader(async()=>({type:'ping',payload:new Uint8Array()}),async()=>{throw pong;}).receiveText(false),e=>e===pong);
});
it('ignored control-frame storms yield and stay cancellable without accumulating a queue',async()=>{
 let reads=0;const controller=new AbortController(),reason=new Error('stop');
 const reader=new RemoteTextReader(async()=>{reads++;return {type:'pong'};},async()=>{});const pending=reader.receiveText(false,controller.signal);
 await tick();controller.abort(reason);await assert.rejects(pending,e=>e===reason);assert.ok(reads>=64&&reads<=128);
});
it('passive frame fields and control bounds reject getters proxies oversized payloads and byte excess',async()=>{
 let hooks=0;const frame={get type(){hooks++;return 'text';},text:'x'} as RemoteSocketFrame;
 await assert.rejects(new RemoteTextReader(async()=>frame,async()=>{}).receiveText(false),TypeError);assert.equal(hooks,0);
 const proxy=new Proxy(async()=>null,{apply(){hooks++;return Promise.resolve(null);}});assert.throws(()=>new RemoteTextReader(proxy,async()=>{}),TypeError);assert.equal(hooks,0);
 await assert.rejects(new RemoteTextReader(async()=>({type:'ping',payload:new Uint8Array(126)}),async()=>{}).receiveText(false),RangeError);
 await assert.rejects(new RemoteTextReader(async()=>({type:'text',text:'한글'}),async()=>{},5).receiveText(false),RangeError);
});
it('preabort starts no IO and non-Promise ports fail rather than allowing thenable hooks',async()=>{
 let calls=0;const controller=new AbortController(),reason=new Error('pre');controller.abort(reason);const reader=new RemoteTextReader(async()=>{calls++;return null;},async()=>{});
 await assert.rejects(reader.receiveText(false,controller.signal),e=>e===reason);assert.equal(calls,0);
 const bad=(()=>({then(){calls++;}})) as unknown as ()=>Promise<RemoteSocketFrame|null>;await assert.rejects(new RemoteTextReader(bad,async()=>{}).receiveText(false),TypeError);assert.equal(calls,0);
});
