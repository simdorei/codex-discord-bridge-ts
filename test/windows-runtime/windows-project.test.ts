import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RemoteFileMutations,fileDigest} from '../../src/remote-agent/files/mutations.ts';
import {RemoteReadOwner,closeRemoteNativeRead} from '../../src/remote-agent/files/read-owner.ts';
import {NativeRemoteCore} from '../../src/remote-agent/native-core.ts';
import {NativeTerminalEngine} from '../../src/remote-agent/native-terminal.ts';
import {RemoteRequestBudget} from '../../src/remote-agent/request-budget.ts';
import type {RemoteOperationContext} from '../../src/remote-agent/dispatcher-ports.ts';
import {isPublicImageAddress} from '../../src/remote-agent/native-images.ts';
import {NativeCheckpoints} from '../../src/remote-agent/native-checkpoints.ts';
const context=(root:string):RemoteOperationContext=>({binding:{threadId:'fixture-thread',root,expiresAt:{seconds:BigInt(Math.floor(Date.now()/1000)+60),nanosecond:0n}},session:{connectionGeneration:1n,sessionGeneration:1n,sessionId:'fixture-session',computerMode:'project'},signal:new AbortController().signal,budget:RemoteRequestBudget.fromDeadline({seconds:BigInt(Math.floor(Date.now()/1000)+60),nanosecond:0n})});
test('native file CAS, checkpoint restore and external edit preservation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cdr-project-')),files=await RemoteFileMutations.bind(root),reader=(await RemoteReadOwner.bind(root)).transfer();
 try{const core=new NativeRemoteCore(files,reader,process.execPath),ctx=context(root);
  const created=await core.execute({kind:'file_create',path:'nested/한글.txt',content:'before\n',overwrite:false},ctx);assert.equal(created.kind,'file_create');
  const patched=await core.execute({kind:'file_apply_patch',changes:[{action:'update',path:'nested/한글.txt',content:'after\n',destination:null,expected_sha256:fileDigest(Buffer.from('before\n'))}]},ctx);assert.equal(patched.kind,'file_apply_patch');if(patched.kind!=='file_apply_patch')throw new Error('Missing patch output');
  assert.equal(await readFile(join(root,'nested','한글.txt'),'utf8'),'after\n');await core.execute({kind:'checkpoint_restore',checkpoint_id:patched.checkpoint_id},ctx);assert.equal(await readFile(join(root,'nested','한글.txt'),'utf8'),'before\n');
  await writeFile(join(root,'nested','한글.txt'),'external');await assert.rejects(core.execute({kind:'checkpoint_restore',checkpoint_id:patched.checkpoint_id},ctx),/changed/);assert.equal(await readFile(join(root,'nested','한글.txt'),'utf8'),'external');
  await assert.rejects(files.write('nested/한글.txt',Buffer.from('bad'),null));await files.delete('nested/한글.txt',fileDigest(Buffer.from('external')));assert.equal(await files.read('nested/한글.txt'),null);
 }finally{await closeRemoteNativeRead(reader);files.close();await rm(root,{recursive:true,force:true});}
});
test('native terminal persists environment, owns IDs and joins cancellation', {skip:process.platform!=='win32'},async()=>{
 const root=await mkdtemp(join(tmpdir(),'cdr-terminal-')),engine=new NativeTerminalEngine(root);try{const ctx=context(root),base={kind:'terminal_exec' as const,terminal_id:null,shell:'powershell' as const,command:'[Console]::Write($env:CDR_FIXTURE_VALUE)',cwd:null,environment:{CDR_FIXTURE_VALUE:'hello'},timeout_seconds:10n,cancel_previous:false};
  const first=await engine.execute(base,ctx);assert.equal(first.kind,'terminal_exec');if(first.kind!=='terminal_exec')throw new Error('Missing terminal result');assert.equal(first.stdout,'hello');assert.equal(first.exit_code,0n);
  const next=await engine.execute({...base,terminal_id:first.terminal_id,environment:{}},ctx);assert.equal(next.kind==='terminal_exec'?next.stdout:'','hello');
  await assert.rejects(engine.execute({...base,terminal_id:'term_0000000000000000'},ctx),/another session/);
  const waiting=engine.execute({...base,terminal_id:first.terminal_id,command:'Start-Sleep -Seconds 20'},ctx);await new Promise(resolve=>setTimeout(resolve,500));const replacement=engine.execute({...base,terminal_id:first.terminal_id,cancel_previous:true},ctx);const cancelled=await waiting;assert.equal(cancelled.kind==='terminal_exec'&&cancelled.cancelled,true);await replacement;
 }finally{await engine.close();await rm(root,{recursive:true,force:true});}
});
test('image download policy rejects private and mapped-private network addresses',()=>{
 for(const value of ['127.0.0.1','10.0.0.1','169.254.169.254','::1','::ffff:127.0.0.1','fe80::1','fc00::1','2001:db8::1'])assert.equal(isPublicImageAddress(value),false,value);
 for(const value of ['8.8.8.8','2606:4700:4700::1111'])assert.equal(isPublicImageAddress(value),true,value);
});
test('checkpoint retention prunes completed records but preserves pending evidence before mutation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cdr-checkpoint-quota-')),files=await RemoteFileMutations.bind(root),folder=join(root,'.codex-remote-mcp','checkpoints');
 try{await mkdir(folder,{recursive:true});const record=(i:number,state:string)=>({checkpoint_id:'cp_'+i.toString(16).padStart(16,'0'),created_at:'2026-10-18T00:00:00Z',reason:'fixture',snapshots:[],state});
  for(let i=0;i<500;i++){const r=record(i,i===0?'pending':'complete');await writeFile(join(folder,r.checkpoint_id+'.json'),JSON.stringify(r));}
  const checkpoints=new NativeCheckpoints(files);await checkpoints.mutate('new',[{path:'new.txt',content:Buffer.from('hello'),expected:null}]);assert.equal((await readdir(folder)).length,500);assert.equal(JSON.parse(await readFile(join(folder,record(0,'pending').checkpoint_id+'.json'),'utf8')).state,'pending');
  for(const name of await readdir(folder)){const value=JSON.parse(await readFile(join(folder,name),'utf8'));value.state='pending';await writeFile(join(folder,name),JSON.stringify(value));}
  await assert.rejects(checkpoints.mutate('no capacity',[{path:'rejected.txt',content:Buffer.from('bad'),expected:null}]),/retention budget/);assert.equal(await files.read('rejected.txt'),null);assert.equal((await readdir(folder)).length,500);
 }finally{files.close();await rm(root,{recursive:true,force:true});}
});
test('confirmed checkpoint rollback retires pending evidence and never reapplies a failed change',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cdr-checkpoint-rollback-')),files=await RemoteFileMutations.bind(root),checkpoints=new NativeCheckpoints(files),write=files.write.bind(files);
 try{t.mock.method(files,'write',async(...args:Parameters<typeof files.write>)=>{if(args[0]==='second.txt')throw new Error('fixture refused write');return write(...args);});
  await assert.rejects(checkpoints.mutate('fixture',[{path:'first.txt',content:Buffer.from('first'),expected:null},{path:'second.txt',content:Buffer.from('second'),expected:null}]),/fixture refused write/);
  assert.equal(await files.read('first.txt'),null);assert.equal(await files.read('second.txt'),null);const [record]=await checkpoints.list();assert.ok(record!.reason.startsWith('[rolled back]'));assert.deepEqual(await checkpoints.restore(record!.checkpoint_id),[]);
 }finally{files.close();await rm(root,{recursive:true,force:true});}
});
