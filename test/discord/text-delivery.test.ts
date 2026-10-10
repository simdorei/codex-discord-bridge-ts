import assert from "node:assert/strict";
import {test} from "node:test";
import {splitMessage,splitDeliveryChunks,splitExactDeliveryChunks,fitSingleMessage,DISCORD_MAX_LEN,TRUNCATION_SUFFIX} from "../../src/discord/text.ts";
import {messageNonce} from "../../src/discord/message-nonce.ts";
import {deliverText,deliverChunksIndexed,DEFAULT_DELIVERY_POLICY,DeliveryFailure} from "../../src/discord/delivery.ts";
test("frozen Rust text-contract examples preserve empty, newline and scalar boundaries",()=>{
  assert.deepEqual(splitMessage("  "),["(no output)"]);assert.deepEqual(splitMessage("  hello\n"),["hello"]);assert.equal(fitSingleMessage("  hello\n",100),"hello");
  assert.deepEqual(splitMessage("abcd\nefgh",6),["abcd","efgh"]);assert.deepEqual(splitMessage("가나다라마바사",3),["가나다","라마바","사"]);assert.deepEqual(splitMessage("😀😁😂😃",3),["😀😁😂","😃"]);
  assert.equal([...fitSingleMessage("x".repeat(100),40)].length,40);assert.ok(fitSingleMessage("x".repeat(100),40).endsWith(TRUNCATION_SUFFIX));
});
test("Rust whitespace strips NEL but preserves BOM and exact delivery retains all whitespace",()=>{
  assert.deepEqual(splitMessage("\u0085hello\u0085"),["hello"]);assert.deepEqual(splitMessage("\ufeff"),["\ufeff"]);
  const original="\u0085\n  "+"😀".repeat(4000)+"\r\n\ufeff  ";assert.equal(splitExactDeliveryChunks(original,false).join(""),original);
  const marked=splitExactDeliveryChunks(original,true);assert.equal(marked.map(x=>x.slice(x.indexOf("\n")+1)).join(""),original);
});
test("chunk marker budget is exact and never adds a marker to one chunk",()=>{
  const chunks=splitDeliveryChunks("x".repeat(2100),true);assert.equal(chunks.length,2);assert.ok(chunks[0]!.startsWith("[1/2]\n"));assert.ok(chunks[1]!.startsWith("[2/2]\n"));assert.equal(chunks[0]!.slice(6).length,1868);
  assert.ok(chunks.every(x=>[...x].length<=DISCORD_MAX_LEN));assert.deepEqual(splitDeliveryChunks("hello",true),["hello"]);assert.deepEqual(splitDeliveryChunks("hello",false),["hello"]);
  assert.deepEqual(splitDeliveryChunks("x".repeat(1868),true),["x".repeat(1868)]);assert.equal(splitDeliveryChunks("x".repeat(1869),true).length,2);
});
test("fit keeps source's suffix behavior for very short limits and rejects malformed UTF-16",()=>{
  assert.equal(fitSingleMessage("long",0),TRUNCATION_SUFFIX);assert.equal(fitSingleMessage("",0),"");assert.throws(()=>splitMessage("a",0),RangeError);
  for(const text of ["\ud800","a\udfff"]){assert.throws(()=>splitMessage(text),TypeError);assert.throws(()=>splitExactDeliveryChunks(text,true),TypeError);assert.throws(()=>fitSingleMessage(text,1),TypeError);}
});
test("optimized splitting matches a direct scalar reference over deterministic mixed inputs",()=>{
  const trim=(s:string)=>s.replace(/^\p{White_Space}+/u,"").replace(/\p{White_Space}+$/u,"");
  const reference=(s:string,limit:number):string[]=>{let chars=[...trim(s)];if(chars.length===0)return ["(no output)"];const result:string[]=[];while(chars.length>limit){const newline=chars.slice(0,limit).lastIndexOf("\n"),stop=newline>0?newline:limit;result.push(trim(chars.slice(0,stop).join("")));chars=[...chars.slice(stop).join("").replace(/^\p{White_Space}+/u,"")];}if(chars.length)result.push(chars.join(""));return result;};
  const units=["a","가","😀","\n"," ","\u0085","\ufeff","\r","́"];let seed=123;
  for(let i=0;i<100;i++){let text="";for(let j=0;j<i;j++){seed=(seed*1664525+1013904223)>>>0;text+=units[seed%units.length];}for(let limit=1;limit<10;limit++)assert.deepEqual(splitMessage(text,limit),reference(text,limit));}
});
test("nonce matches both frozen Rust contract goldens exactly without numeric rounding",()=>{
  assert.equal(messageNonce("session-mirror/assistant-text/v1",42n,"thread-1:abc",0),2340874901045434203n);
  assert.equal(messageNonce("completion/v1",42n,"high-bit-0",0),3227115366091472613n);
});
test("nonce length-frames logical dimensions and supports full u64 identities",()=>{
  const values=[messageNonce("ab",42n,"c",0),messageNonce("a",42n,"bc",0),messageNonce("ab",43n,"c",0),messageNonce("ab",42n,"c",1),messageNonce("😀",(1n<<64n)-1n,"한글",(1n<<64n)-1n)];assert.equal(new Set(values).size,values.length);assert.ok(values.every(v=>v>=0n&&v<1n<<63n));
  assert.throws(()=>messageNonce("a",0n,"b",0),RangeError);assert.throws(()=>messageNonce("a",1n,"b",Number.MAX_SAFE_INTEGER+1),RangeError);assert.throws(()=>messageNonce("a",1n,"b",-1),RangeError);
});
test("delivery retries only the failing indexed chunk and observes default retry delays",async()=>{
  const attempts:[number,string][]=[],delays:number[]=[];let first=0;
  assert.equal(await deliverChunksIndexed(["a","b"],DEFAULT_DELIVERY_POLICY,async(i,c)=>{attempts.push([i,c]);if(i===0&&first++<2)throw new Error("retry");},async ms=>{delays.push(ms);}),2);
  assert.deepEqual(attempts,[[0,"a"],[0,"a"],[0,"a"],[1,"b"]]);assert.deepEqual(delays,[750,2000]);
});
test("permanent failure reports exact part/attempt/source and never advances later parts",async()=>{
  const cause={code:"original"},seen:number[]=[];await assert.rejects(deliverChunksIndexed(["a","b","c"],{retryDelaysMs:[0],chunkMarkers:false},async i=>{seen.push(i);if(i===1)throw cause;},async()=>{}),error=>{
    assert.ok(error instanceof DeliveryFailure);assert.equal(error.part,2);assert.equal(error.totalParts,3);assert.equal(error.attempts,2);assert.equal(error.source,cause);return true;
  });assert.deepEqual(seen,[0,1,1]);
});
test("delivery snapshots owned chunks and policy before awaiting send",async()=>{
  const chunks=["a","b"],delays=[0];const seen:string[]=[];let attempts=0;
  assert.equal(await deliverChunksIndexed(chunks,{retryDelaysMs:delays,chunkMarkers:false},async(_i,c)=>{seen.push(c);chunks[1]="changed";delays.length=0;if(attempts++===0)throw new Error("retry");},async()=>{}),2);assert.deepEqual(seen,["a","a","b"]);
});
test("delivery waits for the current send and has no detached next-chunk work",async()=>{
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;}),seen:number[]=[];
  const work=deliverChunksIndexed(["a","b"],{retryDelaysMs:[],chunkMarkers:false},async i=>{seen.push(i);if(i===0)await gate;});await Promise.resolve();assert.deepEqual(seen,[0]);release();assert.equal(await work,2);assert.deepEqual(seen,[0,1]);
});
test("empty chunk batch sends nothing, text empty becomes source fallback and invalid policies fail before send",async()=>{
  let calls=0;assert.equal(await deliverChunksIndexed([],DEFAULT_DELIVERY_POLICY,async()=>{calls++;}),0);assert.equal(calls,0);
  const values:string[]=[];assert.equal(await deliverText("  ",DEFAULT_DELIVERY_POLICY,async text=>{values.push(text);}),1);assert.deepEqual(values,["(no output)"]);
  await assert.rejects(deliverChunksIndexed(["a"],{retryDelaysMs:[2147483648],chunkMarkers:false},async()=>{calls++;}),RangeError);assert.equal(calls,0);
});
