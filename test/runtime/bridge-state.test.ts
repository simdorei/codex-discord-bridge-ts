import assert from "node:assert/strict";
import {test} from "node:test";
import {writeFileSync,readFileSync,mkdirSync,readdirSync,existsSync} from "node:fs";
import {join,dirname} from "node:path";
import {storeFixture} from "../helpers/store-fixture.ts";
import {BridgeState,BridgeStateError} from "../../src/runtime/bridge-state.ts";
import {parseSerdeValue} from "../../src/core/serde-json-parse.ts";
import {serializePrettySerdeValue} from "../../src/core/serde-json-pretty.ts";
test("lossless pretty formatting preserves scalar tokens and quotes while matching two-space JSON layout",()=>{
  assert.equal(serializePrettySerdeValue({z:[1n,{},[]],a:'quote"\\{}'}),'{\n  "a": "quote\\"\\\\{}",\n  "z": [\n    1,\n    {},\n    []\n  ]\n}');
  assert.equal(serializePrettySerdeValue({int:18446744073709551615n,float:1,negativeZero:-0}),'{\n  "float": 1.0,\n  "int": 18446744073709551615,\n  "negativeZero": -0.0\n}');
});
test("missing state is empty and mutations atomically preserve unrelated lossless JSON fields",async()=>{
  await storeFixture(async path=>{const state=new BridgeState(path);assert.equal(state.selectedThreadId(),null);assert.deepEqual(state.trackedThreadIds(),[]);assert.equal(existsSync(path),false);
    writeFileSync(path,'{"keep":18446744073709551615,"nested":[{},1.0]}');state.setSelectedThreadId("\u0085 target \u0085");
    assert.equal(state.selectedThreadId(),"target");assert.equal((parseSerdeValue(readFileSync(path,"utf8")) as {keep:bigint}).keep,18446744073709551615n);assert.ok(readFileSync(path,"utf8").endsWith("\n"));
    assert.deepEqual(readdirSync(dirname(path)),["store.sqlite"]);state.setSelectedThreadId(" \n");assert.equal(state.selectedThreadId(),null);
  });
});
test("settings trim on read but preserve supplied values and absent options on write",async()=>{
  await storeFixture(async path=>{const state=new BridgeState(path);state.rememberThreadSettings("thread"," model "," high "," fast ");state.rememberThreadSettings("thread",null," ",null);
    assert.deepEqual(state.threadSettings("thread"),{model:"model",reasoning:null,speed:"fast"});assert.match(readFileSync(path,"utf8"),/ model /);
    const bytes=readFileSync(path);state.rememberThreadSettings("thread",null,null,null);assert.deepEqual(readFileSync(path),bytes);
  });
});
test("fork preserves source settings and never overwrites any existing target value",async()=>{
  await storeFixture(async path=>{const state=new BridgeState(path);writeFileSync(path,'{"selected_thread_id":" source ","thread_settings":{"source":{"model":"m"},"existing":null}}');
    state.applyThreadFork("source","new");assert.equal(state.selectedThreadId(),"new");assert.equal(state.threadSettings("source").model,"m");assert.equal(state.threadSettings("new").model,"m");
    state.rememberThreadSettings("new","changed",null,null);assert.equal(state.threadSettings("source").model,"m");state.applyThreadFork("source","existing");
    assert.equal((parseSerdeValue(readFileSync(path,"utf8")) as {thread_settings:Record<string,unknown>}).thread_settings.existing,null);
    const bytes=readFileSync(path);state.applyThreadFork("source","source");assert.deepEqual(readFileSync(path),bytes);
  });
});
test("tracked identities use Rust UTF-8 ordering, preserve nonempty raw keys and handle __proto__ as data",async()=>{
  await storeFixture(async path=>{const state=new BridgeState(path);state.rememberThreadSettings("__proto__","safe",null,null);state.rememberThreadSettings("😀","emoji",null,null);state.rememberThreadSettings("\uE000","bmp",null,null);state.rememberThreadSettings(" ","space",null,null);state.rememberThreadSettings("","empty",null,null);
    assert.deepEqual(state.trackedThreadIds(),[" ","__proto__","\uE000","😀"]);assert.equal(state.threadSettings("__proto__").model,"safe");assert.equal(({} as {model?:unknown}).model,undefined);
  });
});
test("only one UTF-8 BOM is allowed; invalid UTF-8, nonobjects and corrupt JSON remain failures",async()=>{
  await storeFixture(async path=>{const state=new BridgeState(path);writeFileSync(path,Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from('{"selected_thread_id":"ok"}') ]));assert.equal(state.selectedThreadId(),"ok");
    for(const bytes of [Buffer.from([0x80]),Buffer.from('{bad'),Buffer.from('\uFEFF\uFEFF{}')]){writeFileSync(path,bytes);assert.throws(()=>state.selectedThreadId(),e=>e instanceof BridgeStateError&&e.kind==="Json");assert.deepEqual(readFileSync(path),bytes);}
    writeFileSync(path,"[]");assert.throws(()=>state.selectedThreadId(),e=>e instanceof BridgeStateError&&e.kind==="NotObject");
  });
});
test("invalid containers are replaced for setting mutation and failed save never removes foreign destination",async()=>{
  await storeFixture(async path=>{const state=new BridgeState(path);writeFileSync(path,'{"thread_settings":false}');state.rememberThreadSettings("x","m",null,null);assert.equal(state.threadSettings("x").model,"m");
    const destination=join(dirname(path),"directory");mkdirSync(destination);const blocked=new BridgeState(destination);assert.throws(()=>blocked.setSelectedThreadId("x"),e=>e instanceof BridgeStateError&&e.kind==="Io");assert.equal(existsSync(destination),true);
    assert.equal(readdirSync(dirname(path)).some(name=>name.startsWith(".cdr-state-")),false);
  });
});

test("rename and fsync failures retain original bytes and reclaim only the owned temporary file",async()=>{
  const fs=(await import("node:fs")).default;
  const {syncBuiltinESMExports}=await import("node:module");
  const {mock}=await import("node:test");
  for(const operation of ["renameSync","fsyncSync"] as const){await storeFixture(async path=>{
    writeFileSync(path,'{"selected_thread_id":"original"}');const before=readFileSync(path),sentinel=new Error(`injected ${operation}`);
    const stub=mock.method(fs,operation,()=>{throw sentinel;});syncBuiltinESMExports();
    try{assert.throws(()=>new BridgeState(path).setSelectedThreadId("replacement"),e=>e instanceof BridgeStateError&&e.kind==="Io"&&e.cause===sentinel);}
    finally{stub.mock.restore();syncBuiltinESMExports();}
    assert.deepEqual(readFileSync(path),before);assert.deepEqual(readdirSync(dirname(path)),["store.sqlite"]);
  });}
});
