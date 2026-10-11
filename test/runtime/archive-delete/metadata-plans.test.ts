import {it} from 'node:test';
import assert from 'node:assert/strict';
import {planArchiveJsonScrub as json,planArchiveIndexScrub as index,ARCHIVE_METADATA_INPUT_LIMIT as max} from '../../../src/runtime/archive-delete/metadata-plans.ts';
const b=(text:string)=>Buffer.from(text);
it('bridge scrub preserves unrelated data, exact order and immutable copied result',()=>{
 const input=b('{"selected_thread_id":"t","recent_live_approval_requests":{"t":null,"other":7},"recent_ui_thread":{"thread_id":"t","x":1},"keep":{"n":18446744073709551615}}'), before=Buffer.from(input);
 const p=json(input,'t',true,max);
 assert.deepEqual(p.changed,['selected_thread_id','recent_live_approval_requests','recent_ui_thread']);
 assert.equal(Object.hasOwn(p.value,'selected_thread_id'),false);
 assert.deepEqual(p.value.recent_live_approval_requests,{other:7n});
 assert.equal(Object.hasOwn(p.value,'recent_ui_thread'),false);
 assert.deepEqual(p.value.keep,{n:18446744073709551615n});
 assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.value)&&Object.isFrozen(p.value.keep)&&Object.isFrozen(p.changed));
 assert.deepEqual(input,before);
});
it('global scrub removes exact strings only and drops emptied keyed containers',()=>{
 const p=json(b('{"queued-follow-ups":{"t":false},"pinned-thread-ids":["t",null,7,"other","t",{"id":"t"}],"selected_thread_id":"t"}'),'t',false,max);
 assert.deepEqual(p.changed,['queued-follow-ups','pinned-thread-ids']);
 assert.equal(Object.hasOwn(p.value,'queued-follow-ups'),false);
 assert.deepEqual(p.value['pinned-thread-ids'],[null,7n,'other',{id:'t'}]);
 assert.equal(p.value.selected_thread_id,'t');
});
it('wrong shapes, case and partial matches remain untouched',()=>{
 const p=json(b('{"selected_thread_id":"T","recent_live_approval_requests":["t"],"recent_ui_thread":{"thread_id":7}}'),'t',true,max);
 assert.deepEqual(p.changed,[]);assert.equal(p.value.selected_thread_id,'T');
 const q=json(b('{"queued-follow-ups":[],"pinned-thread-ids":{},"x":-9223372036854775808}'),'t',false,max);
 assert.deepEqual(q.changed,[]);assert.equal(q.value.x,-9223372036854775808n);
});
it('prototype-looking thread keys remain own JSON data and removal is exact',()=>{
 const p=json(b('{"recent_live_approval_requests":{"__proto__":{"polluted":true},"constructor":1},"__proto__":{"safe":true}}'),'__proto__',true,max);
 assert.deepEqual(p.changed,['recent_live_approval_requests']);
 assert.deepEqual(p.value.recent_live_approval_requests,{constructor:1n});
 assert.ok(Object.hasOwn(p.value,'__proto__'));assert.equal(({} as Record<string,unknown>).polluted,undefined);
});
it('one BOM accepted for JSON, two rejected; roots and invalid UTF8 fail closed',()=>{
 assert.deepEqual(json(b('\uFEFF{"selected_thread_id":"t"}'),'t',true,max).changed,['selected_thread_id']);
 for(const text of ['\uFEFF\uFEFF{}','[]','null','1'])assert.throws(()=>json(b(text),'t',true,max));
 assert.throws(()=>json(Buffer.from([0xff]),'t',true,max));
 assert.throws(()=>index(Buffer.from([0xff]),'t',max));
});
it('byte budgets and thread validation reject before transformation',()=>{
 assert.throws(()=>json(b('{}'),'t',true,1),RangeError);
 for(const limit of [0,-1,1.5,Infinity,max+1])assert.throws(()=>index(b(''),'t',limit),RangeError);
 assert.deepEqual(json(b('{}'),'',true,2).changed,[]);
 assert.throws(()=>index(b(''), '\uD800',max),TypeError);
 assert.throws(()=>json(b('{}'),'t',null as unknown as boolean,max),TypeError);
 let hooks=0;const proxy=new Proxy(b('{}'),{get(){hooks++;throw Error('hook');}});
 assert.throws(()=>json(proxy,'t',true,max),TypeError);assert.equal(hooks,0);
});
it('index exact IDs removed while malformed JSON and nonstring IDs survive',()=>{
 const original='{"id":"t"}\r\ninvalid\r\n{"id":7}\r\n{"id":"other"}\r\n';
 assert.deepEqual(index(b(original),'t',max),{removed:1,replacement:'invalid\n{"id":7}\n{"id":"other"}\n'});
});
it('no removal retains byte identity by returning no replacement',()=>{
 for(const original of ['','\r\n','bad\r','{"id":"T"}\r\n','\uFEFF{"id":"t"}\n'])assert.deepEqual(index(b(original),'t',max),{removed:0,replacement:null});
});
it('index follows Rust LF and CRLF lines, final bare CR and blank-line behavior',()=>{
 const cases:[string,string][]=[
 ['{"id":"t"}\nkeep','keep'],
 ['{"id":"t"}\nkeep\r','keep\r\n'],
 ['{"id":"t"}\r\nkeep\r\n','keep\n'],
 ['{"id":"t"}\n\n',''],
 ['{"id":"t"}\n\nkeep\n','\nkeep\n'],
 ['{"id":"t"}\r',''],
 ];
 for(const [input,replacement]of cases)assert.deepEqual(index(b(input),'t',max),{removed:1,replacement});
});
it('Rust whitespace NEL trims, BOM does not; astral and empty identifiers work',()=>{
 assert.deepEqual(index(b('\u0085{"id":"t"}\u0085\n\uFEFF{"id":"t"}\n'),'t',max),{removed:1,replacement:'\uFEFF{"id":"t"}\n'});
 assert.deepEqual(index(b('{"id":"😀"}\n'),'😀',max),{removed:1,replacement:''});
 assert.deepEqual(index(b('{"id":""}\n{"id":"x"}'),'',max),{removed:1,replacement:'{"id":"x"}'});
});
it('byte capture does not execute overridden typed-array accessors and refuses shared backing',()=>{
 const bytes=b('{}');let hooks=0;
 for(const key of ['byteLength','byteOffset','buffer','length'])Object.defineProperty(bytes,key,{get(){hooks++;throw Error('input accessor');}});
 assert.deepEqual(json(bytes,'t',true,max).changed,[]);assert.equal(hooks,0);
 assert.throws(()=>json(new Uint8Array(new SharedArrayBuffer(2)),'t',true,max),TypeError);
});
