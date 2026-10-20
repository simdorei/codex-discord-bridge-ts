import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function url(value:string):URL{const parsed=new URL(value);if(parsed.protocol!=='https:'||!['chatgpt.com','www.chatgpt.com'].includes(parsed.hostname)||parsed.username||parsed.password||!parsed.pathname.includes('/c/'))throw Error('Only canonical HTTPS chatgpt.com conversation URLs are allowed.');return parsed;}
const same=(left:string,right:string)=>{const a=url(left),b=url(right);return a.hostname.replace(/^www\./u,'')===b.hostname.replace(/^www\./u,'')&&a.pathname.replace(/\/+$/u,'')===b.pathname.replace(/\/+$/u,'');};
export function conversationDatabase(env:NodeJS.ProcessEnv):string{
 const home=env.USERPROFILE||env.HOME,explicit=env.SIMDOREI_PRO_CONVERSATION_DB?.trim();
 if(explicit){if(explicit==='~'||/^~[\\/]/u.test(explicit)){if(!home)throw Error('User home is unavailable');return join(home,explicit.slice(2));}return explicit;}
 const parent=env.LOCALAPPDATA||env.XDG_STATE_HOME;if(parent)return join(parent,'simdorei','ask-chatgpt-pro','conversations.sqlite3');
 if(!home)throw Error('User home is unavailable');return join(home,'.local','state','simdorei','ask-chatgpt-pro','conversations.sqlite3');
}
export function runConversation(args:readonly string[],env:NodeJS.ProcessEnv=process.env,now=Math.floor(Date.now()/1000)):unknown{
 const action=args[0],options:Record<string,string[]>={acquire:[],delete:[],status:[],set:['--url','--lease-token'],release:['--lease-token'],restart:['--failed-url'],'restore-stalled':['--failed-url'],'complete-restart':['--url']};
 if(action===undefined||!Object.hasOwn(options,action))throw Error('Unknown conversation command');
 const allowed=options[action]!,values=new Map<string,string>();for(let i=1;i<args.length;i+=2){const key=args[i]!,value=args[i+1];if((key!=='--scope'&&!allowed.includes(key))||values.has(key)||value===undefined)throw Error('Invalid conversation option');values.set(key,value);}
 const scope=values.get('--scope');if(scope===undefined||!/^codex-pro-[a-f0-9]{24}$/u.test(scope))throw Error('The conversation scope is invalid.');
 for(const name of allowed)if(!values.has(name))throw Error('Missing '+name);
 const target=values.get('--url')??values.get('--failed-url'),lease=values.get('--lease-token');if(target!==undefined)url(target);if(lease!==undefined&&lease.length<24)throw Error('The conversation creation lease is invalid.');
 const path=conversationDatabase(env);mkdirSync(dirname(path),{recursive:true});const db=new DatabaseSync(path,{timeout:10000});
 try{db.exec('BEGIN IMMEDIATE');db.exec('CREATE TABLE IF NOT EXISTS conversations(scope TEXT PRIMARY KEY,conversation_url TEXT,lease_hash TEXT,lease_expires_at INTEGER,updated_at INTEGER NOT NULL,restart_pending INTEGER NOT NULL DEFAULT 0,restart_from_url TEXT)');
  const columns=db.prepare('PRAGMA table_info(conversations)').all().map(row=>row.name);if(!columns.includes('restart_pending'))db.exec('ALTER TABLE conversations ADD COLUMN restart_pending INTEGER NOT NULL DEFAULT 0');if(!columns.includes('restart_from_url'))db.exec('ALTER TABLE conversations ADD COLUMN restart_from_url TEXT');
  const row=db.prepare('SELECT * FROM conversations WHERE scope=?').get(scope) as {conversation_url:string|null;lease_hash:string|null;lease_expires_at:number|null;restart_pending:number;restart_from_url:string|null}|undefined;
  if(row){if(![0,1].includes(row.restart_pending)||(row.restart_pending===1)!==(row.restart_from_url!==null))throw Error('Invalid conversation restart guard');if(row.conversation_url!==null)url(row.conversation_url);if(row.restart_from_url!==null)url(row.restart_from_url);}
  const current=row?.conversation_url,busy=!!row?.lease_hash&&(row.lease_expires_at??0)>=now,restart=row?.restart_pending===1,origin=row?.restart_from_url;
  const status=()=>current?{status:'found',url:current}:busy?{status:'busy'}:restart?{status:'stalled'}:{status:'missing'};
  const owns=()=>{const expected=row?.lease_hash,actual=digest(lease!);return typeof expected==='string'&&expected.length===actual.length&&timingSafeEqual(Buffer.from(expected),Buffer.from(actual));};
  const restore=()=>db.prepare('UPDATE conversations SET conversation_url=restart_from_url,lease_hash=NULL,lease_expires_at=NULL,updated_at=?,restart_pending=0,restart_from_url=NULL WHERE scope=?').run(now,scope);
  let output:unknown;
  switch(action){
   case 'status':output=status();break;
   case 'acquire':{const observed=status();if(observed.status!=='missing'){output=observed;break;}const token='lease_'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');db.prepare('INSERT INTO conversations(scope,conversation_url,lease_hash,lease_expires_at,updated_at) VALUES(?,NULL,?,?,?) ON CONFLICT(scope) DO UPDATE SET lease_hash=excluded.lease_hash,lease_expires_at=excluded.lease_expires_at,updated_at=excluded.updated_at').run(scope,digest(token),now+120,now);output={status:'acquired',lease_token:token};break;}
   case 'set':if(!owns())throw Error('The conversation creation lease is missing or was replaced.');if(restart&&origin&&same(target!,origin))throw Error('The replacement conversation must differ from the failed conversation.');db.prepare('UPDATE conversations SET conversation_url=?,lease_hash=NULL,lease_expires_at=NULL,updated_at=? WHERE scope=?').run(target!,now,scope);output={status:'saved'};break;
   case 'release':if(owns()){if(current)db.prepare('UPDATE conversations SET lease_hash=NULL,lease_expires_at=NULL WHERE scope=?').run(scope);else if(restart&&origin)restore();else db.prepare('DELETE FROM conversations WHERE scope=?').run(scope);}output={status:'released'};break;
   case 'restart':if(!row){output={status:'missing'};break;}if(restart){output=current?{status:same(current,target!)?'exhausted':'superseded',url:current}:{status:busy?'busy':'stalled'};break;}if(!current){output={status:busy?'busy':'missing'};break;}if(!same(current,target!)){output={status:'superseded',url:current};break;}{const token='lease_'+randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','');db.prepare('UPDATE conversations SET conversation_url=NULL,lease_hash=?,lease_expires_at=?,updated_at=?,restart_pending=1,restart_from_url=? WHERE scope=? AND conversation_url=?').run(digest(token),now+120,now,current,scope,current);output={status:'acquired',lease_token:token};}break;
   case 'complete-restart':if(!row)output={status:'missing'};else if(!current)output={status:'unavailable'};else if(!same(current,target!))output={status:'superseded',url:current};else if(!restart)output={status:'unchanged'};else{db.prepare('UPDATE conversations SET restart_pending=0,restart_from_url=NULL,updated_at=? WHERE scope=?').run(now,scope);output={status:'completed'};}break;
   case 'restore-stalled':if(!row)output={status:'missing'};else if(current)output={status:'superseded',url:current};else if(!restart||!origin)output={status:'missing'};else if(!same(origin,target!))output={status:'superseded',url:origin};else if(busy)output={status:'busy'};else{restore();output={status:'restored',url:origin};}break;
   case 'delete':if(restart)output=current?{status:'protected',url:current}:{status:'protected'};else{db.prepare('DELETE FROM conversations WHERE scope=?').run(scope);output={status:'deleted'};}break;
  }
  db.exec('COMMIT');return output;
 }finally{if(db.isTransaction)db.exec('ROLLBACK');db.close();}
}
