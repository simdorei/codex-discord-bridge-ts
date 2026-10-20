import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dirname,join} from 'node:path';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {storeFixture} from '../helpers/store-fixture.ts';
import {downloadAttachment as download,attachmentTextPreview as preview,type AttachmentTransport} from '../../src/runtime/attachment-download.ts';
const input={filename:'note.txt',size:3n,url:'https://example.invalid/not-requested',contentType:'text/plain'};
function wire(chunks:Uint8Array[],length:bigint|null=null,failure:Error|null=null){
 const observed={gets:0,releases:0,finished:0};const transport:AttachmentTransport={async get(){observed.gets++;return {contentLength:length,chunks:(async function*(){try{for(const chunk of chunks)yield chunk;if(failure!==null)throw failure;}finally{observed.finished++;}})(),async release(){observed.releases++;}};}};return {transport,observed};
}
test('declared oversize short-circuits all transport and filesystem operations',()=>storeFixture(async path=>{
 const w=wire([]);assert.deepEqual(await download(1n,{...input,size:11n},dirname(path),10n,10n,w.transport,false),{detail:'1. note.txt skipped: file is 11 bytes; limit is 10 bytes.',preview:null});
 await assert.rejects(download(1n,{...input,size:11n},dirname(path),10n,10n,w.transport,true),/file is 11 bytes/);assert.equal(w.observed.gets,0);await assert.rejects(stat(join(dirname(path),'01-note.txt')),{code:'ENOENT'});
}));
test('response oversize releases headers without creating a file or reading body',()=>storeFixture(async path=>{
 const w=wire([Buffer.from('x')],11n);assert.match((await download(1n,input,dirname(path),10n,10n,w.transport,false)).detail,/response exceeds 10 bytes/);
 await assert.rejects(download(1n,input,dirname(path),10n,10n,w.transport,true),/response exceeds 10 bytes/);assert.equal(w.observed.releases,2);assert.equal(w.observed.finished,0);await assert.rejects(stat(join(dirname(path),'01-note.txt')),{code:'ENOENT'});
}));
test('required stream writes complete bytes, closes file, returns exact SHA and Unicode preview',()=>storeFixture(async path=>{
 const data=Buffer.from('\ufeff한😀\n'),w=wire([data.subarray(0,2),data.subarray(2)]),directory=dirname(path);
 const result=await download(2n,{...input,filename:'/incoming/한😀.txt'},directory,100n,100n,w.transport,true);
 assert.deepEqual(await readFile(join(directory,'02-__.txt')),data);assert.equal(result.detail,`2. __.txt\n   path: ${join(directory,'02-__.txt')}\n   content_type: text/plain\n   size_bytes: ${data.length}\n   sha256: ${createHash('sha256').update(data).digest('hex')}`);assert.deepEqual(result.preview,['__.txt','\ufeff한😀\n']);assert.equal(w.observed.releases,1);assert.equal(w.observed.finished,1);
}));
test('ordinary binary stream omits hash and preview; exact max-byte boundary is accepted',()=>storeFixture(async path=>{
 const w=wire([Buffer.from('abc')],3n);const result=await download(1n,{...input,filename:'x.bin',contentType:null},dirname(path),3n,100n,w.transport,false);assert.equal(result.preview,null);assert.doesNotMatch(result.detail,/sha256/);assert.match(result.detail,/content_type: -\n   size_bytes: 3$/);assert.equal(w.observed.releases,1);
}));
test('stream oversize removes only its partial destination and joins iterator return before release',()=>storeFixture(async path=>{
 for(const required of [false,true]){const w=wire([Buffer.from('ab'),Buffer.from('cd')]);const operation=download(1n,input,dirname(path),3n,10n,w.transport,required);if(required)await assert.rejects(operation,/download exceeded 3 bytes/);else assert.match((await operation).detail,/skipped: download exceeded 3 bytes/);await assert.rejects(stat(join(dirname(path),'01-note.txt')),{code:'ENOENT'});assert.equal(w.observed.finished,1);assert.equal(w.observed.releases,1);}
}));
test('mid-stream failure retains source partial bytes and original error while closing ownership',()=>storeFixture(async path=>{
 const error=new Error('stream failed'),w=wire([Buffer.from('ab')],null,error);await assert.rejects(download(1n,input,dirname(path),10n,10n,w.transport,true),e=>e===error);assert.equal((await readFile(join(dirname(path),'01-note.txt'))).toString(),'ab');assert.equal(w.observed.releases,1);assert.equal(w.observed.finished,1);
}));
test('filesystem creation failure releases response even without body consumption',()=>storeFixture(async path=>{
 const w=wire([Buffer.from('abc')]);await assert.rejects(download(1n,input,join(dirname(path),'absent'),10n,10n,w.transport,true),{code:'ENOENT'});assert.equal(w.observed.releases,1);assert.equal(w.observed.finished,0);
}));
test('inline size gating is actual written length rather than advertised metadata',()=>storeFixture(async path=>{
 const w=wire([Buffer.from('abc')]);assert.equal((await download(1n,{...input,size:0n},dirname(path),10n,2n,w.transport,true)).preview,null);
}));
test('lossy preview keeps BOM, replaces invalid UTF8 and counts astral scalars at 12000 boundary',()=>{
 assert.equal(preview(Buffer.from([0xef,0xbb,0xbf,0xf0,0x28,0x8c,0x28])),'\ufeff�(�(');assert.equal(preview(Buffer.from('😀'.repeat(12000))),'😀'.repeat(12000));assert.equal(preview(Buffer.from('😀'.repeat(12001))),'😀'.repeat(12000)+'\n\n[truncated]');
});
test('bad metadata, counts and nonnative request reject before unowned thenable executes',()=>storeFixture(async path=>{
 const w=wire([]);await assert.rejects(download(-1n,input,dirname(path),10n,10n,w.transport,true),TypeError);await assert.rejects(download(1n,{...input,filename:'\ud800'},dirname(path),10n,10n,w.transport,true),TypeError);let calls=0;await assert.rejects(download(1n,input,dirname(path),10n,10n,{get(){return {get then(){calls++;return undefined;}};}} as any,true),TypeError);assert.equal(calls,0);assert.equal(w.observed.gets,0);
}));
