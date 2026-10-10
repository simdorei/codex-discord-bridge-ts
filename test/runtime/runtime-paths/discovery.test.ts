import assert from 'node:assert/strict';import {it} from 'node:test';import {mkdir,writeFile,readdir} from 'node:fs/promises';import {dirname,join} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {discoverRuntimePathInputs as discover,splitRuntimeSearchPath as split,RuntimePathDiscoveryError} from '../../../src/runtime/runtime-paths/discovery.ts';
import {resolveRuntimePaths} from '../../../src/runtime/runtime-paths/resolve.ts';
import type {StateDatabaseProbe} from '../../../src/runtime/runtime-paths/state-database.ts';
function probe(files:readonly string[]=[],directories:Record<string,readonly string[]>={}){const calls:string[]=[];return {calls,port:{async entryNames(path:string){calls.push(`read:${path}`);return directories[path]??[];},async isFile(path:string){calls.push(`file:${path}`);return files.includes(path);},async modifiedNs(){return 0n;}} satisfies StateDatabaseProbe};}
it('Windows discovery accepts mixed case OS keys and scans direct plus one child only',async()=>{
 const root='C:\\local\\OpenAI/Codex/bin',direct=root+'\\codex.exe',child=root+'\\build\\codex.exe';const p=probe([direct,child,'D:\\path\\codex.exe'],{[root]:['build']});const r=await discover({UserProfile:' C:\\home ',LocalAppData:'C:\\local',Path:'D:\\path'},'C:\\repo','win32',p.port);assert.equal(r.userHome,'C:\\home');assert.deepEqual(r.localAppCandidates,[direct,child]);assert.deepEqual(r.pathCandidates,['D:\\path\\codex.exe']);assert.equal(p.calls.includes(`read:${root}\\build`),false);
});
it('exact Windows keys win including blank values; home fallback is independently selected',async()=>{
 const p=probe(['real\\codex.exe','wrong\\codex.exe']);const r=await discover({USERPROFILE:' ',UserProfile:'bad',HOME:'good',PATH:'real',Path:'wrong',LOCALAPPDATA:'',LocalAppData:'bad'},'repo','win32',p.port);assert.equal(r.userHome,'good');assert.deepEqual(r.pathCandidates,['real\\codex.exe']);assert.equal(p.calls.some(c=>c.includes('bad')),false);const blank=await discover({USERPROFILE:'good',PATH:'',Path:'wrong'},'repo','win32',p.port);assert.deepEqual(blank.pathCandidates,[]);
});
it('Windows conflicting fallback values fail without leaking either value',async()=>{
 for(const [key,a,b] of [['USERPROFILE','UserProfile','userprofile'],['HOME','Home','home'],['LOCALAPPDATA','LocalAppData','localappdata'],['PATH','Path','path']]){const env:Record<string,string>={USERPROFILE:'home',[a!]:'left-secret',[b!]:'right-secret'};if(key==='USERPROFILE'||key==='HOME')delete env.USERPROFILE;await assert.rejects(discover(env,'repo','win32',probe().port),e=>e instanceof RuntimePathDiscoveryError&&e.key===key&&e.message===`conflicting Windows environment values for ${key}`);}
});
it('identical case-folded fallbacks are valid and unqueried HOME conflicts do not beat USERPROFILE',async()=>{
 const p=probe(['bin\\codex.exe']);assert.deepEqual((await discover({UserProfile:'home',Path:'bin',path:'bin'},'repo','win32',p.port)).pathCandidates,['bin\\codex.exe']);assert.equal((await discover({USERPROFILE:'home',Home:'left',home:'right'},'repo','win32',p.port)).userHome,'home');
});
it('POSIX OS environment remains case-sensitive and preserves Rust trim semantics',async()=>{
 const p=probe(['/bin/codex']);assert.deepEqual((await discover({HOME:'\u0085/home\u0085',PATH:'/bin',Path:'/wrong'},'/repo','posix',p.port)).pathCandidates,['/bin/codex']);await assert.rejects(discover({Home:'/home',userprofile:'/home'},'/repo','posix',p.port),e=>e instanceof RuntimePathDiscoveryError&&e.kind==='UserHomeMissing');
});
it('PATH splitting preserves quoted semicolons, empty entries, unmatched quote regions and POSIX literal quotes',()=>{
 assert.deepEqual(split('C:\\foo;C:\\som"e;di"r;C:\\bar','win32'),['C:\\foo','C:\\some;dir','C:\\bar']);assert.deepEqual(split(';"a;b";;','win32'),['','a;b','','']);assert.deepEqual(split('"a;b','win32'),['a;b']);assert.deepEqual(split('','win32'),['']);assert.deepEqual(split('/a:"/b:c":','posix'),['/a','"/b','c"','']);
});
it('macOS application root is included only on darwin; missing PATH differs from empty current-directory entry',async()=>{
 const file='/Applications/Codex.app/Contents/Resources/bin/codex',p=probe([file,'codex']);assert.deepEqual((await discover({HOME:'/home'},'/repo','darwin',p.port)).localAppCandidates,[file]);assert.deepEqual((await discover({HOME:'/home'},'/repo','posix',p.port)).pathCandidates,[]);assert.deepEqual((await discover({HOME:'/home',PATH:''},'/repo','posix',p.port)).pathCandidates,['codex']);
});
it('discovery snapshots environment across awaits and returns immutable candidate arrays',async()=>{
 const env:Record<string,string>={HOME:'/home',PATH:'/bin'},p=probe(['/bin/codex']);const port={...p.port,async entryNames(){env.PATH='/wrong';return [];}};const r=await discover(env,'/repo','posix',port);assert.deepEqual(r.pathCandidates,['/bin/codex']);assert.equal(Object.isFrozen(r),true);assert.equal(Object.isFrozen(r.pathCandidates),true);
});
it('invalid entries and hostile environment never trigger getters or coercion',async()=>{
 let hooks=0;await assert.rejects(discover({get HOME(){hooks++;return '/home';}},'/repo','posix',probe().port),TypeError);await assert.rejects(discover({HOME:'/home'},'/repo','posix',{...probe().port,entryNames:async()=>['../escape']}),TypeError);await assert.rejects(discover({HOME:'/home'},'/repo','posix',{...probe().port,isFile:()=>({then(){hooks++;}}) as never}),TypeError);assert.equal(hooks,0);
});
it('actual native discovery and resolver compose on inert files without executing or creating data',()=>storeFixture(async file=>{
 const root=dirname(file),home=join(root,'home'),local=join(root,'local'),app=join(local,'OpenAI/Codex/bin/build'),bin=join(root,'bin');await mkdir(home);await mkdir(app,{recursive:true});await mkdir(bin);await writeFile(join(app,'codex'),'inert app');await writeFile(join(bin,'codex'),'inert path');const env={HOME:home,LOCALAPPDATA:local,PATH:bin},before=await readdir(root);const input=await discover(env,root,'posix');assert.deepEqual(input.localAppCandidates,[join(app,'codex')]);assert.deepEqual(input.pathCandidates,[join(bin,'codex')]);const resolved=await resolveRuntimePaths(env,input,'posix');assert.equal(resolved.codexExe,join(app,'codex'));assert.equal(resolved.codexExeSource,'LocalAppBin');assert.deepEqual(await readdir(root),before);
}));
