import assert from "node:assert/strict";
import {test} from "node:test";
import {PassThrough,Readable,Writable} from "node:stream";
import {NodeAppServerInput,NodeAppServerByteSource,AppServerStreamClosedError} from "../../src/app-server/node-streams.ts";
import {FatalUtf8LineReader} from "../../src/app-server/line-reader.ts";
test("Node input waits write callback, copies bytes and shuts down its stream",async()=>{
  let release!:(error?:Error|null)=>void,captured!:Buffer;
  const stream=new Writable({write(chunk,_encoding,callback){captured=chunk;release=callback;}}),input=new NodeAppServerInput(stream),bytes=Buffer.from("original");
  let settled=false;const write=input.writeAll(bytes).then(()=>{settled=true;});bytes.fill(120);await Promise.resolve();assert.equal(settled,false);assert.equal(captured.toString(),"original");release();await write;await input.flush();await input.shutdown();assert.equal(stream.closed,true);assert.equal(stream.writableFinished,true);
});
test("active write cancellation joins both callback and actual close before rejecting caller",async()=>{
  let releaseWrite!:(error?:Error|null)=>void,releaseDestroy!:()=>void;
  const stream=new Writable({write(_chunk,_encoding,callback){releaseWrite=callback;},destroy(error,callback){releaseDestroy=()=>callback(error);}}),input=new NodeAppServerInput(stream),abort=new AbortController(),reason={cancel:true};
  let settled=false;const task=input.writeAll(Buffer.from("x"),abort.signal),rejected=assert.rejects(task,e=>e===reason).then(()=>{settled=true;});abort.abort(reason);releaseWrite(new Error("write interrupted"));await Promise.resolve();await Promise.resolve();assert.equal(settled,false);releaseDestroy();await rejected;assert.equal(stream.closed,true);
});
test("write callback errors retain identity and do not become unhandled stream errors",async()=>{
  const failure=new Error("native write failed"),stream=new Writable({write(_chunk,_encoding,callback){callback(failure);}}),input=new NodeAppServerInput(stream);
  await assert.rejects(input.writeAll(Buffer.from("x")),e=>e===failure);await input.destroyAndJoin();assert.equal(stream.closed,true);
});
test("Node byte output connects to fatal decoder and preserves split UTF-8",async()=>{
  const stream=Readable.from([Buffer.from([0xed]),Buffer.from([0x95,0x9c,10])]),source=new NodeAppServerByteSource(stream),lines=new FatalUtf8LineReader(source);
  assert.equal(await lines.nextLine(),"한");assert.equal(await lines.nextLine(),null);await source.destroyAndJoin();assert.equal(stream.closed,true);
});
test("destroying owned reader settles an in-flight read and rejects later reads",async()=>{
  const stream=new PassThrough(),source=new NodeAppServerByteSource(stream),read=source.readChunk(),rejected=assert.rejects(read);await source.destroyAndJoin();await rejected;await assert.rejects(source.readChunk(),AppServerStreamClosedError);assert.equal(stream.closed,true);
});
test("byte source preserves native failure identity and refuses text-mode streams",async()=>{
  const failure=new Error("read failed"),stream=new PassThrough(),source=new NodeAppServerByteSource(stream),read=source.readChunk(),rejected=assert.rejects(read,e=>e===failure);stream.destroy(failure);await rejected;await source.destroyAndJoin();
  const text=Readable.from(["not bytes"]),textSource=new NodeAppServerByteSource(text);await assert.rejects(textSource.readChunk(),/byte encoded/);await textSource.destroyAndJoin();
});
test("already aborted input never writes or destroys an otherwise healthy stream",async()=>{
  let writes=0;const stream=new Writable({write(_chunk,_encoding,callback){writes++;callback();}}),input=new NodeAppServerInput(stream),abort=new AbortController(),reason={};abort.abort(reason);await assert.rejects(input.writeAll(Buffer.from("x"),abort.signal),e=>e===reason);assert.equal(writes,0);assert.equal(stream.destroyed,false);await input.destroyAndJoin();
});
