import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,join} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {link,symlink,unlink,writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {localMirrorProfile} from '../../helpers/local-mirror-profile.ts';
import {loadRuntimeConfig} from '../../../src/config/runtime.ts';
import {openInitialized} from '../../../src/store/owned-driver.ts';
import {createVerifiedLocalSessionMirrorProfile,captureLocalSessionMirrorProfile,requireLocalSessionMirrorPaths,requireLocalSessionMirrorDatabase,prepareLocalSessionMirrorSchemas} from '../../../src/runtime/discord-runtime/local-session-mirror-profile.ts';
import {runLocalRuntimeApplication,LocalRuntimeUnsupportedError} from '../../../src/runtime/discord-runtime/local-application.ts';
import {PosixRuntimeInstance,RUNTIME_LOCK_NAME} from '../../../src/runtime/runtime-instance.ts';
import {ownedWorkerUsage} from '../../../src/runtime/owned-worker-slot.ts';
import {mirrorRunnerBusy} from '../../../src/runtime/session-mirror/runner.ts';
import {NativeMirrorCursorStore} from '../../../src/runtime/session-mirror/cursor-store.ts';
import {NativeMirrorStartupIntentStore,MirrorStartupIntentWriteUnconfirmedError} from '../../../src/runtime/session-mirror/startup-intent-store.ts';

const config=()=>loadRuntimeConfig(new Map([['DISCORD_BOT_TOKEN','offline-fixture'],['DISCORD_ALLOW_ALL_CHANNELS','1']]));
test('default local mirror uses complete-prefix continuity without inventing a producer assertion',()=>{
 const profile=createVerifiedLocalSessionMirrorProfile({stateDb:'/state.sqlite',mirrorDb:'/root/discord_mirror.sqlite'});
 assert.equal(profile.producer.kind,'VerifiedRolloutPrefix');assert.equal(profile.worker.bootstrap.fullPrefix,true);assert.equal(profile.worker.bootstrap.kind,'SkipExistingHistory');assert.equal(mirrorRunnerBusy(),false);
});

test('missing policy, disabled-config mismatch and invalid bounds reject before startup effects',async()=>{
 const p=localMirrorProfile('/state.sqlite','/root/discord_mirror.sqlite');let hooks=0;
 const env=new Proxy({},{ownKeys(){hooks++;assert.fail('No environment reads');}});
 for(const bad of [{...p,producer:undefined},{...p,producer:{kind:'CallerQualifiedAppendOnly',qualification:''}},{...p,ownership:undefined},{...p,schemaTimeoutMs:0},{...p,worker:{...p.worker,bootstrap:undefined}},{...p,worker:{...p.worker,poll:{...p.worker.poll,read:{...p.worker.poll.read,maxRecords:0}}}}])await assert.rejects(runLocalRuntimeApplication(config(),env,'/unused','test',bad as never));
 await assert.rejects(runLocalRuntimeApplication({...config(),sessionMirror:false},env,'/unused','test',p),/configuration differ/);
 const before=process.listenerCount('SIGINT'),active=Object.defineProperty({...p},'producer',{get(){hooks++;return p.producer;}});
 await assert.rejects(runLocalRuntimeApplication(config(),env,'/unused','test',active),TypeError);
 assert.equal(process.listenerCount('SIGINT'),before);assert.equal(hooks,0);assert.equal(mirrorRunnerBusy(),false);
});

test('profile captures all nested worker budgets and caller assertions without claiming qualification',()=>{
 const p=localMirrorProfile('/state.sqlite','/root/discord_mirror.sqlite'),captured=captureLocalSessionMirrorProfile(p);
 Object.assign(p.producer,{qualification:'changed'});Object.assign(p.worker.bootstrap.context,{maxBytes:1});Object.assign(p.worker.poll.read,{maxRecords:0});Object.assign(p.worker,{bridgeDatabasePath:'/foreign'});
 assert.match(captured.producer.qualification,/Synthetic fixture/);assert.equal(captured.worker.bootstrap.context.maxBytes,1048576);assert.equal(captured.worker.poll.read.maxRecords,20);assert.equal(captured.worker.bridgeDatabasePath,'/root/discord_mirror.sqlite');assert.ok(Object.isFrozen(captured.worker.bootstrap.context));
});

test('actual application rejects path mismatches before singleton acquisition or store creation',async()=>storeFixture(async path=>{
 const root=dirname(path),mirrorDb=join(root,'discord_mirror.sqlite'),stateDb=join(root,'state.sqlite'),env={HOME:root,CODEX_HOME:root,CODEX_STATE_DB:stateDb,CODEX_EXE:process.execPath};
 const original=PosixRuntimeInstance.acquire;let calls=0;PosixRuntimeInstance.acquire=async()=>{calls++;assert.fail('No singleton launch');};
 try{
  await assert.rejects(runLocalRuntimeApplication(config(),env,root,'test',localMirrorProfile(stateDb,mirrorDb+'.wrong')),/configuration differs/);
  await assert.rejects(runLocalRuntimeApplication(config(),env,root,'test',localMirrorProfile(stateDb+'.wrong',mirrorDb)),/configuration differs/);
  await assert.rejects(runLocalRuntimeApplication(config(),{...env,CODEX_DISCORD_MIRROR_DB:path},root,'test',localMirrorProfile(stateDb,path)),/singleton-root/);
  assert.equal(calls,0);assert.equal(existsSync(mirrorDb),false);assert.equal(existsSync(join(root,RUNTIME_LOCK_NAME)),false);
 }finally{PosixRuntimeInstance.acquire=original;}
}));

test('root scope rejects DB and SQLite sidecar symlink or hardlink aliases without modifying the foreign file',async()=>storeFixture(async foreign=>{
 const root=dirname(foreign),mirrorDb=join(root,'discord_mirror.sqlite'),paths={root,mirrorDb,stateDb:join(root,'state.sqlite')};await writeFile(foreign,'foreign bytes');
 requireLocalSessionMirrorPaths(captureLocalSessionMirrorProfile(localMirrorProfile(paths.stateDb,mirrorDb)),paths);
 await requireLocalSessionMirrorDatabase(paths);
 for(const suffix of ['', '-wal', '-shm', '-journal'])for(const create of [symlink,link]){
  await create(foreign,mirrorDb+suffix);
  try{await assert.rejects(requireLocalSessionMirrorDatabase(paths),/not root-owned without aliases/);assert.equal(readFileSync(foreign,'utf8'),'foreign bytes');}finally{await unlink(mirrorDb+suffix);}
 }
}));

test('application schema stage prepares both extension stores without starting a worker',async()=>storeFixture(async path=>{
 const root=dirname(path),mirrorDb=join(root,'discord_mirror.sqlite'),paths={root,mirrorDb,stateDb:join(root,'state.sqlite')},p=localMirrorProfile(paths.stateDb,mirrorDb);
 (await openInitialized(mirrorDb)).close();const pending=prepareLocalSessionMirrorSchemas(p,paths);
 paths.mirrorDb=join(root,'foreign.sqlite');Object.assign(p,{schemaTimeoutMs:0});Object.assign(p.worker,{bridgeDatabasePath:paths.mirrorDb});Object.assign(p.worker.bootstrap.context,{maxBytes:0});await pending;assert.equal(existsSync(paths.mirrorDb),false);
 const cursor=new NativeMirrorCursorStore(mirrorDb),intent=new NativeMirrorStartupIntentStore(mirrorDb);
 try{assert.equal(await cursor.read('missing'),null);assert.equal(await intent.read('missing'),null);}finally{await cursor.close();await intent.close();}
 assert.equal(mirrorRunnerBusy(),false);assert.deepEqual(ownedWorkerUsage(),{Background:0,Control:0,Observation:0,Discovery:0,Maintenance:0});
}));

test('schema failure preserves partial preparation and joins native work without starting mirror polling',async()=>storeFixture(async path=>{
 const root=dirname(path),mirrorDb=join(root,'discord_mirror.sqlite'),paths={root,mirrorDb,stateDb:join(root,'state.sqlite')},p=captureLocalSessionMirrorProfile(localMirrorProfile(paths.stateDb,mirrorDb));
 const db=await openInitialized(mirrorDb);try{db.exec('CREATE TABLE cdr_ts_mirror_startup_intents_v1(wrong TEXT)');}finally{db.close();}
 await assert.rejects(prepareLocalSessionMirrorSchemas(p,paths),error=>{assert.ok(error instanceof MirrorStartupIntentWriteUnconfirmedError);assert.match(String(error.cause),/schema|incompatible/i);return true;});
 const read=new DatabaseSync(mirrorDb,{readOnly:true});try{assert.ok(read.prepare("SELECT 1 FROM sqlite_master WHERE name='cdr_ts_mirror_cursor_anchors_v1'").get());assert.equal(read.prepare('SELECT count(*) AS n FROM cdr_ts_mirror_cursor_anchors_v1').get()!.n,0);assert.deepEqual(read.prepare('PRAGMA table_info(cdr_ts_mirror_startup_intents_v1)').all().map(r=>r.name),['wrong']);}finally{read.close();}
 assert.equal(mirrorRunnerBusy(),false);assert.deepEqual(ownedWorkerUsage(),{Background:0,Control:0,Observation:0,Discovery:0,Maintenance:0});
}));
