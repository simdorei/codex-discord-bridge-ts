import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { rustDebugString } from "../../src/core/rust-debug.ts";
const oracle=JSON.parse(readFileSync(new URL("../fixtures/rust-debug-1.97.1.json",import.meta.url),"utf8")) as {
  unicode_escape_ranges: Array<[number,number]>;
  escaped_scalar_count: number;
  cases: Array<{input:string;expected:string}>;
};
test("Rust debug oracle samples match exactly",()=>{
  for(const c of oracle.cases) assert.equal(rustDebugString(c.input),c.expected);
});
test("Rust debug escape ranges are sorted, nonoverlapping Unicode ranges",()=>{
  let previous=-1, count=0;
  for(const [start,end] of oracle.unicode_escape_ranges) {
    assert.ok(Number.isInteger(start)&&Number.isInteger(end));
    assert.ok(start>previous && start<=end && end<=0x10ffff);
    assert.ok(end<0xd800 || start>0xdfff);
    count+=end-start+1; previous=end;
  }
  assert.equal(count,oracle.escaped_scalar_count);
});
test("Rust debug matches the oracle-derived expectation for every valid scalar",()=>{
  let rangeIndex=0;
  for(let point=0;point<=0x10ffff;point++) {
    if(point>=0xd800 && point<=0xdfff) continue;
    while(rangeIndex<oracle.unicode_escape_ranges.length &&
      oracle.unicode_escape_ranges[rangeIndex]![1]<point) rangeIndex++;
    const range=oracle.unicode_escape_ranges[rangeIndex];
    const escaped=range!==undefined && range[0]<=point && point<=range[1];
    const c=String.fromCodePoint(point);
    let body: string;
    switch(c) {
      case "\0": body="\\0";break;
      case "\t": body="\\t";break;
      case "\r": body="\\r";break;
      case "\n": body="\\n";break;
      case "\\": body="\\\\";break;
      case '"': body='\\"';break;
      default: body=escaped?"\\u{"+point.toString(16)+"}":c;
    }
    assert.equal(rustDebugString(c),'"'+body+'"', "U+"+point.toString(16));
  }
});
test("Rust debug rejects malformed UTF16 instead of normalizing it",()=>{
  assert.throws(()=>rustDebugString("\uD800"),TypeError);
  assert.throws(()=>rustDebugString("\uDFFF"),TypeError);
});
