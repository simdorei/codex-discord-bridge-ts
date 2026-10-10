import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,appendFile,rename,truncate} from 'node:fs/promises';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {MirrorFileWindow,MirrorFileBusyError,MirrorFileChangedError,MirrorFileClosePendingError,activeMirrorFileReads} from '../../../src/runtime/session-mirror/file-window.ts';
import {decodeMirrorWindowOffThread,joinMirrorDecoder} from '../../../src/runtime/session-mirror/decode-reader.ts';
test('actual file read is bounded, uses byte offsets and returns isolated byte copies',async()=>storeFixture(async path=>{
 await writeFile(path,Buffer.from('abcdef'));const value=await MirrorFileWindow.read(path,2n,3);assert.equal(Buffer.from(value.copyBytes()).toString(),'cde');assert.equal(value.byteLength,3);assert.equal(value.offset,2n);assert.equal(value.generation.size,6n);
 const first=value.copyBytes();first[0]=0;assert.equal(Buffer.from(value.copyBytes()).toString(),'cde');await value.verifyCurrent();assert.equal(activeMirrorFileReads(),0);
}));
test('empty EOF observation is valid while beyond EOF holds rather than resetting cursor',async()=>storeFixture(async path=>{
 await writeFile(path,'abc');assert.equal((await MirrorFileWindow.read(path,3n,20)).byteLength,0);await assert.rejects(MirrorFileWindow.read(path,4n,20),MirrorFileChangedError);assert.equal(activeMirrorFileReads(),0);
}));
test('pathname replacement cannot validate an old inode observation',async()=>storeFixture(async path=>{
 await writeFile(path,'same bytes');const value=await MirrorFileWindow.read(path,0n,20);await writeFile(path+'.new','same bytes');await rename(path+'.new',path);await assert.rejects(value.verifyCurrent(),MirrorFileChangedError);
}));
test('append and truncation are conservatively detected before a later handoff',async()=>storeFixture(async path=>{
 await writeFile(path,'abc');const value=await MirrorFileWindow.read(path,0n,20);await appendFile(path,'d');await assert.rejects(value.verifyCurrent(),MirrorFileChangedError);
 const next=await MirrorFileWindow.read(path,0n,20);await truncate(path,1);await assert.rejects(next.verifyCurrent(),MirrorFileChangedError);
}));
test('pre-abort retains exact reason and consumes no open-file capacity',async()=>storeFixture(async path=>{
 const stop=new AbortController(),reason={stop:true};stop.abort(reason);await assert.rejects(MirrorFileWindow.read(path,0n,10,stop.signal),e=>e===reason);assert.equal(activeMirrorFileReads(),0);
}));
test('eight submitted reads consume capacity before await; ninth never queues and all slots release after close',async()=>storeFixture(async path=>{
 await writeFile(path,'abc');const tasks=Array.from({length:8},()=>MirrorFileWindow.read(path,0n,10));assert.equal(activeMirrorFileReads(),8);
 await assert.rejects(MirrorFileWindow.read(path,0n,10),MirrorFileBusyError);await Promise.all(tasks);assert.equal(activeMirrorFileReads(),0);
}));
test('native file failures and invalid input never leak capacity',async()=>storeFixture(async path=>{
 await assert.rejects(MirrorFileWindow.read(path,0n,10));for(const bound of [0,1048577,NaN])await assert.rejects(MirrorFileWindow.read(path,0n,bound),RangeError);
 await assert.rejects(MirrorFileWindow.read(path,-1n,10),RangeError);assert.equal(activeMirrorFileReads(),0);
}));
test('actual bytes feed the existing off-thread decoder without consuming an incomplete record',async()=>storeFixture(async path=>{
 const complete='{"text":"한😀","n":18446744073709551615}\n';await writeFile(path,complete+'{"later":');
 const window=await MirrorFileWindow.read(path,0n,1024);
 try{const decoded=await decodeMirrorWindowOffThread(window.copyBytes(),window.offset,1024,1024,10);assert.equal(decoded.events.length,1);assert.equal(decoded.events[0]!.value.n,18446744073709551615n);assert.equal(decoded.nextOffset,BigInt(Buffer.byteLength(complete)));assert.equal(decoded.stop,'IncompleteRecord');await window.verifyCurrent();}finally{await joinMirrorDecoder();}
}));

test('forged observation receiver cannot run verification IO',async()=>{
 const fake=Object.create(MirrorFileWindow.prototype);let reads=0;Object.defineProperty(fake,'path',{get(){reads++;return '/not-read';}});
 await assert.rejects(fake.verifyCurrent(),TypeError);assert.equal(reads,0);assert.equal(activeMirrorFileReads(),0);
});
test('failed close retains actual open handle capacity until explicit joined retry',async()=>storeFixture(async path=>{
 await writeFile(path,'abc');const fs=await import('node:fs/promises'),{syncBuiltinESMExports}=await import('node:module'),api=fs.default,original=api.open,sentinel={close:true};let pending:MirrorFileClosePendingError|undefined;
 api.open=async(...args:Parameters<typeof original>)=>{const handle=await original(...args),close=handle.close.bind(handle);let first=true;handle.close=async()=>{if(first){first=false;throw sentinel;}await close();};return handle;};syncBuiltinESMExports();
 try{await assert.rejects(MirrorFileWindow.read(path,0n,10),e=>{assert.ok(e instanceof MirrorFileClosePendingError);pending=e;assert.equal(e.cleanup,sentinel);return true;});assert.equal(activeMirrorFileReads(),1);}
 finally{api.open=original;syncBuiltinESMExports();if(pending)await pending.retryCleanup();}
 assert.equal(activeMirrorFileReads(),0);await pending!.retryCleanup();assert.equal(activeMirrorFileReads(),0);
}));
