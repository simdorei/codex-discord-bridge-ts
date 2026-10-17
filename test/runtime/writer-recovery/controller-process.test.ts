import test from 'node:test';
import assert from 'node:assert/strict';
import {invokeControllerProcess,ControllerProcessError} from '../../../src/runtime/writer-recovery/controller-process.ts';
const input=(code:string,extra={})=>({executable:process.execPath,arguments:['-e',code],cwd:process.cwd(),timeoutMs:3000,maxBytes:4096,...extra});
const kind=(expected:ControllerProcessError['kind'])=>(e:unknown)=>e instanceof ControllerProcessError&&e.kind===expected;
test('controller direct child returns lossless JSON after confirmed close',async()=>{assert.deepEqual(await invokeControllerProcess(input('process.stdout.write(\'{"id":9223372036854775807,"ok":true}\')')),{id:9223372036854775807n,ok:true});});
test('controller nonzero exit cannot turn JSON into success',async()=>{await assert.rejects(invokeControllerProcess(input('console.log("{}");process.exitCode=7')),kind('exit'));});
test('controller invalid UTF8 is refused without replacement decoding',async()=>{await assert.rejects(invokeControllerProcess(input('process.stdout.write(Buffer.from([255]))')),kind('decode'));});
test('controller trailing text and malformed JSON fail',async()=>{await assert.rejects(invokeControllerProcess(input('console.log("{} trailing")')),kind('decode'));});
test('controller cumulative stderr and stdout share byte budget',async()=>{await assert.rejects(invokeControllerProcess(input('process.stderr.write("x".repeat(100));process.stdout.write("{}");setInterval(()=>{},1000)',{maxBytes:64})),kind('output'));});
test('controller timeout kills and joins its owned direct child',async()=>{await assert.rejects(invokeControllerProcess(input('setInterval(()=>{},1000)',{timeoutMs:100})),kind('timeout'));});
test('controller cancellation is not an automatic retry',async()=>{const controller=new AbortController();const run=invokeControllerProcess(input('setInterval(()=>{},1000)'),controller.signal);setTimeout(()=>controller.abort(),100);await assert.rejects(run,kind('aborted'));});
test('controller already aborted does not spawn',async()=>{const c=new AbortController(),reason={cancel:true};c.abort(reason);await assert.rejects(invokeControllerProcess(input('process.exit(99)'),c.signal),e=>e===reason);});
test('controller rejects relative executable and active argument getter',async()=>{await assert.rejects(invokeControllerProcess(input('',{executable:'node'})),TypeError);let calls=0;const args=Object.defineProperty([],0,{get(){calls++;return 'x';}});await assert.rejects(invokeControllerProcess(input('',{arguments:args})),TypeError);assert.equal(calls,0);});
test('controller missing executable has explicit spawn failure',async()=>{await assert.rejects(invokeControllerProcess(input('',{executable:process.execPath+'.missing'})),kind('spawn'));});

test('controller argument proxy is refused without traps',async()=>{let calls=0;const args=new Proxy([],{get(){calls++;throw Error('trap');}});await assert.rejects(invokeControllerProcess(input('',{arguments:args})),TypeError);assert.equal(calls,0);});
test('controller preserves UTF8 BOM for JSON parser rejection',async()=>{await assert.rejects(invokeControllerProcess(input('process.stdout.write(Buffer.from([239,187,191,123,125]))')),kind('decode'));});
