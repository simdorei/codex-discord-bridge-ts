import {NativeObservationLedgerOwner} from '../native-observation-ledger.ts';
import type {IStateAccessFacade} from '../../store/state-access-facade.ts';
type Store=Pick<IStateAccessFacade,'activateObservation'|'discoverObservation'|'nextObservationGap'|'certifyObservation'|'finishObservationPage'|'observationScopeVerified'|'recordObservedCompletionForResident'|'recordObservedFinalAnswer'>;
/** Pipeline-owned adapter only. The path cannot be replaced per call; every
 * certificate still comes from the original event producer and store transaction. */
export function createNativeObservationState(path:string):{readonly state:Store;close():Promise<void>}{
 const owner=new NativeObservationLedgerOwner(path),check=(p:string)=>{if(p!==path)throw new TypeError('Native observation path changed');};
 const state:Store=Object.freeze({
  recordObservedCompletionForResident:(p,t,v,g,payload,resident)=>{check(p);return owner.recordTerminal(t,v,g,payload,resident);},
  recordObservedFinalAnswer:(p,t,v,g,content)=>{check(p);return owner.recordFinal(t,v,g,content);},
  activateObservation:(p,s)=>{check(p);return owner.activate(s);},
  discoverObservation:(p,s,n)=>{check(p);return owner.discover(s,n);},
  nextObservationGap:(p,s)=>{check(p);return owner.next(s);},
  certifyObservation:(p,s,n,effects)=>{check(p);return owner.certify(s,n,effects);},
  finishObservationPage:(p,g,n)=>{check(p);return owner.finish(g,n);},
  observationScopeVerified:(p,s,n)=>{check(p);return owner.verified(s,n);},
 });
 return Object.freeze({state,close:()=>owner.close()});
}
