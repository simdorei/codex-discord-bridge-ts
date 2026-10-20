import assert from "node:assert/strict";
import {test} from "node:test";
import {serdeValueEqual} from "../../src/core/serde-value-equal.ts";
test("Serde Value equality preserves number variants but treats floating zero signs equally",()=>{
  assert.equal(serdeValueEqual(-0,0),true);assert.equal(serdeValueEqual(1n,1),false);
  assert.equal(serdeValueEqual(1n,1n),true);assert.equal(serdeValueEqual("1",1n),false);
});
test("Value objects ignore property order, arrays retain order and missing differs from null",()=>{
  assert.equal(serdeValueEqual({b:[1n,null],a:false},{a:false,b:[1n,null]}),true);
  assert.equal(serdeValueEqual([1n,2n],[2n,1n]),false);assert.equal(serdeValueEqual({},[]),false);
  assert.equal(serdeValueEqual({a:null},{}),false);
  assert.equal(serdeValueEqual(JSON.parse('{"__proto__":1}'),{}),false);
});
