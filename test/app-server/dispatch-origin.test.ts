import assert from "node:assert/strict";
import {test} from "node:test";
import {setTimeout as delay} from "node:timers/promises";
import {withStopOrigin,currentStopOrigin,hasStopOriginScope,withoutStopOriginScope,archiveStopOrigin,withArchiveStopScope} from "../../src/app-server/dispatch-origin.ts";
import {parseSerdeValue} from "../../src/core/serde-json-parse.ts";
test("first stop origin wins across nested awaits and is restored outside the scope",async()=>{
  assert.equal(hasStopOriginScope(),false);const value={target:"T",stopRevision:4n};
  await withStopOrigin(value,async()=>{value.stopRevision=9n;assert.deepEqual(currentStopOrigin(),{target:"T",stopRevision:4n});assert.ok(Object.isFrozen(currentStopOrigin()));await withStopOrigin({target:"other",stopRevision:99n},async()=>{await delay(1);assert.deepEqual(currentStopOrigin(),{target:"T",stopRevision:4n});});assert.deepEqual(currentStopOrigin(),{target:"T",stopRevision:4n});});assert.equal(hasStopOriginScope(),false);assert.equal(currentStopOrigin(),null);
});
test("explicit absent origin is still a set scope and cannot be refreshed by nested requests",async()=>{
  await withStopOrigin(null,async()=>{assert.equal(hasStopOriginScope(),true);await withStopOrigin({target:"T",stopRevision:9n},async()=>assert.equal(currentStopOrigin(),null));});
});
test("parallel requests never share stop revision and exceptions do not leak scope",async()=>{
  const results=await Promise.all([1n,2n,3n].map(revision=>withStopOrigin({target:String(revision),stopRevision:revision},async()=>{await delay(Number(4n-revision));return currentStopOrigin();})));assert.deepEqual(results,[1n,2n,3n].map(revision=>({target:String(revision),stopRevision:revision})));
  const error={};await assert.rejects(withStopOrigin({target:"T",stopRevision:1n},async()=>{throw error;}),e=>e===error);assert.equal(hasStopOriginScope(),false);
});
test("independent async work must explicitly leave inherited Node request context",async()=>{
  await withStopOrigin({target:"T",stopRevision:1n},async()=>{await withoutStopOriginScope(async()=>{await delay(1);assert.equal(hasStopOriginScope(),false);await withStopOrigin({target:"other",stopRevision:2n},async()=>assert.deepEqual(currentStopOrigin(),{target:"other",stopRevision:2n}));});assert.deepEqual(currentStopOrigin(),{target:"T",stopRevision:1n});});
});
test("archive without an enclosing origin scope creates no authority or validation side effects",async()=>{
  assert.equal(archiveStopOrigin("",[""]),null);assert.equal(await withArchiveStopScope("",[""],async()=>hasStopOriginScope()),false);
});
test("validated archive expands original revision with deduplicated UTF-8 BTreeSet ordering",async()=>{
  await withStopOrigin({target:"root",stopRevision:9007199254740993n},async()=>{
    const expected={target:"root",stopRevision:9007199254740993n,archiveTargets:["A","root","\uE000","😀"]};assert.deepEqual(archiveStopOrigin("root",["😀","A","\uE000","A"]),expected);
    await withArchiveStopScope("root",["😀","A","\uE000"],async()=>{assert.deepEqual(currentStopOrigin(),expected);await withStopOrigin({target:"A",stopRevision:999n},async()=>assert.deepEqual(currentStopOrigin(),expected));assert.throws(()=>archiveStopOrigin("root",["A"]),/no refresh or retarget/);});assert.deepEqual(currentStopOrigin(),{target:"root",stopRevision:9007199254740993n});
  });
});
test("archive in an explicitly null scope uses the original root with revision zero",async()=>{
  await withStopOrigin(null,async()=>assert.deepEqual(archiveStopOrigin("root",["child"]),{target:"root",stopRevision:0n,archiveTargets:["child","root"]}));
});
test("archive rejects wrong identity, extra fields, floats, negative revisions and out-of-range signed values",async()=>{
  for(const value of [{target:"wrong",stopRevision:1n},{target:"root",stopRevision:1n,extra:true},parseSerdeValue('{"target":"root","stopRevision":1.0}'),parseSerdeValue('{"target":"root","stopRevision":1e0}'),{target:"root",stopRevision:-1n},{target:"root",stopRevision:1n<<63n}])await withStopOrigin(value,async()=>assert.throws(()=>archiveStopOrigin("root",[]),/no refresh or retarget/));
});
test("archive subtree enforces 100 unique children, no root inclusion, and Rust whitespace boundaries",async()=>{
  await withStopOrigin({target:"root",stopRevision:1n},async()=>{
    assert.ok(archiveStopOrigin("root",Array.from({length:100},(_,i)=>String(i))));for(const children of [["root"],[""],[" child"],["child\u0085"],Array.from({length:101},(_,i)=>String(i))])assert.throws(()=>archiveStopOrigin("root",children),/no refresh or retarget/);
    assert.ok(archiveStopOrigin("root",Array(101).fill("one")));assert.ok(archiveStopOrigin("root",["\uFEFF"]));
  });
});
