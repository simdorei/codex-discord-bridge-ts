import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultAppServerArguments,independentInheritedEnvironment} from '../../src/app-server/independent-tools-config.ts';
test('Windows default arguments match exact native pipe override; POSIX unchanged',()=>{
 assert.deepEqual(defaultAppServerArguments('win32'),['app-server','--stdio','-c','mcp_servers.node_repl.env.SKY_CUA_NATIVE_PIPE="0"']);
 for(const platform of ['linux','darwin'] as const)assert.deepEqual(defaultAppServerArguments(platform),['app-server','--stdio']);
 assert.ok(Object.isFrozen(defaultAppServerArguments('win32')));
});
test('Windows filters only inherited desktop identities case-insensitively and preserves ordinary values',()=>{
 const names=['CODEX_APP_TOOLS_PIPE_PATH','BROWSER_USE_ACCESS_VERIFYING_IDENTITY','CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY','SKY_CUA_NATIVE_PIPE_DIRECTORY','CODEX_INTERNAL_ORIGINATOR_OVERRIDE','CODEX_SESSION_ID','CODEX_THREAD_ID'];
 const input=Object.fromEntries([...names.map(n=>[n.toLowerCase(),'fixture-owned-by-parent']),['CODEX_HOME','fixture-home'],['PATH','fixture-path'],['AUTH_FIXTURE','synthetic']]);
 const filtered=independentInheritedEnvironment(input,'win32');
 assert.deepEqual(Object.keys(filtered).sort(),['AUTH_FIXTURE','CODEX_HOME','PATH']);assert.equal(filtered.CODEX_HOME,'fixture-home');
 assert.equal(Object.getPrototypeOf(filtered),null);assert.equal(Object.keys(input).length,10);
 assert.equal(Object.keys(independentInheritedEnvironment(input,'linux')).length,10);
 // Explicit caller additions are intentionally permitted after inherited filtering.
 filtered.CODEX_SESSION_ID='explicit-fixture';assert.equal(filtered.CODEX_SESSION_ID,'explicit-fixture');
});
test('environment assembly rejects active values without executing user hooks',()=>{
 let calls=0;const input=Object.defineProperty({},'PATH',{get(){calls++;return 'x';}});
 assert.throws(()=>independentInheritedEnvironment(input,'win32'),TypeError);assert.equal(calls,0);
 assert.throws(()=>independentInheritedEnvironment({PATH:1} as never,'linux'),TypeError);
});
