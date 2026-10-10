import test from 'node:test';import assert from 'node:assert/strict';import {readFile,writeFile,mkdir,symlink} from 'node:fs/promises';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {storeFixture} from '../helpers/store-fixture.ts';
import {pluginTreeDigest,fingerprintRequiredPlugins,expectedRemotePluginVersion,pluginFilesBusy,PluginFingerprintError} from '../../src/pro/plugin-files.ts';
import {REMOTE_PLUGIN_ID,CHROME_PLUGIN_ID,ownedProDiagnostic} from '../../src/pro/preflight.ts';
import {OwnedWorkerBusyError} from '../../src/runtime/owned-worker-slot.ts';
const fixtures=fileURLToPath(new URL('../fixtures/pro-fingerprint/',import.meta.url));
const record=(pluginId:string,path:string)=>({pluginId,installed:true,enabled:true,version:'1',source:{path}});
const errorKind=(kind:string)=>(e:unknown)=>e instanceof PluginFingerprintError&&e.kind===kind;
test('actual worker tree hashes match frozen Rust repository Python goldens',async()=>{const expected=JSON.parse(await readFile(join(fixtures,'expected.json'),'utf8'));assert.equal(await pluginTreeDigest(join(fixtures,'remote')),expected.remote);assert.equal(await pluginTreeDigest(join(fixtures,'chrome')),expected.chrome);assert.equal(pluginFilesBusy(),false);});
test('DFS filename order, byte lengths and Unicode content are explicit',async()=>storeFixture(async path=>{
 const root=dirname(path);await mkdir(join(root,'a'));await writeFile(join(root,'a','x'),'한😀');await writeFile(join(root,'a.txt'),'second');
 const hash=createHash('sha256');for(const [name,text] of [['a/x','한😀'],['a.txt','second']]){const n=Buffer.from(name!),v=Buffer.from(text!),size=Buffer.alloc(8);size.writeBigUInt64BE(BigInt(n.length));hash.update(size).update(n);const bytes=Buffer.alloc(8);bytes.writeBigUInt64BE(BigInt(v.length));hash.update(bytes).update(v);}assert.equal(await pluginTreeDigest(root),hash.digest('hex'));
}));
test('fingerprint uses declaration-order evidence, canonical roots, and changes with actual file bytes',async()=>storeFixture(async path=>{
 const root=dirname(path),remote=join(root,'remote'),chrome=join(root,'chrome');await mkdir(remote);await mkdir(chrome);await writeFile(join(remote,'plugin.json'),'remote');await writeFile(join(chrome,'plugin.json'),'chrome');const records=[record(REMOTE_PLUGIN_ID,remote),record(CHROME_PLUGIN_ID,chrome)];
 const evidence=[];for(const r of records)evidence.push({plugin_id:r.pluginId,version:'1',source_path:r.source.path,tree_sha256:await pluginTreeDigest(r.source.path)});
 const raw=JSON.stringify({installed:records});const first=await fingerprintRequiredPlugins(raw);assert.equal(first,createHash('sha256').update(JSON.stringify(evidence)).digest('hex'));assert.equal(await fingerprintRequiredPlugins(raw),first);await writeFile(join(remote,'plugin.json'),'changed');assert.notEqual(await fingerprintRequiredPlugins(raw),first);
 // Fingerprint source ignores unrelated non-object records; later full preflight rejects them.
 assert.equal(await fingerprintRequiredPlugins(JSON.stringify({installed:[null,...records]})),await fingerprintRequiredPlugins(raw));
}));
test('missing duplicated disabled and malformed source entries reject without guessing a path',async()=>{
 for(const raw of ['bad','{}',JSON.stringify({installed:[record(REMOTE_PLUGIN_ID,'/missing'),record(REMOTE_PLUGIN_ID,'/missing')]}),JSON.stringify({installed:[{...record(REMOTE_PLUGIN_ID,'/missing'),enabled:false}]}),JSON.stringify({installed:[{...record(REMOTE_PLUGIN_ID,'/missing'),source:null}]})])await assert.rejects(fingerprintRequiredPlugins(raw),errorKind('Inventory'));
});
test('nonignored links reject and ignored cache links do not contribute content',async()=>storeFixture(async path=>{
 const root=dirname(path),remote=join(root,'remote');await mkdir(remote);await writeFile(path,'foreign');await symlink(path,join(remote,'bad'));await assert.rejects(pluginTreeDigest(remote),errorKind('Content'));
 const clean=join(root,'clean');await mkdir(clean);await symlink(path,join(clean,'ignored.PYC'));await mkdir(join(clean,'__pycache__'));await symlink(path,join(clean,'__pycache__','link'));assert.equal(await pluginTreeDigest(clean),createHash('sha256').digest('hex'));
}));
test('native manifest read distinguishes missing/syntax/UTF8 errors from invalid JSON shape',async()=>storeFixture(async path=>{
 await assert.rejects(expectedRemotePluginVersion(path),(e:unknown)=>ownedProDiagnostic(e)?.code==='RemoteManifestUnavailable');
 await writeFile(path,'\ufeff{"version":"1.2.3"}');assert.equal(await expectedRemotePluginVersion(path),'1.2.3');
 for(const data of ['bad',Buffer.from([0xc3,0x28]),Buffer.alloc(1048577,120)]){await writeFile(path,data);await assert.rejects(expectedRemotePluginVersion(path),(e:unknown)=>ownedProDiagnostic(e)?.code==='RemoteManifestUnavailable');}
 await writeFile(path,'[]');await assert.rejects(expectedRemotePluginVersion(path),(e:unknown)=>ownedProDiagnostic(e)?.code==='RemoteManifestInvalid');
}));
test('cancellation joins owned filesystem worker and keeps competing scans out until exit',async()=>{
 const stop=new AbortController(),reason={cancel:true},task=pluginTreeDigest(join(fixtures,'remote'),stop.signal);const outcome=task.then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));assert.equal(pluginFilesBusy(),true);stop.abort(reason);await assert.rejects(pluginTreeDigest(fixtures),OwnedWorkerBusyError);const result=await outcome;assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error,reason);assert.equal(pluginFilesBusy(),false);
});
test('directory depth budget refuses the whole observation, not a partial digest',async()=>storeFixture(async path=>{let nested=dirname(path);for(let i=0;i<130;i++){nested=join(nested,'d');await mkdir(nested);}await assert.rejects(pluginTreeDigest(dirname(path)),errorKind('Content'));}));
test('invalid input never starts a worker and regular-file roots are not directories',async()=>storeFixture(async path=>{
 await assert.rejects(pluginTreeDigest('\ud800'),TypeError);await assert.rejects(fingerprintRequiredPlugins('x'.repeat(1048577)),RangeError);assert.equal(pluginFilesBusy(),false);await writeFile(path,'x');await assert.rejects(pluginTreeDigest(path),errorKind('Content'));
}));
