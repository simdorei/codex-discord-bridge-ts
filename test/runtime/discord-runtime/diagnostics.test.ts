import test from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeDiagnostics} from '../../../src/runtime/discord-runtime/diagnostics.ts';
import {ActionExecutionError} from '../../../src/runtime/action-executor/action-error.ts';

test('runtime report keeps phase, cause code and target with the same rendered diagnostic ID',()=>{
 const lines:string[]=[],diagnostics=createRuntimeDiagnostics(line=>lines.push(line));
 const cause=Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY',errno:5});
 const error=new ActionExecutionError('Store',cause),thread='01a0de1c-bd38-7743-a229-4b7247acc141';
 const rendered=diagnostics.render(error);
 diagnostics.forScope('completion')({kind:'Failed',phase:'receipt',threadId:thread,channelId:42n,error});
 const event=JSON.parse(lines[1]!),detail=event.details[0];
 assert.equal(event.scope,'completion');assert.equal(detail.phase,'receipt');assert.equal(detail.threadId,thread);assert.equal(detail.channelId,'42');
 assert.equal(detail.error.actionKind,'Store');assert.equal(detail.error.cause.code,'SQLITE_BUSY');
 assert.equal(detail.error.category,'DatabaseBusy');assert.ok(rendered.includes(detail.error.diagnostic_id));
});
test('payloads, paths, raw messages and configured tokens never leave diagnostic boundary',()=>{
 const lines:string[]=[],secret='not-an-entropy-token',diagnostics=createRuntimeDiagnostics(line=>lines.push(line),[secret]);
 const error=Object.assign(new Error(`request failed password=${secret}; prompt=private user text; C:\\private\\file`),{code:secret});
 diagnostics.report({kind:'Failed',payload:{token:secret},content:'private user text',stack:'private stack',error});
 const output=lines.join('');
 for(const forbidden of [secret,'private user text','private stack','password=','C:\\private','payload','content'])assert.ok(!output.includes(forbidden),forbidden);
 assert.ok(output.includes('[REDACTED]'));assert.ok(output.includes('diagnostic_id'));
});
test('reporting never invokes accessors, proxy hooks or object coercion',()=>{
 let calls=0;const hook=()=>{calls++;throw Error('must not run');},lines:string[]=[],diagnostics=createRuntimeDiagnostics(line=>lines.push(line));
 const proxy=new Proxy({},{get:hook,getOwnPropertyDescriptor:hook,getPrototypeOf:hook});
 const error={get message(){return hook();},get cause(){return hook();},get name(){return hook();},toString:hook,stack:proxy};
 assert.doesNotThrow(()=>diagnostics.report(error,proxy));
 assert.doesNotThrow(()=>diagnostics.render(proxy));assert.equal(calls,0);
});
test('mirror success is quiet while failed targets retain identity and timeout classification',()=>{
 const lines:string[]=[],diagnostics=createRuntimeDiagnostics(line=>lines.push(line)),thread='01a0de1c-bd38-7743-a229-4b7247acc141';
 const row=(kind:string)=>({finished:{target:{thread,channel:42n},outcome:{kind,error:new Error('target deadline elapsed')}}});
 diagnostics.forScope('mirror')({kind:'Targets',rows:[row('Completed')]});assert.equal(lines.length,0);
 diagnostics.forScope('mirror')({kind:'Targets',rows:[row('Completed'),row('TimedOut')]});
 const data=JSON.parse(lines[0]!);assert.equal(data.scope,'mirror');
 assert.equal(data.details[0].rows[0].finished.target.thread,thread);
 assert.equal(data.details[0].rows[0].finished.outcome.error.category,'Timeout');
});
test('large cyclic causes are bounded and repeated failures retain stable retry text',()=>{
 const lines:string[]=[],diagnostics=createRuntimeDiagnostics(line=>lines.push(line));
 const error=new Error('deadline '+'x'.repeat(1000000));Object.defineProperty(error,'cause',{value:error});
 const first=diagnostics.render(error),second=diagnostics.render(new Error(error.message));
 assert.equal(first,second);assert.ok(lines.every(line=>Buffer.byteLength(line)<=16385));assert.ok(lines[0]!.includes('cycle'));
});
test('diagnostic sink failures remain visible instead of becoming a successful report',()=>{
 const failure=Error('local stderr closed'),diagnostics=createRuntimeDiagnostics(()=>{throw failure;});
 assert.throws(()=>diagnostics.report(Error('problem')),e=>e===failure);
 assert.throws(()=>diagnostics.render(Error('problem')),e=>e===failure);
});
