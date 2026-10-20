import assert from 'node:assert/strict';import {it} from 'node:test';import {writeFile,stat} from 'node:fs/promises';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {selectRuntimeExecutable as select,RuntimeExecutableError,type ExecutableInputs,type ExecutableProbe} from '../../../src/runtime/runtime-paths/executable.ts';
const base:ExecutableInputs={configuredPath:null,codexHome:'C:\\home',localAppCandidates:[],pathCandidates:[]};
function probe(files:Record<string,bigint>){const seen:string[]=[];return {seen,port:{async isFile(path:string){seen.push(path);return Object.hasOwn(files,path);},async modifiedNs(path:string){return files[path]??0n;}} satisfies ExecutableProbe};}
it('existing explicit executable wins; missing explicit fails without silently taking fallback',async()=>{
 const p=probe({'C:\\explicit.exe':1n,'C:\\fallback.exe':2n});assert.deepEqual(await select({...base,configuredPath:'C:\\explicit.exe',localAppCandidates:['C:\\fallback.exe']},'win32',p.port),{path:'C:\\explicit.exe',source:'Environment'});p.seen.length=0;await assert.rejects(select({...base,configuredPath:'C:\\missing.exe',localAppCandidates:['C:\\fallback.exe']},'win32',p.port),e=>e instanceof RuntimeExecutableError&&e.kind==='ConfiguredExecutableMissing');assert.deepEqual(p.seen,['C:\\missing.exe']);
});
it('latest source incomplete explicit install falls back to a complete older local installation',async()=>{
 const bad='C:\\OpenAI\\Codex\\bin\\new\\codex.exe',good='C:\\OpenAI\\Codex\\bin\\old\\codex.exe',p=probe({[bad]:9n,[good]:1n,'C:\\OpenAI\\Codex\\bin\\old\\codex-code-mode-host.exe':1n});assert.deepEqual(await select({...base,configuredPath:bad,localAppCandidates:[bad,good]},'win32',p.port),{path:good,source:'LocalAppBin'});
});
it('newest complete local install beats sandbox; incomplete local candidates are each skipped',async()=>{
 const newer='C:/OpenAI/Codex/bin/z/codex.exe',older='C:/OpenAI/Codex/bin/a/codex.exe',p=probe({[newer]:2n,[older]:1n,'C:/OpenAI/Codex/bin/a/codex-code-mode-host.exe':1n,'C:\\home\\.sandbox-bin\\codex.exe':3n});assert.equal((await select({...base,localAppCandidates:[older,newer]},'win32',p.port)).path,older);assert.equal(p.seen.includes('C:\\home\\.sandbox-bin\\codex.exe'),false);
});
it('sandbox missing matching host falls back to usable PATH binary',async()=>{
 const p=probe({'C:\\home\\.sandbox-bin\\codex.exe':1n,'D:\\tools\\codex.exe':1n});assert.deepEqual(await select({...base,pathCandidates:['D:\\tools\\codex.exe']},'win32',p.port),{path:'D:\\tools\\codex.exe',source:'Path'});
});
it('first missing host error wins over later incomplete installs and WindowsApps aliases',async()=>{
 const bad='C:/OpenAI/Codex/bin/new/codex.exe',p=probe({[bad]:1n,'C:\\home\\.sandbox-bin\\codex.exe':1n,'C:/WindowsApps/codex.exe':1n});await assert.rejects(select({...base,configuredPath:bad,pathCandidates:['C:/WindowsApps/codex.exe']},'win32',p.port),e=>e instanceof RuntimeExecutableError&&e.kind==='CodeModeHostMissing'&&e.path==='C:/OpenAI/Codex/bin/new/codex-code-mode-host.exe');
});
it('PATH aliases cannot win over later real paths and alias-only is distinguished from not found',async()=>{
 const p=probe({'C:/WindowsApps/codex.exe':1n,'C:/real/codex.exe':1n});assert.equal((await select({...base,pathCandidates:['C:/WindowsApps/codex.exe','C:/real/codex.exe']},'win32',p.port)).path,'C:/real/codex.exe');await assert.rejects(select({...base,pathCandidates:['C:/WindowsApps/codex.exe']},'win32',p.port),e=>e instanceof RuntimeExecutableError&&e.kind==='WindowsAppsAliasOnly');await assert.rejects(select(base,'win32',probe({}).port),e=>e instanceof RuntimeExecutableError&&e.kind==='ExecutableNotFound');
});
it('local timestamp tie uses deterministic descending path order and POSIX does not require Windows host',async()=>{
 const a='/OpenAI/Codex/bin/a/codex',b='/OpenAI/Codex/bin/b/codex',p=probe({[a]:10n,[b]:10n});assert.deepEqual(await select({...base,localAppCandidates:[a,b]},'posix',p.port),{path:b,source:'LocalAppBin'});
});
it('lexical sandbox append preserves dot-dot and drive-relative base rather than resolving it',async()=>{
 const p=probe({'C:.sandbox-bin\\codex.exe':1n,'C:.sandbox-bin\\codex-code-mode-host.exe':1n});assert.equal((await select({...base,codexHome:'C:'},'win32',p.port)).path,'C:.sandbox-bin\\codex.exe');const q=probe({'/home/link/../.sandbox-bin/codex':1n});assert.equal((await select({...base,codexHome:'/home/link/..'},'posix',q.port)).path,'/home/link/../.sandbox-bin/codex');
});
it('actual native file metadata chooses existing file and rejects directory without executing either',()=>storeFixture(async path=>{
 const root=dirname(path);const file=join(root,'inert');await writeFile(file,'not executable test data');const before=await stat(file);assert.deepEqual(await select({configuredPath:null,codexHome:root,localAppCandidates:[root,file],pathCandidates:[]},'posix'),{path:file,source:'LocalAppBin'});assert.equal((await stat(file)).mtimeMs,before.mtimeMs);
}));
it('accessors, proxies and non-native probe promises are rejected without active hooks',async()=>{
 let calls=0;await assert.rejects(select({...base,get localAppCandidates(){calls++;return [];}}),TypeError);const proxy=new Proxy([],{get(){calls++;throw Error();}});await assert.rejects(select({...base,pathCandidates:proxy}),TypeError);await assert.rejects(select(base,'posix',{isFile:()=>({then(){calls++;}}) as never,modifiedNs:async()=>0n}),TypeError);assert.equal(calls,0);
});
