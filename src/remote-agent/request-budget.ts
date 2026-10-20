import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import type {RemoteUtcDateTime} from './datetime.ts';
const BILLION=1000000000n,DAY=86400n,MAX_DURATION=((1n<<64n)-1n)*BILLION+999999999n;
const failures=new WeakMap<object,'Expired'|'Cancelled'>();
export function remoteDeadlineFailureKind(value:unknown):'Expired'|'Cancelled'|null{return value!==null&&typeof value==='object'?failures.get(value)??null:null;}
export class RemoteDeadlineError extends Error{
 readonly kind:'Expired'|'Cancelled';
 constructor(kind:'Expired'|'Cancelled'){super(kind==='Expired'?'The local project request expired before execution.':'The local project request was cancelled with its bridge connection.');this.name='RemoteDeadlineError';this.kind=kind;failures.set(this,kind);}
}
function snapshot(value:RemoteUtcDateTime):RemoteUtcDateTime{
 const seconds=own(value,'seconds'),nanosecond=own(value,'nanosecond');
 if(typeof seconds!=='bigint'||seconds< -8640000000000n||seconds>8640000000000n||typeof nanosecond!=='bigint'||nanosecond<0n||nanosecond>=2000000000n)throw new TypeError('Invalid UTC clock value');
 const year=new Date(Number(seconds)*1000).getUTCFullYear();if(year< -262143||year>262142||!Number.isFinite(year))throw new RangeError('UTC clock outside Chrono range');
 if(nanosecond>=BILLION&&(seconds%60n+60n)%60n!==59n)throw new TypeError('Invalid leap second clock value');
 return Object.freeze({seconds,nanosecond});
}
function systemUtc():RemoteUtcDateTime{
 const ms=BigInt(Date.now()),seconds=ms>=0n?ms/1000n:(ms-999n)/1000n;
 return {seconds,nanosecond:(ms-seconds*1000n)*1000000n};
}
function duration(end:RemoteUtcDateTime,start:RemoteUtcDateTime):bigint{
 const et=(end.seconds%DAY+DAY)%DAY,st=(start.seconds%DAY+DAY)%DAY;
 let seconds=end.seconds-start.seconds;
 // Chrono NaiveDateTime date duration + NaiveTime leap correction. Comparing
 // total flattened nanoseconds would give a different result around leap seconds.
 if(et>st&&start.nanosecond>=BILLION)seconds++;
 else if(et<st&&end.nanosecond>=BILLION)seconds--;
 return seconds*BILLION+end.nanosecond-start.nanosecond;
}
function monotonic(value:bigint):void{if(typeof value!=='bigint'||value<0n)throw new RangeError('Invalid monotonic clock');}
/** Converts a captured wall deadline into one monotonic deadline. Remaining-time
 * reads never consult the wall clock again. No timer, cancellation or work is
 * started here; the caller still owns actual termination and capacity release. */
export class RemoteRequestBudget{
 readonly #deadline:bigint;readonly #start:bigint;
 private constructor(deadline:bigint,start:bigint){this.#deadline=deadline;this.#start=start;}
 static fromDeadline(deadline:RemoteUtcDateTime,nowUtc:RemoteUtcDateTime=systemUtc(),nowMonotonic=process.hrtime.bigint()):RemoteRequestBudget{
  const end=snapshot(deadline),start=snapshot(nowUtc);monotonic(nowMonotonic);const remaining=duration(end,start);
  return new RemoteRequestBudget(nowMonotonic+(remaining>0n?remaining:0n),nowMonotonic);
 }
 clone():RemoteRequestBudget{return new RemoteRequestBudget(this.#deadline,this.#start);}
 remaining(capNanoseconds:bigint|null=null,nowMonotonic=process.hrtime.bigint()):bigint{
  monotonic(nowMonotonic);if(nowMonotonic<this.#start)throw new RangeError('Monotonic clock regressed');
  if(capNanoseconds!==null&&(typeof capNanoseconds!=='bigint'||capNanoseconds<0n||capNanoseconds>MAX_DURATION))throw new RangeError('Invalid duration cap');
  const remaining=this.#deadline-nowMonotonic;if(remaining<=0n)throw new RemoteDeadlineError('Expired');
  return capNanoseconds!==null&&capNanoseconds<remaining?capNanoseconds:remaining;
 }
}
