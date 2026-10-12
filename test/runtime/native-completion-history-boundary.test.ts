import assert from 'node:assert/strict';import {test} from 'node:test';
import {storeFixture} from '../helpers/store-fixture.ts';import {openInitialized} from '../../src/store/owned-driver.ts';
import {NativeCompletionHistoryReader} from '../../src/runtime/completion/native-history-read.ts';import {turnOriginMarker} from '../../src/store/mirror-event-read.ts';
test('composite marker preserves both maximum native identities without a smaller combined request cap',async()=>storeFixture(async path=>{
 const target='x'.repeat(32768),turn='🚀'.repeat(8192),digest=turnOriginMarker(target,turn),db=await openInitialized(path),reader=new NativeCompletionHistoryReader(path);try{assert.equal(Buffer.byteLength(turn),32768);db.prepare('INSERT INTO codex_session_mirror_events(event_digest,codex_thread_id,created_at) VALUES(?,?,0)').run(digest,target);assert.equal(await reader.marker(digest,target),true);assert.equal(await reader.marker(digest,'other'),false);assert.throws(()=>reader.marker(digest,target+'x'),RangeError);assert.throws(()=>reader.marker('x'.repeat(2*32768+65),target),RangeError);assert.equal(reader.active,0);}finally{await reader.close();db.close();}
}));
