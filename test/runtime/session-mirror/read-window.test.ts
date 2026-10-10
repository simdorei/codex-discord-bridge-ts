import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,appendFile} from 'node:fs/promises';import {setTimeout as sleep} from 'node:timers/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {readStableMirrorWindow} from '../../../src/runtime/session-mirror/read-window.ts';
import {activeMirrorFileReads,MirrorFileChangedError} from '../../../src/runtime/session-mirror/file-window.ts';
import {mirrorDecoderBusy,joinMirrorDecoder} from '../../../src/runtime/session-mirror/decode-reader.ts';
const limits={maxWindowBytes:1048576,maxRecordBytes:262144,maxRecords:1024,decodeTimeoutMs:3000};
test('native file and native decoder return only the complete prefix, preserving UTF8 and u64',async()=>storeFixture(async path=>{
 const line='{"text":"한😀","n":18446744073709551615}\n';await writeFile(path,line+'{"partial":');
 const result=await readStableMirrorWindow(path,0n,limits);assert.equal(result.decoded.events.length,1);assert.equal(result.decoded.events[0]!.value.n,18446744073709551615n);assert.equal(result.decoded.nextOffset,BigInt(Buffer.byteLength(line)));assert.equal(result.decoded.stop,'IncompleteRecord');assert.equal(mirrorDecoderBusy(),false);assert.equal(activeMirrorFileReads(),0);
}));
test('damaged record stops before it and never converts the remainder into successful consumption',async()=>storeFixture(async path=>{
 const first='{"ok":true}\n';await writeFile(path,first+'{bad}\n{"later":true}\n');
 const result=await readStableMirrorWindow(path,0n,limits);assert.equal(result.decoded.stop,'InvalidJson');assert.equal(result.decoded.nextOffset,BigInt(Buffer.byteLength(first)));assert.equal(result.decoded.events.length,1);
}));
test('invalid limits and active option getters are rejected before opening a file',async()=>storeFixture(async path=>{
 let reads=0;await assert.rejects(readStableMirrorWindow(path,0n,{...limits,get maxRecords(){reads++;return 1;}}));assert.equal(reads,0);
 await assert.rejects(readStableMirrorWindow(path,0n,{...limits,maxRecordBytes:1048576}),RangeError);assert.equal(activeMirrorFileReads(),0);assert.equal(mirrorDecoderBusy(),false);
}));
test('abort during actual off-thread decoding does not return before native worker exit',async()=>storeFixture(async path=>{
 await writeFile(path,'{"payload":"'+ 'x'.repeat(250000)+'"}\n');const stop=new AbortController(),reason={cancel:true};
 const task=readStableMirrorWindow(path,0n,limits,stop.signal);let settled=false;const outcome=task.then(value=>{settled=true;return {ok:true as const,value};},error=>{settled=true;return {ok:false as const,error};});
 try{const deadline=performance.now()+3000;while(!mirrorDecoderBusy()&&!settled&&performance.now()<deadline)await sleep(1);assert.equal(mirrorDecoderBusy(),true);stop.abort(reason);
  const result=await outcome;assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error,reason);assert.equal(mirrorDecoderBusy(),false);assert.equal(activeMirrorFileReads(),0);
 }finally{stop.abort(reason);await outcome;await joinMirrorDecoder();}
}));

test('append during native decode invalidates the complete result before it can be handed off',async()=>storeFixture(async path=>{
 await writeFile(path,'{"payload":"'+ 'x'.repeat(250000)+'"}\n');const stop=new AbortController();
 let settled=false;const task=readStableMirrorWindow(path,0n,limits,stop.signal),outcome=task.then(value=>{settled=true;return {ok:true as const,value};},error=>{settled=true;return {ok:false as const,error};});
 try{const deadline=performance.now()+3000;while(!mirrorDecoderBusy()&&!settled&&performance.now()<deadline)await sleep(1);assert.equal(mirrorDecoderBusy(),true);await appendFile(path,'{"later":true}\n');
  const result=await outcome;assert.equal(result.ok,false);if(!result.ok)assert.ok(result.error instanceof MirrorFileChangedError);assert.equal(mirrorDecoderBusy(),false);
 }finally{stop.abort();await outcome;await joinMirrorDecoder();}
}));
