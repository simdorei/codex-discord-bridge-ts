import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,open,stat,rm,rename,truncate} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {captureMirrorCursorAnchor as capture,observeMirrorCursorContinuity as observe} from '../../../src/runtime/session-mirror/continuity-observation.ts';
import {observeWindowsAppendJournal,sameWindowsAppendCheckpoint} from '../../../src/runtime/session-mirror/windows-append-journal.ts';
import {MirrorFileChangedError} from '../../../src/runtime/session-mirror/file-window.ts';
const size=16*1024*1024;
async function fixture(run:(path:string)=>Promise<void>){
 const dir=await mkdtemp(join(tmpdir(),'mirror-journal-'));
 try{const path=join(dir,'rollout.jsonl');await writeFile(path,'a'.repeat(size-1)+'\n');await run(path);}
 finally{await rm(dir,{recursive:true,force:true});}
}
test('Windows append reads only the boundary and new bytes, preserving the full digest',{skip:process.platform!=='win32'},async t=>fixture(async path=>{
 const capability=await observeWindowsAppendJournal(path,await stat(path,{bigint:true}));
 assert.ok(capability,'test volume must support unprivileged NTFS journal reads');
 const prior=await capture(path,BigInt(size),undefined,true),h=await open(path,'r'),prototype=Object.getPrototypeOf(h),original=prototype.read;
 await h.close();let bytes=0;
 t.mock.method(prototype,'read',async function(this:unknown,...args:unknown[]){const result=await Reflect.apply(original,this,args) as {bytesRead:number};bytes+=result.bytesRead;return result;});
 for(let i=1;i<=3;i++){
  await appendFile(path,'next\n');bytes=0;
  const next=await observe(prior.anchor);
  assert.equal(next.observation.anchor.historyHash,prior.anchor.historyHash);
  assert.ok(bytes<=512,`append re-read ${bytes} old bytes`);
 }
 bytes=0;await capture(path,BigInt(size+15),undefined,true);
 assert.ok(bytes<=527,`new boundary read ${bytes} bytes`);
}));
test('middle overwrite followed by growth is refused even with an open coalescing writer',async()=>fixture(async path=>{
 const writer=await open(path,'r+');
 try{
  const prior=await capture(path,BigInt(size),undefined,true);
  await writer.write('next\n',size,'utf8');await observe(prior.anchor);
  await writer.write('b',size/2,'utf8');await writer.write('more\n',size+5,'utf8');
  await assert.rejects(observe(prior.anchor),MirrorFileChangedError);
  // A full rehash taken while OVERWRITE is already present must not grant
  // reuse on the next overwrite of the same still-open handle.
  const changed=await capture(path,BigInt(size+10),undefined,true);
  await writer.write('c',size/2+1,'utf8');await writer.write('last\n',size+10,'utf8');
  await assert.rejects(observe(changed.anchor),MirrorFileChangedError);
 }finally{await writer.close();}
}));
test('replacement and truncate/regrow keep the old cursor held',async()=>fixture(async path=>{
 const prior=await capture(path,BigInt(size),undefined,true);
 await truncate(path,size/2);await appendFile(path,'a'.repeat(size/2+10)+'\n');
 await assert.rejects(observe(prior.anchor),MirrorFileChangedError);
 await rename(path,path+'.old');await writeFile(path,'a'.repeat(size-1)+'\nnext\n');
 await assert.rejects(observe(prior.anchor),MirrorFileChangedError);
}));
test('unsupported or forged journal observations never authorize prefix reuse',async()=>fixture(async path=>{
 const stamp=await stat(path,{bigint:true});
 assert.equal(await observeWindowsAppendJournal('\\\\server\\share\\rollout.jsonl',stamp),null);
 assert.equal(sameWindowsAppendCheckpoint(undefined,undefined),false);
 const fake={journal:0n,usn:0n,file:stamp.ino,volume:stamp.dev};
 assert.equal(sameWindowsAppendCheckpoint(fake,fake),false);
 const observed=await observeWindowsAppendJournal(path,stamp,fake);
 if(observed!==null)assert.equal(observed.appendOnly,false);
 const abort=new AbortController(),reason=Error('cancel');abort.abort(reason);
 await assert.rejects(observeWindowsAppendJournal(path,stamp,undefined,abort.signal),e=>e===reason);
}));
