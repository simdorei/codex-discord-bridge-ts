import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {createPersistentResidentRegistration,createPersistentResidentNormalComponent} from '../../src/runtime/persistent-resident-store-role.ts';

// Regression for an exact submitted-but-never-admitted ID. The surviving data
// endpoint carries a bounded proof; no endpoint rescue manufactures completion.
// Root quarantine still records the independent receiver control failure.
let defectObserved=false;
test('exact no-admission proof joins posted receiver ID without endpoint rescue',{concurrency:false,timeout:30000},async t=>{
 const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,'cdr-receiver-pre-admission-probe-'));
 const initial=realpathSync(root),identity=lstatSync(root),path=join(root,'store.sqlite');
 (await openInitialized(path)).close();
 const component=createPersistentResidentNormalComponent(createPersistentResidentRegistration(path),'fixture-runtime');
 const originalJoin=component.join();void originalJoin.catch(()=>undefined);
 await component.ready();
 assert.equal(component.snapshot().runtimeStarted,true);
 await assert.rejects(component.runFixture('receiver-control-before-admission-probe'));
 // There is no unbounded cleanup finally, synthetic task completion, or forced
 // requester termination here. The original join observes actual physical exit.
 const pendingDiagnostic=setTimeout(()=>{
  const state=component.snapshot(),receiver=component.receiverSnapshot();
  t.diagnostic('CDR_RECEIVER_PRE_ADMISSION_PENDING_V1 '+JSON.stringify({version:1,terminal:false,childClosure:state.directChildClosure,requesterExited:state.exited,droppedId:receiver.probeDroppedId,pendingId:receiver.probePendingId,rescueIssued:receiver.probeRescueIssued,dataClosed:receiver.dataClosed,controlClosed:receiver.controlClosed,rootDebt:state.rootDebt}));
 },1000);
 try{await originalJoin;}finally{clearTimeout(pendingDiagnostic);}
 const state=component.snapshot(),receiver=component.receiverSnapshot();
 assert.equal(state.state,'quarantined');assert.equal(state.exited,true);
 assert.equal(state.registrationLive,false);assert.equal(state.rootDebt,true);
 assert.equal(state.directChildClosure,'confirmed');
 assert.equal(receiver.probeDroppedId,1);assert.equal(receiver.probePendingId,1);
 assert.equal(receiver.probeRescueIssued,false);assert.equal(receiver.probeClientUnjoinedAtExit,false);assert.equal(receiver.probeClientJoinedAtExit,true);
 assert.equal(receiver.submitted,1);assert.equal(receiver.completed,0);assert.equal(receiver.retired,0);
 assert.equal(receiver.calls,0);assert.equal(receiver.clientResultObserved,false);
 assert.equal(receiver.controlReplySent,false);assert.equal(receiver.terminalRetained,false);
 assert.equal(receiver.dataClosed,true);assert.equal(receiver.controlClosed,true);
 assert.equal(receiver.closed,false);assert.equal(receiver.releasable,false);assert.equal(receiver.quarantined,true);
 await assert.rejects(component.closeComponent());
 assert.throws(()=>createPersistentResidentRegistration(path),/debt/);
 const db=new DatabaseSync(path,{readOnly:true});
 try{assert.equal(db.prepare('SELECT count(*) AS n FROM codex_delivery_receipts').get()!.n,0);assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_server_responses').get()!.n,0);}finally{db.close();}
 assert.equal(realpathSync(root),initial);assert.equal(dirname(initial),parent);
 const current=lstatSync(root);assert.equal(current.isSymbolicLink(),false);assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);
 // The owned root deliberately remains, including unresolved logical debt.
 defectObserved=true;
 t.diagnostic('CDR_RECEIVER_PRE_ADMISSION_FIXED_V1 '+JSON.stringify({version:1,postedId:1,admitted:0,completed:0,clientJoinedAtExit:true,originalChildClosure:'confirmed',rescue:false,requesterExited:true,rootDebt:true,temporaryRoot:'retained'}));
});
test('mandatory exact-ID logical cleanup and no-replay evidence',{concurrency:false},()=>{
 assert.equal(defectObserved,true,'Original bounded counterexample evidence missing');
 // The preceding assertions require an observed logical join as well as actual
 // child, requester and endpoint closure. Abnormal root quarantine is retained.
});
