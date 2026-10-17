import {it} from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,existsSync,symlinkSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createArchiveBackup,createValidatedArchiveBackup,ArchiveBackupError,type ArchiveBackupPaths} from '../../../src/runtime/archive-delete/native-backup.ts';
async function fixture(run:(p:ArchiveBackupPaths)=>Promise<void>){const root=mkdtempSync(join(tmpdir(),'archive-backup-test-'));const p={state:join(root,'state.sqlite'),logs:join(root,'logs.sqlite'),global:join(root,'global.json'),bridge:join(root,'bridge.json'),index:join(root,'index.jsonl'),rollout:join(root,'rollout.jsonl'),root:join(root,'backups')};try{for(const path of [p.state,p.logs]){const db=new DatabaseSync(path);try{db.exec("CREATE TABLE proof(v TEXT);INSERT INTO proof VALUES('saved')");}finally{db.close();}}for(const path of [p.global,p.bridge])writeFileSync(path,'{}');writeFileSync(p.index,'{"id":"t"}\n');writeFileSync(p.rollout,'transcript\n');await run(p);}finally{rmSync(root,{recursive:true,force:true});}}
it('native backup preserves all inputs, snapshots SQLite and separates transcript basename',()=>fixture(async p=>{
 const result=await createArchiveBackup(p,'thread-a',10000);assert.equal(result.files,6);assert.match(result.directory,/delete-archive-[a-f0-9]{32}-threada$/);
 assert.equal(readFileSync(join(result.directory,'transcript','rollout.jsonl'),'utf8'),'transcript\n');assert.equal(readFileSync(p.rollout,'utf8'),'transcript\n');
 const db=new DatabaseSync(join(result.directory,'state.sqlite'),{readOnly:true});try{assert.equal(db.prepare('SELECT v FROM proof').get()!.v,'saved');}finally{db.close();}
 const second=await createArchiveBackup(p,'thread-a',10000);assert.notEqual(second.directory,result.directory);assert.equal(readdirSync(p.root).length,2);
}));
it('absent optional sources still retain mandatory database and transcript',()=>fixture(async p=>{
 for(const path of [p.logs,p.global,p.bridge,p.index])rmSync(path);const result=await createArchiveBackup(p,'t',10000);assert.equal(result.files,2);assert.equal(existsSync(join(result.directory,'logs.sqlite')),false);
}));
it('case-insensitive input basename collision is refused before recovery directory creation',()=>fixture(async p=>{
 await assert.rejects(createArchiveBackup({...p,index:join(p.root,'GLOBAL.JSON')},'t',10000),/basenames collide/);assert.equal(existsSync(p.root),false);
}));
it('missing mandatory transcript preserves partial backup and source database',()=>fixture(async p=>{
 rmSync(p.rollout);let recovery:string|null=null;await assert.rejects(createArchiveBackup(p,'t',10000),(e:unknown)=>{assert.ok(e instanceof ArchiveBackupError);recovery=e.recoveryDirectory;return true;});assert.ok(recovery);assert.ok(existsSync(join(recovery,'state.sqlite')));assert.ok(existsSync(p.state));assert.equal(readdirSync(p.root).length,1);
}));
it('oversized metadata fails before copying it, retaining recoverable earlier files',()=>fixture(async p=>{
 writeFileSync(p.global,Buffer.alloc(1048577));await assert.rejects(createArchiveBackup(p,'t',10000),/bounded backup budget/);const d=join(p.root,readdirSync(p.root)[0]!);assert.ok(existsSync(join(d,'state.sqlite')));assert.equal(existsSync(join(d,'global.json')),false);
}));
it('pre-abort is exact and creates no backup files',()=>fixture(async p=>{
 const controller=new AbortController(),reason={cancel:true};controller.abort(reason);await assert.rejects(createArchiveBackup(p,'t',10000,controller.signal),e=>e===reason);assert.equal(existsSync(p.root),false);
}));
it('directory or symlink sources never become copied recovery evidence',()=>fixture(async p=>{
 rmSync(p.global);mkdirSync(p.global);await assert.rejects(createArchiveBackup(p,'t',10000),/regular file/);
 rmSync(p.global,{recursive:true});symlinkSync(p.bridge,p.global);await assert.rejects(createArchiveBackup(p,'t',10000),/regular file/);
}));
it('invalid path and timeout inputs reject before a worker can modify filesystem',()=>fixture(async p=>{
 await assert.rejects(createArchiveBackup(p,'t',0),RangeError);await assert.rejects(createArchiveBackup({...p,logs:p.state},'t',10000),/distinct/);assert.equal(existsSync(p.root),false);
}));
it('in-flight abort joins worker cleanup before permitting a fresh attempt',()=>fixture(async p=>{
 const controller=new AbortController(),reason={cancel:'during-owner'};const pending=createArchiveBackup(p,'t',10000,controller.signal);controller.abort(reason);await assert.rejects(pending,e=>e===reason);const next=await createArchiveBackup(p,'t',10000);assert.equal(next.files,6);
}));
it('concurrent attempt is rejected while the original backup retains its owner',()=>fixture(async p=>{
 const first=createArchiveBackup(p,'t',10000);await assert.rejects(createArchiveBackup(p,'other',10000),/busy/i);assert.equal((await first).files,6);assert.equal(readdirSync(p.root).length,1);
}));
it('recovery prefix takes eight ASCII alphanumeric characters after filtering like Rust',()=>fixture(async p=>{
 const result=await createArchiveBackup(p,'--한글ab-cd12XY9',10000);assert.match(result.directory,/delete-archive-[a-f0-9]{32}-abcd12XY$/);
}));

function addArchive(p:ArchiveBackupPaths,rollout=p.rollout,archived=1){const db=new DatabaseSync(p.state);try{db.exec('CREATE TABLE threads(id TEXT,rollout_path TEXT,archived INTEGER)');db.prepare('INSERT INTO threads VALUES(?,?,?)').run('t',rollout,archived);}finally{db.close();}}
it('validated backup derives rollout from archived DB and validates JSON before writing',()=>fixture(async p=>{
 addArchive(p);const result=await createValidatedArchiveBackup({...p,archivedSessions:join(p.rollout,'..')},'t',10000);assert.equal(result.rollout,p.rollout);assert.equal(result.files,6);
}));
it('validated backup refuses active thread before creating recovery directory',()=>fixture(async p=>{
 addArchive(p,p.rollout,0);await assert.rejects(createValidatedArchiveBackup({...p,archivedSessions:join(p.rollout,'..')},'t',10000),/ActiveThread/);assert.equal(existsSync(p.root),false);
}));
it('validated backup refuses outside archive and malformed JSON without partial recovery',()=>fixture(async p=>{
 addArchive(p);const separate=join(p.root,'..','separate-archive');mkdirSync(separate);await assert.rejects(createValidatedArchiveBackup({...p,archivedSessions:separate},'t',10000),/OutsideArchive/);assert.equal(existsSync(p.root),false);
 writeFileSync(p.bridge,'[]');await assert.rejects(createValidatedArchiveBackup({...p,archivedSessions:join(p.rollout,'..')},'t',10000),/JSON object/);assert.equal(existsSync(p.root),false);
}));
