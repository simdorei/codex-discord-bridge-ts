import assert from "node:assert/strict";
import {test} from "node:test";
import {TerminalFence,TerminalFenceSubscriptionClosedError} from "../../../src/runtime/completion/terminal-fence.ts";
test("stale queue snapshot cannot erase terminal observed since read began",()=>{
  const fence=new TerminalFence(),version=fence.retentionVersion;fence.stop(1n,"thread","turn");fence.retain(1n,[],version);assert.equal(fence.stopped(1n,"thread","turn"),true);
  fence.retain(1n,[],fence.retentionVersion);assert.equal(fence.stopped(1n,"thread","turn"),false);
});
test("stop notifies before any I/O and is scoped to generation/thread/turn",async()=>{
  const fence=new TerminalFence(),receiver=fence.subscribe();const changed=receiver.changed();fence.stop(1n,"thread","turn");assert.equal(fence.stopped(1n,"thread","turn"),true);assert.equal(await changed,1n);
  assert.equal(fence.stopped(2n,"thread","turn"),false);assert.equal(fence.stopped(1n,"thread","next"),false);receiver.dispose();assert.equal(fence.pendingSubscribers,0);
});
test("repeated stops advance version and pending notifications coalesce to latest",async()=>{
  const fence=new TerminalFence(),r=fence.subscribe(),waiting=r.changed();fence.stop(1n,"t","u");fence.stop(1n,"t","u");assert.equal(await waiting,2n);assert.equal(fence.retentionVersion,2n);r.dispose();
});
test("retain removes old generations and absent turns but keeps exact queue matches",()=>{
  const fence=new TerminalFence();fence.stop(1n,"t","u");fence.stop(2n,"t","u");fence.stop(2n,"t","v");fence.retain(2n,[{targetThreadId:"t",turnId:"u"},{targetThreadId:"t",turnId:null}],fence.retentionVersion);
  assert.equal(fence.stopped(1n,"t","u"),false);assert.equal(fence.stopped(2n,"t","u"),true);assert.equal(fence.stopped(2n,"t","v"),false);
});
test("aborted watch leaves receiver reusable and does not consume future stop",async()=>{
  const fence=new TerminalFence(),r=fence.subscribe(),controller=new AbortController(),reason={cancelled:true};const wait=r.changed(controller.signal);controller.abort(reason);await assert.rejects(wait,e=>e===reason);
  fence.stop(1n,"t","u");assert.equal(await r.changed(),1n);r.dispose();assert.equal(fence.pendingSubscribers,0);
});
test("disposing a pending receiver settles its waiter and releases registration",async()=>{
  const fence=new TerminalFence(),r=fence.subscribe();const waiting=r.changed();await assert.rejects(r.changed(),TypeError);r.dispose();await assert.rejects(waiting,TerminalFenceSubscriptionClosedError);await assert.rejects(r.changed(),TerminalFenceSubscriptionClosedError);assert.equal(fence.pendingSubscribers,0);r.dispose();
});
test("new subscription begins at current version rather than replaying old stops",async()=>{
  const fence=new TerminalFence();fence.stop(1n,"t","u");const r=fence.subscribe();let finished=false;const wait=r.changed().then(v=>{finished=true;return v;});await Promise.resolve();assert.equal(finished,false);fence.stop(1n,"t","v");assert.equal(await wait,2n);r.dispose();
});
test("retention validates all snapshot identities before pruning and never invokes getters",()=>{
  const fence=new TerminalFence();fence.stop(1n,"t","u");let reads=0;const bad={get targetThreadId(){reads++;return "t";},turnId:"u"};assert.throws(()=>fence.retain(1n,[bad],fence.retentionVersion),TypeError);assert.equal(reads,0);assert.equal(fence.stopped(1n,"t","u"),true);
});
