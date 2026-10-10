import {drainGateErrorInfo} from '../../admission/owned-key.ts';
export type InteractionDispatchErrorKind='Acknowledge'|'Update'|'ClaimCacheSaturated'|'ClaimState'|'Custody'|'Admission';
const known=new WeakMap<object,{kind:InteractionDispatchErrorKind;text:string}>();
/** Central typed dispatcher errors. Unknown causes are retained without invoking
 * their getters/toString; trusted transport String failures retain source text. */
export class InteractionDispatchError extends Error{
 readonly kind:InteractionDispatchErrorKind;
 constructor(kind:InteractionDispatchErrorKind,cause?:unknown){const detail=typeof cause==='string'?cause:'transport operation failed';const text=kind==='Admission'?(drainGateErrorInfo(cause)?.message??'restart admission failed'):kind==='Acknowledge'?`failed to acknowledge Discord interaction: ${detail}`:kind==='Update'?`failed to update Discord interaction response: ${detail}`:kind==='Custody'?`durable interaction custody failed: ${detail}`:kind==='ClaimState'?'interaction claim state changed before acknowledgement could be committed':'interaction claim cache is full with acknowledgements still in flight';super(text,{cause});this.name='InteractionDispatchError';this.kind=kind;known.set(this,{kind,text});Object.freeze(this);}
}
export function interactionDispatchErrorInfo(value:unknown):Readonly<{kind:InteractionDispatchErrorKind;text:string}>|null{const info=value!==null&&(typeof value==='object'||typeof value==='function')?known.get(value):undefined;return info===undefined?null:Object.freeze({...info});}
