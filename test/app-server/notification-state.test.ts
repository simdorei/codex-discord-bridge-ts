import assert from "node:assert/strict";
import {test} from "node:test";
import {NotificationState,IdleObservationError,nextNotificationRevision,type AppNotification} from "../../src/app-server/notification-state.ts";
const notification=(method="fixture/no-effect",params:unknown={threadId:"A"}):AppNotification=>({method,params});
const terminal=(turn:string)=>notification("turn/completed",{threadId:"A",turn:{id:turn}});
test("active turns change only on matching starts and exact current completion",()=>{
  const s=new NotificationState();s.record(notification("turn/started",{threadId:" A ",turn:{id:"one"}}));s.record(notification("turn/started",{threadId:"A",turnId:"two"}));s.record(terminal("one"));assert.equal(s.activeTurnId("A"),"two");assert.equal(s.hasActiveTurns,true);s.record(terminal("two"));assert.equal(s.hasActiveTurns,false);
});
test("only ordered exact legacy observations catch up, latest revision is not an ACK",()=>{
  const s=new NotificationState(),one=terminal("one"),two=terminal("two");s.record(one);s.record(two);assert.equal(s.idleObservationsCaughtUp,false);assert.equal(s.confirmIdleObservation(one),true);assert.equal(s.idleObservationsCaughtUp,false);assert.equal(s.confirmIdleObservation(two),true);assert.equal(s.idleObservationsCaughtUp,true);assert.equal(s.witnessedIdleTerminal("A","one"),false);assert.equal(s.witnessedIdleTerminal("A","two"),true);
});
test("skipped observation remains a gap even after later ordered acknowledgements",()=>{
  const s=new NotificationState(),one=terminal("one"),two=terminal("two");s.record(one);s.record(two);assert.equal(s.confirmIdleObservation(two),false);assert.equal(s.confirmIdleObservation(one),true);assert.equal(s.confirmIdleObservation(two),true);assert.equal(s.idleObservationsCaughtUp,false);
});
test("required ledger rejects legacy catch-up until internal proven prefix transition",()=>{
  const s=new NotificationState(true),n=notification();s.record(n);assert.equal(s.confirmIdleObservation(n),true);assert.equal(s.idleObservationsCaughtUp,false);assert.equal(s.certifyObservationPrefix(2n),false);assert.equal(s.certifyObservationPrefix(1n),true);assert.equal(s.idleObservationsCaughtUp,true);s.record(n);assert.equal(s.idleObservationsCaughtUp,false);
});
test("identical occurrences keep sequence and fixed upper despite later events",()=>{
  const s=new NotificationState();s.record(notification());s.record(notification());const page=s.observationWindow(0n,2n);for(let i=0;i<100;i++)s.record(notification());const again=s.observationWindow(0n,page.upper);assert.deepEqual(again.events.map(e=>e.sequence),[1n,2n]);assert.equal(again.upper,2n);assert.equal(again.sourceUpper,102n);assert.equal(again.ownerId,"");assert.equal(again.generation,0n);
});
test("evicted prefix is visible, pages cap at 32 and old observations cannot certify it",()=>{
  const s=new NotificationState();for(let i=0;i<1004;i++)s.record(notification());const page=s.observationWindow(0n,1004n);assert.equal(s.retainedCount,1000);assert.equal(page.firstAvailable,5n);assert.equal(page.events[0]?.sequence,5n);assert.equal(page.events.length,32);assert.equal(page.scannedThrough,36n);assert.equal(s.confirmIdleObservation(notification()),false);
});
test("oversized occurrence keeps its position without consuming smaller later payload budget",()=>{
  const s=new NotificationState();s.record(notification("huge",{text:"x".repeat(2*1024*1024+1)}));s.record(notification());const page=s.observationWindow(0n);assert.equal(page.events[0]?.notification,null);assert.ok(page.events[1]?.notification);assert.equal(page.scannedThrough,2n);
});
test("thread settings are revisioned, invalidated on unload and hidden after close",()=>{
  const s=new NotificationState();s.record(notification("thread/settings/updated",{threadId:"a",threadSettings:{model:"first"}}));s.record(notification("thread/settings/updated",{threadId:"b",threadSettings:{model:"other"}}));assert.deepEqual(s.observedThreadSettings("a"),[1n,{model:"first"}]);
  s.record(notification("thread/status/changed",{threadId:"a",status:{type:"notLoaded"}}));assert.equal(s.observedThreadSettings("a"),null);s.record(notification("thread/settings/updated",{threadId:"a",threadSettings:{model:"second"}}));assert.deepEqual(s.observedThreadSettings("a"),[4n,{model:"second"}]);s.close();assert.equal(s.observedThreadSettings("a"),null);
});
test("expired settings disappear and copied input cannot rewrite observation history",()=>{
  const s=new NotificationState(),params={threadId:"a",threadSettings:{model:"first"}};s.record(notification("thread/settings/updated",params));params.threadSettings.model="changed";assert.deepEqual(s.observedThreadSettings("a"),[1n,{model:"first"}]);for(let i=0;i<1000;i++)s.record(notification());assert.equal(s.observedThreadSettings("a"),null);
});
test("invalid windows refuse and u64 increment exhaustion never wraps to a fresh sequence",()=>{
  const s=new NotificationState();assert.throws(()=>s.observationWindow(1n),IdleObservationError);assert.throws(()=>s.observationWindow(0n,1n),IdleObservationError);assert.equal(s.observationWindow(0n).scannedThrough,0n);
  const max=(1n<<64n)-1n;assert.deepEqual(nextNotificationRevision(max-1n),{revision:max,exhausted:false});assert.deepEqual(nextNotificationRevision(max),{revision:max,exhausted:true});assert.throws(()=>nextNotificationRevision(-1n),TypeError);
});
test("invalid/accessor notification cannot advance revision or invoke an application getter",()=>{
  const s=new NotificationState();let calls=0;assert.throws(()=>s.record({method:"x",get params(){calls++;return {};}}),TypeError);assert.equal(calls,0);assert.equal(s.notificationRevision,0n);assert.equal(s.retainedCount,0);
});
