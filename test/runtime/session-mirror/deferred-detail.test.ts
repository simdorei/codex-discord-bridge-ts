import test from 'node:test';import assert from 'node:assert/strict';import {writeFile,appendFile} from 'node:fs/promises';import {join,dirname} from 'node:path';import {existsSync} from 'node:fs';
import {storeFixture} from '../../helpers/store-fixture.ts';import {openInitialized} from '../../../src/store/owned-driver.ts';import {captureMirrorCursorAnchor} from '../../../src/runtime/session-mirror/continuity-observation.ts';import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';import {discoverMirrorStore} from '../../../src/runtime/session-mirror/store-discovery.ts';
import {pollBoundMirrorTarget} from '../../../src/runtime/session-mirror/bound-poll.ts';import {snapshotMirrorItemOptions,collectMirrorWindowOffThread,joinMirrorDecoder} from '../../../src/runtime/session-mirror/decode-reader.ts';
const options={read:{maxWindowBytes:65536,maxRecordBytes:32768,maxRecords:20,decodeTimeoutMs:5000},ownership:{maxJobs:32n,maxValueBytes:1048576n,timeoutMs:5000}},discovery={...options.ownership,maxTargets:32n,maxOutputBytes:1048576};
test('empty native tail does not read missing detail table; actual event later surfaces the missing schema before HTTP',async()=>storeFixture(async path=>{
 const file=join(dirname(path),'rollout.jsonl');await writeFile(file,'');const db=await openInitialized(path);try{db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run('thread','project','title',1n,42n,1);db.exec('DROP TABLE session_mirror_details')}finally{db.close()}
 const cursor=new NativeMirrorCursorStore(path);try{await cursor.initializeSchema();await cursor.initializeFresh('thread',(await captureMirrorCursorAnchor(file,0n)).anchor,'turn',1,'init');const jobs=(await discoverMirrorStore(path,discovery)).jobs;let calls=0;const transport={async sendValidated(){calls++;return 1n}};
 assert.deepEqual(await pollBoundMirrorTarget(path,{id:'thread',rolloutPath:file},42n,jobs,options,transport),{targets:0n,events:0n,sent:0n});assert.equal((await cursor.read('thread'))!.revision,1n);
 await appendFile(file,JSON.stringify({type:'event_msg',payload:{type:'agent_message',message:'test'}})+'\n');await assert.rejects(pollBoundMirrorTarget(path,{id:'thread',rolloutPath:file},42n,jobs,options,transport),/session_mirror_details/);assert.equal(calls,0);assert.equal((await cursor.read('thread'))!.revision,1n);
 }finally{await cursor.close()}
}));
test('deferred mode context is own-data bounded and captured before async work without invoking hooks',()=>{
 let hooks=0;assert.throws(()=>snapshotMirrorItemOptions({thread:'t',detail:{get databasePath(){hooks++;return '/x'}},currentTurn:null}),TypeError);
 assert.throws(()=>snapshotMirrorItemOptions({thread:'t',detail:new Proxy({databasePath:'/x'},{getOwnPropertyDescriptor(){hooks++;throw Error('hook')}}),currentTurn:null}),TypeError);
 const detail={databasePath:'/original'},captured=snapshotMirrorItemOptions({thread:'t',detail,currentTurn:null});detail.databasePath='/changed';assert.deepEqual(captured.detail,{databasePath:'/original'});assert.equal(Object.isFrozen(captured.detail),true);assert.equal(hooks,0);
});
test('blank and scalar records decode without opening absent detail store, object event requires it',async()=>storeFixture(async path=>{
 const options={thread:'t',detail:{databasePath:path},currentTurn:null};
 try{const v=await collectMirrorWindowOffThread(Buffer.from('\nnull\n[]\n'),0n,1000,500,10,options,5000);assert.equal(v.eventCount,0);assert.equal(v.scannedRecords,3);assert.equal(existsSync(path),false)}finally{await joinMirrorDecoder()}
 try{await assert.rejects(collectMirrorWindowOffThread(Buffer.from('{}\n'),0n,1000,500,10,options,5000),/open database/);assert.equal(existsSync(path),false)}finally{await joinMirrorDecoder()}
}));
