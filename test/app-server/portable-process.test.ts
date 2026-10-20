import assert from "node:assert/strict";
import {test} from "node:test";
import {randomUUID} from "node:crypto";
import {OwnedPortableAppServerProcess,AppServerSpawnError} from "../../src/app-server/portable-process.ts";
import {FatalUtf8LineReader} from "../../src/app-server/line-reader.ts";
function config(code:string){return {executable:process.execPath,arguments:["--input-type=module","-e",code],environment:{CDR_OWNED_PROCESS_TEST:"owned"}};}
test("owned native helper echoes UTF-8 through real stdio and exits after stdin shutdown",{timeout:10000},async t=>{
  const child=await OwnedPortableAppServerProcess.spawn(config('process.stdin.on("data",d=>process.stdout.write(d));process.stdin.on("end",()=>process.stderr.write(process.env.CDR_OWNED_PROCESS_TEST));'));t.after(()=>child.forceDispose());
  const stdout=new FatalUtf8LineReader(child.stdout),stderr=new FatalUtf8LineReader(child.stderr);await child.input.writeAll(Buffer.from("한😀\n"));await child.input.flush();assert.equal(await stdout.nextLine(),"한😀");await child.input.shutdown();await child.wait();assert.equal(child.exitConfirmed,true);assert.equal(await stdout.nextLine(),null);assert.equal(await stderr.nextLine(),"owned");assert.equal(await stderr.nextLine(),null);await child.forceDispose();assert.equal(child.stdioClosed,true);
});
test("signal acceptance is followed by exit wait and exact owned-child cleanup",{timeout:10000},async t=>{
  const child=await OwnedPortableAppServerProcess.spawn(config('process.stdout.write("ready\\n");setInterval(()=>{},1000);'));t.after(()=>child.forceDispose());
  const stdout=new FatalUtf8LineReader(child.stdout);assert.equal(await stdout.nextLine(),"ready");assert.equal(child.tryWait(),false);child.startKill();await child.wait();assert.equal(child.exitConfirmed,true);child.startKill();await child.forceDispose();assert.equal(child.stdioClosed,true);
});
test("nonzero native exit is still confirmed termination, not request success",{timeout:10000},async t=>{
  const child=await OwnedPortableAppServerProcess.spawn(config('process.exitCode=7;'));t.after(()=>child.forceDispose());await child.wait();assert.equal(child.tryWait(),true);await child.forceDispose();assert.equal(child.stdioClosed,true);
});
test("missing executable rejects spawn without claiming an owned live process",{timeout:10000},async()=>{
  await assert.rejects(OwnedPortableAppServerProcess.spawn({executable:`/tmp/cdr-nonexistent-${randomUUID()}`,arguments:[],environment:{}}),error=>error instanceof AppServerSpawnError);
});
test("canceling a wait does not kill the child; explicit cleanup still confirms exit",{timeout:10000},async t=>{
  const child=await OwnedPortableAppServerProcess.spawn(config('process.stdout.write("ready\\n");setInterval(()=>{},1000);'));t.after(()=>child.forceDispose());assert.equal(await new FatalUtf8LineReader(child.stdout).nextLine(),"ready");const abort=new AbortController(),reason={cancel:true},waiting=child.wait(abort.signal),rejected=assert.rejects(waiting,e=>e===reason);abort.abort(reason);await rejected;assert.equal(child.exitConfirmed,false);await child.forceDispose();assert.equal(child.exitConfirmed,true);
});
test("late output read after fast child exit is retained and parent exit hook is removed",{timeout:10000},async t=>{
  const before=process.listeners("exit"),child=await OwnedPortableAppServerProcess.spawn(config('process.stdout.write("retained\\n");'));t.after(()=>child.forceDispose());await child.wait();assert.equal(await new FatalUtf8LineReader(child.stdout).nextLine(),"retained");await child.forceDispose();assert.deepEqual(process.listeners("exit"),before);
});
test("later pipe cleanup timeout does not replace first owned-control error",{timeout:10000},async t=>{
  const child=await OwnedPortableAppServerProcess.spawn(config('process.stdout.write("unread\\n");'));await child.wait();
  const primary={},kill=t.mock.method(child,"startKill",()=>{throw primary;}),destroy=t.mock.method(child.stdout,"destroyAndJoin",()=>new Promise<void>(()=>{}));
  try{await assert.rejects(child.forceDispose(20),error=>error===primary);}
  finally{kill.mock.restore();destroy.mock.restore();await Promise.all([child.input.destroyAndJoin(),child.stdout.destroyAndJoin(),child.stderr.destroyAndJoin()]);}
  assert.equal(child.exitConfirmed,true);
});
