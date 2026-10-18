import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rename,rm,symlink,link} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WindowsFilePin} from '../../src/runtime/windows/windows-file-pin.ts';
import {RemoteReadOwner,listRemoteOwnedFiles,closeRemoteNativeRead} from '../../src/remote-agent/files/read-owner.ts';
import {pluginTreeDigest,expectedRemotePluginVersion} from '../../src/pro/plugin-files.ts';
import {runOwnedCommand,OwnedCommandLimitError} from '../../src/runtime/windows/owned-command.ts';
const windows={skip:process.platform!=='win32'};
test('Windows native pins deny ancestor replacement and release every handle',windows,async()=>{
 const root=await mkdtemp(join(tmpdir(),'cdr-pins-'));try{const dir=join(root,'parent');await mkdir(dir);const file=join(dir,'한글.txt');await writeFile(file,'hello');const pin=WindowsFilePin.acquire(file,'file',true);
 try{assert.ok(pin.identity().index>0n);await assert.rejects(rename(dir,join(root,'moved')));await assert.rejects(rename(file,join(dir,'moved.txt')));}finally{pin.close();}
 await rename(dir,join(root,'moved'));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('Windows reader and plugin scanner reject junctions and hard links',windows,async()=>{
 const root=await mkdtemp(join(tmpdir(),'cdr-read-'));let owner:RemoteReadOwner|undefined;
 try{await writeFile(join(root,'한글.txt'),'hello');await mkdir(join(root,'nested'));await writeFile(join(root,'nested','ok.txt'),'ok');owner=await RemoteReadOwner.bind(root);
 assert.equal((await owner.readBytes('한글.txt')).toString(),'hello');const digest=await pluginTreeDigest(root);assert.match(digest,/^[a-f0-9]{64}$/);
 await symlink(join(root,'nested'),join(root,'junction'),'junction');await assert.rejects(owner.readBytes('junction/ok.txt'));await assert.rejects(pluginTreeDigest(root));await rm(join(root,'junction'));
 await link(join(root,'한글.txt'),join(root,'alias.txt'));await assert.rejects(owner.readBytes('alias.txt'));await rm(join(root,'alias.txt'));
 const native=owner.transfer();owner=undefined;try{const listed=await listRemoteOwnedFiles(native,'**/*',20);assert.deepEqual(listed.files.map(x=>x.path).sort(),['nested/ok.txt','한글.txt'].sort());}finally{await closeRemoteNativeRead(native);}
 }finally{await owner?.close();await rm(root,{recursive:true,force:true});}
});
test('owned command captures exit and joins a timed-out process tree',windows,async()=>{
 const ok=await runOwnedCommand({executable:process.execPath,arguments:['-e','process.stdout.write("ok");process.exitCode=7'],environment:{}},{timeoutMs:10000,maxBytes:1024});assert.equal(ok.stdout.toString(),'ok');assert.equal(ok.exitCode,7);
 await assert.rejects(runOwnedCommand({executable:process.execPath,arguments:['-e','setInterval(()=>{},1000)'],environment:{}},{timeoutMs:1000,maxBytes:1024}),e=>e instanceof OwnedCommandLimitError&&e.kind==='Timeout');
});
