import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildApprovalResponse} from '../../src/app-server/approval-replies.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
const cases=JSON.parse(readFileSync(new URL('../fixtures/mcp-form-input.json',import.meta.url),'utf8')) as Array<{name:string;schema:unknown;answer:string;content?:unknown;action?:string;invalid?:boolean}>;
for(const mode of ['form','openai/form',undefined])for(const sample of cases)test('MCP input '+String(mode)+': '+sample.name,()=>{
 const params={requestedSchema:sample.schema,...(mode===undefined?{}:{mode})};
 const run=()=>buildApprovalResponse('mcpServer/elicitation/request',params,sample.answer);
 if(sample.invalid)assert.throws(run);
 else assert.deepEqual(JSON.parse(serializeSerdeValue(run().payload)),{action:sample.action??'accept',content:sample.content??null,_meta:null});
});
