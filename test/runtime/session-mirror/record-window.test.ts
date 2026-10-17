import assert from 'node:assert/strict';
import {it} from 'node:test';
import {decodeMirrorRecordWindow as decode} from '../../../src/runtime/session-mirror/record-window.ts';
const bytes=(s:string)=>new TextEncoder().encode(s);
const run=(s:string,start=0n,maxRecord=1024,maxRecords=100)=>decode(bytes(s),start,4096,maxRecord,maxRecords);
it('complete records carry byte offsets and lossless u64 JSON values',()=>{
 const first='{"text":"한😀","n":18446744073709551615}\n',second='{"x":2}\r\n';const r=run(first+second,100n);
 assert.equal(r.stop,'WindowEnd');assert.equal(r.scannedRecords,2);assert.equal(r.events.length,2);assert.equal(r.events[0]!.value.n,18446744073709551615n);
 assert.equal(r.events[0]!.startOffset,100n);assert.equal(r.events[0]!.endOffset,100n+BigInt(bytes(first).length));assert.equal(r.events[1]!.endOffset,r.nextOffset);assert.equal(r.nextOffset,100n+BigInt(bytes(first+second).length));
});
it('valid JSON without LF is retained and later complete read emits exactly once',()=>{
 const raw='{"x":1}';const a=run(raw,8n);assert.equal(a.stop,'IncompleteRecord');assert.equal(a.nextOffset,8n);assert.equal(a.events.length,0);
 const b=run(raw+'\n',8n);assert.equal(b.events.length,1);assert.equal(b.nextOffset,16n);
});
it('incomplete final UTF-8 scalar and truncated JSON never advance that record',()=>{
 const prefix=bytes('{"ok":true}\n'),tail=bytes('{"text":"😀');const window=new Uint8Array(prefix.length+tail.length-2);window.set(prefix);window.set(tail.subarray(0,-2),prefix.length);
 const r=decode(window,0n,4096,1024,100);assert.equal(r.stop,'IncompleteRecord');assert.equal(r.events.length,1);assert.equal(r.nextOffset,BigInt(prefix.length));
});
it('malformed UTF-8 is held rather than replaced, and BOM is not silently stripped',()=>{
 const invalid=new Uint8Array([123,34,120,34,58,34,255,34,125,10]);assert.equal(decode(invalid,0n,100,100,10).stop,'InvalidUtf8');
 const r=run('\ufeff{}\n');assert.equal(r.stop,'InvalidJson');assert.equal(r.nextOffset,0n);
});
it('malformed JSON retains bad line after valid prefix and never jumps to later records',()=>{
 const r=run('{}\nnot-json\n{"later":1}\n',40n);assert.equal(r.stop,'InvalidJson');assert.equal(r.nextOffset,43n);assert.equal(r.scannedRecords,1);assert.equal(r.events.length,1);
});
it('wire record byte limit includes LF/CRLF and refuses huge incomplete records',()=>{
 assert.equal(run('{}\n',0n,3).stop,'WindowEnd');assert.equal(run('{}\n',0n,2).stop,'OversizedRecord');assert.equal(run('{}\r\n',0n,3).stop,'OversizedRecord');
 assert.equal(run('abc',0n,3).stop,'OversizedRecord');assert.equal(run('ab',0n,3).stop,'IncompleteRecord');assert.equal(run('x'.repeat(2000),0n,100).nextOffset,0n);
});
it('record count bounds include blank and non-object records, preventing scan starvation',()=>{
 const r=run('\n[]\nnull\n{}\n',0n,100,2);assert.equal(r.stop,'RecordLimit');assert.equal(r.scannedRecords,2);assert.equal(r.events.length,0);assert.equal(r.nextOffset,4n);
 const next=run('null\n{}\n',r.nextOffset,100,2);assert.equal(next.stop,'WindowEnd');assert.equal(next.events.length,1);assert.equal(next.nextOffset,12n);
});
it('Rust Unicode whitespace accepted around JSON, non-object values consumed without events',()=>{
 const r=run('\u0085{}\u0085\n42\n"x"\ntrue\n[]\n');assert.equal(r.stop,'WindowEnd');assert.equal(r.scannedRecords,5);assert.equal(r.events.length,1);
});
it('invalid limits and u64 overflow reject before scanning',()=>{
 for(const value of [0,-1,1.5,NaN,Infinity])assert.throws(()=>decode(bytes('{}\n'),0n,value,1,1),RangeError);
 assert.throws(()=>decode(bytes('{}\n'),0n,1048577,1,1),RangeError);assert.throws(()=>decode(bytes('{}\n'),0n,10,11,1),RangeError);
 assert.throws(()=>decode(bytes('{}\n'),0n,10,5,1025),RangeError);assert.throws(()=>decode(bytes('{}\n'),-1n,10,5,1),RangeError);
 assert.throws(()=>decode(bytes('{}\n'),(1n<<64n)-2n,10,5,1),RangeError);assert.throws(()=>decode(bytes('{}\n'),0n,2,2,1),RangeError);
 assert.equal(decode(new Uint8Array(),(1n<<64n)-1n,1,1,1).nextOffset,(1n<<64n)-1n);
});
it('shared and resizable buffers and proxy byte arrays are refused',()=>{
 assert.throws(()=>decode(new Uint8Array(new SharedArrayBuffer(4)),0n,10,10,1),TypeError);
 assert.throws(()=>decode(new Uint8Array(Reflect.construct(ArrayBuffer,[4,{maxByteLength:8}]) as ArrayBuffer),0n,10,10,1),TypeError);
 let traps=0;const p=new Proxy(bytes('{}\n'),{get(){traps++;throw Error('trap');}});assert.throws(()=>decode(p,0n,10,10,1),TypeError);assert.equal(traps,0);
});
it('input property getters are ignored and returned event graph is frozen',()=>{
 const input=bytes('{"nested":{"v":1}}\n');let calls=0;for(const key of ['buffer','byteLength','length'])Object.defineProperty(input,key,{get(){calls++;throw Error('getter');}});
 const r=decode(input,0n,100,100,10);assert.equal(calls,0);assert.equal(r.events.length,1);assert.equal(Object.isFrozen(r),true);assert.equal(Object.isFrozen(r.events),true);assert.equal(Object.isFrozen(r.events[0]!.value.nested),true);
 input.fill(0);assert.equal((r.events[0]!.value.nested as {v:bigint}).v,1n);
});
it('oversized record after safe prefix retains exact boundary, not a partial record',()=>{
 const r=run('{}\n'+('x'.repeat(20))+'\n{}\n',9n,10);assert.equal(r.stop,'OversizedRecord');assert.equal(r.nextOffset,12n);assert.equal(r.events.length,1);
});
