import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {captureMirrorCursorAnchor as capture,observeAnchoredMirrorBatch as observe,AnchoredMirrorBatch} from '../../../src/runtime/session-mirror/continuity-observation.ts';
import {MirrorFileChangedError} from '../../../src/runtime/session-mirror/file-window.ts';
const limits={maxWindowBytes:8192,maxRecordBytes:4096,maxRecords:20,decodeTimeoutMs:5000};
const options={thread:'thread',detail:'Send' as const,currentTurn:'turn'};
const line=JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'한😀'}})+'\n';
async function fixture(run:(path:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'mirror-anchor-batch-'));try{await run(join(dir,'rollout.jsonl'))}finally{await rm(dir,{recursive:true,force:true})}}
test('old anchor, complete native decode and next boundary share one exact file stamp',async()=>fixture(async path=>{
 await writeFile(path,'{}\n');const prior=await capture(path,3n);await appendFile(path,line);
 const result=await observe(prior.anchor,limits,options);
 assert.equal(result.continuity,'SameIdentityGrowthAndAnchors');assert.equal(result.batch.items[0]!.text,'한😀');
 assert.equal(result.batch.nextOffset,3n+BigInt(Buffer.byteLength(line)));
 const next=await result.observeNextBoundary();assert.deepEqual(next.anchor.stamp,result.batch.fileStamp);assert.equal(next.anchor.offset,result.batch.nextOffset);
 assert.equal(result.historyIntegrityVerified,false);await result.verifyCurrent();
}));
test('incomplete suffix never enters the proposed next boundary',async()=>fixture(async path=>{
 await writeFile(path,'');const prior=await capture(path,0n);await appendFile(path,line+'{"partial":');
 const result=await observe(prior.anchor,limits,options);assert.equal(result.batch.heldSuffix,true);
 assert.equal(result.batch.nextOffset,BigInt(Buffer.byteLength(line)));assert.equal((await result.observeNextBoundary()).anchor.offset,result.batch.nextOffset);
}));
test('append after decode refuses next observation rather than blessing changed bytes',async()=>fixture(async path=>{
 await writeFile(path,'');const prior=await capture(path,0n);await appendFile(path,line);const result=await observe(prior.anchor,limits,options);
 await appendFile(path,line);await assert.rejects(result.observeNextBoundary(),MirrorFileChangedError);await assert.rejects(result.verifyCurrent(),MirrorFileChangedError);
}));
test('options, limits and prior fields are captured before the first awaited read',async()=>fixture(async path=>{
 await writeFile(path,'');const original=await capture(path,0n);await appendFile(path,line);
 const prior={...original.anchor},bounds={...limits},context={...options};const pending=observe(prior,bounds,context);
 prior.path='/wrong';bounds.maxRecords=0;context.thread='wrong';context.currentTurn='wrong';
 const result=await pending;assert.equal(result.batch.thread,'thread');assert.equal(result.batch.priorTurn,'turn');assert.equal(result.batch.items.length,1);
}));
test('bad accessor limits and forged batch cannot initiate native reading',async()=>fixture(async path=>{
 await writeFile(path,'');const prior=await capture(path,0n);let calls=0;
 await assert.rejects(observe(prior.anchor,{...limits,get maxRecords(){calls++;return 1}},options),TypeError);
 assert.throws(()=>new AnchoredMirrorBatch(Symbol(),'UnchangedMetadataAndAnchors',prior.anchor,{} as never),TypeError);assert.equal(calls,0);
}));
test('cancelled anchored observation retains exact reason and returns no substitute batch',async()=>fixture(async path=>{
 await writeFile(path,'');const prior=await capture(path,0n);const controller=new AbortController(),reason=Error('cancel');controller.abort(reason);
 await assert.rejects(observe(prior.anchor,limits,options,controller.signal),e=>e===reason);
}));
test('forged method receiver cannot run caller supplied verification hooks',async()=>{
 let calls=0;const forged=Object.create(AnchoredMirrorBatch.prototype);
 Object.defineProperty(forged,'batch',{get(){calls++;throw Error('hook')}});
 await assert.rejects(forged.verifyCurrent(),TypeError);await assert.rejects(forged.observeNextBoundary(),TypeError);assert.equal(calls,0);
});
