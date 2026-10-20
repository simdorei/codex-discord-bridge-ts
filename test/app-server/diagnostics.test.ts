import assert from "node:assert/strict";
import {test} from "node:test";
import {BoundedDiagnostics} from "../../src/app-server/diagnostics.ts";
test("diagnostics retain at most 512 lines in arrival order",()=>{
  const d=new BoundedDiagnostics();for(let i=0;i<513;i++)d.push(String(i));const s=d.snapshot();assert.equal(s.lines.length,512);assert.equal(s.lines[0],"1");assert.equal(s.lines.at(-1),"512");assert.equal(s.droppedLines,1n);assert.equal(s.retainedBytes,s.lines.reduce((n,line)=>n+Buffer.byteLength(line),0));
});
test("64KiB retained-byte cap evicts oldest lines independently of count",()=>{
  const d=new BoundedDiagnostics();d.push("a".repeat(40000));d.push("b".repeat(30000));const s=d.snapshot();assert.deepEqual(s.lines,["b".repeat(30000)]);assert.equal(s.retainedBytes,30000);assert.equal(s.droppedLines,1n);
});
test("oversized ASCII and aligned emoji retain exact budget without counting truncation as a dropped line",()=>{
  for(const line of ["x".repeat(65537),"🦊".repeat(16385)]){const d=new BoundedDiagnostics();d.push(line);const s=d.snapshot();assert.equal(s.retainedBytes,65536);assert.equal(Buffer.byteLength(s.lines[0]!),65536);assert.equal(s.droppedLines,0n);}
});
test("documented TS correction floors an unaligned Korean byte boundary rather than panicking",()=>{
  const line="한".repeat(21846),bytes=Buffer.from(line);assert.equal(bytes.length,65538);assert.equal(bytes[65536]!&0xc0,0x80);
  const d=new BoundedDiagnostics();assert.doesNotThrow(()=>d.push(line));const s=d.snapshot();assert.equal(s.retainedBytes,65535);assert.equal(s.lines[0],"한".repeat(21845));assert.equal(/[\uD800-\uDFFF]/u.test(s.lines[0]!),false);
});
test("empty lines still consume count and snapshot cannot mutate retained data",()=>{
  const d=new BoundedDiagnostics();for(let i=0;i<513;i++)d.push("");const s=d.snapshot();assert.equal(s.lines.length,512);assert.equal(s.retainedBytes,0);assert.equal(s.droppedLines,1n);assert.throws(()=>{(s.lines as string[]).push("tampered");},TypeError);assert.equal(d.snapshot().lines.length,512);assert.throws(()=>d.push("\uD800"),TypeError);
});
