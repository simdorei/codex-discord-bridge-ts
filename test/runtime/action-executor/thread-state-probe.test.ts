import test from 'node:test';
import assert from 'node:assert/strict';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {parseThreadState,readThreadStates} from '../../../src/runtime/action-executor/thread-state-probe.ts';
const stamp='2026-10-10T00:00:00.000+00:00';const value=(type:string,activeFlags:unknown=[],id='t')=>({thread:{id,status:{type,activeFlags}}});
test('only exact identity and explicit status label execution or idle',()=>{
 for(const [status,text] of [['idle','idle (작업 없음)'],['notLoaded','다른 앱 실행 여부 미확인'],['systemError','서버 오류'],['active','진행 중']])assert.ok(parseThreadState(value(status!), 't',stamp).includes(text!));
 for(const input of [null,{},value('idle',[],'other'),{thread:{id:'t'}},value('unknown')])assert.match(parseThreadState(input,'t',stamp),/조회 실패/);
 assert.equal(parseThreadState(value('idle'),'t',stamp),`idle (작업 없음) · 서버 조회 시점; ${stamp}`);
});
test('approval and input flags stay distinct, unknown flags are never ordinary active',()=>{
 assert.match(parseThreadState(value('active',['waitingOnApproval']),'t',stamp),/active \(승인 대기\)/);assert.match(parseThreadState(value('active',['waitingOnUserInput']),'t',stamp),/active \(사용자 입력 대기\)/);assert.match(parseThreadState(value('active',['waitingOnApproval','waitingOnUserInput']),'t',stamp),/승인 대기 · 사용자 입력 대기/);
 for(const flags of [null,{},'waitingOnApproval'])assert.match(parseThreadState(value('active',flags),'t',stamp),/누락 또는 배열/);for(const flags of [['newFlag'],[1n],[null]])assert.match(parseThreadState(value('active',flags),'t',stamp),/미지원 activeFlags/);
});
async function fixture(mode:string,run:(server:PortableResidentLifecycle,seen:()=>Promise<any[]>)=>Promise<void>){
 const code=`import readline from 'node:readline';const mode=${JSON.stringify(mode)},seen=[];const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l),reply=result=>emit({id:m.id,result});if(m.method==='initialize')reply({});else if(m.method==='initialized'){}else if(m.method==='seen')reply(seen);else {seen.push({method:m.method,params:m.params});if(mode==='hang')return;if(mode==='error')emit({id:m.id,error:{code:-9,message:'line1\\nline2'}});else reply({thread:{id:mode==='wrong'?'other':m.params.threadId,status:{type:'idle'}}});}});`;
 const server=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'state-probe',title:'fixture',version:'1'}},()=> 'safe',{persistDeadWork(){},oldChildExited(){}},undefined,{fence:null,renderError:()=> 'safe'});
 const seen=async()=>{const a=server.admitRequest();try{return await a.client.requestAdmitted(a.permit,'seen',{},1000) as any[];}finally{a.release();}};try{await run(server,seen);}finally{await server.dispose();}
}
test('native observational probe preserves requested order, final UTF8 key order and no mutation',async()=>fixture('idle',async(server,seen)=>{
 const out=await readThreadStates(server,[{id:'한글'},{id:'a'},{id:'😀'}],3,()=> 'safe');assert.deepEqual([...out.keys()],['a','한글','😀']);assert.ok([...out.values()].every(v=>v.startsWith('idle (작업 없음)')));const calls=await seen();assert.deepEqual(calls.map(v=>v.params.threadId),['한글','a','😀']);assert.ok(calls.every(v=>v.method==='thread/read'&&v.params.includeTurns===false));
}));
test('fifty-query cap labels remaining requested rows as unknown without issuing extra reads',async()=>fixture('idle',async(server,seen)=>{
 const threads=Array.from({length:55},(_,i)=>({id:`t${i}`}));const out=await readThreadStates(server,threads,55,()=> 'safe');assert.equal((await seen()).length,50);assert.equal(out.size,55);for(let i=50;i<55;i++)assert.equal(out.get(`t${i}`),'미확인 (서버 조회 한도 50개/전체 3초)');
}));
test('wrong server identity and multiline error cannot fabricate idle or inject display rows',async()=>{
 await fixture('wrong',async server=>{assert.match((await readThreadStates(server,[{id:'t'}],1,()=> 'safe')).get('t')!,/ID 불일치/);});await fixture('error',async server=>{assert.equal((await readThreadStates(server,[{id:'t'}],1,()=> 'first\r\nsecond')).get('t'),'조회 실패: first  second');});
});
test('native stalled reads share the actual three-second total and joined cancellation',{timeout:7000},async()=>fixture('hang',async(server,seen)=>{
 const start=performance.now(),out=await readThreadStates(server,Array.from({length:12},(_,i)=>({id:`t${i}`})),12,()=> 'safe');const elapsed=performance.now()-start;assert.ok(elapsed>=2900&&elapsed<5000);assert.match(out.get('t0')!,/시간 제한 초과/);assert.equal(out.get('t11'),'미확인 (서버 조회 한도 50개/전체 3초)');const calls=await seen();assert.ok(calls.length>=4&&calls.length<=6);assert.ok(calls.every(v=>v.method==='thread/read'));
}));
test('pre-cancelled caller issues no native read and absent server returns no inferred state',async()=>fixture('idle',async(server,seen)=>{
 const a=new AbortController(),reason=new Error('cancel');a.abort(reason);await assert.rejects(readThreadStates(server,[{id:'t'}],1,()=> 'safe',a.signal),e=>e===reason);assert.deepEqual(await seen(),[]);assert.equal((await readThreadStates(null,[{id:'t'}],1,()=> 'safe')).size,0);
}));
test('input snapshot rejects getters without executing them and detached list cannot retarget native reads',async()=>fixture('idle',async(server,seen)=>{
 let hooks=0;await assert.rejects(readThreadStates(server,[{get id(){hooks++;return 't';}}],1,()=> 'safe'));assert.equal(hooks,0);const threads=[{id:'original'}],work=readThreadStates(server,threads,1,()=> 'safe');threads[0]!.id='changed';await work;assert.equal((await seen())[0].params.threadId,'original');
}));
