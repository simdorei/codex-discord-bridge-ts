import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureMirrorCursorAnchor,observeMirrorCursorContinuity} from '../../src/runtime/session-mirror/continuity-observation.ts';
import {encodeMirrorCursorAnchor,decodeMirrorCursorAnchor} from '../../src/core/mirror-cursor-anchor.ts';
import {storeFixture} from '../helpers/store-fixture.ts';
import {dirname} from 'node:path';
test('durable full prefix detects a middle rewrite followed by append after restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cdr-source-'));try{const path=join(root,'rollout.jsonl');const content=('x'.repeat(1023)+'\n').repeat(8);await writeFile(path,content);
 const anchor=(await captureMirrorCursorAnchor(path,BigInt(Buffer.byteLength(content)),undefined,true)).anchor;assert.equal(anchor.version,3);
 const persisted=decodeMirrorCursorAnchor(encodeMirrorCursorAnchor(anchor));await appendFile(path,'{"type":"append"}\n');await observeMirrorCursorContinuity(persisted);
 const file=await open(path,'r+');try{await file.write(Buffer.from('changed'),0,7,4096);}finally{await file.close();}await appendFile(path,'{}\n');
 await assert.rejects(observeMirrorCursorContinuity(persisted),/changed/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('unchanged full-prefix polls read only bounded anchors, and files larger than 512 MiB remain supported',{timeout:30000},()=>storeFixture(async database=>{
 const path=join(dirname(database),'large.jsonl'),file=await open(path,'w+');const size=513*1024*1024;
 try{await file.truncate(size);await file.write(Buffer.from('\n'),0,1,size-1);}finally{await file.close();}
 const anchor=(await captureMirrorCursorAnchor(path,BigInt(size),undefined,true)).anchor;
 const handle=await open(path,'r'),prototype=Object.getPrototypeOf(handle),original=prototype.read;await handle.close();let bytes=0;
 prototype.read=async function(...args:unknown[]){const result=await Reflect.apply(original,this,args) as {bytesRead:number};bytes+=result.bytesRead;return result;};
 try{await observeMirrorCursorContinuity(anchor);await observeMirrorCursorContinuity(anchor);assert.equal(bytes,1024,'Two unchanged polls must not rehash the consumed 513 MiB prefix');}
 finally{prototype.read=original;}
}));
