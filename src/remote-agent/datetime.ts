import {requireDiscordText} from '../discord/text.ts';
/** Chrono DateTime<Utc> representation. A leap second is second 59 with nanos
 * >=1e9, never silently normalized into the following ordinary second. */
export interface RemoteUtcDateTime{readonly seconds:bigint;readonly nanosecond:bigint;}
const whitespace=/^\p{White_Space}$/u,digit=(c:string|undefined)=>c!==undefined&&c>='0'&&c<='9';
const invalid=():never=>{throw new SyntaxError('Invalid Chrono UTC datetime');};
const days=(y:number,m:number)=>[31,y%4===0&&(y%100!==0||y%400===0)?29:28,31,30,31,30,31,31,30,31,30,31][m-1]!;
/** Chrono0.4.45 Serde uses FromStr's relaxed parser, not strict RFC3339 nor
 * Twilight timestamps. Explicit frame-derived bytes bound the scan. This leaf
 * does not compare deadlines, sample a clock, or grant execution permission. */
export function parseRemoteUtcDateTime(input:string,maxBytes:number):RemoteUtcDateTime{
 if(typeof input!=='string')throw new TypeError('Expected datetime string');
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>12000000)throw new RangeError('Invalid datetime byte budget');
 if(input.length>maxBytes||Buffer.byteLength(input)>maxBytes)throw new RangeError('Datetime exceeds byte budget');
 requireDiscordText(input);let at=0;
 const space=()=>{while(at<input.length&&whitespace.test(input[at]!))at++;};
 const digits=(max:number,min=1):bigint=>{let n=0n,count=0;while(count<max&&digit(input[at])){n=n*10n+BigInt(input.charCodeAt(at++)-48);if(n>9223372036854775807n)invalid();count++;}if(count<min)invalid();return n;};
 const numeric=(max:number):number=>{space();return Number(digits(max));};
 const literal=(c:string)=>{if(input[at++]!==c)invalid();};
 space();let sign=1,yearValue:bigint;
 if(input[at]==='+'||input[at]==='-'){sign=input[at++]==='-'?-1:1;yearValue=digits(input.length);}
 else yearValue=digits(4);
 if(yearValue>2147483648n)invalid();const year=Number(yearValue)*sign;
 if(year < -262143||year>262142)invalid();
 space();literal('-');const month=numeric(2);space();literal('-');const day=numeric(2);
 const separator=input[at++];if(separator!=='T'&&separator!=='t'&&separator!==' ')invalid();
 const hour=numeric(2);space();literal(':');const minute=numeric(2);space();literal(':');const second=numeric(2);
 let fraction=0n;
 if(input[at]==='.'){
  at++;let count=0;while(digit(input[at])){if(count<9)fraction=fraction*10n+BigInt(input.charCodeAt(at)-48);at++;count++;}
  if(count===0)invalid();for(let i=count;i<9;i++)fraction*=10n;
 }
 space();let offset=0;
 if(input.slice(at,at+3).toUpperCase()==='UTC')at+=3;
 else if(input[at]==='Z'||input[at]==='z')at++;
 else{
  const symbol=input[at++];if(symbol!=='+'&&symbol!=='-'&&symbol!=='−')invalid();
  const hours=Number(digits(2,2));while(input[at]===':'||(at<input.length&&whitespace.test(input[at]!)))at++;
  const minutes=Number(digits(2,2));if(minutes>59)invalid();offset=(hours*60+minutes)*60*(symbol==='+'?1:-1);if(Math.abs(offset)>=86400)invalid();
 }
 space();if(at!==input.length||month<1||month>12||day<1||day>days(year,month)||hour>23||minute>59||second>60)invalid();
 const local=new Date(0);local.setUTCFullYear(year,month-1,day);local.setUTCHours(hour,minute,Math.min(second,59),0);
 const utcMs=local.getTime()-offset*1000,utcYear=new Date(utcMs).getUTCFullYear();if(!Number.isSafeInteger(utcMs)||utcYear< -262143||utcYear>262142)invalid();
 return Object.freeze({seconds:BigInt(utcMs/1000),nanosecond:fraction+(second===60?1000000000n:0n)});
}
