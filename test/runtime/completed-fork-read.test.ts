import test from 'node:test';
import assert from 'node:assert/strict';
import {captureCompletedForkRead} from '../../src/runtime/completed-fork-read.ts';
test('completed-fork capture snapshots own port and original path while reading every hop fresh',async()=>{
 const calls:unknown[][]=[];let target:string|null='first';const source={completedAppServerForkTargetForSource:async(...args:unknown[])=>{calls.push(args);return target;}},read=captureCompletedForkRead('original',source);source.completedAppServerForkTargetForSource=async()=>assert.fail('replacement');
 assert.equal(await read(' source '),'first');target='second';assert.equal(await read(' source '),'second');target=null;assert.equal(await read(''),null);assert.deepEqual(calls,[['original',' source '],['original',' source '],['original','']]);
});
test('completed-fork capture rejects proxy inherited accessor and generator ports without invoking hooks',()=>{
 let hooks=0;const fn=async()=>null;
 for(const source of [new Proxy({completedAppServerForkTargetForSource:fn},{getOwnPropertyDescriptor(){hooks++;return undefined;}}),Object.create({completedAppServerForkTargetForSource:fn}),Object.defineProperty({},'completedAppServerForkTargetForSource',{get(){hooks++;return fn;}}),...([null,function*(){hooks++;},async function*(){hooks++;},new Proxy(fn,{apply(){hooks++;return Promise.resolve(null);}})]).map(value=>({completedAppServerForkTargetForSource:value}))])assert.throws(()=>captureCompletedForkRead('path',source),TypeError);assert.equal(hooks,0);
});
test('completed-fork capture requires a real Promise and strict null or text result without thenable assimilation',async()=>{
 let hooks=0;const thenable={get then(){hooks++;return ()=>{hooks++;};}};
 for(const value of [null,undefined,thenable,new Proxy(Promise.resolve(null),{})]){const read=captureCompletedForkRead('path',{completedAppServerForkTargetForSource:()=>value} as any);assert.throws(()=>read('source'),/Promise/);}
 for(const value of [undefined,1,1n,false,{},'\ud800'])await assert.rejects(captureCompletedForkRead('path',{completedAppServerForkTargetForSource:async()=>value} as any)('source'),TypeError);
 const promise=Promise.resolve('target');Object.defineProperty(promise,'then',{get(){hooks++;throw Error('untrusted then');}});assert.equal(await captureCompletedForkRead('path',{completedAppServerForkTargetForSource:()=>promise})('source'),'target');assert.equal(hooks,0);
});
test('completed-fork capture preserves synchronous and asynchronous errors without false absence',async()=>{
 for(const sync of [true,false]){const error=new Error('read failed'),read=captureCompletedForkRead('path',{completedAppServerForkTargetForSource:()=>{if(sync)throw error;return Promise.reject(error);}});await assert.rejects(async()=>read('source'),e=>e===error);}
});
