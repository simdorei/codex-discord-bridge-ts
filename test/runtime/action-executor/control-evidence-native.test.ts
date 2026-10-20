import {it} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {join,dirname} from 'node:path';import {existsSync,readFileSync,mkdirSync,symlinkSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {StateAccessFacade as state} from '../../../src/store/state-access-facade.ts';import {OwnedWorkerSlot,OwnedWorkerBusyError,ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';import {NativeControlEvidenceReader,NativeControlEvidenceUnavailable} from '../../../src/runtime/action-executor/control-evidence-native.ts';
it('native control predicate equals initialized two-key query independent of generation and resident',()=>storeFixture(async path=>{
 const db=await openInitialized(path);try{for(const [thread,turn] of [['T','V'],['',''],['스레드😀','턴']])db.prepare('INSERT INTO codex_observed_completions(thread_id,turn_id,generation,payload,resident_owner) VALUES(?,?,-9,?,?)').run(thread!,turn!,'{}','other-resident');}finally{db.close();}
 const owner=new NativeControlEvidenceReader(path);for(const [thread,turn] of [['T','V'],['T','other'],['other','V'],['',''],['스레드😀','턴']])assert.equal(await owner.observed(thread!,turn!),await state.hasObservedCompletion(path,thread!,turn!));assert.equal(await owner.observed('T','V'),true);assert.equal(ownedWorkerUsage().Control,0);
}));
it('missing file table and malformed column refuse without initialization or repair',()=>storeFixture(async root=>{
 const missing=join(dirname(root),'absent.sqlite');await assert.rejects(new NativeControlEvidenceReader(missing).observed('T','V'),NativeControlEvidenceUnavailable);assert.equal(existsSync(missing),false);
 for(const sql of ['CREATE TABLE unrelated(x)','CREATE TABLE codex_observed_completions(wrong TEXT)']){const path=join(dirname(root),sql.includes('wrong')?'wrong.sqlite':'empty.sqlite'),db=new DatabaseSync(path);try{db.exec(sql);}finally{db.close();}const before=readFileSync(path);await assert.rejects(new NativeControlEvidenceReader(path).observed('T','V'),NativeControlEvidenceUnavailable);assert.deepEqual(readFileSync(path),before);}
 assert.equal(ownedWorkerUsage().Control,0);
}));
it('preabort invalid identities and reserved Control overlap never authorize false or leak slots',()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();const a=new NativeControlEvidenceReader(path),b=new NativeControlEvidenceReader(path),c=new AbortController(),reason=new Error('cancel');c.abort(reason);await assert.rejects(a.observed('T','V',c.signal),e=>e===reason);await assert.rejects(a.observed('\uD800','V'),TypeError);await assert.rejects(a.observed('x'.repeat(16385),'V'),RangeError);assert.equal(ownedWorkerUsage().Control,0);
 const pending=a.observed('T','V');await assert.rejects(b.observed('T','V'),OwnedWorkerBusyError);assert.equal(await pending,false);assert.equal(ownedWorkerUsage().Control,0);
}));
it('actual one millisecond deadline joins native read and later fresh read remains available',()=>storeFixture(async path=>{
 const db=await openInitialized(path);db.close();const owner=new NativeControlEvidenceReader(path);await assert.rejects(owner.observed('T','V',undefined,1),NativeControlEvidenceUnavailable);assert.equal(ownedWorkerUsage().Control,0);assert.equal(await owner.observed('T','V'),false);
}));
it('response Boolean alone or wrong bound original identity cannot mint control evidence',async t=>storeFixture(async path=>{
 const owner=new NativeControlEvidenceReader(path);let mode=0;t.mock.method(OwnedWorkerSlot.prototype,'run',async(_url:URL,q:Record<string,unknown>)=>mode===0?{ok:true,value:false}:mode===1?{...q,ok:true,turn:'replacement',value:true}:{...q,ok:true,value:'false'});
 for(mode=0;mode<3;mode++)await assert.rejects(owner.observed('T','V'),NativeControlEvidenceUnavailable);assert.equal(ownedWorkerUsage().Control,0);
}));
it('native path traversal after a directory link follows host filesystem semantics',()=>storeFixture(async root=>{
 const dir=dirname(root),outside=join(dir,'real'),inside=join(outside,'child');mkdirSync(inside,{recursive:true});symlinkSync(inside,join(dir,'link'),process.platform==='win32'?'junction':'dir');const actual=join(outside,'evidence.sqlite'),lexical=join(dir,'evidence.sqlite');
 for(const [path,turn] of [[actual,'real'],[lexical,'lexical']]){const db=new DatabaseSync(path!);try{db.exec('CREATE TABLE codex_observed_completions(thread_id TEXT,turn_id TEXT)');db.prepare('INSERT INTO codex_observed_completions VALUES(?,?)').run('T',turn!);}finally{db.close();}}
 const owner=new NativeControlEvidenceReader(join(dir,'link')+'/../evidence.sqlite');assert.equal(await owner.observed('T','real'),process.platform!=='win32');assert.equal(await owner.observed('T','lexical'),process.platform==='win32');
}));
