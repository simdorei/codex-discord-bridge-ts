import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {existsSync,readFileSync,linkSync,symlinkSync} from 'node:fs';import {join,dirname} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';import {prepareRuntimeStorageOffThread,RuntimeStoragePreparationError,RuntimeStoragePreparationUnconfirmed} from '../../../src/runtime/discord-runtime/storage-preparation.ts';import {ownedWorkerUsage,OwnedWorkerBusyError,OwnedWorkerSlot,OwnedWorkerBudgetError} from '../../../src/runtime/owned-worker-slot.ts';import {LATEST_STORE_SCHEMA_VERSION,schemaExtensionsCurrent} from '../../../src/store/schema-assembly.ts';
function stateFile(path:string){const db=new DatabaseSync(path);try{db.exec('CREATE TABLE original_data(value TEXT);INSERT INTO original_data VALUES (\'preserve\')');}finally{db.close();}}
test('missing Codex state fails first without creating bridge or either original path',async()=>storeFixture(async mirrorDb=>{
 const stateDb=join(dirname(mirrorDb),'missing.sqlite');await assert.rejects(prepareRuntimeStorageOffThread({stateDb,mirrorDb}),e=>e instanceof RuntimeStoragePreparationError&&e.stage==='Codex');assert.equal(existsSync(stateDb),false);assert.equal(existsSync(mirrorDb),false);assert.equal(ownedWorkerUsage().Control,0);
}));
test('fixed worker prepares normal bridge schema while preserving existing Codex bytes and not installing cursor extension',async()=>storeFixture(async mirrorDb=>{
 const stateDb=join(dirname(mirrorDb),'state.sqlite');stateFile(stateDb);const before=readFileSync(stateDb);await prepareRuntimeStorageOffThread({stateDb,mirrorDb});assert.deepEqual(readFileSync(stateDb),before);
 const db=new DatabaseSync(mirrorDb,{readOnly:true});try{assert.equal(BigInt(db.prepare('PRAGMA user_version').get()!.user_version as number),LATEST_STORE_SCHEMA_VERSION);assert.equal(schemaExtensionsCurrent(db),true);assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='cdr_ts_mirror_cursor_anchors_v1'").get(),undefined);}finally{db.close();}
 await prepareRuntimeStorageOffThread({stateDb,mirrorDb});assert.deepEqual(readFileSync(stateDb),before);
}));
test('same path, hardlink and symlink aliases cannot initialize the Codex state as a bridge',async()=>storeFixture(async mirrorDb=>{
 const stateDb=join(dirname(mirrorDb),'state.sqlite');stateFile(stateDb);const before=readFileSync(stateDb);
 await assert.rejects(prepareRuntimeStorageOffThread({stateDb,mirrorDb:stateDb}),TypeError);
 linkSync(stateDb,mirrorDb);await assert.rejects(prepareRuntimeStorageOffThread({stateDb,mirrorDb}),e=>e instanceof RuntimeStoragePreparationError&&e.stage==='Codex');
 const alias=join(dirname(mirrorDb),'alias.sqlite');symlinkSync(stateDb,alias);await assert.rejects(prepareRuntimeStorageOffThread({stateDb,mirrorDb:alias}),e=>e instanceof RuntimeStoragePreparationError&&e.stage==='Codex');assert.deepEqual(readFileSync(stateDb),before);
}));
test('unsupported bridge version is reported at bridge stage and leaves its data unchanged',async()=>storeFixture(async mirrorDb=>{
 const stateDb=join(dirname(mirrorDb),'state.sqlite');stateFile(stateDb);const db=new DatabaseSync(mirrorDb);db.exec('PRAGMA user_version=999;CREATE TABLE preserved(value);INSERT INTO preserved VALUES(12)');db.close();const before=readFileSync(mirrorDb);
 await assert.rejects(prepareRuntimeStorageOffThread({stateDb,mirrorDb}),e=>e instanceof RuntimeStoragePreparationError&&e.stage==='Bridge');assert.deepEqual(readFileSync(mirrorDb),before);
}));
test('submitted abort retains control slot until real completion and reports no rollback fiction',async()=>storeFixture(async mirrorDb=>{
 const stateDb=join(dirname(mirrorDb),'state.sqlite');stateFile(stateDb);const a=new AbortController(),reason={abort:true};const pending=prepareRuntimeStorageOffThread({stateDb,mirrorDb},10000,a.signal);a.abort(reason);
 await assert.rejects(prepareRuntimeStorageOffThread({stateDb,mirrorDb}),OwnedWorkerBusyError);
 await assert.rejects(pending,e=>e instanceof RuntimeStoragePreparationUnconfirmed&&e.cause===reason&&e.mirrorDb===mirrorDb);assert.equal(ownedWorkerUsage().Control,0);
 // The native worker completed despite caller cancellation; no automatic retry
 // or claim that the newly initialized bridge did not exist is permitted.
 assert.equal(existsSync(mirrorDb),true);const db=new DatabaseSync(mirrorDb,{readOnly:true});try{assert.equal(schemaExtensionsCurrent(db),true);}finally{db.close();}
}));
test('preabort, proxy/getter paths and invalid deadline cause no native submission',async()=>storeFixture(async mirrorDb=>{
 let hooks=0;const input=Object.defineProperty({mirrorDb},'stateDb',{get(){hooks++;return 'bad';}});await assert.rejects(prepareRuntimeStorageOffThread(input as never),TypeError);await assert.rejects(prepareRuntimeStorageOffThread(new Proxy({},{getOwnPropertyDescriptor(){hooks++;throw Error('hook');}}) as never),TypeError);
 await assert.rejects(prepareRuntimeStorageOffThread({stateDb:mirrorDb+'.state',mirrorDb},0),RangeError);const a=new AbortController();a.abort('pre');await assert.rejects(prepareRuntimeStorageOffThread(input as never,10000,a.signal),e=>e==='pre');assert.equal(hooks,0);assert.equal(existsSync(mirrorDb),false);assert.equal(ownedWorkerUsage().Control,0);
}));
test('control capacity rejection before submission is not misreported as an unknown store mutation',async()=>storeFixture(async mirrorDb=>{
 const stateDb=join(dirname(mirrorDb),'state.sqlite');stateFile(stateDb);const slot=new OwnedWorkerSlot('Control'),shared=new SharedArrayBuffer(4),view=new Int32Array(shared);
 const url=new URL('data:text/javascript,'+encodeURIComponent("import{parentPort,workerData}from'node:worker_threads';Atomics.wait(new Int32Array(workerData),0,0,10000);parentPort.postMessage('done');parentPort.close();"));
 const pending=slot.run(url,shared,10000);
 try{await assert.rejects(prepareRuntimeStorageOffThread({stateDb,mirrorDb}),OwnedWorkerBudgetError);assert.equal(existsSync(mirrorDb),false);}finally{Atomics.store(view,0,1);Atomics.notify(view,0);await pending;await slot.join();}
}));
