import {DatabaseSync} from 'node:sqlite';
import {dirname,join} from 'node:path';
import {writeFile,appendFile,unlink} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {storeFixture} from './store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {initializeMirrorCursorJournal,initializeFreshMirrorCursor} from '../../src/store/mirror-cursor-journal.ts';
import {captureMirrorCursorAnchor} from '../../src/runtime/session-mirror/continuity-observation.ts';

export interface DeferralFixture {path:string;statePath:string;db:DatabaseSync;state:DatabaseSync;files:Record<string,string>;bound:string[];body:string;}
export async function legacyDeferralFixture(run:(f:DeferralFixture)=>Promise<void>){
 await storeFixture(async path=>{
  const db=await openInitialized(path),statePath=join(dirname(path),'state.sqlite'),state=new DatabaseSync(statePath),files:Record<string,string>={};
  state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,updated_at INTEGER,rollout_path TEXT,model TEXT,reasoning_effort TEXT,tokens_used INTEGER,archived INTEGER,archived_at INTEGER)');
  initializeMirrorCursorJournal(db);const bound=['bound0','bound1','bound2','bound3'],body=JSON.stringify({type:'turn_context',payload:{turn_id:'old'}})+'\n';
  try{
   for(const [i,id] of [...bound,'drift','unbound','boundary','good','archived','orphan'].entries()){
    const file=files[id]=join(dirname(path),'deferred-'+id+'.jsonl');
    if(id!=='archived'&&id!=='orphan')await writeFile(file,body);
    if(id!=='orphan')state.prepare('INSERT INTO threads(id,rollout_path,archived) VALUES(?,?,?)').run(id,id==='archived'?file+'.relocated':file,id==='archived'?1:0);
    if(!['archived','orphan'].includes(id))db.prepare('INSERT INTO mirror_threads VALUES(?,?,?,?,?,?)').run(id,'project','fixture',1,100+i,123);
    if(bound.includes(id)||id==='drift'){
     const anchor=(await captureMirrorCursorAnchor(file,BigInt(Buffer.byteLength(body)),undefined,true)).anchor;
     initializeFreshMirrorCursor(db,id,anchor,'old',123,'legacy-baseline-'+randomUUID());
    }else db.prepare('INSERT INTO codex_session_mirror_offsets VALUES(?,?,?,?,?)').run(id,file,id==='good'?Buffer.byteLength(body):2,123,id==='good'?'old':null);
    if(bound.includes(id)||id==='unbound'){await writeFile(file+'.zst',Buffer.from('28b52ffd','hex'));await unlink(file);}
    if(id==='archived')await writeFile(file+'.relocated.zst',Buffer.from('28b52ffd','hex'));
    if(id==='drift'){await appendFile(file,'{}\n');db.prepare('UPDATE codex_session_mirror_offsets SET cursor=?,turn_context=?,updated_at=? WHERE codex_thread_id=?').run(Buffer.byteLength(body)+3,'current',124,id);}
   }
   await run({path,statePath,db,state,files,bound,body});
  }finally{if(db.isTransaction)db.exec('ROLLBACK');state.close();db.close();}
 });
}
