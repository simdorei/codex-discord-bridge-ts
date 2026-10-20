import assert from 'node:assert/strict';import {it} from 'node:test';import {join,dirname} from 'node:path';import {existsSync,writeFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';import {RuntimeServiceActions} from '../../../src/runtime/action-executor/service-actions.ts';import {joinDiagnosticReaders} from '../../../src/runtime/diagnostic-report.ts';
const render=(e:unknown)=>e instanceof Error?e.message:'fixture';
async function fixture(run:(f:{actions:RuntimeServiceActions;server:PortableResidentLifecycle;paths:{state:string;mirror:string;bridge:string};call:(m:string)=>Promise<unknown>})=>Promise<void>){await storeFixture(async mirror=>{
 const paths={state:join(dirname(mirror),'state.sqlite'),mirror,bridge:join(dirname(mirror),'bridge.json')};
 const code="import readline from 'node:readline';let reads=0;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);if(m.method==='initialized')return;if(m.method==='start')emit({method:'turn/started',params:{threadId:'t',turnId:'v'}});if(m.method==='finish')emit({method:'turn/completed',params:{threadId:'t',turnId:'v'}});if(m.method!=='initialize')reads++;emit({id:m.id,result:m.method==='seen'?reads:{}});});";
 const server=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'service',title:'fixture',version:'1'}},render,{persistDeadWork(){},oldChildExited(){}});
 const call=async(method:string)=>{const a=server.admitResponse(server.generation());try{return await a.client.requestAdmitted(a.permit,method,{},1000);}finally{a.release();}};
 try{await run({paths,server,call,actions:new RuntimeServiceActions(paths,server)});}finally{await Promise.all([server.dispose(),joinDiagnosticReaders()]);}
});}
it('doctor reports actual native lifecycle and process ID without RPC or leaking file values',async()=>fixture(async f=>{
 writeFileSync(f.paths.bridge,'{"secret":"do-not-leak"}');const generation=f.server.generation(),text=(await f.actions.doctor()).text;assert.ok(text.includes('runtime_pid: '+process.pid));assert.ok(text.includes('"healthy":true'));assert.ok(text.includes('app_server:'));assert.ok(!text.includes('do-not-leak'));assert.equal(await f.call('seen'),1n);assert.equal(f.server.generation(),generation);assert.equal(existsSync(f.paths.state),false);assert.equal(existsSync(f.paths.mirror),false);
}));
it('resources keeps unavailable host measurement explicit and does not create missing databases',async()=>fixture(async f=>{
 const text=(await f.actions.resources()).text;assert.ok(text.startsWith('TypeScript runtime resources'));assert.ok(text.includes('Windows 실측 API만 지원'));assert.ok(text.includes('runner'));assert.equal(existsSync(f.paths.mirror),false);assert.equal(await f.call('seen'),1n);
}));
it('no resident remains a diagnostic fact while restart requires a real server',async()=>storeFixture(async mirror=>{
 const paths={state:mirror+'state',mirror,bridge:mirror+'bridge'},a=new RuntimeServiceActions(paths,null);try{assert.match((await a.doctor()).text,/미확인: app-server 연결 없음/);assert.match((await a.resources()).text,/app_server: unavailable/);await assert.rejects(a.restartCodex(),/unavailable/);}finally{await joinDiagnosticReaders();}
}));
it('restart joins owned old child and reports restarted only after a new healthy generation',async()=>fixture(async f=>{
 const oldPid=f.server.lifecycleSnapshot().processId;assert.match((await f.actions.restartCodex()).text,/restarted\./);assert.equal(f.server.generation(),2n);assert.equal(f.server.lifecycleSnapshot().healthy,true);assert.notEqual(f.server.lifecycleSnapshot().processId,oldPid);assert.throws(()=>process.kill(oldPid!,0),(e:unknown)=>(e as NodeJS.ErrnoException).code==='ESRCH');
}));
it('active turn makes restart pending without interrupt or replacement; later request can finish it',async()=>fixture(async f=>{
 await f.call('start');const pid=f.server.lifecycleSnapshot().processId;assert.match((await f.actions.restartCodex()).text,/pending until active turns/);assert.equal(f.server.generation(),1n);assert.equal(f.server.lifecycleSnapshot().processId,pid);await f.call('finish');assert.match((await f.actions.restartCodex()).text,/restarted\./);assert.equal(f.server.generation(),2n);
}));
it('pre-cancel creates no worker, files or restart request',async()=>fixture(async f=>{
 const c=new AbortController(),reason=new Error('cancel');c.abort(reason);for(const run of [()=>f.actions.doctor(c.signal),()=>f.actions.resources(c.signal),()=>f.actions.restartCodex(c.signal)])await assert.rejects(run(),e=>e===reason);assert.equal(f.server.generation(),1n);assert.equal(f.server.lifecycleSnapshot().restartPending,false);assert.equal(existsSync(f.paths.mirror),false);
}));
