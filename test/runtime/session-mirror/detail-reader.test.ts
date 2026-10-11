import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync,readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {mirrorDetailModeIn,InvalidMirrorDetailError} from '../../../src/store/mirror-policy-read.ts';
import {StoreIntegrityError} from '../../../src/store/schema-assembly.ts';
import {observeMirrorDetailMode as read,mirrorOwnershipReaderBusy,MirrorOwnershipReadError} from '../../../src/runtime/session-mirror/ownership-reader.ts';
import {OwnedWorkerBusyError} from '../../../src/runtime/owned-worker-slot.ts';
const schema='CREATE TABLE session_mirror_details(codex_thread_id TEXT PRIMARY KEY,detail_mode)';
test('detail mode absent defaults Send; exact lowercase send/all, other targets and empty/astral IDs',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec(schema);assert.equal(mirrorDetailModeIn(db,'missing'),'Send');
 for(const [id,value,expected] of [['a','all','All'],['','send','Send'],['🌏','all','All']]){db.prepare('INSERT INTO session_mirror_details VALUES(?,?)').run(id!,value!);assert.equal(mirrorDetailModeIn(db,id!),expected)}
 for(const value of ['ALL','Send','',' all','send\0']){db.prepare('UPDATE session_mirror_details SET detail_mode=? WHERE codex_thread_id=?').run(value,'a');assert.throws(()=>mirrorDetailModeIn(db,'a'),e=>e instanceof InvalidMirrorDetailError&&e.value===value&&e.message==='invalid session mirror detail mode: '+value)}
 }finally{db.close()}
});
test('corrupt storage classes, malformed UTF8 and oversized text never default or escape large data',()=>{
 const db=new DatabaseSync(':memory:');try{db.exec(schema);db.exec("INSERT INTO session_mirror_details VALUES('t',NULL)");
 for(const value of [null,1n,1.5,new Uint8Array([97,108,108]),'x'.repeat(257)]){db.prepare("UPDATE session_mirror_details SET detail_mode=?").run(value);assert.throws(()=>mirrorDetailModeIn(db,'t'),StoreIntegrityError)}
 db.exec("UPDATE session_mirror_details SET detail_mode=CAST(X'80' AS TEXT)");assert.throws(()=>mirrorDetailModeIn(db,'t'),/encoding/);
 db.exec("UPDATE session_mirror_details SET detail_mode='all'");assert.equal(mirrorDetailModeIn(db,'t'),'All');
 }finally{db.close()}
});
test('detail read preserves caller transaction and native schema/closed errors, validation precedes SQL',()=>{
 const db=new DatabaseSync(':memory:');try{assert.throws(()=>mirrorDetailModeIn(db,'t'),/no such table/);db.exec(schema+";BEGIN;INSERT INTO session_mirror_details VALUES('t','all')");
 assert.equal(mirrorDetailModeIn(db,'t'),'All');assert.equal(db.isTransaction,true);db.exec('ROLLBACK');assert.equal(mirrorDetailModeIn(db,'t'),'Send');
 assert.throws(()=>mirrorDetailModeIn(db,'\ud800'),TypeError);assert.throws(()=>mirrorDetailModeIn(db,'x'.repeat(16385)),RangeError);
 }finally{db.close()}
 assert.throws(()=>mirrorDetailModeIn(db,'t'),e=>e instanceof Error&&Object.getOwnPropertyDescriptor(e,'code')?.value==='ERR_INVALID_STATE');
});
test('UTF16 databases decode exact detail mode and enforce byte rather than character budget',()=>{
 for(const encoding of ['UTF-16le','UTF-16be']){const db=new DatabaseSync(':memory:');try{db.exec(`PRAGMA encoding='${encoding}';`+schema+";INSERT INTO session_mirror_details VALUES('t','all')");assert.equal(mirrorDetailModeIn(db,'t'),'All');db.prepare('UPDATE session_mirror_details SET detail_mode=?').run('x'.repeat(129));assert.throws(()=>mirrorDetailModeIn(db,'t'),/byte budget/)}finally{db.close()}}
});
test('native detail lookup reads existing DB without changing bytes or initializing a missing store',async()=>storeFixture(async path=>{
 await assert.rejects(read(path,'t'),MirrorOwnershipReadError);assert.equal(existsSync(path),false);
 const db=new DatabaseSync(path);try{db.exec(schema+";INSERT INTO session_mirror_details VALUES('t','all')")}finally{db.close()}
 const before=readFileSync(path);assert.equal(await read(path,'t'),'All');assert.equal(await read(path,'absent'),'Send');assert.deepEqual(readFileSync(path),before);
 const edit=new DatabaseSync(path);try{edit.exec("UPDATE session_mirror_details SET detail_mode='bad'")}finally{edit.close()}
 await assert.rejects(read(path,'t'),e=>e instanceof MirrorOwnershipReadError&&e.message.includes('invalid session mirror detail mode: bad'));
}));
test('shared native owner rejects overlap, joins cancellation, and accepts reuse only after native exit',async()=>storeFixture(async path=>{
 const db=new DatabaseSync(path);try{db.exec(schema)}finally{db.close()}
 const controller=new AbortController(),reason=Error('cancel');const pending=read(path,'t',5000,controller.signal);assert.equal(mirrorOwnershipReaderBusy(),true);
 await assert.rejects(read(path,'t'),OwnedWorkerBusyError);controller.abort(reason);await assert.rejects(pending,e=>e===reason);assert.equal(mirrorOwnershipReaderBusy(),false);assert.equal(await read(path,'t'),'Send');
 const pre=new AbortController();pre.abort(reason);await assert.rejects(read(path,'t',5000,pre.signal),e=>e===reason);assert.equal(mirrorOwnershipReaderBusy(),false);
}));
test('locked native detail timeout is joined and invalid inputs cannot start a worker',async()=>storeFixture(async path=>{
 const db=new DatabaseSync(path);try{db.exec(schema+';BEGIN EXCLUSIVE');await assert.rejects(read(path,'t',1));assert.equal(mirrorOwnershipReaderBusy(),false);db.exec('ROLLBACK')}finally{db.close()}
 for(const timeout of [0,10001,NaN])await assert.rejects(read(path,'t',timeout),RangeError);
 await assert.rejects(read(path+'\0','t'),RangeError);await assert.rejects(read(path,'\ud800'),TypeError);assert.equal(await read(path,'t'),'Send');
}));
