import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {storeFixture} from '../helpers/store-fixture.ts';
import {NativeRemoteCore} from '../../src/remote-agent/native-core.ts';
import {RemoteFileMutations} from '../../src/remote-agent/files/mutations.ts';
import {RemoteReadOwner,closeRemoteNativeRead} from '../../src/remote-agent/files/read-owner.ts';
import {RemoteRequestBudget} from '../../src/remote-agent/request-budget.ts';
import {readRemoteFile} from '../../src/remote-agent/files/read-file.ts';
import {redactRemoteTextCpu} from '../../src/remote-agent/files/redaction-cpu.ts';

test('Git applies file policy before diff, includes text/binary untracked files, and distinguishes staged-only paths',{timeout:30000},()=>storeFixture(async path=>{
 const root=dirname(path),run=promisify(execFile),git=(...args:string[])=>run('git',args,{cwd:root,windowsHide:true});
 await git('init','-q');await writeFile(join(root,'tracked.txt'),'before\n');await writeFile(join(root,'.env'),'DUMMY_PRIVATE_LABEL=before\n');await git('add','--','.');
 await git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgSign=false','-c','core.hooksPath=NUL','commit','-qm','fixture');
 await writeFile(join(root,'tracked.txt'),'after\n');await git('add','--','tracked.txt');
 await writeFile(join(root,'.env'),'DUMMY_PRIVATE_LABEL=after\n');await writeFile(join(root,'new.txt'),'untracked content\n');await writeFile(join(root,'binary.dat'),Buffer.from([0,1,2]));
 const reader=(await RemoteReadOwner.bind(root)).transfer(),files=await RemoteFileMutations.bind(reader.root);
 try{
  const core=new NativeRemoteCore(files,reader,process.execPath),context={binding:{threadId:'fixture',root,expiresAt:{seconds:BigInt(Math.floor(Date.now()/1000)+60),nanosecond:0n}},session:{connectionGeneration:1n,sessionGeneration:1n,sessionId:'fixture',computerMode:'project' as const},signal:new AbortController().signal,budget:RemoteRequestBudget.fromDeadline({seconds:BigInt(Math.floor(Date.now()/1000)+60),nanosecond:0n})};
  const status=await core.status(context),diff=await core.execute({kind:'repo_diff'},context);assert.equal(diff.kind,'repo_diff');if(diff.kind!=='repo_diff')throw Error('diff');
  assert.deepEqual(status.staged_files,['tracked.txt']);assert.ok(!status.dirty_files.includes('tracked.txt'));assert.ok(!status.dirty_files.includes('.env'));
  assert.ok(diff.files.some(file=>file.path==='new.txt'&&file.added===1n));assert.ok(diff.files.some(file=>file.path==='binary.dat'));
  assert.match(diff.patch,/untracked content/u);assert.match(diff.patch,/Binary untracked file/u);assert.doesNotMatch(diff.patch,/DUMMY_PRIVATE_LABEL|\.env/u);
 }finally{files.close();await closeRemoteNativeRead(reader);}
}));

test('credential redaction precedes line slicing and only file review contexts exempt public identifiers/hashes',()=>storeFixture(async path=>{
 const root=dirname(path),source='before\n-----BEGIN PRIVATE KEY-----\ndummy-secret-line\n-----END PRIVATE KEY-----\nafter\n';await writeFile(join(root,'fixture.txt'),source);
 const reader=(await RemoteReadOwner.bind(root)).transfer();try{const output=await readRemoteFile(reader,'fixture.txt',3n,1);assert.equal(output.content,'');assert.equal(output.total_lines,5n);}finally{await closeRemoteNativeRead(reader);}
 const json='{"token":"abc","password":"dummy\\\"escaped","authorization":"Bearer abcdefghi"}';assert.doesNotMatch(redactRemoteTextCpu(json),/abc|dummy/u);
 const python='ctypes.windll.kernel32.InitializeProcThreadAttributeList(args)';assert.equal(redactRemoteTextCpu(python,'fixture.py'),python);assert.match(redactRemoteTextCpu(python),/REDACTED/u);
 const digest='a1'.repeat(32),review=JSON.stringify({path:'src/fixture.py',sha256:digest,metadata:{secret:{path:digest,sha256:digest}}});
 const masked=redactRemoteTextCpu(review,'review.json');assert.equal((JSON.parse(masked) as any).sha256,digest);assert.equal((JSON.parse(masked) as any).metadata.secret.sha256,'[REDACTED]');
 assert.equal(redactRemoteTextCpu(digest),'[REDACTED]');assert.equal(redactRemoteTextCpu(source).split('\n').length,source.split('\n').length);
}));
