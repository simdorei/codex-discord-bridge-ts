import assert from 'node:assert/strict';
import {test} from 'node:test';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {NativeStopPendingReader} from '../../../src/runtime/action-executor/stop-pending-native.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {restartReadinessSnapshot,joinRestartSnapshotReader} from '../../../src/store/restart-readiness.ts';
test('periodic native Stop listing leaves reserved Control available for actual restart snapshot',()=>storeFixture(async path=>{const db=await openInitialized(path);db.close();const reader=new NativeStopPendingReader(path);const pending=reader.pending(0n);const snapshot=restartReadinessSnapshot(path);try{const [page,result]=await Promise.all([pending,snapshot]);assert.deepEqual(page,[]);assert.ok(Array.isArray(result.blockers));}finally{await Promise.allSettled([pending,snapshot]);await joinRestartSnapshotReader();}assert.equal(ownedWorkerUsage().Maintenance,0);assert.equal(ownedWorkerUsage().Control,0);}));
