import test from 'node:test';
import assert from 'node:assert/strict';
import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
import {parseSerdeValue} from '../../src/core/serde-json-parse.ts';
import {provesArchivedSteerRejection as proves, eligibleArchivedCleanupIn as eligible, type ArchivedCleanupRejection} from '../../src/store/archived-cleanup-proof.ts';
const actor=9007199254740993n;
const choice=(override={})=>({choice_id:'choice',owner_user_id:actor,channel_id:3n,target_thread_id:'thread',prompt:'p',allow_steer:false,created_at:10,expires_at:20,...override});
const record=(override={}):ArchivedCleanupRejection=>({id:'interaction:1',payload:serializeSerdeValue({busy_action:'steer',busy_choice:choice(override)}),outcome:'{"kind":"busy_control_preflight_rejected","control_dispatched":false}',actor,canonical:'busy-choice:choice',snapshot:'{}'});
test('exact expired non-dispatch is recognized at expiry without notification assertion',()=>{
 assert.equal(proves(record(),3n,'thread',20),true);assert.equal(proves(record(),3n,'thread',19.999),false);assert.equal(proves(record({choice_id:' choice '}),3n,'thread',20),false);assert.equal(proves({...record({choice_id:' choice '}),canonical:'busy-choice: choice '},3n,'thread',20),true);
});
test('choice ownership, target, mode, canonical owner and temporal bounds all remain mandatory',()=>{
 for(const mutation of [{owner_user_id:actor-1n},{channel_id:4n},{target_thread_id:'other'},{target_thread_id:null},{allow_steer:true},{created_at:21},{expires_at:21},{choice_id:'\u2003'}])assert.equal(proves(record(mutation),3n,'thread',20),false);
 for(const now of [NaN,Infinity,-Infinity])assert.equal(proves(record(),3n,'thread',now),false);
 assert.equal(proves({...record(),actor:0n},3n,'thread',20),false);assert.equal(proves({...record(),canonical:'busy-choice:other'},3n,'thread',20),false);
});
test('malformed or ambiguous dispatch evidence cannot exclude a held ingress',()=>{
 for(const outcome of ['{','null','{}','{"kind":"busy_control_preflight_rejected","control_dispatched":true}','{"kind":"other","control_dispatched":false}'])assert.equal(proves({...record(),outcome},3n,'thread',20),false);
 for(const payload of ['{','null','{}',serializeSerdeValue({busy_action:'queue',busy_choice:choice()}),serializeSerdeValue({busy_action:'steer',busy_choice:{...choice(),prompt:null}})])assert.equal(proves({...record(),payload},3n,'thread',20),false);
});
async function fixture(run:(db:DatabaseSync)=>void){await storeFixture(async path=>{const db=await openInitialized(path);try{run(db);}finally{db.close();}});}
function insert(db:DatabaseSync,event=1n,payload=record().payload,outcome=record().outcome){db.prepare("INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,channel_id,owner_user_id,payload_json,state,phase,target_thread_id,canonical_owner,outcome_json,confirmation_delivered,created_at,updated_at) VALUES(?,'interaction',?,3,?,?,'held','result_recorded','thread','busy-choice:choice',?,0,10,11)").run('interaction:'+event,event,actor,payload,outcome);}
test('candidate SQL preserves exact lossless row audit without writes or transaction control',async()=>fixture(db=>{
 insert(db);db.exec('BEGIN');const before=db.prepare('SELECT total_changes() AS n').get()?.n;const rows=eligible(db,3n,'thread',20);assert.equal(rows.length,1);assert.equal(rows[0]!.actor,actor);const snapshot=parseSerdeValue<Record<string,unknown>>(rows[0]!.snapshot);assert.equal(snapshot.owner_user_id,actor);assert.equal(snapshot.confirmation_delivered,0n);assert.equal(db.isTransaction,true);assert.equal(db.prepare('SELECT total_changes() AS n').get()?.n,before);db.exec('ROLLBACK');
}));
test('recorded owner receipt excludes candidate despite matching non-dispatch JSON',async()=>fixture(db=>{
 insert(db);db.prepare("INSERT INTO discord_ingress_owner_receipts VALUES('busy-choice:choice','queue','q','thread',3,?,'{}',1)").run(actor);assert.deepEqual(eligible(db,3n,'thread',20),[]);
}));
for(const [label,update] of [['confirmation', 'confirmation_delivered=1'],['phase',"phase='received'"],['owner',"owner_kind='queue',owner_id='q'"],['event identity',"ingress_id='different'"],['kind',"kind='message'"],['state',"state='completed'"],['channel','channel_id=4'],['target',"target_thread_id='other'"]] as const)test('candidate SQL refuses changed '+label,async()=>fixture(db=>{
 insert(db);db.exec('UPDATE discord_ingress_journal SET '+update);assert.deepEqual(eligible(db,3n,'thread',20),[]);
}));
test('malformed selected SQLite type raises rather than hiding a candidate row',async()=>fixture(db=>{
 insert(db);db.exec("UPDATE discord_ingress_journal SET owner_user_id='wrong-storage-class'");assert.throws(()=>eligible(db,3n,'thread',20));
}));
