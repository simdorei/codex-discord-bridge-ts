import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {digest,sameSecret,scopes as allScopes,type OAuthConfig} from './config.ts';
export class OAuthError extends Error{constructor(readonly code:string){super(code);}}
/** No transaction was admitted and its body was never called. Only this error
 * permits the worker to wait asynchronously and attempt admission again. */
export class OAuthTransactionBusy extends Error{}
function fail(code='invalid_request'):never{throw new OAuthError(code);}
const secret=()=>randomBytes(32).toString('base64url');
const text=(v:unknown):string=>typeof v==='string'?v:fail();
const scopes=(v:unknown,fallback:readonly string[]=allScopes):string[]=>{const result=v===undefined||v===''?[...fallback]:text(v).trim().split(/\s+/u);if(!result.length||result.some(s=>!allScopes.includes(s as typeof allScopes[number])))fail('invalid_scope');return result;};
interface Client{client_id:string;client_secret:string;redirect_uris:string[];scope:string;}
interface Grant{client_id:string;redirect_uri:string;code_challenge:string;scopes:string[];resource:string;state:string|undefined;expires:number;attempts:number;}
export interface Access{client_id:string;scopes:string[];subject:string;}
/** Invoked only inside the owned OAuth worker in production. Transactions are
 * short SQLite operations; network and agent waits never hold this writer. */
export class OAuthStore{
 readonly #db:DatabaseSync;readonly #pending=new Map<string,Grant>();readonly #codes=new Map<string,Grant>();
 constructor(readonly config:OAuthConfig,readonly now:()=>number=()=>Math.floor(Date.now()/1000)){
  mkdirSync(dirname(config.database),{recursive:true});this.#db=new DatabaseSync(config.database);this.#db.exec('PRAGMA busy_timeout=5000');
  this.#db.exec('CREATE TABLE IF NOT EXISTS oauth_clients(client_id TEXT PRIMARY KEY,payload TEXT NOT NULL,created_at INTEGER NOT NULL DEFAULT 0);CREATE TABLE IF NOT EXISTS oauth_tokens(token_hash TEXT PRIMARY KEY,token_kind TEXT NOT NULL,family_id TEXT NOT NULL,client_id TEXT NOT NULL,scopes_json TEXT NOT NULL,expires_at INTEGER,resource TEXT,subject TEXT);CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens(family_id);CREATE TABLE IF NOT EXISTS oauth_refresh_history(token_hash TEXT PRIMARY KEY,family_id TEXT NOT NULL,expires_at INTEGER NOT NULL,used_at INTEGER NOT NULL);CREATE INDEX IF NOT EXISTS oauth_refresh_history_family ON oauth_refresh_history(family_id);CREATE INDEX IF NOT EXISTS oauth_refresh_history_expiry ON oauth_refresh_history(expires_at);');
  if(!this.#db.prepare('PRAGMA table_info(oauth_clients)').all().some(v=>v.name==='created_at'))this.#db.exec('ALTER TABLE oauth_clients ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0');
  // Runtime lock waits belong to the asynchronous admission loop, not SQLite's
  // synchronous sleep, so unrelated access reads keep progressing on this worker.
  this.#db.exec('PRAGMA busy_timeout=0');
 }
 close(){this.#db.close();}
 #row(sql:string,...args:SQLInputValue[]){return this.#db.prepare(sql).get(...args);}
 #run(sql:string,...args:SQLInputValue[]){return this.#db.prepare(sql).run(...args);}
 #count(sql:string,...args:SQLInputValue[]){return Number(this.#row(sql,...args)?.n??0);}
 #transaction<T>(fn:()=>T):T{
  try{this.#db.exec('BEGIN IMMEDIATE');}catch(error){if(error instanceof Error&&(error as {errcode?:number}).errcode===5&&!this.#db.isTransaction)throw new OAuthTransactionBusy('OAuth transaction has not started');throw error;}
  try{const result=fn();this.#db.exec('COMMIT');return result;}finally{if(this.#db.isTransaction)this.#db.exec('ROLLBACK');}
 }
 #prune(){const now=this.now();this.#run('DELETE FROM oauth_tokens WHERE expires_at IS NOT NULL AND expires_at < ?',now);this.#run('DELETE FROM oauth_refresh_history WHERE expires_at < ?',now);}
 #client(id:unknown):Client{const row=this.#row('SELECT payload FROM oauth_clients WHERE client_id=?',text(id));if(!row)return fail('invalid_client');return JSON.parse(String(row.payload));}
 #authenticate(input:Record<string,unknown>):Client{const client=this.#client(input.client_id);if(!sameSecret(client.client_secret,text(input.client_secret)))fail('invalid_client');return client;}
 #expire(){for(const map of [this.#pending,this.#codes])for(const [key,value]of map)if(value.expires<this.now())map.delete(key);}
 #pair(client:string,allowed:string[],family:string){const access=secret(),refresh=secret(),now=this.now(),insert=this.#db.prepare('INSERT INTO oauth_tokens(token_hash,token_kind,family_id,client_id,scopes_json,expires_at,resource,subject) VALUES(?,?,?,?,?,?,?,?)');
  insert.run(digest(access),'access',family,client,JSON.stringify(allowed),now+this.config.accessSeconds,this.config.resource,'owner');insert.run(digest(refresh),'refresh',family,client,JSON.stringify(allowed),now+this.config.refreshSeconds,null,'owner');
  return{access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:this.config.accessSeconds,scope:allowed.join(' ')};
 }
 run(operation:string,input:Record<string,unknown>):unknown{
  this.#expire();
  switch(operation){
   case 'register':return this.#transaction(()=>{
    const redirects=input.redirect_uris;if(!Array.isArray(redirects)||!redirects.length)fail();for(const raw of redirects){let url:URL;try{url=new URL(text(raw));}catch{return fail();}if(!['http:','https:'].includes(url.protocol)||url.hash||url.username||url.password)fail();}
    if(input.token_endpoint_auth_method!==undefined&&input.token_endpoint_auth_method!=='client_secret_post')fail();for(const [key,allowed]of [['grant_types',['authorization_code','refresh_token']],['response_types',['code']]] as const){const v=input[key];if(v!==undefined&&(!Array.isArray(v)||!v.length||v.some(s=>!allowed.includes(s as never))))fail();}
    const allowed=scopes(input.scope);this.#prune();const required=this.#count('SELECT count(*) n FROM oauth_clients')-this.config.limits.clients+1;
    if(required>0){const inactive=this.#db.prepare('SELECT c.client_id FROM oauth_clients c WHERE NOT EXISTS (SELECT 1 FROM oauth_tokens t WHERE t.client_id=c.client_id AND (t.expires_at IS NULL OR t.expires_at>=?)) ORDER BY c.created_at,c.rowid LIMIT ?').all(this.now(),required);if(inactive.length<required)fail('temporarily_unavailable');for(const row of inactive)this.#run('DELETE FROM oauth_clients WHERE client_id=?',String(row.client_id));}
    const result={...input,client_id:secret(),client_secret:secret(),client_id_issued_at:this.now(),client_secret_expires_at:0,token_endpoint_auth_method:'client_secret_post',grant_types:['authorization_code','refresh_token'],response_types:['code'],scope:allowed.join(' ')};
    this.#run('INSERT INTO oauth_clients(client_id,payload,created_at) VALUES(?,?,?)',result.client_id,JSON.stringify(result),this.now());return result;
   });
   case 'registered_redirect':{try{return this.#client(input.client_id).redirect_uris.includes(text(input.redirect_uri));}catch{return false;}}
   case 'authorize':{
    const client=this.#client(input.client_id),redirect=text(input.redirect_uri),challenge=text(input.code_challenge),resource=text(input.resource??this.config.resource);
    if(input.response_type!=='code'||resource!==this.config.resource||input.code_challenge_method!=='S256'||!/^[A-Za-z0-9_-]{43}$/u.test(challenge)||!client.redirect_uris.includes(redirect))fail();
    const allowed=scopes(input.scope);if(allowed.some(s=>!client.scope.split(' ').includes(s)))fail('invalid_scope');if(this.#pending.size>=this.config.pending)fail('temporarily_unavailable');
    const id=secret();this.#pending.set(id,{client_id:client.client_id,redirect_uri:redirect,code_challenge:challenge,scopes:allowed,resource,state:input.state===undefined?undefined:text(input.state),expires:this.now()+300,attempts:0});return{request_id:id,approval_url:this.config.base+'/oauth/approve?request_id='+id};
   }
   case 'pending':return this.#pending.get(text(input.request_id))?.scopes??null;
   case 'approve':{
    const id=text(input.request_id),grant=this.#pending.get(id);if(!grant)fail('approval_expired');if(!sameSecret(text(input.owner_token),this.config.owner)){if(++grant.attempts>=5)this.#pending.delete(id);fail('approval_denied');}
    if(this.#codes.size>=this.config.codes||[...this.#codes.values()].filter(g=>g.client_id===grant.client_id).length>=this.config.clientCodes)fail('temporarily_unavailable');
    const code=secret();this.#codes.set(code,{...grant,expires:this.now()+300});this.#pending.delete(id);const callback=new URL(grant.redirect_uri);callback.searchParams.append('code',code);callback.searchParams.append('iss',this.config.base);if(grant.state!==undefined)callback.searchParams.append('state',grant.state);return callback.href;
   }
   case 'token':{
    const client=this.#authenticate(input);if((input.resource??this.config.resource)!==this.config.resource)fail('invalid_grant');
    if(input.grant_type==='authorization_code'){
     const code=text(input.code),grant=this.#codes.get(code),verifier=text(input.code_verifier);if(!grant||grant.client_id!==client.client_id||grant.redirect_uri!==input.redirect_uri||!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)||!sameSecret(createHash('sha256').update(verifier).digest('base64url'),grant.code_challenge))fail('invalid_grant');
     const pair=this.#transaction(()=>{this.#prune();if(this.#count('SELECT count(DISTINCT family_id) n FROM oauth_tokens')>=this.config.limits.families||this.#count('SELECT count(DISTINCT family_id) n FROM oauth_tokens WHERE client_id=?',client.client_id)>=this.config.limits.clientFamilies)fail('temporarily_unavailable');return this.#pair(client.client_id,grant.scopes,secret());});this.#codes.delete(code);return pair;
    }
    if(input.grant_type!=='refresh_token')fail('unsupported_grant_type');
    const pair=this.#transaction(()=>{
     this.#prune();const hash=digest(text(input.refresh_token)),row=this.#row("SELECT * FROM oauth_tokens WHERE token_hash=? AND token_kind='refresh'",hash);
     if(!row){const history=this.#row('SELECT family_id FROM oauth_refresh_history WHERE token_hash=?',hash);if(history)this.#run('DELETE FROM oauth_tokens WHERE family_id=?',String(history.family_id));return null;}
     if(row.client_id!==client.client_id)fail('invalid_grant');const family=String(row.family_id),previous=JSON.parse(String(row.scopes_json)) as string[],allowed=scopes(input.scope,previous);if(allowed.some(s=>!previous.includes(s)))fail('invalid_scope');
     if(this.#count('SELECT count(*) n FROM oauth_refresh_history')>=this.config.limits.history||this.#count('SELECT count(*) n FROM oauth_refresh_history WHERE family_id=?',family)>=this.config.limits.familyHistory){this.#run('DELETE FROM oauth_tokens WHERE family_id=?',family);return null;}
     const expiry=this.now()+this.config.refreshSeconds;this.#run('UPDATE oauth_refresh_history SET expires_at=? WHERE family_id=?',expiry,family);this.#run('INSERT INTO oauth_refresh_history(token_hash,family_id,expires_at,used_at) VALUES(?,?,?,?)',hash,family,expiry,this.now());this.#run('DELETE FROM oauth_tokens WHERE family_id=?',family);return this.#pair(client.client_id,allowed,family);
    });if(!pair)fail('invalid_grant');return pair;
   }
   case 'access':{const row=this.#row("SELECT * FROM oauth_tokens WHERE token_hash=? AND token_kind='access'",digest(text(input.token)));return row&&Number(row.expires_at)>this.now()&&row.resource===this.config.resource?{client_id:String(row.client_id),scopes:JSON.parse(String(row.scopes_json)),subject:String(row.subject)} satisfies Access:null;}
   case 'revoke':this.#authenticate(input);return this.#transaction(()=>{this.#prune();const hash=digest(text(input.token)),row=this.#row('SELECT family_id FROM oauth_tokens WHERE token_hash=? UNION SELECT family_id FROM oauth_refresh_history WHERE token_hash=?',hash,hash);if(row)this.#run('DELETE FROM oauth_tokens WHERE family_id=?',String(row.family_id));return null;});
   default:throw Error('Unknown OAuth operation');
  }
 }
}
