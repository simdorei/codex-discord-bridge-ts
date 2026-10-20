import assert from 'node:assert/strict';import {it} from 'node:test';
import {PortableResidentLifecycle} from '../../../src/app-server/portable-resident-lifecycle.ts';
import {verifyResumedThread} from '../../../src/runtime/action-executor/resume-verifier.ts';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';
import {createMutationCustodyFence} from '../../../src/runtime/mutation-custody-fence.ts';
async function serverFixture(pages:unknown[],run:(server:PortableResidentLifecycle,seen:()=>Promise<any[]>)=>Promise<void>){await storeFixture(async path=>{
 const db=await openInitialized(path);try{db.exec("INSERT INTO codex_mutation_runtime VALUES(1,'runtime');INSERT INTO codex_app_server_runtime VALUES(1,'runtime')");}finally{db.close();}
 const code=`import readline from 'node:readline';const pages=${JSON.stringify(pages)},seen=[];let n=0;const emit=x=>process.stdout.write(JSON.stringify(x)+'\\n');readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l),reply=result=>emit({id:m.id,result});if(m.method==='initialize')reply({});else if(m.method==='initialized'){}else if(m.method==='seen')reply(seen);else{seen.push({method:m.method,params:m.params});const p=pages[n++]??{};if(p.stall)return;if(p.error)emit({id:m.id,error:p.error});else reply(p);}});`;
 const server=await PortableResidentLifecycle.start({process:{executable:process.execPath,arguments:['--input-type=module','-e',code],environment:{}},clientInfo:{name:'archive-observation',title:'fixture',version:'1'}},()=> 'fixture failure',{persistDeadWork(){},oldChildExited(){}},undefined,{renderError:()=> 'fixture failure',fence:createMutationCustodyFence(path,'runtime',()=> 'fixture failure')});
 const seen=async()=>{const a=server.admitResponse(server.generation());try{return await a.client.requestAdmitted(a.permit,'seen',{},1000) as any[];}finally{a.release();}};
 try{await run(server,seen);}finally{await server.dispose();}
});}

it('already idle or active skips resume when no subscription journal requires it',async()=>{
 for(const status of ['idle','active'])await serverFixture([{thread:{id:'t',status:{type:status}}}],async(s,seen)=>{assert.equal(s.subscriptionResumeRequired('t'),false);assert.equal(await verifyResumedThread(s,'t',1n,1000),'already loaded');assert.deepEqual((await seen()).map(x=>x.method),['thread/read']);});
});
it('notLoaded resumes original exact target then requires a loaded read',async()=>serverFixture([{thread:{id:'t',status:{type:'notLoaded'}}},{thread:{id:'t'}},{thread:{id:'t',status:{type:'idle'}}}],async(s,seen)=>{
 assert.equal(await verifyResumedThread(s,'t',1n,1000),'recovered');assert.deepEqual((await seen()).map(x=>x.method),['thread/read','thread/resume','thread/read']);assert.ok((await seen()).every(x=>x.params.threadId==='t'));
}));
it('missing identity, foreign identity, missing/unknown/systemError status do not become loaded evidence',async()=>{
 for(const response of [{},{thread:{id:'foreign',status:{type:'idle'}}},{thread:{id:'t'}},{thread:{id:'t',status:{type:'newVariant'}}},{thread:{id:'t',status:{type:'systemError'}}}])await serverFixture([response],async(s,seen)=>{await assert.rejects(verifyResumedThread(s,'t',1n,1000));assert.equal((await seen()).length,1);});
});
it('mismatched resume and still-notLoaded final read fail without prompt or fork fallback',async()=>{
 await serverFixture([{thread:{id:'t',status:{type:'notLoaded'}}},{thread:{id:'foreign'}}],async(s,seen)=>{await assert.rejects(verifyResumedThread(s,'t',1n,1000),/resume returned/);assert.equal((await seen()).length,2);});
 await serverFixture([{thread:{id:'t',status:{type:'notLoaded'}}},{thread:{id:'t'}},{thread:{id:'t',status:{type:'notLoaded'}}}],async(s,seen)=>{await assert.rejects(verifyResumedThread(s,'t',1n,1000),/still not loaded/);assert.equal((await seen()).length,3);});
});
it('required journal resume is queried only for loaded status and preserves journal errors',async()=>{
 for(const outcome of [true,false,new Error('journal unknown')])await serverFixture([{thread:{id:'t',status:{type:'active'}}},{thread:{id:'t'}},{thread:{id:'t',status:{type:'active'}}}],async(s,seen)=>{
 let calls=0;const journal={beforeMutation(){return null;},checkMutation(){},resumeRequired(thread:string){calls++;assert.equal(thread,'t');if(outcome instanceof Error)throw outcome;return outcome;},verify(){},transition(){throw Error('not used');},oldChildExited(){}};s.installIdleReleaseJournal(journal);
 if(outcome instanceof Error)await assert.rejects(verifyResumedThread(s,'t',1n,1000),e=>e===outcome);else assert.equal(await verifyResumedThread(s,'t',1n,1000),outcome?'recovered':'already loaded');assert.equal(calls,1);assert.equal((await seen()).length,outcome===true?3:1);
 });
});
it('generation mismatch, zero deadline and pre-cancel send no request',async()=>serverFixture([],async(s,seen)=>{
 await assert.rejects(verifyResumedThread(s,'t',2n,1000));await assert.rejects(verifyResumedThread(s,'t',1n,0),/timed out/);const c=new AbortController(),reason=new Error('cancel');c.abort(reason);await assert.rejects(verifyResumedThread(s,'t',1n,1000,c.signal),e=>e===reason);assert.deepEqual(await seen(),[]);assert.throws(()=>s.subscriptionResumeRequired('\ud800'),TypeError);
}));

it('stalled initial read is bounded and caller cancellation never resumes or resends a prompt',async()=>{
 await serverFixture([{stall:true}],async(s,seen)=>{const start=performance.now();await assert.rejects(verifyResumedThread(s,'t',1n,100));assert.ok(performance.now()-start<1500);assert.deepEqual((await seen()).map(x=>x.method),['thread/read']);});
 await serverFixture([{stall:true}],async(s,seen)=>{const c=new AbortController(),reason=new Error('cancel waiting read'),pending=verifyResumedThread(s,'t',1n,1000,c.signal),assertion=assert.rejects(pending,e=>e===reason);await new Promise(r=>setTimeout(r,20));c.abort(reason);await assertion;assert.deepEqual((await seen()).map(x=>x.method),['thread/read']);});
});
