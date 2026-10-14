import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rename,rm,truncate,mkdir,symlink,open} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureMirrorStartupCutoff as capture,readMirrorStartupContext as read,MirrorStartupCutoff,MirrorStartupContextObservation,MirrorStartupContextHeldError,mirrorStartupContextReaderBusy,joinMirrorStartupContextReader,type MirrorStartupContextLimits,type MirrorStartupContextHold} from '../../../src/runtime/session-mirror/startup-context-reader.ts';
import {snapshotMirrorStartupCutoffData} from '../../../src/runtime/session-mirror/startup-context-limits.ts';
import {readMirrorStartupContextNative,captureMirrorStartupCutoffNative} from '../../../src/runtime/session-mirror/startup-context-scan.ts';
import {MirrorFileChangedError} from '../../../src/runtime/session-mirror/file-window.ts';
import {OwnedWorkerBusyError,OwnedWorkerSlot,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
const limits:MirrorStartupContextLimits={maxBytes:1048576,maxRecords:20000,maxRecordBytes:262144,maxWindowBytes:65536,maxTurnBytes:16384,timeoutMs:5000};
const line=(turn:unknown)=>JSON.stringify({type:'turn_context',payload:{turn_id:turn}})+'\n';
const held=(reason:MirrorStartupContextHold)=>(error:unknown)=>error instanceof MirrorStartupContextHeldError&&error.reason===reason;
async function fixture(run:(path:string,dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'mirror-startup-'));try{await run(join(dir,'rollout.jsonl'),dir);}finally{await rm(dir,{recursive:true,force:true});}}
async function fromText(path:string,text:string|Uint8Array,input:MirrorStartupContextLimits=limits){await writeFile(path,text);const cutoff=await capture(path);return read(cutoff,input);}

test('complete successful empty/no-match scans alone produce null context',()=>fixture(async path=>{
 const empty=await fromText(path,'');assert.equal(empty.currentTurn,null);assert.equal(empty.scannedBytes,0n);assert.equal(empty.scannedRecords,0);assert.equal(empty.cutoff.offset,0n);assert.equal(empty.historyIntegrityVerified,false);await empty.verifyCurrent();
 const noMatch=await fromText(path,'\nplain text\nnull\n[]\n{}\n');assert.equal(noMatch.currentTurn,null);assert.equal(noMatch.scannedRecords,5);assert.equal(noMatch.continuity,'UnchangedMetadataAndAnchors');assert.ok(Object.isFrozen(noMatch));assert.ok(Object.isFrozen(noMatch.anchor.stamp));
}));

test('source predicates, last match and nonempty untrimmed turn IDs are preserved',()=>fixture(async path=>{
 const text=line('first')+JSON.stringify({type:'other',payload:{type:'task_started',turn_id:'payload-only'}})+'\n'+line('')+line(17)+line(null)+JSON.stringify({type:'turn_context',payload:{}})+'\n'+JSON.stringify({type:'event_msg',payload:{type:'task_complete',turn_id:'terminal'}})+'\n';
 const value=await fromText(path,text);assert.equal(value.currentTurn,'payload-only');assert.equal(value.scannedRecords,7);
 assert.equal((await fromText(path,text+line(' \t\n '))).currentTurn,' \t\n ');
 assert.equal((await fromText(path,line('first')+'{"type":"turn_context","payload":{"turn_id":"old","turn_id":"last"}}\n')).currentTurn,'last');
}));

test('only top-level turn_context or payload task_started qualify; terminal events do not clear',()=>fixture(async path=>{
 const events=[{type:'task_started',payload:{turn_id:'wrong-top'}},{type:'other',payload:{type:'turn_context',turn_id:'wrong-payload'}},{type:'turn_context',turn_id:'wrong-location'},{type:'event_msg',payload:{type:'turn_aborted'}},{type:'event_msg',payload:{type:'task_failed'}},{type:'event_msg',payload:{type:'task_complete'}},{type:'event_msg',payload:{type:'agent_message',message:'done'}}];
 assert.equal((await fromText(path,line('kept')+events.map(v=>JSON.stringify(v)+'\n').join(''))).currentTurn,'kept');
}));

test('keyword prefix counts 200 Unicode scalars rather than UTF16 code units',()=>fixture(async path=>{
 const unicode=JSON.stringify({padding:'😀'.repeat(150),type:'turn_context',payload:{turn_id:'unicode'}})+'\n';
 assert.ok(unicode.indexOf('turn_context')>200);assert.equal((await fromText(path,unicode)).currentTurn,'unicode');
 const before='{"padding":"',after='","type":"',marker='turn_context';
 const endingAt=(n:number)=>before+'x'.repeat(n-before.length-after.length-marker.length)+after+marker+'","payload":{"turn_id":"boundary"}}\n';
 assert.equal((await fromText(path,endingAt(200))).currentTurn,'boundary');assert.equal((await fromText(path,line('kept')+endingAt(201))).currentTurn,'kept');
}));

test('prefix filter uses literal raw keywords before JSON decoding and does not trim',()=>fixture(async path=>{
 const escaped='{"type":"turn_\\u0063ontext","payload":{"turn_id":"escaped"}}\n';
 assert.equal((await fromText(path,line('kept')+escaped)).currentTurn,'kept');
 assert.equal((await fromText(path,' '.repeat(200)+line('beyond'))).currentTurn,null);
 assert.equal((await fromText(path,'\ufeff'+line('bom'))).currentTurn,null);
 assert.equal((await fromText(path,'{"hint":"task_started","type":"turn_\\u0063ontext","payload":{"turn_id":"parsed"}}\n')).currentTurn,'parsed');
}));

test('malformed JSON, nonobjects and serde-invalid values are ignored',()=>fixture(async path=>{
 const text=line('kept')+'turn_context broken\n["turn_context"]\n"task_started"\n'+
  '{"type":"turn_context","n":1e999,"payload":{"turn_id":"overflow"}}\n'+
  '{"type":"turn_context","n":"\\ud800","payload":{"turn_id":"surrogate"}}\n'+
  '{"type":"turn_context","payload":{"turn_id":"deep"},"deep":'+ '['.repeat(128)+'0'+']'.repeat(128)+'}\n';
 assert.equal((await fromText(path,text)).currentTurn,'kept');
}));

test('invalid UTF8 on any line holds instead of ignoring it or returning prior context',()=>fixture(async path=>{
 for(const invalid of [Buffer.from([0xff,10]),Buffer.from([0xf0,0x9f,10]),Buffer.from([0xc0,0xaf,10])]){
  await writeFile(path,Buffer.concat([Buffer.from(line('prior')),invalid,Buffer.from(line('later'))]));const cutoff=await capture(path);await assert.rejects(read(cutoff,limits),held('InvalidUtf8'));
 }
}));

test('CRLF and multibyte characters survive arbitrary small native windows',()=>fixture(async path=>{
 const text=line('한😀').replace('\n','\r\n')+'\r\n'+JSON.stringify({payload:{type:'task_started',turn_id:'終😀'},type:'different'})+'\r\n';
 const result=await fromText(path,text,{...limits,maxWindowBytes:3});assert.equal(result.currentTurn,'終😀');assert.equal(result.scannedRecords,3);assert.equal(result.scannedBytes,BigInt(Buffer.byteLength(text)));
}));

test('non-LF EOF stays held with exact N even if later appended bytes complete it',()=>fixture(async path=>{
 const text=line('old').slice(0,-1);await writeFile(path,text);const cutoff=await capture(path);assert.equal(cutoff.completeRecordBoundary,false);assert.equal(cutoff.offset,BigInt(Buffer.byteLength(text)));
 await assert.rejects(read(cutoff,limits),held('IncompleteBoundary'));await appendFile(path,'\n'+line('new'));await assert.rejects(read(cutoff,limits),held('IncompleteBoundary'));assert.equal(cutoff.offset,BigInt(Buffer.byteLength(text)));assert.equal(mirrorStartupContextReaderBusy(),false);
}));

test('fixed cutoff survives a held retry and pre-scan append without consuming new records',()=>fixture(async path=>{
 const original=line('old');await writeFile(path,original);const cutoff=await capture(path);
 await assert.rejects(read(cutoff,{...limits,maxBytes:1}),held('ByteBudget'));await appendFile(path,line('new'));
 const result=await read(cutoff,limits);assert.equal(result.cutoff,cutoff);assert.equal(result.currentTurn,'old');assert.equal(result.scannedRecords,1);assert.equal(result.scannedBytes,BigInt(Buffer.byteLength(original)));assert.equal(result.anchor.offset,cutoff.offset);assert.ok(result.anchor.stamp.size>cutoff.offset);assert.equal(result.continuity,'SameIdentityGrowthAndAnchors');await result.verifyCurrent();
 await appendFile(path,line('newer'));await assert.rejects(result.verifyCurrent(),MirrorFileChangedError);assert.equal((await read(cutoff,limits)).currentTurn,'old');
}));

test('an empty captured EOF remains zero after append',()=>fixture(async path=>{
 await writeFile(path,'');const cutoff=await capture(path);await appendFile(path,line('later'));const result=await read(cutoff,limits);assert.equal(result.currentTurn,null);assert.equal(result.scannedBytes,0n);assert.equal(result.scannedRecords,0);assert.equal(result.continuity,'SameIdentityGrowthAndAnchors');
}));

test('replacement, shrink, same-size rewrite and changed prefix with append refuse old cutoff',()=>fixture(async path=>{
 await writeFile(path,line('original'));let cutoff=await capture(path);await rename(path,path+'.old');await writeFile(path,line('original'));await assert.rejects(read(cutoff,limits),held('ChangedFile'));
 cutoff=await capture(path);await truncate(path,0);await assert.rejects(read(cutoff,limits),held('ChangedFile'));
 await writeFile(path,line('original'));cutoff=await capture(path);await writeFile(path,line('modified'));await assert.rejects(read(cutoff,limits),held('ChangedFile'));
 cutoff=await capture(path);const handle=await open(path,'r+');try{await handle.write(' ',0,'utf8');}finally{await handle.close();}await appendFile(path,line('later'));await assert.rejects(read(cutoff,limits),held('ChangedFile'));
}));

test('a deterministic append or rewrite after window capture holds the entire native scan',()=>fixture(async path=>{
 for(const replace of [false,true]){
  await writeFile(path,line('original'));const cutoff=await capture(path),slot=new OwnedWorkerSlot();
  const pending=slot.run(new URL('./startup-context-race-worker.ts',import.meta.url),{cutoff:cutoff.captured(),limits,replace},5000),exited=slot.join();
  try{assert.deepEqual(await pending,{ok:false,changed:true});}finally{await exited;}
  assert.equal(cutoff.offset,BigInt(Buffer.byteLength(line('original'))));
 }
}));

test('byte, record and complete-wire-line budgets hold the entire reconstruction',()=>fixture(async path=>{
 const text=line('first')+line('last');await writeFile(path,text);const cutoff=await capture(path);
 await assert.rejects(read(cutoff,{...limits,maxBytes:Buffer.byteLength(text)-1}),held('ByteBudget'));
 await assert.rejects(read(cutoff,{...limits,maxRecords:1}),held('RecordBudget'));
 const single=line('one').replace('\n','\r\n');await writeFile(path,single);const singleCutoff=await capture(path);
 await assert.rejects(read(singleCutoff,{...limits,maxRecordBytes:Buffer.byteLength(single)-1,maxWindowBytes:4}),held('RecordBytes'));
 assert.equal((await read(singleCutoff,{...limits,maxRecordBytes:Buffer.byteLength(single),maxWindowBytes:4,maxRecords:1})).currentTurn,'one');
}));

test('final turn output enforces the explicit UTF8 and UTF16 cap without clipping',()=>fixture(async path=>{
 assert.equal((await fromText(path,line('x'.repeat(16384)))).currentTurn?.length,16384);
 await writeFile(path,line('x'.repeat(16385)));await assert.rejects(read(await capture(path),limits),held('TurnBudget'));
 await writeFile(path,line('한'.repeat(5462)));await assert.rejects(read(await capture(path),limits),held('TurnBudget'));
 assert.equal((await fromText(path,line('x'.repeat(20000))+line('last'))).currentTurn,'last');
 await writeFile(path,line('12345'));await assert.rejects(read(await capture(path),{...limits,maxTurnBytes:4}),held('TurnBudget'));
}));

test('raw native symlink-parent path remains bound to the intended rollout',()=>fixture(async (path,dir)=>{
 await mkdir(join(dir,'physical','child'),{recursive:true});await symlink(join(dir,'physical','child'),join(dir,'alias'),'dir');
 await writeFile(join(dir,'physical','rollout.jsonl'),line('correct'));await writeFile(path,line('wrong'));
 const raw=dir+'/alias/../rollout.jsonl',cutoff=await capture(raw),result=await read(cutoff,limits);assert.equal(cutoff.path,raw);assert.equal(result.anchor.version,2);assert.equal(result.anchor.path,raw);assert.equal(result.currentTurn,'correct');
}));

test('forged evidence, active limit accessors and invalid limits do not submit work',()=>fixture(async path=>{
 await writeFile(path,line('turn'));const cutoff=await capture(path);let getters=0;
 await assert.rejects(read(cutoff,{...limits,get maxRecords(){getters++;return 1;}}),TypeError);assert.equal(getters,0);
 for(const field of ['maxBytes','maxRecords','maxRecordBytes','maxWindowBytes','maxTurnBytes','timeoutMs'] as const)await assert.rejects(read(cutoff,{...limits,[field]:0}),RangeError);
 await assert.rejects(read(cutoff,{...limits,maxBytes:67108865}),RangeError);await assert.rejects(read(cutoff,{...limits,maxTurnBytes:16385}),RangeError);
 await assert.rejects(read(Object.create(MirrorStartupCutoff.prototype),limits),TypeError);await assert.rejects(read(new Proxy(cutoff,{}),limits),TypeError);
 assert.throws(()=>new MirrorStartupCutoff(Symbol(),cutoff.captured()),TypeError);assert.throws(()=>new MirrorStartupContextObservation(Symbol(),cutoff,cutoff.captured().anchor!,'UnchangedMetadataAndAnchors',null,0),TypeError);
 const forged=Object.create(MirrorStartupContextObservation.prototype);await assert.rejects(forged.verifyCurrent(),TypeError);
 assert.throws(()=>snapshotMirrorStartupCutoffData({...cutoff.captured(),offset:1n<<63n,stamp:{...cutoff.fileStamp,size:1n<<63n}}),TypeError);
 assert.equal(mirrorStartupContextReaderBusy(),false);
}));

test('native scan functions refuse execution on the main event loop',()=>fixture(async path=>{
 await writeFile(path,line('turn'));const cutoff=await capture(path);await assert.rejects(captureMirrorStartupCutoffNative(path,()=>{}),TypeError);await assert.rejects(readMirrorStartupContextNative(cutoff.captured(),limits,()=>{}),TypeError);
}));

test('pre-abort and native missing-file failures are errors, never empty contexts',()=>fixture(async path=>{
 const stop=new AbortController(),reason={stop:true};stop.abort(reason);await assert.rejects(capture(path,5000,stop.signal),error=>error===reason);await assert.rejects(capture(path),held('NativeRead'));
 await writeFile(path,line('turn'));const cutoff=await capture(path);await assert.rejects(read(cutoff,limits,stop.signal),error=>error===reason);await rm(path);await assert.rejects(read(cutoff,limits),held('NativeRead'));assert.equal(mirrorStartupContextReaderBusy(),false);
}));

test('native cancellation joins the worker, preserves reason and refuses another queued read',()=>fixture(async path=>{
 await writeFile(path,line('turn'));const cutoff=await capture(path),before=ownedWorkerUsage().Background,stop=new AbortController(),reason={cancel:true};
 const task=read(cutoff,limits,stop.signal);assert.equal(mirrorStartupContextReaderBusy(),true);assert.equal(ownedWorkerUsage().Background,before+1);
 await assert.rejects(read(cutoff,limits),OwnedWorkerBusyError);stop.abort(reason);await assert.rejects(task,error=>error===reason);assert.equal(mirrorStartupContextReaderBusy(),false);assert.equal(ownedWorkerUsage().Background,before);await joinMirrorStartupContextReader();
 assert.equal((await read(cutoff,limits)).currentTurn,'turn');
}));

test('deadline is an explicit held error and releases capacity only after native exit',()=>fixture(async path=>{
 await writeFile(path,line('turn'));const cutoff=await capture(path),before=ownedWorkerUsage().Background;
 await assert.rejects(read(cutoff,{...limits,timeoutMs:1}),held('Deadline'));assert.equal(mirrorStartupContextReaderBusy(),false);assert.equal(ownedWorkerUsage().Background,before);
 assert.equal((await read(cutoff,limits)).currentTurn,'turn');
}));
