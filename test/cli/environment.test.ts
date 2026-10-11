import {it} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,realpath,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';
import {loadStartupEnvironmentOffThread,StartupEnvironmentError,defaultStartupEnvironmentPath} from '../../src/cli/environment.ts';import {OwnedWorkerBusyError} from '../../src/runtime/owned-worker-slot.ts';
async function fixture(body:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'cdr-env-owned-')),identity=await realpath(root);try{await body(root);}finally{assert.equal(await realpath(root),identity);assert.equal(dirname(root),tmpdir());await rm(root,{recursive:true});}}
it('native file merge preserves existing values, first file occurrence, source trimming and quote behavior',async()=>fixture(async root=>{
 const file=join(root,'.env');await writeFile(file,'# ignore\nA=file\nB="\'hello\'"\nB=later\nEMPTY=other\n\u0085C\u0085=\u0085value\u0085\nNO_EQUALS\n=empty-key\n');const input=new Map([['A','process'],['EMPTY','']]);const result=await loadStartupEnvironmentOffThread(input,null,join(root,'app.exe'));assert.deepEqual([...result],[['A','process'],['B','hello'],['C','value'],['EMPTY','']]);assert.deepEqual([...input],[['A','process'],['EMPTY','']]);
}));
it('native-host default path and explicit missing file preserve snapshot without changing process environment',async()=>fixture(async root=>{
 assert.equal(defaultStartupEnvironmentPath(join(root,'app.exe')),join(root,'.env'));const input=new Map([['Z','z'],['A','a']]);const pending=loadStartupEnvironmentOffThread(input,join(root,'absent'),'/ignored/application');input.set('A','changed');assert.deepEqual([...await pending],[['A','a'],['Z','z']]);
}));
it('strict UTF8 failure and BOM retention match source string semantics',async()=>fixture(async root=>{
 const file=join(root,'env');await writeFile(file,Buffer.from([0xff,0xfe]));await assert.rejects(loadStartupEnvironmentOffThread(new Map(),file,'/app'),e=>e instanceof StartupEnvironmentError&&e.code==='InvalidUtf8');await writeFile(file,'\uFEFFKEY=value\n');const map=await loadStartupEnvironmentOffThread(new Map(),file,'/app');assert.equal(map.get('\uFEFFKEY'),'value');assert.equal(map.has('KEY'),false);
}));
it('regular-file, byte and entry limits fail closed before any environment is returned',async()=>fixture(async root=>{
 await assert.rejects(loadStartupEnvironmentOffThread(new Map(),root,'/app'),e=>e instanceof StartupEnvironmentError&&e.code==='NotRegularFile');const file=join(root,'env');await writeFile(file,'x'.repeat(1048577));await assert.rejects(loadStartupEnvironmentOffThread(new Map(),file,'/app'),e=>e instanceof StartupEnvironmentError&&e.code==='FileLimit');await writeFile(file,Array.from({length:4097},(_,i)=>'KEY'+i+'=x').join('\n'));await assert.rejects(loadStartupEnvironmentOffThread(new Map(),file,'/app'),e=>e instanceof StartupEnvironmentError&&e.code==='EntryLimit');
}));
it('large native merge keeps timers progressing; shared lane refuses concurrent environment reads',async()=>fixture(async root=>{
 const file=join(root,'env');await writeFile(file,'PAYLOAD='+'x'.repeat(900000));let ticks=0;const timer=setInterval(()=>ticks++,1);try{const first=loadStartupEnvironmentOffThread(new Map(),file,'/app');await assert.rejects(loadStartupEnvironmentOffThread(new Map(),file,'/app'),OwnedWorkerBusyError);assert.equal((await first).get('PAYLOAD')?.length,900000);assert.ok(ticks>0);}finally{clearInterval(timer);}
}));
it('malformed process strings are omitted; active maps, excessive snapshot and preabort are rejected',async()=>fixture(async root=>{
 const file=join(root,'absent');const map=await loadStartupEnvironmentOffThread(new Map([['GOOD','x'],['BAD','\uD800'],['\uD800','bad']]),file,'/app');assert.deepEqual([...map],[['GOOD','x']]);let hooks=0;const proxy=new Proxy(new Map<string,string>(),{get(){hooks++;return undefined;}});await assert.rejects(loadStartupEnvironmentOffThread(proxy,file,'/app'),TypeError);assert.equal(hooks,0);await assert.rejects(loadStartupEnvironmentOffThread(new Map([['X','x'.repeat(1048577)]]),file,'/app'),RangeError);
 const stop=new AbortController(),reason=new Error('stop');stop.abort(reason);await assert.rejects(loadStartupEnvironmentOffThread(new Map(),file,'/app',stop.signal),e=>e===reason);
}));

it('invalid process entries cannot evade the total inspected-entry limit',async()=>{const input=new Map<string,string>();for(let i=0;i<4097;i++)input.set('BAD'+i,'\uD800');await assert.rejects(loadStartupEnvironmentOffThread(input,'/unused/missing','/unused/app'),RangeError);});
it('explicit empty env path preserves source missing-file tolerance instead of resolving to the working directory',async()=>{assert.deepEqual([...await loadStartupEnvironmentOffThread(new Map([['A','kept']]),'','/ignored/app')],[['A','kept']]);});
