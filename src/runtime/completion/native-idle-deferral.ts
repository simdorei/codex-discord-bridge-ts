import {NativeIdleBeforeOwner} from '../native-idle-before.ts';import {cloneIdleReleaseToken} from '../../app-server/idle-release-journal.ts';import {requireDiscordText} from '../../discord/text.ts';import {takeUnicodeScalarChars} from '../../store/queue-preflight-failure.ts';import type {IdleIntent} from '../../store/idle-release-row.ts';import type {IdleDeferralWriter} from './idle-release.ts';
/** Trusted diagnostic adapter only, never new release permission. Caller retains
 * original target lease and checks full current row before invoking this CAS. */
export class NativeIdleDeferralWriter implements IdleDeferralWriter{
 readonly #owner:NativeIdleBeforeOwner;
 constructor(path:string,render:(error:unknown)=>string,timeoutMs=5000){this.#owner=new NativeIdleBeforeOwner(path,render,timeoutMs);}
 get busy():boolean{return this.#owner.busy;}
 async record(expected:IdleIntent,detail:string):Promise<void>{
  const token=cloneIdleReleaseToken(expected);if(token.state!=='Candidate')throw new TypeError('Idle diagnostic requires original Candidate');requireDiscordText(detail);
  // Original store writes exactly first512 Unicode scalars. Validate full text first.
  await this.#owner.transition(token,'Candidate',takeUnicodeScalarChars(detail,512));
 }
 close(reason?:unknown):Promise<void>{return this.#owner.close(reason);}
}
Object.freeze(NativeIdleDeferralWriter.prototype);
