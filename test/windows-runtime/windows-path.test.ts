import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {normalizeWorkspacePathWindows} from '../../src/codex-state/thread-reference.ts';
import {sameWindowsRuntimePath,windowsRuntimeFilename} from '../../src/runtime/runtime-paths/path-text.ts';
const fixture=JSON.parse(readFileSync(new URL('../fixtures/windows-path-rust.json',import.meta.url),'utf8')) as {
 cases:Array<{input:string;normalized:string;filename:string;equivalent:number[]}>;
};
test('Windows workspace normalization and filenames match native Rust oracle vectors',()=>{
 for(const row of fixture.cases){
  assert.equal(normalizeWorkspacePathWindows(row.input),row.normalized,JSON.stringify(row.input));
  assert.equal(windowsRuntimeFilename(row.input),row.filename,JSON.stringify(row.input));
 }
});
test('Windows lexical database affinity matches the entire native Rust equality matrix',()=>{
 for(const row of fixture.cases)for(const [index,other] of fixture.cases.entries())
  assert.equal(sameWindowsRuntimePath(row.input,other.input),row.equivalent.includes(index),JSON.stringify([row.input,other.input]));
});
