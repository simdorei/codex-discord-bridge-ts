import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
test('bundled current-composer connector passes the local Rust DOM contract without opening a browser',{timeout:30000},async()=>{
 const result=await promisify(execFile)(process.execPath,['--test','--test-reporter=tap',fileURLToPath(new URL('./connector-current.test.mjs',import.meta.url))],{windowsHide:true,timeout:25000,maxBuffer:1048576,env:{...process.env,NODE_TEST_CONTEXT:undefined,PRO_CONNECTOR_TEST_SOURCE:resolve('plugins/codex-discord-remote/skills/ask-chatgpt-pro/scripts/pro_connector_control.mjs')}});
 assert.match(result.stdout,/(?:#|ℹ) fail 0/u);
});
