import assert from "node:assert/strict";
import {test} from "node:test";
import {AppServerWriter,type OwnedAppServerInput} from "../../src/app-server/writer.ts";
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
function closer(){let closed=false;const reasons:string[]=[];return {reasons,get closed(){return closed;},async markClosed(reason:string){closed=true;reasons.push(reason);}};}
const plain={check:()=>undefined,dispose:()=>{}};
test("writer encodes one newline, checks after lock, then starts/write/flush with ownership transfer",async()=>{
  const events:string[]=[],close=closer(),token={},input:OwnedAppServerInput={async writeAll(bytes){events.push(Buffer.from(bytes).toString());},async flush(){events.push("flush");}};
  const writer=new AppServerWriter(input,close),result=await writer.write({n:9007199254740993n},{check(){events.push("check");return token;},dispose(){events.push("dispose");}},()=>{events.push("started");});
  assert.equal(result,token);assert.deepEqual(events,["check","started",'{"n":9007199254740993}\n',"flush"]);assert.deepEqual(close.reasons,[]);
});
test("writer FIFO and post-lock preflight sees state changed while waiting",async()=>{
  const entered=deferred(),release=deferred(),close=closer(),events:string[]=[];let writes=0,allow=true;
  const writer=new AppServerWriter({async writeAll(){writes++;entered.resolve();await release.promise;},async flush(){}},close);
  const first=writer.write({},plain,()=>{});await entered.promise;
  const sentinel={},second=writer.write({},{check(){events.push("check");if(!allow)throw sentinel;},dispose(){}},()=>{events.push("started");});
  const rejected=assert.rejects(second,e=>e===sentinel);assert.deepEqual(events,[]);allow=false;release.resolve();await first;await rejected;assert.equal(writes,1);assert.deepEqual(events,["check"]);assert.equal(close.closed,false);
});
test("missing input disposes admitted preflight but does not claim a started write",async()=>{
  const close=closer();let disposed=0,started=0;await assert.rejects(new AppServerWriter(null,close).write({},{check:()=>123,dispose:n=>{assert.equal(n,123);disposed++;}},()=>{started++;}),/closed/);assert.equal(disposed,1);assert.equal(started,0);assert.deepEqual(close.reasons,[]);
});
test("partial write failure closes before lease release and blocks queued writer",async()=>{
  const close=closer(),sentinel={},entered=deferred(),release=deferred();let checks=0,disposed=0,flushes=0;
  const writer=new AppServerWriter({async writeAll(){entered.resolve();await release.promise;throw sentinel;},async flush(){flushes++;}},close);
  const first=writer.write({},{check:()=>1,dispose:()=>{disposed++;}},()=>{}),a=assert.rejects(first,e=>e===sentinel);await entered.promise;
  const second=writer.write({},{check(){checks++;},dispose(){}},()=>{}),b=assert.rejects(second,/closed/);release.resolve();await Promise.all([a,b]);assert.equal(checks,0);assert.equal(flushes,0);assert.equal(disposed,1);assert.deepEqual(close.reasons,["app-server write outcome indeterminate"]);
});
test("write-start hook and flush failures each mark indeterminate",async()=>{
  for(const where of ["hook","flush"]){const close=closer(),sentinel={where};let writes=0,disposed=0;
    const writer=new AppServerWriter({async writeAll(){writes++;},async flush(){if(where==="flush")throw sentinel;}},close);
    await assert.rejects(writer.write({},{check:()=>null,dispose:()=>{disposed++;}},()=>{if(where==="hook")throw sentinel;}),e=>e===sentinel);assert.equal(disposed,1);assert.equal(writes,where==="hook"?0:1);assert.equal(close.closed,true);
  }
});
test("queued cancellation removes only its waiter and causes no indeterminate close",async()=>{
  const close=closer(),entered=deferred(),release=deferred(),abort=new AbortController();let checks=0;
  const writer=new AppServerWriter({async writeAll(){entered.resolve();await release.promise;},async flush(){}},close),first=writer.write({},plain,()=>{});await entered.promise;
  const sentinel={},second=writer.write({},{check(){checks++;},dispose(){}},()=>{},abort.signal),rejected=assert.rejects(second,e=>e===sentinel);abort.abort(sentinel);await rejected;assert.equal(checks,0);assert.equal(close.closed,false);release.resolve();await first;
});
test("active cancellation closes promptly but retains ownership until adapter joins",async()=>{
  const close=closer(),entered=deferred(),joined=deferred(),abort=new AbortController(),sentinel={cancel:true};let disposed=0,flushes=0,finished=false;
  const writer=new AppServerWriter({async writeAll(_bytes,signal){entered.resolve();await joined.promise;signal?.throwIfAborted();},async flush(){flushes++;}},close);
  const task=writer.write({},{check:()=>1,dispose:()=>{disposed++;}},()=>{},abort.signal),rejected=assert.rejects(task,e=>e===sentinel).then(()=>{finished=true;});await entered.promise;abort.abort(sentinel);await Promise.resolve();
  assert.equal(close.closed,true);assert.equal(finished,false);assert.equal(disposed,0);joined.resolve();await rejected;assert.equal(flushes,0);assert.equal(disposed,1);assert.equal(close.reasons.length,1);
});
test("serializer/preflight failure stays before started-write guard",async()=>{
  const close=closer();let checks=0;const writer=new AppServerWriter({async writeAll(){throw Error("not reached");},async flush(){}},close);
  await assert.rejects(writer.write({bad:undefined},{check(){checks++;},dispose(){}},()=>{}));assert.equal(checks,0);
  const sentinel={};await assert.rejects(writer.write({},{check(){throw sentinel;},dispose(){}},()=>{}),e=>e===sentinel);assert.equal(close.closed,false);
});
test("cleanup failures retain original write error and still dispose preflight",async()=>{
  const primary={},cleanup={},dispose={},close={closed:false,async markClosed(){this.closed=true;throw cleanup;}};
  const writer=new AppServerWriter({async writeAll(){throw primary;},async flush(){}},close);
  await assert.rejects(writer.write({},{check:()=>1,dispose(){throw dispose;}},()=>{}),error=>{
    assert.ok(error instanceof AggregateError);assert.deepEqual(error.errors,[primary,cleanup,dispose]);return true;
  });assert.equal(close.closed,true);
});
