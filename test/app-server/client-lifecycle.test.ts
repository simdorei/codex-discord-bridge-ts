import assert from "node:assert/strict";
import {test} from "node:test";
import {ClientLifecycle,ClientLifecyclePoisonedError,ClientLifecycleReentryError,type ClientAdmissionPermit} from "../../src/app-server/client-lifecycle.ts";
import {AppServerClosedError} from "../../src/app-server/client-errors.ts";
test("all admitted operations must release before quiescent check runs",()=>{
  const l=new ClientLifecycle(),a=l.admit(),b=l.admit();let calls=0;assert.equal(l.sealIfQuiescent(()=>{calls++;return true;}),false);assert.equal(calls,0);a.release();assert.equal(l.snapshot().inFlight,1n);assert.equal(l.sealIfQuiescent(()=>true),false);b.release();assert.equal(l.snapshot().inFlight,0n);assert.equal(l.sealIfQuiescent(()=>true),true);assert.throws(()=>l.admit(),AppServerClosedError);
});
test("false tentative check leaves open gate while previously sealed stays sealed",()=>{
  const l=new ClientLifecycle();assert.equal(l.sealIfQuiescent(()=>false),false);assert.equal(l.withOpen(()=>"open"),"open");const p=l.admit();p.release();l.seal();let ran=false;assert.equal(l.sealIfQuiescent(()=>{ran=true;return false;}),false);assert.equal(ran,true);assert.equal(l.snapshot().sealed,true);assert.throws(()=>l.withOpen(()=>{throw new Error("must not run");}),AppServerClosedError);
});
test("synchronous callback failure poisons admission but permits still clean up",()=>{
  const l=new ClientLifecycle(),p=l.admit(),sentinel={panic:true};assert.throws(()=>l.withOpen(()=>{throw sentinel;}),e=>e===sentinel);assert.equal(l.snapshot().poisoned,true);assert.throws(()=>l.admit(),ClientLifecyclePoisonedError);p.release();p.release();assert.equal(l.snapshot().inFlight,0n);
});
test("reentrant gate mutation is refused and cannot silently seal during open work",()=>{
  const l=new ClientLifecycle();assert.throws(()=>l.withOpen(()=>l.seal()),ClientLifecycleReentryError);assert.equal(l.snapshot().poisoned,true);assert.equal(l.snapshot().sealed,false);
});
test("close intent and published close are separate first-wins facts",async()=>{
  const l=new ClientLifecycle();l.sealForClose("requested");l.sealForClose("later");assert.equal(l.sealAndResolveCloseReason("observed EOF"),"requested");let resolved=false;const wait=l.waitClosed().then(reason=>{resolved=true;return reason;});await Promise.resolve();assert.equal(resolved,false);assert.equal(l.publishClosed("canonical winner"),true);assert.equal(await wait,"canonical winner");assert.equal(l.publishClosed("loser"),false);assert.equal(await l.waitClosed(),"canonical winner");assert.equal(l.pendingCloseWaiters,0);
});
test("aborted close waiter is removed without publishing a close",async()=>{
  const l=new ClientLifecycle(),controller=new AbortController(),reason={cancelled:true};const wait=l.waitClosed(controller.signal);assert.equal(l.pendingCloseWaiters,1);controller.abort(reason);await assert.rejects(wait,e=>e===reason);assert.equal(l.pendingCloseWaiters,0);assert.equal(l.snapshot().closedReason,null);
});
test("foreign, forged and released permits are not current owned permits",()=>{
  const a=new ClientLifecycle(),b=new ClientLifecycle(),p=a.admit();a.requirePermit(p);assert.throws(()=>b.requirePermit(p),TypeError);assert.throws(()=>a.requirePermit({release(){}} as ClientAdmissionPermit),TypeError);a.seal();a.requirePermit(p);p.release();assert.throws(()=>a.requirePermit(p),TypeError);
});
test("unsupported promise callback and nonboolean quiescence cannot authorize later work",async()=>{
  const l=new ClientLifecycle();assert.throws(()=>l.withOpen(()=>Promise.reject(new Error("unsupported"))),TypeError);assert.equal(l.snapshot().poisoned,true);await Promise.resolve();
  const b=new ClientLifecycle();assert.throws(()=>b.sealIfQuiescent((()=>1) as unknown as ()=>boolean),TypeError);assert.equal(b.snapshot().poisoned,true);assert.equal(b.snapshot().sealed,false);
});
test("quiescence rejects async callbacks before launch and drains unsupported native Promise results",async()=>{
  let ran=false;const a=new ClientLifecycle();assert.throws(()=>a.sealIfQuiescent((async()=>{ran=true;throw new Error("must not launch");}) as unknown as ()=>boolean),TypeError);assert.equal(ran,false);assert.equal(a.snapshot().poisoned,true);
  const b=new ClientLifecycle();assert.throws(()=>b.sealIfQuiescent((()=>Promise.reject(new Error("unsupported"))) as unknown as ()=>boolean),TypeError);await Promise.resolve();assert.equal(b.snapshot().poisoned,true);
});
test("transferring a permit revokes the old handle without changing admission count",()=>{
  const gate=new ClientLifecycle(),old=gate.admit(),next=gate.transferPermit(old);assert.equal(gate.snapshot().inFlight,1n);assert.throws(()=>old.release(),/transferred/);assert.throws(()=>gate.requirePermit(old),TypeError);gate.requirePermit(next);next.release();assert.equal(gate.snapshot().inFlight,0n);
});
