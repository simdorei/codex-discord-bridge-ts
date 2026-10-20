import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {storeFixture} from '../helpers/store-fixture.ts';
import {seedPublication,editPublication} from '../helpers/question-publication-fixture.ts';
import {confirmAsyncQuestionOwnerExisting,bindAsyncQuestionReceiptExisting,getAsyncQuestionExisting,asyncQuestionReceiptKey} from '../../src/store/async-question-delivery-state.ts';
import {StateAccessFacade as state} from '../../src/store/state-access-facade.ts';
import {receiptHash} from '../../src/store/delivery-receipt-key.ts';
import {serializeSerdeValue as json} from '../../src/core/serde-json.ts';
async function control(path:string,id:string,message:string){await editPublication(path,db=>db.prepare('INSERT INTO codex_delivery_receipts(receipt_key,content_hash,message_id) VALUES(?,?,?)').run(asyncQuestionReceiptKey({id,channelId:1n}),receiptHash('controls'),message));}
test('existing owner confirmation never creates/migrates and retains latched IMMEDIATE rollback without decoding body',async t=>storeFixture(async path=>{
 assert.throws(()=>confirmAsyncQuestionOwnerExisting(path,'q'));assert.equal(existsSync(path),false);assert.throws(()=>bindAsyncQuestionReceiptExisting(path,'q',true));assert.equal(existsSync(path),false);
 const [q]=await seedPublication(path);assert.equal(confirmAsyncQuestionOwnerExisting(path,q!.id),true);await editPublication(path,db=>db.exec("UPDATE cdr_async_questions SET body='invalid';DELETE FROM codex_turn_queue"));
 const exec=DatabaseSync.prototype.exec,seen:string[]=[];t.mock.method(DatabaseSync.prototype,'exec',function(this:DatabaseSync,sql:string){seen.push(sql);return exec.call(this,sql);});
 assert.equal(confirmAsyncQuestionOwnerExisting(path,q!.id),true);assert.deepEqual(seen.filter(s=>/^(BEGIN|COMMIT|ROLLBACK)/.test(s)),['BEGIN IMMEDIATE','ROLLBACK']);
}));
for(const message of ['000123','m'])test(`stored control receipt ${message} retains historical text decoder parity`,async()=>storeFixture(async path=>{
 const [q]=await seedPublication(path);await control(path,q!.id,message);await state.bindAsyncQuestionReceipt(path,q!.id,true);assert.equal(getAsyncQuestionExisting(path,q!.id).messageId,message);
 await editPublication(path,db=>db.prepare("UPDATE cdr_async_questions SET message_id=NULL,state='observed' WHERE id=?").run(q!.id));bindAsyncQuestionReceiptExisting(path,q!.id,true,q!);assert.equal(getAsyncQuestionExisting(path,q!.id).messageId,message);
}));
test('only control receipt binds and source outer scope survives separate owner transaction',async t=>storeFixture(async path=>{
 const [q]=await seedPublication(path);await editPublication(path,db=>db.prepare('INSERT INTO codex_delivery_receipts(receipt_key,content_hash,message_id) VALUES(?,?,?)').run(json([1n,'async-question-body-v1',q!.id,0n]),receiptHash('body'),'body-only'));
 assert.throws(()=>bindAsyncQuestionReceiptExisting(path,q!.id,true,q!),/message receipt is not confirmed/);await control(path,q!.id,'control');
 const prepare=DatabaseSync.prototype.prepare,connections:DatabaseSync[]=[];t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){if(sql.startsWith('SELECT runtime_id')||sql==='SELECT owner_confirmed FROM cdr_async_questions WHERE id=?'||sql.startsWith('SELECT message_id,'))connections.push(this);return prepare.call(this,sql);});
 bindAsyncQuestionReceiptExisting(path,q!.id,true,q!);assert.equal(connections.length,3);assert.equal(connections[0],connections[2]);assert.notEqual(connections[0],connections[1]);assert.equal(getAsyncQuestionExisting(path,q!.id).messageId,'control');
}));
test('same-ID replacement during the separate confirmation transaction never acquires the original control receipt',async()=>storeFixture(async path=>{
 const [q]=await seedPublication(path);await control(path,q!.id,'original-control');await editPublication(path,db=>db.exec('UPDATE cdr_async_questions SET owner_confirmed=0'));
 await editPublication(path,db=>db.exec(`CREATE TRIGGER replace_during_owner AFTER UPDATE OF owner_confirmed ON cdr_async_questions BEGIN UPDATE cdr_async_questions SET runtime_id='replacement',body='{"index":0,"source_text":"shared context","title":"replacement","options":["no"]}' WHERE id=NEW.id;END`));
 assert.throws(()=>bindAsyncQuestionReceiptExisting(path,q!.id,true,q!),/occurrence changed/);const current=getAsyncQuestionExisting(path,q!.id);assert.equal(current.runtimeId,'replacement');assert.equal(current.messageId,null);assert.equal(current.state,'observed');
 await editPublication(path,db=>assert.equal(db.prepare('SELECT message_id FROM codex_delivery_receipts WHERE receipt_key=?').get(asyncQuestionReceiptKey(q!))!.message_id,'original-control'));
}));
test('single selected body capture refuses replacement immediately after the original row read',async t=>storeFixture(async path=>{
 const [q]=await seedPublication(path);await control(path,q!.id,'original-control');await editPublication(path,db=>db.exec('UPDATE cdr_async_questions SET owner_confirmed=0'));const prepare=DatabaseSync.prototype.prepare;let armed=true;
 t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){if(armed&&sql==='SELECT owner_confirmed FROM cdr_async_questions WHERE id=?'){armed=false;this.exec(`UPDATE cdr_async_questions SET body='{"index":0,"source_text":"shared context","title":"replacement","options":["no"]}' WHERE id='${q!.id}'`);}return prepare.call(this,sql);});
 assert.throws(()=>bindAsyncQuestionReceiptExisting(path,q!.id,true,q!),/occurrence changed/);assert.equal(getAsyncQuestionExisting(path,q!.id).messageId,null);
}));
test('concurrent exact already-bound state is acknowledged, differing state or message is refused',async t=>{
 for(const target of ['same','wrong-message','wrong-state'])await storeFixture(async path=>{
  const [q]=await seedPublication(path);await control(path,q!.id,'control');const prepare=DatabaseSync.prototype.prepare;let armed=true;
  const mocked=t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){if(armed&&sql.startsWith('UPDATE cdr_async_questions SET message_id=?,state=?')){armed=false;const writer=new DatabaseSync(path);try{writer.prepare('UPDATE cdr_async_questions SET state=?,message_id=? WHERE id=?').run(target==='wrong-state'?'expired':'open',target==='wrong-message'?'other':'control',q!.id);}finally{writer.close();}}return prepare.call(this,sql);});
  try{if(target==='same')bindAsyncQuestionReceiptExisting(path,q!.id,true,q!);else assert.throws(()=>bindAsyncQuestionReceiptExisting(path,q!.id,true,q!),/publication changed/);}finally{mocked.mock.restore();}
 });
});

test('expected-only error completion retains bounds and cannot update a replaced occurrence',async t=>storeFixture(async path=>{
 const {recordAsyncQuestionErrorExisting}=await import('../../src/store/async-question-dispatch.ts'),[q]=await seedPublication(path);recordAsyncQuestionErrorExisting(path,q!.id,'😀'.repeat(1001),q!);assert.equal(Array.from(getAsyncQuestionExisting(path,q!.id).error).length,1000);
 const prepare=DatabaseSync.prototype.prepare;let armed=true;t.mock.method(DatabaseSync.prototype,'prepare',function(this:DatabaseSync,sql:string){if(armed&&sql.startsWith('UPDATE cdr_async_questions SET error=?')){armed=false;const replacement=new DatabaseSync(path);try{replacement.prepare("UPDATE cdr_async_questions SET runtime_id='replacement',error='fresh' WHERE id=?").run(q!.id);}finally{replacement.close();}}return prepare.call(this,sql);});
 assert.throws(()=>recordAsyncQuestionErrorExisting(path,q!.id,'old diagnostic',q!),/occurrence changed/);assert.equal(getAsyncQuestionExisting(path,q!.id).error,'fresh');
}));
