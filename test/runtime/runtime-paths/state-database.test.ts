import assert from 'node:assert/strict';
import {it} from 'node:test';
import {mkdir,writeFile,utimes,readdir,symlink} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {findRuntimeStateDatabase as find,nativeStateDatabaseProbe,type StateDatabaseProbe} from '../../../src/runtime/runtime-paths/state-database.ts';
function probe(names:readonly string[],files:Record<string,bigint>){const calls:string[]=[];return {calls,port:{async entryNames(path:string){calls.push(`read:${path}`);return names;},async isFile(path:string){calls.push(`file:${path}`);return Object.hasOwn(files,path);},async modifiedNs(path:string){calls.push(`time:${path}`);return files[path]??0n;}} satisfies StateDatabaseProbe};}
it('state database selects newest regular file, not highest numerical schema name',async()=>{
 const p=probe(['state_99.sqlite','state_3.sqlite','state_4.sqlite'],{'/home/state_99.sqlite':2n,'/home/state_3.sqlite':5n});assert.equal(await find('/home','posix',p.port),'/home/state_3.sqlite');assert.equal(p.calls.includes('time:/home/state_4.sqlite'),false);
});
it('state filename tie is descending lexical rather than numeric, with lossless nanoseconds',async()=>{
 const p=probe(['state_10.sqlite','state_9.sqlite','state_1.sqlite'],{'/home/state_10.sqlite':9007199254740993n,'/home/state_9.sqlite':9007199254740993n,'/home/state_1.sqlite':9007199254740992n});assert.equal(await find('/home','posix',p.port),'/home/state_9.sqlite');
});
it('sidecars, unrelated files and non-files cannot become state database',async()=>{
 const p=probe(['state_9.sqlite-wal','state_9.sqlite-shm','other.sqlite','state_directory.sqlite'],{});assert.equal(await find('/home','posix',p.port),'/home/state_5.sqlite');assert.deepEqual(p.calls,['read:/home','file:/home/state_directory.sqlite']);
});
it('state fallback appends lexically, retaining relative drive and symlink-sensitive dot-dot',async()=>{
 assert.equal(await find('C:','win32',probe([],{}).port),'C:state_5.sqlite');assert.equal(await find('C:\\home\\','win32',probe([],{}).port),'C:\\home\\state_5.sqlite');assert.equal(await find('/home/link/..','posix',probe([],{}).port),'/home/link/../state_5.sqlite');assert.equal(await find('','posix',probe([],{}).port),'state_5.sqlite');
});
it('actual fs selection follows file symlinks semantics and preserves native files without creating fallback',()=>storeFixture(async file=>{
 const root=dirname(file);await mkdir(join(root,'state_directory.sqlite'));const older=join(root,'state_9.sqlite'),newer=join(root,'state_2.sqlite');await writeFile(older,'old');await writeFile(newer,'new');await utimes(older,100,100);await utimes(newer,200,200);assert.equal(await find(root,'posix'),newer);const target=join(root,'target');await writeFile(target,'linked');await utimes(target,300,300);const link=join(root,'state_7.sqlite');await symlink(target,link);assert.equal(await find(root,'posix'),link);const before=await readdir(root);const absent=join(root,'absent');assert.equal(await find(absent,'posix'),join(absent,'state_5.sqlite'));assert.deepEqual(await readdir(root),before);
}));
it('native failed stat returns false and failed mtime returns epoch fallback',()=>storeFixture(async file=>{assert.equal(await nativeStateDatabaseProbe.isFile(file+'/missing'),false);assert.equal(await nativeStateDatabaseProbe.modifiedNs(file+'/missing'),0n);}));
it('hostile entries, accessors, traversal and non-native promises fail before hooks or filesystem probes',async()=>{
 let hooks=0;const p=probe([],{});await assert.rejects(find('/x','posix',{...p.port,get entryNames(){hooks++;return p.port.entryNames;}}),TypeError);await assert.rejects(find('/x','posix',{...p.port,entryNames:()=>({then(){hooks++;}}) as never}),TypeError);for(const name of ['../state_1.sqlite','/state_1.sqlite',''])await assert.rejects(find('/x','posix',probe([name],{}).port),TypeError);await assert.rejects(find('C:\\x','win32',probe(['C:state_1.sqlite'],{}).port),TypeError);assert.equal(hooks,0);
});
it('scripted probe errors retain identity and malformed metadata cannot silently choose fallback',async()=>{
 const error=new Error('probe transport');const p=probe(['state_1.sqlite'],{'/x/state_1.sqlite':1n});await assert.rejects(find('/x','posix',{...p.port,entryNames:async()=>{throw error;}}),e=>e===error);await assert.rejects(find('/x','posix',{...p.port,isFile:async()=>1 as never}),TypeError);await assert.rejects(find('/x','posix',{...p.port,modifiedNs:async()=>1 as never}),TypeError);
});
