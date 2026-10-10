import assert from "node:assert/strict";
import {test} from "node:test";
import {Readable} from "node:stream";
import {FatalUtf8LineReader,AppServerUtf8Error} from "../../src/app-server/line-reader.ts";
function reader(chunks:Uint8Array[]){let index=0;return new FatalUtf8LineReader({async readChunk(){return chunks[index++]??null;}});}
async function all(r:FatalUtf8LineReader){const lines:string[]=[];while(true){const line=await r.nextLine();if(line===null)return lines;lines.push(line);}}
test("LF and CRLF strip only their delimiter; final lone CR stays",async()=>{
  assert.deepEqual(await all(reader([Buffer.from("one\r\ntwo\n\nlast\r")])),["one","two","","last\r"]);
  assert.deepEqual(await all(reader([Buffer.from("\r\r\n")])),["\r"]);assert.deepEqual(await all(reader([])),[]);assert.deepEqual(await all(reader([Buffer.from("\n")])),[""]);
});
test("UTF-8 split at every byte boundary preserves scalar text and BOM on each line",async()=>{
  const bytes=Buffer.from("\ufeff한😀\r\n\ufeff둘\u0085\u2028끝");
  for(let cut=0;cut<=bytes.length;cut++){
    const chunks=[bytes.subarray(0,cut),bytes.subarray(cut)].filter(c=>c.length>0);
    assert.deepEqual(await all(reader(chunks)),["\ufeff한😀","\ufeff둘\u0085\u2028끝"]);
  }
  assert.deepEqual(await all(reader([...bytes].map(b=>Buffer.from([b])))),["\ufeff한😀","\ufeff둘\u0085\u2028끝"]);
});
test("invalid UTF-8 never becomes replacement text",async()=>{
  for(const bytes of [[0xff,10],[0xc0,0xaf,10],[0xed,0xa0,0x80,10],[0xf4,0x90,0x80,0x80,10],[0xe2,0x82]]){
    const r=reader([Buffer.from(bytes)]);await assert.rejects(r.nextLine(),AppServerUtf8Error);await assert.rejects(r.nextLine(),AppServerUtf8Error);
  }
});
test("valid earlier line is delivered before invalid subsequent line in the same chunk",async()=>{
  const r=reader([Buffer.from([111,107,10,255,10])]);assert.equal(await r.nextLine(),"ok");await assert.rejects(r.nextLine(),AppServerUtf8Error);
});
test("incomplete invalid bytes followed by I/O failure preserve original I/O error",async()=>{
  const sentinel={io:true};let calls=0;const r=new FatalUtf8LineReader({async readChunk(){if(calls++===0)return Buffer.from([255]);throw sentinel;}});
  await assert.rejects(r.nextLine(),e=>e===sentinel);await assert.rejects(r.nextLine(),e=>e===sentinel);assert.equal(calls,2);
});
test("borrowed caller buffer changes cannot rewrite retained next line",async()=>{
  const bytes=Buffer.from("first\nsecond\n"),r=reader([bytes]);assert.equal(await r.nextLine(),"first");bytes.fill(120);assert.equal(await r.nextLine(),"second");assert.equal(await r.nextLine(),null);
});
test("concurrent line reads are rejected without stealing the active reader",async()=>{
  let release!:(v:Uint8Array|null)=>void;const r=new FatalUtf8LineReader({readChunk:()=>new Promise(resolve=>{release=resolve;})});
  const first=r.nextLine();await assert.rejects(r.nextLine(),/Concurrent/);release(Buffer.from("ok\n"));assert.equal(await first,"ok");
});
test("empty source chunk is EOF and never consumes later source bytes",async()=>{
  const r=reader([Buffer.from("tail"),Buffer.alloc(0),Buffer.from("ignored\n")]);assert.equal(await r.nextLine(),"tail");assert.equal(await r.nextLine(),null);
});
test("long source line remains whole before downstream diagnostic retention",async()=>{
  const text="한".repeat(40000);assert.deepEqual(await all(reader([Buffer.from(text+"\n")])),[text]);
});
test("actual Node Readable byte chunks exercise the decoder without a child process",async()=>{
  const stream=Readable.from([Buffer.from([0xed]),Buffer.from([0x95,0x9c,10])]),iterator=stream[Symbol.asyncIterator]();
  const r=new FatalUtf8LineReader({async readChunk(){const next=await iterator.next();return next.done?null:next.value as Uint8Array;}});assert.deepEqual(await all(r),["한"]);assert.equal(stream.readableEnded,true);
});
