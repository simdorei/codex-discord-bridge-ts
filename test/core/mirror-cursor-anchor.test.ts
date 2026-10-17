import test from 'node:test';import assert from 'node:assert/strict';import {resolve} from 'node:path';
import {encodeMirrorCursorAnchor as encode,decodeMirrorCursorAnchor as decode,snapshotMirrorCursorAnchor as snapshot,type MirrorCursorAnchor} from '../../src/core/mirror-cursor-anchor.ts';
const hash='a'.repeat(64);
const anchor=():MirrorCursorAnchor=>({version:1,path:resolve('한😀.jsonl'),offset:9007199254740993n,stamp:{dev:1n,ino:18446744073709551615n,birthtimeNs:9007199254740993n,mtimeNs:-9223372036854775808n,ctimeNs:9223372036854775807n,size:18446744073709551615n},prefixHash:hash,tailHash:'b'.repeat(64)});
test('canonical tuple preserves u64/i64 values beyond IEEE754 and Unicode path',()=>{
 const a=anchor(),s=encode(a),b=decode(s);assert.deepEqual(b,a);assert.equal(encode(b),s);assert.ok(s.includes('9007199254740993'));assert.ok(Object.isFrozen(b.stamp));assert.ok(Object.isFrozen(b));
});
test('version, shape and noncanonical numeric JSON cannot be silently accepted',()=>{
 const text=encode(anchor());
 for(const bad of [' '+text,text+'\n',text.replace('[1,','[1.0,'),text.replace('[1,','[2,'),text.slice(0,-1)+',0]',text.replace('9007199254740993','9007199254740993.0'),'{}','null'])assert.throws(()=>decode(bad));
});
test('all integer ranges and offset/size relation are checked before encoding',()=>{
 for(const [key,value] of [['ino',0n],['birthtimeNs',0n],['dev',-1n],['ino',1n<<64n],['mtimeNs',1n<<63n],['ctimeNs',-(1n<<63n)-1n],['size',1n]] as const){
  const a=anchor();assert.throws(()=>encode({...a,stamp:{...a.stamp,[key]:value}}));
 }
 assert.throws(()=>encode({...anchor(),offset:-1n}));assert.throws(()=>encode({...anchor(),offset:1 as never}));
});
test('relative paths, NUL, invalid UTF16 and malformed digests are rejected',()=>{
 for(const path of ['relative.jsonl','/x\0y','/x\uD800'])assert.throws(()=>encode({...anchor(),path}));
 for(const prefixHash of ['A'.repeat(64),'a'.repeat(63),'a'.repeat(64)+'\n'])assert.throws(()=>encode({...anchor(),prefixHash}));
});
test('accessors and proxies execute no hooks during data capture',()=>{
 let calls=0;const a=anchor();
 assert.throws(()=>snapshot({...a,get offset(){calls++;return 0n}}),TypeError);
 assert.throws(()=>snapshot({...a,stamp:new Proxy(a.stamp,{get(){calls++;throw Error('trap')}})}),TypeError);
 assert.throws(()=>snapshot(new Proxy(a,{get(){calls++;throw Error('trap')}})),TypeError);assert.equal(calls,0);
});
test('snapshot is detached from mutable caller stamp',()=>{
 const a=anchor(),b=snapshot(a);(a.stamp as {ino:bigint}).ino=2n;assert.notEqual(a.stamp.ino,b.stamp.ino);
});
test('encoded bytes are bounded before JSON parse and escaped path expansion is bounded',()=>{
 assert.throws(()=>decode(' '.repeat(65537)),RangeError);assert.throws(()=>decode('한'.repeat(22000)),RangeError);
 const path=resolve('\u0001'.repeat(15000));assert.throws(()=>encode({...anchor(),path}),RangeError);
});
