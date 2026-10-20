import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,symlinkSync,writeFileSync,readFileSync,readdirSync,existsSync} from 'node:fs';
import {dirname} from 'node:path';
import {storeFixture} from '../helpers/store-fixture.ts';
import {BridgeState} from '../../src/runtime/bridge-state.ts';
import {diagnosticReportBlocking} from '../../src/runtime/diagnostic-report-blocking.ts';
function paths(p:string){const root=dirname(p);mkdirSync(root+'/physical/child',{recursive:true});symlinkSync(root+'/physical/child',root+'/alias','dir');return {root,physical:root+'/physical',raw:root+'/alias/..'};}
test('bridge state creates its exclusive temporary beside the native target',()=>storeFixture(async p=>{
 const f=paths(p);mkdirSync(f.physical+'/only-physical');const path=f.raw+'/only-physical/bridge.json';
 const state=new BridgeState(path);state.setSelectedThreadId('correct');
 assert.equal(state.selectedThreadId(),'correct');assert.equal(JSON.parse(readFileSync(f.physical+'/only-physical/bridge.json','utf8')).selected_thread_id,'correct');
 assert.deepEqual(readdirSync(f.physical+'/only-physical'),['bridge.json']);assert.equal(existsSync(f.root+'/only-physical'),false);
}));
test('diagnostics read adjacent files in the native state directory',()=>storeFixture(async p=>{
 const f=paths(p);writeFileSync(f.physical+'/session_index.jsonl','correct');writeFileSync(f.root+'/session_index.jsonl','wrong-size');
 writeFileSync(f.physical+'/.codex-global-state.json','not-json');writeFileSync(f.root+'/.codex-global-state.json','{}');
 const text=diagnosticReportBlocking({state:f.raw+'/state.sqlite',mirror:f.raw+'/mirror.sqlite',bridge:f.raw+'/bridge.json'});
 assert.match(text,/session_index: readable · 7 bytes/);assert.match(text,/global_state: 조회 실패 · invalid JSON/);
 assert.equal(existsSync(f.physical+'/state.sqlite'),false);assert.equal(existsSync(f.root+'/state.sqlite'),false);
}));
