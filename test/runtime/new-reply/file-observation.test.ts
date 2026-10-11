import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rename,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {encodeNewReplyFileCursor,decodeNewReplyFileCursor,beginNewReplyFileCursor,observeNewReplyFile,snapshotNewReplyFileCursor,NewReplyFileObservation} from '../../../src/runtime/new-reply/file-observation.ts';
import {MirrorFileChangedError,activeMirrorFileReads} from '../../../src/runtime/session-mirror/file-window.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {serializeSerdeValue} from '../../../src/core/serde-json.ts';
const id={threadId:'thread',cwd:'/project',turnId:'first-turn',promptSha256:'be41aba2fd84362ba49d22d8635d6c05f86426ee40846f1354e944062c4557a8'};
const meta=JSON.stringify({type:'session_meta',payload:{id:'thread',cwd:'/project'}})+'\n',turn=JSON.stringify({type:'turn_context',payload:{turn_id:'first-turn'}})+'\n',user=JSON.stringify({type:'event_msg',payload:{type:'user_message',message:'요청'}})+'\n';
async function fixture(body:(p:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'new-reply-window-'));try{await body(join(root,'rollout.jsonl'));}finally{await rm(root,{recursive:true,force:true});assert.equal(activeMirrorFileReads(),0);assert.deepEqual(ownedWorkerUsage(),{Background:0,Control:0,Observation:0});}}
test('native file append resumes exact prior boundary and state instead of rescanning prefix',async()=>fixture(async p=>{
 await writeFile(p,meta+turn+user.slice(0,-1));const start=await beginNewReplyFileCursor(p,id),first=await observeNewReplyFile(start);
 assert.equal(first.stop,'IncompleteRecord');assert.equal(first.cursor.anchor.offset,BigInt(Buffer.byteLength(meta+turn)));assert.equal(first.cursor.state.turn,'first-turn');assert.equal(first.cursor.state.matched,false);
 await appendFile(p,'\n');const next=await observeNewReplyFile(first.cursor);assert.equal(next.continuity,'SameIdentityGrowthAndAnchors');assert.equal(next.scannedRecords,1);assert.equal(next.stop,'Matched');assert.equal(next.historyIntegrityVerified,false);await next.verifyCurrent();
 const same=await observeNewReplyFile(next.cursor);assert.equal(same.scannedRecords,0);assert.equal(same.cursor.state.matched,true);
}));
test('over 700 events progress through serialized bounded checkpoints without offset reset',async()=>fixture(async p=>{
 await writeFile(p,meta+turn+'{"type":"ignored"}\n'.repeat(700)+user);let cursor=await beginNewReplyFileCursor(p,id),total=0,steps=0;
 while(!cursor.state.matched&&steps<30){const r=await observeNewReplyFile(cursor,{maxWindowBytes:1048576,maxRecordBytes:262144,maxRecords:128});assert.ok(r.cursor.anchor.offset>cursor.anchor.offset);assert.ok(r.scannedRecords<=128);total+=r.scannedRecords;steps++;cursor=decodeNewReplyFileCursor(encodeNewReplyFileCursor(r.cursor));}
 assert.equal(cursor.state.matched,true);assert.equal(total,703);assert.ok(steps>=6);
}));
test('replacement and observed truncation refuse old turn context without automatic bootstrap',async()=>fixture(async p=>{
 await writeFile(p,meta+turn);const first=await observeNewReplyFile(await beginNewReplyFileCursor(p,id));
 await rename(p,p+'.old');await writeFile(p,user);await assert.rejects(observeNewReplyFile(first.cursor),MirrorFileChangedError);
 const fresh=await beginNewReplyFileCursor(p,id),read=await observeNewReplyFile(fresh);assert.equal(read.cursor.state.matched,false);
 await writeFile(p,'');await assert.rejects(observeNewReplyFile(read.cursor),MirrorFileChangedError);
}));
test('prefix rewrite plus growth rejects anchors and post-observation mutation invalidates witness',async()=>fixture(async p=>{
 await writeFile(p,meta+turn);const first=await observeNewReplyFile(await beginNewReplyFileCursor(p,id));
 await writeFile(p,meta.replace('thread','other!')+turn+user);await assert.rejects(observeNewReplyFile(first.cursor),MirrorFileChangedError);
 await writeFile(p,meta+turn+user);const matched=await observeNewReplyFile(await beginNewReplyFileCursor(p,id));await appendFile(p,'{}\n');await assert.rejects(matched.verifyCurrent(),MirrorFileChangedError);
}));
test('invalid record and identity mismatch yield no next cursor and preserve prior snapshot',async()=>fixture(async p=>{
 await writeFile(p,meta+'{bad}\n');const cursor=await beginNewReplyFileCursor(p,id),before=serializeSerdeValue(cursor);await assert.rejects(observeNewReplyFile(cursor),/Invalid new rollout JSON/);assert.equal(serializeSerdeValue(cursor),before);
 await writeFile(p,meta.replace('thread','wrong!')+turn+user);await assert.rejects(observeNewReplyFile(await beginNewReplyFileCursor(p,id)),/identity mismatch/);
}));
test('abort and passive cursor/limits rejection allocate no native work; observation brands cannot be forged',async()=>fixture(async p=>{
 await writeFile(p,'');const cursor=await beginNewReplyFileCursor(p,id),c=new AbortController(),reason=new Error('aborted');c.abort(reason);await assert.rejects(observeNewReplyFile(cursor,undefined,c.signal),e=>e===reason);
 let hooks=0;const evil=Object.defineProperty({},'version',{get(){hooks++;return 1;}});assert.throws(()=>snapshotNewReplyFileCursor(evil as never),TypeError);
 await assert.rejects(observeNewReplyFile(cursor,Object.defineProperty({},'maxWindowBytes',{get(){hooks++;return 1;}}) as never),TypeError);assert.equal(hooks,0);
 assert.throws(()=>snapshotNewReplyFileCursor({...cursor,state:{sessionSeen:true,turn:'first-turn',matched:true}}),/Zero cursor/);assert.throws(()=>snapshotNewReplyFileCursor({...cursor,state:{sessionSeen:false,turn:'first-turn',matched:true}}),/inconsistent original turn/);
 assert.throws(()=>NewReplyFileObservation.prototype.captured.call(Object.create(NewReplyFileObservation.prototype)),TypeError);
}));

test('checkpoint codec preserves exact large integers and rejects noncanonical or forged data',async()=>fixture(async p=>{await writeFile(p,meta);const c=await beginNewReplyFileCursor(p,id),text=encodeNewReplyFileCursor(c);assert.equal(encodeNewReplyFileCursor(decodeNewReplyFileCursor(text)),text);assert.throws(()=>decodeNewReplyFileCursor(' '+text),/Noncanonical/);assert.throws(()=>decodeNewReplyFileCursor(text.replace('[1,','[2,')),/Invalid/);assert.throws(()=>decodeNewReplyFileCursor('x'.repeat(200001)),RangeError);assert.equal(decodeNewReplyFileCursor(text).anchor.stamp.ino,c.anchor.stamp.ino);}));
