import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rename,rm,open,truncate} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {captureMirrorCursorAnchor as capture,observeMirrorCursorContinuity as observe,MirrorContinuityObservation} from '../../../src/runtime/session-mirror/continuity-observation.ts';
import {MirrorFileChangedError,activeMirrorFileReads} from '../../../src/runtime/session-mirror/file-window.ts';
async function fixture(run:(path:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'mirror-anchor-'));try{await run(join(dir,'rollout.jsonl'))}finally{await rm(dir,{recursive:true,force:true})}}
test('complete-record anchor round trips without treating it as history integrity',async()=>fixture(async path=>{
 await writeFile(path,'a'.repeat(700)+'\n');const first=await capture(path,701n);
 assert.equal(first.historyIntegrityVerified,false);assert.ok(Object.isFrozen(first.anchor.stamp));
 assert.equal((await observe(first.anchor)).kind,'UnchangedMetadataAndAnchors');await first.verifyCurrent();assert.equal(activeMirrorFileReads(),0);
}));
test('append retains bounded old prefix/tail while marking growth separately',async()=>fixture(async path=>{
 await writeFile(path,'first\n');const first=await capture(path,6n);await appendFile(path,'next\n');
 const next=await observe(first.anchor);assert.equal(next.kind,'SameIdentityGrowthAndAnchors');assert.equal(next.observation.anchor.offset,6n);
 assert.equal(next.observation.historyIntegrityVerified,false);await assert.rejects(first.verifyCurrent(),MirrorFileChangedError);
}));
test('replacement at same path and observed shrink cannot inherit the old cursor',async()=>fixture(async path=>{
 await writeFile(path,'first\n');const first=await capture(path,6n);
 await rename(path,path+'.old');await writeFile(path,'first\nnext\n');await assert.rejects(observe(first.anchor),MirrorFileChangedError);
 const next=await capture(path,6n);await truncate(path,6);await assert.rejects(observe(next.anchor),MirrorFileChangedError);
}));
test('changed captured prefix or tail is rejected even after append',async()=>fixture(async path=>{
 await writeFile(path,'a'.repeat(700)+'\n');const first=await capture(path,701n);
 const handle=await open(path,'r+');try{await handle.write('b',0,'utf8')}finally{await handle.close()}
 await appendFile(path,'next\n');await assert.rejects(observe(first.anchor),MirrorFileChangedError);
}));
test('partial record boundary never becomes an anchor; zero is explicit',async()=>fixture(async path=>{
 await writeFile(path,'partial');await assert.rejects(capture(path,7n),MirrorFileChangedError);
 const start=await capture(path,0n);assert.equal(start.anchor.offset,0n);assert.equal(start.historyIntegrityVerified,false);
 await assert.rejects(capture(path,8n),MirrorFileChangedError);
}));
test('anchors explicitly do not certify unseen middle rewrites followed by append',async()=>fixture(async path=>{
 await writeFile(path,'a'.repeat(1200)+'\n');const first=await capture(path,1201n);
 const handle=await open(path,'r+');try{await handle.write('b',600,'utf8')}finally{await handle.close()}
 await appendFile(path,'next\n');const observation=await observe(first.anchor);
 assert.equal(observation.kind,'SameIdentityGrowthAndAnchors');assert.equal(observation.observation.historyIntegrityVerified,false);
}));
test('forged observations, accessor anchors and pre-abort cannot acquire IO capacity',async()=>fixture(async path=>{
 await writeFile(path,'x\n');const first=await capture(path,2n);let calls=0;
 await assert.rejects(observe({...first.anchor,get offset(){calls++;return 2n}}),TypeError);
 assert.throws(()=>new MirrorContinuityObservation(Symbol(),first.anchor,{} as never),TypeError);
 const controller=new AbortController(),reason=Error('cancel');controller.abort(reason);
 await assert.rejects(observe(first.anchor,controller.signal),e=>e===reason);assert.equal(calls,0);assert.equal(activeMirrorFileReads(),0);
}));
