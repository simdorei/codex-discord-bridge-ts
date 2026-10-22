import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {storeFixture} from '../helpers/store-fixture.ts';
import {captureMirrorCursorAnchor} from '../../src/runtime/session-mirror/continuity-observation.ts';
import {recoverLegacyMirrorTurn,MigrationBudget,LEGACY_LINE_BYTES} from '../../src/cli/legacy-mirror-turn.ts';
// storeFixture intentionally returns void, so assertions run inside its lifetime.
async function expectScan(content:string|Buffer,expected:string|RegExp,offset?:number){await storeFixture(async path=>{
 const log=join(dirname(path),'events.jsonl');await writeFile(log,content);
 const run=async()=>{const anchor=await captureMirrorCursorAnchor(log,BigInt(offset??Buffer.byteLength(content)),undefined,true);return recoverLegacyMirrorTurn(anchor.anchor,new MigrationBudget());};
 if(typeof expected==='string')assert.equal(await run(),expected);else await assert.rejects(run(),expected);
});}
test('zero offset and fully scanned no-turn prefix are empty, not errors',async()=>{await expectScan('future\n','',0);await expectScan('{"type":"other"}\n','');});
test('CRLF, malformed JSON, empty IDs and different event types follow Rust selection',()=>expectScan('{"type":"turn_context","payload":{"turn_id":"first"}}\r\nnot JSON turn_context\n{"type":"turn_context","payload":{"turn_id":""}}\n{"type":"event_msg","payload":{"type":"task_started","turn_id":"last"}}\n','last'));
test('UTF-8 scalar split across 64 KiB chunk remains valid',()=>expectScan(' '.repeat(65535)+'한\n'+JSON.stringify({type:'turn_context',payload:{turn_id:'한글'}})+'\n','한글'));
test('events outside first 200 Unicode scalar prefix retain Rust filter',()=>expectScan(' '.repeat(201)+JSON.stringify({type:'turn_context',payload:{turn_id:'ignored'}})+'\n',''));
test('invalid UTF-8 is not silently replaced',()=>expectScan(Buffer.from([0xff,10]),/encoded data|encoding/i));
test('partial line is not treated as initialized no-turn',()=>expectScan('{"type":"other"}',/changed|boundary/));
for(const delta of [-1,0,1])test('line byte budget boundary '+delta,()=>expectScan('x'.repeat(LEGACY_LINE_BYTES+delta)+'\n',delta>0?/byte budget/:''));

test('Rust-invalid escaped lone surrogate record is ignored, not used as a turn',()=>expectScan('{"type":"turn_context","payload":{"turn_id":"keep"}}\n'+String.raw`{"type":"turn_context","payload":{"turn_id":"\ud800"}}`+'\n','keep'));
