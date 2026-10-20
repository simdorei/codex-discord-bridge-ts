import {requireDiscordText} from '../../discord/text.ts';
import {remoteReviewRanges} from './review-context.ts';
const MASK='[REDACTED]';
import {RUST_UNICODE16_WORD as word,RUST_UNICODE16_SPACE as space} from './unicode16.ts';
const boundary=String.raw`(?:(?<=[${word}])(?![${word}])|(?<![${word}])(?=[${word}]))`;
// Only fixed ASCII pattern literals are case folded. Unicode16 simple folding adds K/kelvin and S/long-s.
const ci=(text:string)=>text.replace(/[A-Za-z]/gu,ch=>{const lo=ch.toLowerCase();return '['+lo+lo.toUpperCase()+(lo==='k'?'K':lo==='s'?'ſ':'')+']';});
const pattern=(value:string)=>new RegExp(value.replaceAll('WORD_BOUNDARY',boundary).replaceAll('WORD_CLASS',word).replaceAll('SPACE_CLASS',space),'gu');
const pem=pattern(String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`);
const awsAccess=pattern(String.raw`WORD_BOUNDARY(?:AKIA|ASIA)[0-9A-Z]{16}WORD_BOUNDARY`);
const awsSecret=pattern(String.raw`WORD_BOUNDARY((?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)[SPACE_CLASS]*[:=][SPACE_CLASS]*)([A-Za-z0-9/+=]{40})WORD_BOUNDARY`);
const gcpKey=pattern(String.raw`WORD_BOUNDARYAIza[0-9A-Za-z_-]{35}WORD_BOUNDARY`);
const gcpJson=pattern(String.raw`("(?:private_key_id|client_secret|client_email)"[SPACE_CLASS]*:[SPACE_CLASS]*")([^"]*)(")`);
const database=pattern(String.raw`WORD_BOUNDARY((?:${ci('DATABASE_URL')}|${ci('DB_URL')}|${ci('POSTGRES_URL')}|${ci('MYSQL_URL')}|${ci('MONGO')}(?:${ci('DB')})?${ci('_URI')})[SPACE_CLASS]*=[SPACE_CLASS]*)([^SPACE_CLASS]+)`);
const credentials=pattern(String.raw`WORD_BOUNDARY([A-Za-z][WORD_CLASS+.-]*://)([^:/SPACE_CLASS]+):([^@/SPACE_CLASS]+)@`);
const userinfo=pattern(String.raw`WORD_BOUNDARY(${ci('http')}${ci('s')}?://)[^/@SPACE_CLASS]+@`);
const query=pattern(String.raw`([?&](?:${['access_token','api_key','apikey','auth','key','password','secret','token'].map(ci).join('|')})=)([^&#SPACE_CLASS]+)`);
const bearer=pattern(String.raw`WORD_BOUNDARY(${ci('Bearer')}[SPACE_CLASS]+)([A-Za-zKſ0-9\-_.~+/]{10,}=*)`);
const generic=pattern(String.raw`WORD_BOUNDARY((?:${ci('api')}[_-]?${ci('key')}|${ci('apikey')}|${ci('access')}[_-]?${ci('token')}|${ci('auth')}[_-]?${ci('token')}|${['token','secret','password','passwd','pwd'].map(ci).join('|')})[SPACE_CLASS]*[:=][SPACE_CLASS]*)(['"]?)([A-Za-zKſ0-9\-_.\/+={}]{8,})['"]?`);
const jsonSecret=/("(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|authorization|private[_-]?key)"\s*:\s*")((?:[^"\\]|\\.)*)(")/giu;
const entropy=pattern(String.raw`WORD_BOUNDARY[A-Za-z0-9+/_-]{32,}={0,2}WORD_BOUNDARY`);
/** Pure CPU leaf, run only through the disposable owned CPU worker in production.
 * V8 regex is not Rust's linear engine. Never run untrusted text on main thread.
 * This source-compatible heuristic does not promise detecting every secret. */
export function redactRemoteTextCpu(text:string,path?:string):string{
 requireDiscordText(text);if(text.length>1048576||Buffer.byteLength(text)>1048576)throw new RangeError('Redaction input exceeds1MiB');
 let value=text.replace(pem,all=>MASK+'\n'.repeat(all.split('\n').length-1)).replace(awsAccess,MASK).replace(awsSecret,(_all,prefix:string)=>prefix+MASK).replace(gcpKey,MASK);
 value=value.replace(gcpJson,(_all,prefix:string,secret:string,suffix:string)=>prefix+MASK+suffix+'\n'.repeat(secret.split('\n').length-1)).replace(database,(_all,prefix:string)=>prefix+MASK);
 value=value.replace(credentials,(_all,scheme:string,user:string)=>scheme+user+':'+MASK+'@').replace(userinfo,(_all,prefix:string)=>prefix+MASK+'@');
 value=value.replace(query,(_all,prefix:string)=>prefix+MASK).replace(bearer,(_all,prefix:string)=>prefix+MASK).replace(generic,(_all,prefix:string,quote:string)=>prefix+quote+MASK+quote);
 value=value.replace(jsonSecret,(_all,prefix:string,secret:string,suffix:string)=>prefix+MASK+suffix+'\n'.repeat(secret.split('\n').length-1));
 const allowed=path===undefined?[]:remoteReviewRanges(value,path);let range=0;
 value=value.replace(entropy,(token,offset:number)=>{while(allowed[range]!==undefined&&allowed[range]![1]<=offset)range++;const contextual=allowed[range]!==undefined&&allowed[range]![0]<=offset&&allowed[range]![1]>=offset+token.length;
  const digits=/[0-9]/u.test(token),variety=Number(digits)+Number(/[A-Z]/u.test(token))+Number(/[a-z]/u.test(token));return contextual||variety<2||(token.includes('/')&&!digits)?token:MASK;});
 if(value.length>2097152||Buffer.byteLength(value)>2097152)throw new RangeError('Redaction output exceeds2MiB');return value;
}
