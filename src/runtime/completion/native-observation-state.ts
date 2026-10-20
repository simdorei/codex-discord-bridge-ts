import type {PortableResidentLifecycle} from "../../app-server/portable-resident-lifecycle.ts";
import {captureAsyncQuestionNotification,type observeAsyncQuestionNotification} from '../async-question-observation.ts';
import {NativeObservationLedgerOwner} from '../native-observation-ledger.ts';
import type {IStateAccessFacade} from '../../store/state-access-facade.ts';
import type {NativeObservationInspection} from '../native-observation-ledger.ts';
import type {ObservationScope} from '../../store/observation-gap-model.ts';
type Store=Pick<IStateAccessFacade,'activateObservation'|'discoverObservation'|'nextObservationGap'|'certifyObservation'|'finishObservationPage'|'observationScopeVerified'|'recordObservedCompletionForResident'|'recordObservedFinalAnswer'>&{inspectObservation(p:string,s:ObservationScope,n:bigint,signal?:AbortSignal):Promise<NativeObservationInspection>};
/** Pipeline-owned adapter only. The path cannot be replaced per call; every
 * certificate still comes from the original event producer and store transaction. */
export function createNativeObservationState(path:string):{readonly state:Store;readonly observeQuestions:typeof observeAsyncQuestionNotification;prepareQuestions(p:string,runtime:string,generation:bigint,signal?:AbortSignal):Promise<void>;prepareResidentQuestions(server:Pick<PortableResidentLifecycle,"instanceId"|"admitResponse">,generation:bigint,signal?:AbortSignal):Promise<void>;close():Promise<void>}{
 const owner=new NativeObservationLedgerOwner(path),check=(p:string)=>{if(p!==path)throw new TypeError('Native observation path changed');};
 const state:Store=Object.freeze({
  recordObservedCompletionForResident:(p,t,v,g,payload,resident)=>{check(p);return owner.recordTerminal(t,v,g,payload,resident);},
  recordObservedFinalAnswer:(p,t,v,g,content)=>{check(p);return owner.recordFinal(t,v,g,content);},
  activateObservation:(p,s)=>{check(p);return owner.activate(s);},
  discoverObservation:(p,s,n)=>{check(p);return owner.discover(s,n);},
  nextObservationGap:(p,s)=>{check(p);return owner.next(s);},
  inspectObservation:(p,s,n,signal)=>{check(p);return owner.inspect(s,n,signal);},
  certifyObservation:(p,s,n,effects)=>{check(p);return owner.certify(s,n,effects);},
  finishObservationPage:(p,g,n)=>{check(p);return owner.finish(g,n);},
  observationScopeVerified:(p,s,n)=>{check(p);return owner.verified(s,n);},
 });
 return Object.freeze({state,prepareResidentQuestions:async(server:Pick<PortableResidentLifecycle,"instanceId"|"admitResponse">,generation:bigint,signal?:AbortSignal)=>{signal?.throwIfAborted();const runtime=server.instanceId,admission=server.admitResponse(generation);try{await owner.prepareQuestions(runtime,generation,signal);}finally{admission.release();}},prepareQuestions:(p:string,runtime:string,generation:bigint,signal?:AbortSignal)=>{check(p);return owner.prepareQuestions(runtime,generation,signal);},observeQuestions:async(p:string,runtime:string,generation:bigint,params:unknown,clock?:()=>number)=>{check(p);const records=captureAsyncQuestionNotification(runtime,generation,params,clock);if(records!==null)await owner.recordQuestions(runtime,generation,records);},close:()=>owner.close()});
}
