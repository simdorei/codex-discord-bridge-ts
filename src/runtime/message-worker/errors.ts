import {passiveErrorText} from '../../core/passive-error-text.ts';
import {cleanupNotificationFailureInfo} from '../cleanup-notification-failure.ts';
export type MessageWorkerErrorKind='KnownOutcomeNotification'|'PromptDelivery'|'Restarting'|'Plan'|'Admission'|'Action'|'Store'|'IntegerRange'|'Delivery'|'RecordedDelivery'|'Component'|'Attachment'|'Ui'|'Discord';
const kinds=new Set<MessageWorkerErrorKind>(['KnownOutcomeNotification','PromptDelivery','Restarting','Plan','Admission','Action','Store','IntegerRange','Delivery','RecordedDelivery','Component','Attachment','Ui','Discord']);
const owned=new WeakMap<object,Readonly<{kind:MessageWorkerErrorKind;source:unknown;text:string}>>();
/** Central typed failure classification. Never traverses arbitrary error hooks. */
export class MessageWorkerError extends Error {
 constructor(kind:MessageWorkerErrorKind,source:unknown=null){
  if(!kinds.has(kind))throw new TypeError('Expected message failure kind');if(kind==='KnownOutcomeNotification'&&cleanupNotificationFailureInfo(source)===null)throw new TypeError('Expected recorded known-outcome notification failure');
  const detail=typeof source==='string'?source:passiveErrorText(source,'message operation failed');
  const text=kind==='Restarting'?'Codex Discord is restarting. Please retry after restart.':kind==='IntegerRange'?'Discord identifier does not fit the SQLite integer contract':kind==='Delivery'?'Discord message delivery failed: '+detail:detail;
  super(text,{cause:source});this.name='MessageWorkerError';owned.set(this,Object.freeze({kind,source,text}));Object.freeze(this);
 }
}
export function messageWorkerErrorInfo(value:unknown){return value!==null&&(typeof value==='object'||typeof value==='function')?owned.get(value)??null:null;}
