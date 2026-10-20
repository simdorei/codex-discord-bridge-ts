import {createHash,timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
export const scopes=['files:read','files:write','computer:observe','computer:control','terminal:execute','terminal:interact'] as const;
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const sameSecret=(a:string,b:string)=>timingSafeEqual(Buffer.from(digest(a),'hex'),Buffer.from(digest(b),'hex'));
export interface StoreLimits{clients:number;families:number;clientFamilies:number;history:number;familyHistory:number;}
export interface OAuthConfig{base:string;resource:string;owner:string;database:string;accessSeconds:number;refreshSeconds:number;pending:number;codes:number;clientCodes:number;limits:StoreLimits;}
export interface GatewayConfig{oauth:OAuthConfig;credentials:readonly {device:string;hash:string}[];host:string;port:number;requestTimeoutMs:number;}
export function gatewayConfig(env:NodeJS.ProcessEnv):GatewayConfig{
 const value=(key:string,fallback='')=>(env['SIMDOREI_MCP_'+key]??'').trim()||fallback;
 const integer=(key:string,fallback:number,min:number,max:number)=>{const raw=value(key,String(fallback)),n=Number(raw);if(!/^\d+$/u.test(raw)||!Number.isSafeInteger(n)||n<min||n>max)throw Error('Invalid SIMDOREI_MCP_'+key);return n;};
 const required=(key:string)=>{const v=value(key);if(!v)throw Error('SIMDOREI_MCP_'+key+' is required');return v;};
 const url=new URL(required('PUBLIC_BASE_URL')),base=url.href.replace(/\/+$/u,'');
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('OAuth public base must be an HTTP(S) origin');
 const owner=required('OWNER_TOKEN');if(Buffer.byteLength(owner)<24)throw Error('OAuth owner token must contain at least 24 bytes');
 const registry=value('DEVICE_CREDENTIALS_JSON'),legacyId=value('DEVICE_ID'),legacyToken=value('DEVICE_TOKEN');if(!!legacyId!==!!legacyToken)throw Error('Legacy device ID and token must be set together');
 let devices:unknown;
 if(registry){if(Buffer.byteLength(registry)>24576)throw Error('Device credential registry exceeds 24 KiB');let parsed;try{parsed=JSON.parse(registry);}catch{throw Error('Invalid device credential JSON');}if(parsed?.version!==1||Object.keys(parsed).some(k=>!['version','devices'].includes(k)))throw Error('Invalid device credential registry');devices=parsed.devices;}
 else devices=[{device_id:required('DEVICE_ID'),token:required('DEVICE_TOKEN')}];
 if(!Array.isArray(devices)||devices.length<1||devices.length>32)throw Error('Expected 1 to 32 device credentials');
 const credentials=devices.map(v=>{if(!v||typeof v.device_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(v.device_id)||typeof v.token!=='string'||!/^[\x21-\x7e]{32,512}$/u.test(v.token)||Object.keys(v).some(k=>!['device_id','token'].includes(k)))throw Error('Invalid device credential');return{device:v.device_id as string,hash:digest(v.token)};});
 if(new Set(credentials.map(v=>v.device)).size!==credentials.length||new Set(credentials.map(v=>v.hash)).size!==credentials.length)throw Error('Device credentials must be unique');
 if(legacyId&&!credentials.some(v=>v.device===legacyId&&sameSecret(v.hash,digest(legacyToken))))throw Error('Legacy credentials differ from registry');
 const bind=value('BIND','0.0.0.0:8030'),parts=/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/u.exec(bind),host=parts?.[1]??parts?.[2],port=Number(parts?.[3]);if(!host||!isIP(host)||!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid SIMDOREI_MCP_BIND');
 const limits={clients:integer('OAUTH_CLIENT_LIMIT',500,10,10000),families:integer('OAUTH_TOKEN_FAMILY_GLOBAL_LIMIT',256,1,100000),clientFamilies:integer('OAUTH_TOKEN_FAMILY_PER_CLIENT_LIMIT',16,1,10000),history:integer('OAUTH_REFRESH_HISTORY_GLOBAL_LIMIT',65536,1,1000000),familyHistory:integer('OAUTH_REFRESH_HISTORY_PER_FAMILY_LIMIT',1024,1,100000)};
 if(limits.clientFamilies>limits.families||limits.familyHistory>limits.history)throw Error('OAuth per-owner limit exceeds global limit');
 return{oauth:{base,resource:base+'/mcp',owner,database:value('OAUTH_DATABASE_PATH','/data/oauth.sqlite3'),accessSeconds:integer('OAUTH_ACCESS_TOKEN_SECONDS',3600,300,86400),refreshSeconds:integer('OAUTH_REFRESH_TOKEN_SECONDS',2592000,3600,31536000),pending:integer('OAUTH_PENDING_AUTHORIZATION_LIMIT',100,1,1000),codes:integer('OAUTH_AUTHORIZATION_CODE_GLOBAL_LIMIT',1024,1,100000),clientCodes:integer('OAUTH_AUTHORIZATION_CODE_PER_CLIENT_LIMIT',64,1,10000),limits},credentials,host,port,requestTimeoutMs:integer('REQUEST_TIMEOUT_SECONDS',3630,3630,7200)*1000};
}
export function authenticateDevice(config:GatewayConfig,header:string):string|null{
 if(!header.startsWith('Bearer '))return null;const candidate=Buffer.from(digest(header.slice(7)),'hex');let match:string|null=null;
 for(const item of config.credentials)if(timingSafeEqual(candidate,Buffer.from(item.hash,'hex')))match=item.device;return match;
}
