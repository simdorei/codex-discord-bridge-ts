import {isMirrorChannelMethod} from './mirror-channel-request.ts';
import {messageComponentClearResource} from './message-component-clear-request.ts';
import {isOriginalInteractionResponsePath} from './interaction-update-request.ts';
import {isInteractionCallbackPath} from './interaction-callback-request.ts';
import {isCommandRegistrationPath} from './commands.ts';
import {DiscordChannelRateState,type ChannelRateHeaders,type RateClock} from './channel-rate-state.ts';
import type {DiscordRateLimiter,DiscordRatePermit,DiscordHttpMethod} from './response-engine.ts';
import {invokeSynchronousVoid} from '../core/synchronous-void.ts';
function isChannelPostPath(path:unknown):boolean{
 if(typeof path!=='string')return false;const match=/^channels\/([1-9][0-9]{0,19})\/(messages|typing)$/u.exec(path);return match!==null&&match[0]===path;
}
export class UnsupportedRateResetError extends RangeError{constructor(){super('Rate reset duration is outside the supported nonnegative finite profile');this.name='UnsupportedRateResetError';}}
function ascii(value:Uint8Array|undefined):string{if(value===undefined||value.some(n=>n<32||n>126))throw new SyntaxError('Missing or non-ASCII rate header');return Buffer.from(value).toString('ascii');}
function u16(text:string):number{const m=/^\+?[0-9]+$/u.exec(text);if(m===null||m[0]!==text)throw new SyntaxError('Invalid u16 rate header');const value=BigInt(text);if(value>65535n)throw new SyntaxError('Rate header outside u16');return Number(value);}
function ratio(bits:number):readonly [bigint,bigint]{if(bits===0x7f800000)return [1n<<128n,1n];const exponent=(bits>>>23)&255,mantissa=(bits&0x7fffff)+(exponent===0?0:0x800000),power=exponent===0?-149:exponent-150;return power>=0?[BigInt(mantissa)<<BigInt(power),1n]:[BigInt(mantissa),1n<<BigInt(-power)];}
const compare=(a:bigint,b:bigint)=>a<b?-1:a>b?1:0;
/** Decimal -> IEEE binary32 without a binary64 double-rounding error at a midpoint.
 * The binary64 approximation locates adjacent candidates; exact decimal BigInts decide
 * the halfway case and ties-to-even. Special/nonfinite values are rejected by duration. */
export function parseRateF32(text:string):number{
 if(typeof text!=='string')throw new TypeError('Expected f32 text');const special=/^[+-]?(?:inf(?:inity)?|nan)$/iu.exec(text);
 if(special!==null&&special[0]===text)return /nan/iu.test(text)?NaN:text.startsWith('-')?-Infinity:Infinity;
 const match=/^([+-]?)((?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))(?:[eE]([+-]?[0-9]+))?$/u.exec(text);if(match===null||match[0]!==text)throw new SyntaxError('Invalid f32 rate header');
 const sign=match[1]==='-'?-1:1,mantissa=match[2]!,fraction=mantissa.includes('.')?mantissa.length-mantissa.indexOf('.')-1:0,digits=mantissa.replace('.','').replace(/^0+/u,'');if(digits==='')return sign*0;
 const power=Number(match[3]??0)-fraction,order=digits.length+power-1;if(order>38)return sign*Infinity;if(order< -46)return sign*0;
 let numerator=BigInt(digits),denominator=1n;if(power>=0)numerator*=10n**BigInt(power);else denominator=10n**BigInt(-power);
 const view=new DataView(new ArrayBuffer(4));view.setFloat32(0,Math.abs(Number(text)));let bits=view.getUint32(0);
 const midpoint=(left:number,right:number)=>{const [ln,ld]=ratio(left),[rn,rd]=ratio(right);return compare(numerator*(2n*ld*rd),denominator*(ln*rd+rn*ld));};
 if(bits===0x7f800000){if(midpoint(bits-1,bits)<0)bits--;}
 else{const [n,d]=ratio(bits),direction=compare(numerator*d,n*denominator);if(direction!==0){const other=bits+direction,m=direction>0?midpoint(bits,other):midpoint(other,bits);if((direction>0&&m>0)||(direction<0&&m<0)||(m===0&&(bits&1)!==0))bits=other;}}
 view.setUint32(0,bits);return sign*view.getFloat32(0);
}
/** Input names are lowercased by the trusted wire adapter; bucket bytes remain exact.
 * Monotonic millisecond scheduling is the supported profile, not std::time nanoseconds. */
export function parseChannelRateHeaders(input:ReadonlyMap<string,Uint8Array>,nowMs:number):ChannelRateHeaders|null{
 if(!Number.isFinite(nowMs)||nowMs<0)throw new TypeError('Expected monotonic response time');const scope=input.get('x-ratelimit-scope');if(scope===undefined)return null;const same=(s:string)=>Buffer.from(scope).equals(Buffer.from(s));
 if(same('global'))return null;if(!same('user')&&!same('shared'))return null;
 const bucket=input.get('x-ratelimit-bucket');if(bucket===undefined)throw new SyntaxError('Missing rate bucket');
 if(same('shared'))return {bucket:new Uint8Array(bucket),limit:0,remaining:0,resetAtMs:nowMs+u16(ascii(input.get('retry-after')))*1000};
 const limit=u16(ascii(input.get('x-ratelimit-limit'))),remaining=u16(ascii(input.get('x-ratelimit-remaining'))),seconds=parseRateF32(ascii(input.get('x-ratelimit-reset-after')));
 if(!Number.isFinite(seconds)||seconds<0||seconds>=2**64)throw new UnsupportedRateResetError();return {bucket:new Uint8Array(bucket),limit,remaining,resetAtMs:nowMs+seconds*1000};
}
/** Production channel-profile adapter for the response engine. Ordinary malformed
 * headers complete(None), matching Twilight's warning path. A duration that would
 * panic/overflow the source is held as an error, never silently changed to no limit. */
export class DiscordChannelRateLimiter implements DiscordRateLimiter{
 readonly #state:DiscordChannelRateState;readonly #now:()=>number;readonly #report:(error:unknown)=>void;
 constructor(options:{globalLimit?:number;clock?:RateClock;report:(error:unknown)=>void}){this.#state=new DiscordChannelRateState(options.globalLimit,options.clock);this.#now=options.clock===undefined?()=>performance.now():options.clock.now.bind(options.clock);this.#report=options.report;}
 async acquire(method:DiscordHttpMethod,path:string,signal:AbortSignal):Promise<DiscordRatePermit>{if(!isMirrorChannelMethod(method,path)&&!(method==='GET'&&path==='gateway/bot')&&!(method==='POST'&&(isChannelPostPath(path)||isInteractionCallbackPath(path)))&&!(method==='PUT'&&isCommandRegistrationPath(path))&&!(method==='PATCH'&&(isOriginalInteractionResponsePath(path)||messageComponentClearResource(path)!==null)))throw new TypeError('Unsupported Discord rate endpoint method');const permit=await this.#state.acquire(path,signal);return Object.freeze({complete:(_status:number,values:ReadonlyMap<string,Uint8Array>)=>{
  let parsed:ChannelRateHeaders|null;try{parsed=parseChannelRateHeaders(values,this.#now());}catch(error){invokeSynchronousVoid(this.#report,{},[error]);if(!(error instanceof SyntaxError))throw error;parsed=null;}permit.complete(parsed);
 },release:()=>permit.release()});}
 close(reason?:unknown):Promise<void>{return this.#state.close(reason);}
}
