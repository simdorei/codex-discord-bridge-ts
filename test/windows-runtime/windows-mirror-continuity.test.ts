import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureMirrorCursorAnchor,observeMirrorCursorContinuity} from '../../src/runtime/session-mirror/continuity-observation.ts';
import {encodeMirrorCursorAnchor,decodeMirrorCursorAnchor} from '../../src/core/mirror-cursor-anchor.ts';
test('durable full prefix detects a middle rewrite followed by append after restart',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cdr-source-'));try{const path=join(root,'rollout.jsonl');const content=('x'.repeat(1023)+'\n').repeat(8);await writeFile(path,content);
 const anchor=(await captureMirrorCursorAnchor(path,BigInt(Buffer.byteLength(content)),undefined,true)).anchor;assert.equal(anchor.version,3);
 const persisted=decodeMirrorCursorAnchor(encodeMirrorCursorAnchor(anchor));await appendFile(path,'{"type":"append"}\n');await observeMirrorCursorContinuity(persisted);
 const file=await open(path,'r+');try{await file.write(Buffer.from('changed'),0,7,4096);}finally{await file.close();}await appendFile(path,'{}\n');
 await assert.rejects(observeMirrorCursorContinuity(persisted),/changed/);
 }finally{await rm(root,{recursive:true,force:true});}
});
