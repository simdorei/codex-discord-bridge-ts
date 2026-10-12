import assert from 'node:assert/strict';import {test} from 'node:test';
import {CompletionReady} from '../../../../src/runtime/completion/scheduler/ready.ts';
import type {CompletionEntry} from '../../../../src/store/completion-metadata.ts';
const entry=(id:string,source:CompletionEntry['source']='Queue'):CompletionEntry=>({source,id,target:id,turn:'turn',channel:1n,bytes:1n,position:{stamp:0,ordinal:0n,id}});
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
test('async draft publishes all durable additions together and leaves original live owner intact',async()=>{
 const q=new CompletionReady<string>(),g=gate();let disposed=0;q.live({target:'live',payload:'owned',needsNative:false,dispose(){disposed++;}});let draft:CompletionReady<string>|undefined;
 const pending=q.draftAsync(async d=>{draft=d;d.durable(entry('a'),new Set());await g.promise;d.durable(entry('b','Final'),new Set());return 7;});assert.equal(q.stateLength,1);assert.equal(q.httpLength,0);g.resolve();assert.equal(await pending,7);assert.equal(q.stateLength,2);assert.equal(q.httpLength,1);assert.equal(disposed,0);assert.throws(()=>draft!.durable(entry('late'),new Set()),/selection owns/);q.dispose();assert.equal(disposed,1);
});
test('async draft failure discards all new hints without releasing existing live ownership',async()=>{
 const q=new CompletionReady<string>(),g=gate(),reason={failedSnapshot:true};let disposed=0;q.live({target:'live',payload:'owned',needsNative:false,dispose(){disposed++;}});q.durable(entry('old','Final'),new Set());const before=q.stateSnapshot(),http=q.httpSnapshot();const pending=q.draftAsync(async d=>{d.durable(entry('a'),new Set());d.durable(entry('new','Final'),new Set());await g.promise;throw reason;});const rejected=assert.rejects(pending,e=>e===reason);g.resolve();await rejected;assert.deepEqual(q.stateSnapshot(),before);assert.deepEqual(q.httpSnapshot(),http);assert.equal(disposed,0);q.dispose();assert.equal(disposed,1);
});
test('all original mutations and reentrant drafts are refused while asynchronous discovery owns Ready',async()=>{
 const q=new CompletionReady<string>(),g=gate();const pending=q.draftAsync(async d=>{d.durable(entry('a'),new Set());await g.promise;});for(const op of [()=>q.live({target:'b',payload:'b',needsNative:false,dispose(){assert.fail('ownership was never transferred');}}),()=>q.durable(entry('b'),new Set()),()=>q.prioritize(entry('b','Final')),()=>q.takeHttp(new Map()),()=>q.dispose(),()=>q.draft(()=>{}),()=>q.discardOrphanHints([]),()=>q.takeStateAdmitted(new Set(),0,()=>null)])assert.throws(op,/selection owns/);await assert.rejects(q.draftAsync(async()=>{}),/selection owns/);await assert.rejects(q.takeStateAdmittedAsync(new Set(),0,async()=>null),/selection owns/);g.resolve();await pending;assert.equal(q.stateLength,1);q.dispose();
});
test('private draft permits only durable append and nested synchronous rollback',async()=>{
 const q=new CompletionReady<string>();await q.draftAsync(async d=>{for(const op of [()=>d.live({target:'a',payload:'a',needsNative:false,dispose(){assert.fail('no transfer');}}),()=>d.prioritize(entry('a','Final')),()=>d.takeHttp(new Map()),()=>d.dispose(),()=>d.discardOrphanHints([])])assert.throws(op,/append-only/);await assert.rejects(d.draftAsync(async()=>{}),/append-only/);d.durable(entry('kept'),new Set());assert.throws(()=>d.draft(()=>{d.durable(entry('discard'),new Set());throw new Error('source failure');}),/source failure/);d.draft(()=>d.durable(entry('http','Final'),new Set()));});assert.deepEqual(q.stateSnapshot().map(x=>x.kind==='Durable'?x.entry.id:'live'),['kept']);assert.deepEqual(q.httpSnapshot().map(x=>x.id),['http']);
});
test('draft retains the shared128 cap and original active-target and duplicate rules',async()=>{
 const q=new CompletionReady<string>();for(let i=0;i<127;i++)q.durable(entry('old'+i,'Final'),new Set());await q.draftAsync(async d=>{d.durable(entry('busy'),new Set(['busy']));d.durable(entry('old0','Final'),new Set());d.durable(entry('last'),new Set());d.durable(entry('overflow','Final'),new Set());assert.equal(d.length,128);});assert.equal(q.length,128);assert.equal(q.stateLength,1);assert.equal(q.httpLength,127);q.dispose();
});
test('callback throw before first await unlocks Ready and retained draft cannot be reused',async()=>{
 const q=new CompletionReady<string>();let retained:CompletionReady<string>|undefined;await assert.rejects(q.draftAsync(async d=>{retained=d;throw new Error('snapshot refused');}),/snapshot refused/);assert.throws(()=>retained!.durable(entry('late'),new Set()),/selection owns/);q.durable(entry('new'),new Set());assert.equal(q.length,1);q.dispose();
});
