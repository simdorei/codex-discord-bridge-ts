import assert from 'node:assert/strict';
import {it} from 'node:test';
import {decodeMirrorWindowOffThread as decode,joinMirrorDecoder,mirrorDecoderBusy} from '../../../src/runtime/session-mirror/decode-reader.ts';
import {OwnedWorkerBusyError,OwnedWorkerTimeoutError} from '../../../src/runtime/owned-worker-slot.ts';
const bytes=(s:string)=>new TextEncoder().encode(s);
it('real owned worker decodes lossless bounded records then releases its slot',async()=>{
 const result=await decode(bytes('{"id":18446744073709551615}\n'),50n,100,100,2);assert.equal(result.events[0]!.value.id,18446744073709551615n);assert.equal(result.stop,'WindowEnd');assert.equal(mirrorDecoderBusy(),false);assert.equal(Object.isFrozen(result.events[0]!.value),true);
});
it('one process-wide owner rejects concurrent work without queuing and copies input before yielding',async()=>{
 const input=bytes('{"x":1}\n');const first=decode(input,0n,100,100,2);assert.equal(mirrorDecoderBusy(),true);input.fill(0);
 await assert.rejects(decode(bytes('{}\n'),0n,100,100,2),OwnedWorkerBusyError);const result=await first;assert.equal(result.events[0]!.value.x,1n);assert.equal(mirrorDecoderBusy(),false);
});
it('abort settles caller but immediate slot ownership persists until native exit',async()=>{
 const controller=new AbortController(),reason=new Error('caller stopped');const pending=decode(bytes('{}\n'),0n,100,100,2,3000,controller.signal);assert.equal(mirrorDecoderBusy(),true);controller.abort(reason);assert.equal(mirrorDecoderBusy(),true);
 await assert.rejects(pending,e=>e===reason);await joinMirrorDecoder();assert.equal(mirrorDecoderBusy(),false);
 const next=await decode(bytes('{"next":true}\n'),0n,100,100,2);assert.equal(next.events[0]!.value.next,true);
});
it('deadline does not deliver a late result and owner can be joined before reuse',async()=>{
 await assert.rejects(decode(bytes('{}\n'),0n,100,100,2,0),OwnedWorkerTimeoutError);await joinMirrorDecoder();assert.equal(mirrorDecoderBusy(),false);
 assert.equal((await decode(bytes('{}\n'),0n,100,100,2)).events.length,1);
});
it('pre-abort and oversized input fail before creating a worker',async()=>{
 const c=new AbortController(),reason=new Error('pre-abort');c.abort(reason);await assert.rejects(decode(bytes('{}\n'),0n,100,100,2,3000,c.signal),e=>e===reason);assert.equal(mirrorDecoderBusy(),false);
 await assert.rejects(decode(new Uint8Array(1048577),0n,1048576,100,1),RangeError);assert.equal(mirrorDecoderBusy(),false);
 await assert.rejects(decode(bytes('{}\n'),0n,100,100,2,-1),RangeError);assert.equal(mirrorDecoderBusy(),false);
});
it('invalid JSON and incomplete records return held offsets, not worker errors or advances',async()=>{
 const bad=await decode(bytes('{}\nbad\n'),9n,100,100,5);assert.equal(bad.stop,'InvalidJson');assert.equal(bad.nextOffset,12n);
 const partial=await decode(bytes('{}'),9n,100,100,5);assert.equal(partial.stop,'IncompleteRecord');assert.equal(partial.nextOffset,9n);
});
