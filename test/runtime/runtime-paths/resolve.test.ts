import assert from 'node:assert/strict';import {it} from 'node:test';
import {writeFile,readdir} from 'node:fs/promises';import {dirname,join} from 'node:path';
import {storeFixture} from '../../helpers/store-fixture.ts';
import {joinRuntimePath as push} from '../../../src/runtime/runtime-paths/path-text.ts';
import {resolveRuntimePaths as resolve,resolveRuntimeStatePaths as state,resolveRuntimeStorePaths as store,RuntimeUserHomeMissing,type RuntimePathInputs} from '../../../src/runtime/runtime-paths/resolve.ts';
import type {StateDatabaseProbe} from '../../../src/runtime/runtime-paths/state-database.ts';
const base:RuntimePathInputs={root:'/repo',userHome:'/home',localAppCandidates:[],pathCandidates:['/bin/codex']};
function probe(files:Record<string,bigint>={'/bin/codex':1n},names:readonly string[]=[]){const calls:string[]=[];return {calls,port:{async entryNames(path:string){calls.push(`read:${path}`);return names;},async isFile(path:string){calls.push(`file:${path}`);return Object.hasOwn(files,path);},async modifiedNs(path:string){return files[path]??0n;}} satisfies StateDatabaseProbe};}
it('POSIX joins preserve relative dot-dot and replace absolute children without path.resolve',()=>{
 for(const [a,b,want] of [['/a/link','../db','/a/link/../db'],['/a','/db','/db'],['a','','a/'],['','x','x'],['/a/','x','/a/x'],['C:','x','C:/x']])assert.equal(push(a!,b!,'posix'),want);
});
it('Windows drive-relative, rooted, UNC and device paths follow prefix replacement rules',()=>{
 for(const [a,b,want] of [['C:','x','C:x'],['C:\\a','..\\db','C:\\a\\..\\db'],['C:\\a','\\db','C:\\db'],['C:\\a','D:db','D:db'],['\\\\server\\share\\a','\\db','\\\\server\\share\\db'],['\\\\.\\device\\a','/db','\\\\.\\device/db'],['C:/a/','x','C:/a/x'],['C:','','C:']])assert.equal(push(a!,b!,'win32'),want);
});
it('Windows verbatim appends normalize new dot segments and retain slash as existing component text',()=>{
 assert.equal(push('\\\\?\\C:\\a','..\\b','win32'),'\\\\?\\C:\\b');assert.equal(push('\\\\?\\C:\\a','\\b','win32'),'\\\\?\\C:\\b');assert.equal(push('\\\\?\\UNC\\server\\share\\a','..\\b','win32'),'\\\\?\\UNC\\server\\share\\b');assert.equal(push('\\\\?\\C:\\a/b','child','win32'),'\\\\?\\C:\\a/b\\child');assert.equal(push('\\\\?\\C:','child','win32'),'\\\\?\\C:\\child');assert.equal(push('\\\\?\\C:\\a','D:relative','win32'),'D:relative');
});
it('runtime defaults resolve state then store and all supporting files without opening databases',async()=>{
 const p=probe();assert.deepEqual(await resolve({},base,'posix',p.port),{root:'/repo',mirrorDb:'/repo/discord_mirror.sqlite',codexHome:'/home/.codex',stateDb:'/home/.codex/state_5.sqlite',bridgeState:'/home/.codex/codex_desktop_bridge_state.json',logDb:'/home/.codex/logs_2.sqlite',globalState:'/home/.codex/.codex-global-state.json',sessionIndex:'/home/.codex/session_index.jsonl',archivedSessions:'/home/.codex/archived_sessions',maintenanceBackupRoot:'/home/.codex/maintenance_backups',attachmentDir:'/repo/.codex-discord-attachments',codexExe:'/bin/codex',codexExeSource:'Path'});assert.equal(p.calls[0],'read:/home/.codex');
});
it('all explicit path overrides and home expansion use the same configured roots',async()=>{
 const p=probe({'/home/tools/codex':1n});const r=await resolve({CODEX_HOME:'~/profile',CODEX_STATE_DB:'~/chosen.sqlite',CODEX_DISCORD_ROOT:'~/bridge',CODEX_DISCORD_MIRROR_DB:'~/mirror.sqlite',CODEX_BRIDGE_STATE:'~/bridge.json',CODEX_LOG_DB:'~/logs',CODEX_GLOBAL_STATE:'~/global',CODEX_SESSION_INDEX:'~/index',CODEX_ARCHIVED_SESSIONS_DIR:'~/archive',CODEX_MAINTENANCE_BACKUP_ROOT:'~/backups',DISCORD_ATTACHMENT_DOWNLOAD_DIR:'~/files',CODEX_EXE:' "~/tools/codex,0" '},base,'posix',p.port);assert.equal(r.codexHome,'/home/profile');assert.equal(r.stateDb,'/home/chosen.sqlite');assert.equal(r.root,'/home/bridge');assert.equal(r.mirrorDb,'/home/mirror.sqlite');assert.equal(r.bridgeState,'/home/bridge.json');assert.equal(r.logDb,'/home/logs');assert.equal(r.globalState,'/home/global');assert.equal(r.sessionIndex,'/home/index');assert.equal(r.archivedSessions,'/home/archive');assert.equal(r.maintenanceBackupRoot,'/home/backups');assert.equal(r.attachmentDir,'/home/files');assert.equal(r.codexExe,'/home/tools/codex');assert.deepEqual(p.calls,['file:/home/tools/codex']);
});
it('Rust trim accepts NEL but preserves BOM and configuration keys remain exact-case',()=>{
 assert.equal(store({CODEX_DISCORD_ROOT:'\u0085 /configured \u0085'},'/fallback',null,'posix').root,'/configured');assert.equal(store({CODEX_DISCORD_ROOT:'\ufeff/path'},'/fallback',null,'posix').root,'\ufeff/path');assert.equal(store({codex_discord_root:'/wrong'},'/fallback',null,'posix').root,'/fallback');
});
it('offline state and store resolvers share home-less override and missing-home rules',async()=>{
 const p=probe();assert.deepEqual(await state({CODEX_STATE_DB:'/only.sqlite'},null,'posix',p.port),{codexHome:'',stateDb:'/only.sqlite'});assert.deepEqual(store({},'/repo',null,'posix'),{root:'/repo',mirrorDb:'/repo/discord_mirror.sqlite'});await assert.rejects(state({},null,'posix',p.port),RuntimeUserHomeMissing);await assert.rejects(state({CODEX_HOME:'~'},null,'posix',p.port),RuntimeUserHomeMissing);assert.throws(()=>store({CODEX_DISCORD_MIRROR_DB:'~\\db'},'/repo',null,'posix'),RuntimeUserHomeMissing);assert.deepEqual(p.calls,[]);
});
it('blank quoted executable falls back while a missing explicit binary remains an error',async()=>{
 const p=probe();assert.equal((await resolve({CODEX_EXE:' "" '},base,'posix',p.port)).codexExe,'/bin/codex');await assert.rejects(resolve({CODEX_EXE:'/missing'},base,'posix',p.port),/configured CODEX_EXE/);
});
it('state selection precedes executable lookup and keeps latest metadata choice',async()=>{
 const p=probe({'/profile/state_2.sqlite':2n,'/profile/state_9.sqlite':1n,'/bin/codex':1n},['state_9.sqlite','state_2.sqlite']);const r=await resolve({CODEX_HOME:'/profile'},base,'posix',p.port);assert.equal(r.stateDb,'/profile/state_2.sqlite');assert.equal(p.calls[0],'read:/profile');
});
it('environment and candidate arrays are snapshotted before the first asynchronous probe',async()=>{
 const env:Record<string,string>={CODEX_HOME:'/original'},input={...base,pathCandidates:['/bin/codex']};const p=probe();const port={...p.port,async entryNames(path:string){env.CODEX_HOME='/changed';env.CODEX_EXE='/wrong';input.pathCandidates[0]='/wrong';return [];}};const result=await resolve(env,input,'posix',port);assert.equal(result.codexHome,'/original');assert.equal(result.codexExe,'/bin/codex');assert.equal(Object.isFrozen(result),true);
});
it('hostile environment, inherited overrides and invalid platform cannot execute accessors',async()=>{
 let hooks=0;await assert.rejects(resolve({get CODEX_HOME(){hooks++;return '/wrong';}},base,'posix',probe().port),TypeError);await assert.rejects(resolve(new Proxy({},{ownKeys(){hooks++;throw Error();}}),base,'posix',probe().port),TypeError);const env=Object.create({CODEX_EXE:'/wrong'}) as Record<string,string>;assert.equal((await resolve(env,base,'posix',probe().port)).codexExe,'/bin/codex');assert.throws(()=>store({},'/x',null,'bad' as never),TypeError);assert.equal(hooks,0);
});
it('actual native resolution selects an inert file and does not create any configured data files',()=>storeFixture(async file=>{
 const root=dirname(file),exe=join(root,'inert');await writeFile(exe,'not executable');const before=await readdir(root);const r=await resolve({CODEX_EXE:exe,CODEX_STATE_DB:join(root,'state.sqlite')},{root,userHome:root,localAppCandidates:[],pathCandidates:[]},'posix');assert.equal(r.codexExe,exe);assert.equal(r.stateDb,join(root,'state.sqlite'));assert.deepEqual(await readdir(root),before);
}));
