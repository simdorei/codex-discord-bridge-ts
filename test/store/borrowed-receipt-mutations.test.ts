import test from 'node:test';import assert from 'node:assert/strict';
import {openInitialized} from '../../src/store/owned-driver.ts';import {storeFixture} from '../helpers/store-fixture.ts';
import {beginDeliveryReceiptIn as begin,confirmDeliveryReceiptIn as confirm,releaseRejectedDeliveryIn as release,blockRejectedDeliveryIn as block} from '../../src/store/delivery-receipts.ts';
test('borrowed confirmation rolls back with caller transaction and never closes it',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{
  db.exec('BEGIN');assert.equal(begin(db,'key','hash').kind,'New');assert.equal(confirm(db,'key','10'),true);assert.equal(db.isTransaction,true);
  assert.equal(begin(db,'key','hash').kind,'Delivered');db.exec('ROLLBACK');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM codex_delivery_receipts').get()!.n,0);
  db.exec('BEGIN');begin(db,'key','hash');confirm(db,'key','10');db.exec('COMMIT');assert.equal(db.prepare('SELECT message_id FROM codex_delivery_receipts').get()!.message_id,'10');
 }finally{db.close()}
}));
test('confirmed identity cannot be overwritten or released and blocked outcome cannot be retried',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{
  db.exec('BEGIN');begin(db,'one','hash');confirm(db,'one','10');assert.equal(confirm(db,'one','11'),false);assert.equal(release(db,'one'),false);assert.equal(block(db,'one','blocked'),false);
  begin(db,'two','hash');assert.equal(block(db,'two','blocked'),true);assert.equal(release(db,'two'),false);assert.equal(begin(db,'two','hash').kind,'RejectedBlocked');db.exec('COMMIT');
  assert.equal(db.prepare("SELECT message_id FROM codex_delivery_receipts WHERE receipt_key='one'").get()!.message_id,'10');
 }finally{db.close()}
}));
test('explicit authoritative rejection release is consumed once by begin and rollback restores it',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{
  db.exec('BEGIN');begin(db,'key','hash');assert.equal(begin(db,'key','hash').kind,'Unknown');assert.equal(release(db,'key'),true);db.exec('COMMIT');
  db.exec('BEGIN');assert.equal(begin(db,'key','hash').kind,'New');assert.equal(begin(db,'key','hash').kind,'Unknown');db.exec('ROLLBACK');
  db.exec('BEGIN');assert.equal(begin(db,'key','hash').kind,'New');db.exec('COMMIT');
 }finally{db.close()}
}));
test('block keeps original Unicode scalar bound and original autocommit behavior',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{
  db.exec('BEGIN');begin(db,'key','hash');db.exec('COMMIT');assert.equal(block(db,'key','😀'.repeat(1001)),true);
  assert.equal(db.isTransaction,false);assert.equal(db.prepare('SELECT blocked_reason AS r FROM codex_delivery_receipts').get()!.r,'😀'.repeat(1000));
 }finally{db.close()}
}));
test('borrowed multistatement helpers require active caller transaction and preserve native errors',async()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{
  assert.throws(()=>confirm(db,'key','10'),/active transaction/);assert.throws(()=>release(db,'key'),/active transaction/);
  db.exec('BEGIN');begin(db,'key','hash');db.exec("CREATE TRIGGER reject_confirm BEFORE UPDATE ON codex_delivery_receipts BEGIN SELECT RAISE(ABORT,'original native refusal'); END");
  assert.throws(()=>confirm(db,'key','10'),/original native refusal/);assert.equal(db.isTransaction,true);db.exec('ROLLBACK');
  db.exec('BEGIN');assert.equal(begin(db,'key','hash').kind,'New');db.exec('ROLLBACK');
 }finally{db.close()}
}));
