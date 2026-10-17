import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {createPersistentResidentRegistration,createPersistentResidentNormalComponent} from '../../src/runtime/persistent-resident-store-role.ts';

// Diagnostic pre-fix counterexample, not a normal workflow qualification. Run
// only in the reviewed fresh graph under the owned-process bounded supervisor.
// The fixed rescue closes only this construction's surviving data endpoint,
// after genuine child disposal. Probe-only failure teardown leaves the existing
// native close path usable until disposal, then applies final quarantine. Neither
// intervention can settle the original client read or qualify production cleanup.
let defectObserved=false;
test('pre-fix posted receiver ID is stranded until explicitly labeled endpoint rescue',{concurrency:false,timeout:20000},async t=>{
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
 assert.equal(receiver.probeRescueIssued,true);assert.equal(receiver.probeClientUnjoinedAtExit,true);
 assert.equal(receiver.submitted,0);assert.equal(receiver.completed,0);assert.equal(receiver.retired,0);
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
 t.diagnostic('CDR_RECEIVER_PRE_ADMISSION_PROBE_V1 '+JSON.stringify({version:1,postedId:1,droppedId:1,admitted:0,completed:0,clientJoinedAtExit:false,originalChildClosure:'confirmed',rescue:'construction-data-endpoint-after-child-disposal',teardown:'probe-only-lifecycle-before-final-quarantine',requesterExited:true,rootDebt:true,cleanupQualified:false,temporaryRoot:'retained'}));
});
test('mandatory pre-fix receiver logical cleanup qualification',{concurrency:false},()=>{
 assert.equal(defectObserved,true,'Original bounded counterexample evidence missing');
 assert.equal(false,true,'Endpoint rescue allowed physical exit; the original client slot and component root debt remain unresolved');
});
