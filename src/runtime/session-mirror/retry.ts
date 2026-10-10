import {requireDiscordText} from '../../discord/text.ts';
const SECOND=1_000_000_000n,U64_MAX=(1n<<64n)-1n;
const DURATION_MAX=U64_MAX*SECOND+999_999_999n;
export interface SessionMirrorFailureReport {readonly count:bigint;readonly error:string;}
export interface SessionMirrorRetryDecision {readonly retryAfterNanoseconds:bigint;readonly report:SessionMirrorFailureReport|null;}
/** Pure retry/report policy only. The owner must retain running I/O until it exits;
 * a delay decision is not permission to replay an uncertain Discord delivery. */
export class SessionMirrorRetryState {
 #consecutiveFailures=0n;#lastError:string|null=null;#nextReportAt:bigint|null=null;
 onFailure(nowNanoseconds:bigint,error:string):SessionMirrorRetryDecision{
  if(typeof nowNanoseconds!=='bigint'||nowNanoseconds<0n||nowNanoseconds>DURATION_MAX)throw new RangeError('Expected Rust Duration range');
  requireDiscordText(error);
  const changed=this.#lastError!==error;let report:SessionMirrorFailureReport|null=null;
  if(changed){this.#consecutiveFailures=1n;this.#lastError=error;this.#nextReportAt=deadline(nowNanoseconds);report=this.#report(error);}
  else{
   if(this.#consecutiveFailures<U64_MAX)this.#consecutiveFailures++;
   if(this.#nextReportAt===null||nowNanoseconds>=this.#nextReportAt){this.#nextReportAt=deadline(nowNanoseconds);report=this.#report(error);}
  }
  const exponent=Number(this.#consecutiveFailures>6n?5n:this.#consecutiveFailures-1n);
  return Object.freeze({retryAfterNanoseconds:BigInt(Math.min(1<<exponent,30))*SECOND,report});
 }
 onSuccess():bigint{this.#consecutiveFailures=0n;this.#lastError=null;this.#nextReportAt=null;return SECOND;}
 #report(error:string):SessionMirrorFailureReport{return Object.freeze({count:this.#consecutiveFailures,error});}
}
function deadline(now:bigint):bigint{const result=now+60n*SECOND;return result>DURATION_MAX?DURATION_MAX:result;}
