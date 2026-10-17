import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,lstatSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {createPersistentResidentRegistration,createPersistentResidentNormalComponent} from '../../src/runtime/persistent-resident-store-role.ts';
import {PERSISTENT_RESIDENT_SCENARIOS,PERSISTENT_RESIDENT_NEGATIVE_SCENARIOS,capturePersistentResidentFixtureCommand} from '../../src/runtime/persistent-resident-bootstrap.ts';
import {capturePersistentResidentComponentReport} from '../../src/runtime/persistent-resident-component-report.ts';

// One fresh Node process owns this deliberately quarantined component. This file
// never deletes its root or substitutes a process exit for application cleanup.
const scenario='mutation-cancel-after-write' as const;
const nonce=process.env.CDR_MUTATION_CANCELLATION_NONCE;
if(nonce===undefined||!/^[0-9a-f]{32}$/.test(nonce))throw new TypeError('Expected parent-generated negative qualification nonce');
const report={version:1,kind:'fixture-negative-result',scenario,assertionsPassed:true,cleanupQualified:false,componentQualified:false};
let witness:Readonly<{runNonce:string;root:string;rootDebt:true;cleanupQualified:false;componentQualified:false}>|undefined;

test('fixed mutation negative report cannot claim normal or cleanup success',()=>{
 assert.equal(PERSISTENT_RESIDENT_SCENARIOS.length,12);assert.equal((PERSISTENT_RESIDENT_SCENARIOS as readonly string[]).includes(scenario),false);
 assert.deepEqual(PERSISTENT_RESIDENT_NEGATIVE_SCENARIOS,[scenario]);
 assert.deepEqual(capturePersistentResidentFixtureCommand({kind:'run-fixture',scenario}),{kind:'run-fixture',scenario});
 assert.deepEqual({...capturePersistentResidentComponentReport(report)},report);
 for(const invalid of [{...report,passed:true},{...report,cleanupQualified:true},{...report,componentQualified:true},{...report,assertionsPassed:false},{...report,scenario:'arbitrary'}])assert.throws(()=>capturePersistentResidentComponentReport(invalid),TypeError);
});

test('actual mutation cancellation preserves original intent and retained cleanup debt',{concurrency:false,timeout:20000},async t=>{
 const parent=realpathSync(tmpdir()),root=mkdtempSync(join(parent,'cdr-mutation-cancel-'));
 const initial=realpathSync(root),identity=lstatSync(root),path=join(root,'store.sqlite');
 (await openInitialized(path)).close();
 const component=createPersistentResidentNormalComponent(createPersistentResidentRegistration(path),'fixture-runtime');
 const joined=component.join();void joined.catch(()=>undefined);
 await component.ready();assert.equal(component.snapshot().runtimeStarted,true);
 const result=await component.runFixture(scenario);
 assert.deepEqual(result,{scenario,assertionsPassed:true,cleanupQualified:false,componentQualified:false});
 assert.equal(component.snapshot().state,'fixture-done');
 const read=()=>{const db=new DatabaseSync(path,{readOnly:true});try{return db.prepare('SELECT * FROM codex_mutation_attempts').all();}finally{db.close();}};
 const original=read();assert.equal(original.length,1);assert.equal(original[0]!.state,'prepared');
 assert.equal(original[0]!.runtime_id,'fixture-runtime');assert.equal(original[0]!.target_thread_id,'fixture-independent');
 const closing=component.closeComponent();
 await assert.rejects(closing,/Original resident component unconfirmed; main phase=closing; worker phase=closing; category=lifecycle; fixture step=none; root debt retained; no automatic retry/);
 await joined;assert.equal(component.join(),joined);
 assert.deepEqual(component.snapshot(),{state:'quarantined',submitted:true,exited:true,registrationLive:false,rootDebt:true,runtimeStarted:true,servicesClosed:false,mutationJoined:false,directChildClosure:'unknown'});
 await assert.rejects(component.runFixture(scenario),TypeError);
 assert.throws(()=>createPersistentResidentRegistration(path),/Original resident component root debt retained/);
 assert.deepEqual(read(),original,'No synthetic completion or second attempt during original disposal');
 assert.equal(realpathSync(root),initial);assert.equal(dirname(initial),parent);
 const current=lstatSync(root);assert.equal(current.isSymbolicLink(),false);assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);
 witness=Object.freeze({runNonce:nonce,root,rootDebt:true,cleanupQualified:false,componentQualified:false});
 t.diagnostic('CDR_MUTATION_CANCELLATION_WITNESS_V1 '+JSON.stringify({version:1,scope:'mutation-cancellation-invariants-only',...witness,assertionsPassed:true,requesterExited:true,componentJoin:'fulfilled',registrationLive:false,servicesClosed:false,mutationNormalJoined:false,directChildClosure:'unknown',temporaryRoot:'retained'}));
});

// This remains mandatory in the same exact argv, with no name filter. A valid
// negative witness cannot promote the component's retained quarantine to PASS.
test('mandatory mutation-cancellation cleanup qualification',{concurrency:false},()=>{
 assert.notEqual(witness,undefined,'Missing original negative fixture witness');
 assert.equal(witness!.cleanupQualified,true,'Original mutation cancellation cleanup remains unqualified; root debt retained');
});
