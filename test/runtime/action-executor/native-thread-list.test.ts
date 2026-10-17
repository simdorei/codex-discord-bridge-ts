import {it} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {dirname,join} from 'node:path';import {readFileSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {readThreadInventoryOffThread as inventory,resolveThreadReferenceOffThread as reference} from '../../../src/codex-state/reference-reader.ts';
import {ThreadListAction} from '../../../src/runtime/action-executor/thread-list.ts';
import {BridgeState} from '../../../src/runtime/bridge-state.ts';
import {ownedWorkerUsage,OwnedWorkerBusyError} from '../../../src/runtime/owned-worker-slot.ts';
function seed(path:string,extra=''){const db=new DatabaseSync(path);try{db.exec("CREATE TABLE threads(id TEXT,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER);INSERT INTO threads VALUES('a','A','/one',5,'/absent',NULL,NULL,0,1,2),('b','B','/two',3,'/absent',NULL,NULL,0,1,4),('live','Live','/live',10,'/absent',NULL,NULL,0,0,0);"+extra);}finally{db.close();}}
it('complete native inventories preserve archive ordering and frozen row values without modifying DB',()=>storeFixture(async path=>{
 seed(path);const before=readFileSync(path);
 assert.deepEqual((await inventory(path,true)).map(r=>r.id),['b','a']);
 const active=await inventory(path,false);assert.deepEqual(active.map(r=>r.id),['live']);assert.ok(Object.isFrozen(active)&&active.every(Object.isFrozen));assert.deepEqual(readFileSync(path),before);
}));
it('actual list refuses incomplete inventory even when display limit is one',()=>storeFixture(async path=>{
 seed(path,"WITH RECURSIVE n(x)AS(SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<4095) INSERT INTO threads SELECT 'extra-'||x,'Extra','/extra',0,'/absent',NULL,NULL,0,1,0 FROM n");
 const bridge=new BridgeState(join(dirname(path),'bridge.json')),list=new ThreadListAction(path,bridge,null,()=> 'safe');
 await assert.rejects(list.list(1n,true),/budget/);assert.equal(ownedWorkerUsage().Background,0);
 assert.equal((await reference(path,'a',null,true)).id,'a');
}));
it('inventory and reference share one native owner, cancellation joins before returning',()=>storeFixture(async path=>{
 seed(path);const first=inventory(path,true);await assert.rejects(reference(path,'a',null,true),OwnedWorkerBusyError);await first;
 const c=new AbortController(),reason=new Error('cancel inventory'),pending=inventory(path,true,c.signal);c.abort(reason);await assert.rejects(pending,e=>e===reason);assert.equal(ownedWorkerUsage().Background,0);
 assert.equal((await inventory(path,false)).length,1);
}));
