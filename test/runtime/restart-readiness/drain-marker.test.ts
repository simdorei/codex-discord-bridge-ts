import assert from 'node:assert/strict';import {it} from 'node:test';
import {writeFile,readFile,mkdir,readdir,symlink} from 'node:fs/promises';import {dirname,join} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {DrainFenceKey,DrainGateError} from '../../../src/admission/owned-key.ts';
import {DRAIN_MARKER_NAMES as names,DrainMarkerError,PosixDrainMarkerStore as Store,parseRuntimeIdentityMarker as identity,parseRuntimeFenceMarker as fence,encodeRuntimeIdentityMarker as encodeIdentity,encodeRuntimeAckMarker as encodeAck} from '../../../src/runtime/restart-readiness/drain-marker.ts';
const marker={runtimeId:'runtime-a',processId:123},key=DrainFenceKey.create('runtime-a','123|456','nonce-a');
const text=encodeIdentity(marker),ack=encodeAck(key);
it('identity and ack formats preserve exact source bytes and parse constructor-owned keys',()=>{
 assert.equal(text,'version=1\nruntime_id=runtime-a\npid=123\nstate=open\n');assert.equal(ack,'version=1\nruntime_id=runtime-a\nprocess_identity=123|456\nnonce=nonce-a\nstate=sealed\n');assert.deepEqual(identity(text,'identity'),marker);assert.equal(key.equals(fence(ack,'ack','sealed')),true);
});
it('Rust lines permits CRLF/final LF but preserves lone final CR and rejects empty intermediate lines',()=>{
 assert.deepEqual(identity(text.replaceAll('\n','\r\n'),'identity'),marker);assert.deepEqual(identity(text.slice(0,-1),'identity'),marker);assert.throws(()=>identity(text.slice(0,-1)+'\r','identity'),/invalid state/);assert.throws(()=>identity(text+'\n','identity'),/line does not contain/);
});
it('duplicate, empty, missing and wrong required fields are rejected; unknown well-formed fields remain allowed',()=>{
 for(const bad of [text+'pid=123\n',text+'=value\n',text+'key=\n',text.replace('version=1','version=2'),text.replace('pid=123\n','')])assert.throws(()=>identity(bad,'identity'),DrainMarkerError);assert.deepEqual(identity(text+'extension=a=b\n','identity'),marker);assert.throws(()=>identity('\ufeff'+text,'identity'),/missing version/);
});
it('marker size is UTF-8 byte bounded at 4096 and does not confuse characters with bytes',()=>{
 const padding='extra='+('x'.repeat(4096-Buffer.byteLength(text)-7))+'\n';assert.equal(Buffer.byteLength(text+padding),4096);assert.deepEqual(identity(text+padding,'identity'),marker);assert.throws(()=>identity(text+padding+'x','identity'),/exceeds 4096/);assert.throws(()=>identity(text+'extra='+'한'.repeat(1400),'identity'),/exceeds 4096/);
});
it('PID is exact Rust u32 syntax and identity runtime text is not silently UUID-normalized',()=>{
 for(const [raw,want] of [['0',0],['+000123',123],['4294967295',4294967295]] as const)assert.equal(identity(text.replace('pid=123',`pid=${raw}`),'identity').processId,want);for(const raw of ['-1','4294967296','1.0',' 1','1 '])assert.throws(()=>identity(text.replace('pid=123',`pid=${raw}`),'identity'),/unsigned integer/);assert.equal(identity(text.replace('runtime-a','한글=identity'),'identity').runtimeId,'한글=identity');
});
it('prepare/restart ignore optional state but ack requires sealed and invalid fence key is not absence',()=>{
 assert.equal(key.equals(fence(ack.replace('state=sealed','state=other'),'prepare')),true);assert.throws(()=>fence(ack.replace('state=sealed','state=other'),'ack','sealed'),/invalid state/);assert.throws(()=>fence(ack.replace('123|456','bad'),'prepare'),DrainGateError);assert.throws(()=>encodeAck(Object.create(DrainFenceKey.prototype) as DrainFenceKey),DrainGateError);
});
it('native POSIX atomic identity/ack overwrite and matching-only removal leave no temporary files',()=>storeFixture(async file=>{
 const root=dirname(file),store=new Store(root);assert.equal(await store.readIdentity(),null);await store.publishIdentity(marker);await store.publishIdentity({...marker,processId:124});assert.deepEqual(await store.readIdentity(),{...marker,processId:124});await store.removeIdentityIfOwned(marker);assert.notEqual(await store.readIdentity(),null);await store.removeIdentityIfOwned({...marker,processId:124});assert.equal(await store.readIdentity(),null);await store.publishAck(key);await store.removeAckIfOwned(DrainFenceKey.create('runtime-a','123|456','other'));assert.equal(key.equals(await store.readAck()),true);await store.removeAckIfOwned(key);assert.equal(await store.readAck(),null);assert.deepEqual(await readdir(root),[]);
}));
it('native reads reject malformed, invalid UTF-8, oversized and directory markers rather than approving absence',()=>storeFixture(async file=>{
 const root=dirname(file),store=new Store(root),path=join(root,names.prepare);assert.equal(await store.readPrepare(),null);await writeFile(path,'bad');await assert.rejects(store.readPrepare(),DrainMarkerError);await writeFile(path,Buffer.from([255]));await assert.rejects(store.readPrepare(),e=>e instanceof DrainMarkerError&&e.kind==='Io');await writeFile(path,'x'.repeat(4097));await assert.rejects(store.readPrepare(),/exceeds 4096/);await mkdir(join(root,names.ack));await assert.rejects(store.readAck(),e=>e instanceof DrainMarkerError&&e.kind==='Io');
}));
it('stop file overrides restart file while directories do not count as operation requests',()=>storeFixture(async file=>{
 const root=dirname(file),store=new Store(root);await writeFile(join(root,names.restart),ack);assert.equal(await store.restartRequested(),true);assert.equal(await store.shutdownRequested(),true);await writeFile(join(root,names.stop),'');assert.equal(await store.stopRequested(),true);assert.equal(await store.restartRequested(),false);const other=join(root,'other');await mkdir(other);await mkdir(join(other,names.stop));assert.equal(await new Store(other).stopRequested(),false);
}));
it('marker writes preserve symlink-sensitive parent paths instead of normalizing dot-dot',()=>storeFixture(async file=>{
 const root=dirname(file),target=join(root,'target'),deep=join(target,'deep');await mkdir(deep,{recursive:true});await symlink(deep,join(root,'link'));const store=new Store(root+'/link/..');await store.publishIdentity(marker);assert.equal(await readFile(join(target,names.identity),'utf8'),text);assert.equal((await readdir(root)).includes(names.identity),false);assert.equal((await readdir(target)).some(name=>name.startsWith('.cdr-runtime-')),false);
}));
it('identity encoder rejects active fields and line injection without invoking getters',()=>{let calls=0;assert.throws(()=>encodeIdentity({get runtimeId(){calls++;return 'x';},processId:1}),TypeError);assert.throws(()=>encodeIdentity({runtimeId:'x\npid=9',processId:1}),TypeError);assert.equal(calls,0);});
