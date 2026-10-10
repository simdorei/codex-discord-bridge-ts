import type {DatabaseSync} from 'node:sqlite';
import {receiptRow, receiptText, receiptTextColumns, receiptExists} from './delivery-receipt-key.ts';
import {decodeI64, decodeOptionalI64, decodeTimestamp} from './sqlite-values.ts';
import {AbandonmentIntegrityError} from './schema-abandonment.ts';
import {publicationTimeBits} from './publication-codec.ts';
import type {AbandonmentDecision, StoredAbandonmentProposal} from './abandonment-codec.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serdeValueEqual} from '../core/serde-value-equal.ts';
import {serdeField, rustTrim} from '../app-server/value.ts';
import {requireDiscordText} from '../discord/text.ts';

export interface AbandonmentTarget {readonly job: string; readonly thread: string; readonly owner: bigint; readonly channel: bigint}
export class AbandonmentRowMissingError extends Error {
  readonly kind = 'QueryReturnedNoRows';
  constructor() {super('Query returned no rows'); this.name='AbandonmentRowMissingError';}
}
const invalid = (why: string): never => {throw new AbandonmentIntegrityError(why);};
function readIngress(db: DatabaseSync, id: string) {
  requireDiscordText(id);
  const row=receiptRow(db,`SELECT version,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,
    runtime_id,state,phase,target_thread_id,owner_kind,owner_id,created_at,payload_json,
    ${receiptTextColumns('kind','runtime_id','state','phase','target_thread_id','owner_kind','owner_id','payload_json')}
    FROM discord_ingress_journal WHERE ingress_id=? AND length(CAST(payload_json AS BLOB))<=131072`,id);
  if(row===undefined)throw new AbandonmentRowMissingError();
  const value={version:decodeI64(row.version,'version'),kind:receiptText(row,'kind'),event:decodeOptionalI64(row.event_id,'event_id'),
    application:decodeOptionalI64(row.application_id,'application_id'),channel:decodeI64(row.channel_id,'channel_id'),owner:decodeI64(row.owner_user_id,'owner_user_id'),
    message:decodeOptionalI64(row.source_message_id,'source_message_id'),runtime:receiptText(row,'runtime_id',true),state:receiptText(row,'state'),phase:receiptText(row,'phase'),
    target:receiptText(row,'target_thread_id',true),owner_kind:receiptText(row,'owner_kind',true),owner_id:receiptText(row,'owner_id',true),
    created_at:decodeTimestamp(row.created_at,'created_at'),payload:parseSerdeValue(receiptText(row,'payload_json')!)};
  if(value.version!==1n||!Number.isFinite(value.created_at)||value.created_at<0)return invalid('unsupported saved ingress');
  return value;
}
function executing(value: ReturnType<typeof readIngress>): void {
  if(value.state!=='executing'||value.phase!=='processing'||value.owner_kind!==null||value.owner_id!==null)
    invalid('ingress has no current unowned processing custody');
}
/** Borrowed connection reads only; caller owns snapshot/transaction lifetime. */
export function readAbandonmentRuntimeIn(db: DatabaseSync): Readonly<{app: string; wire: string}> {
  const read=(table: 'codex_app_server_runtime'|'codex_mutation_runtime')=>{
    const row=receiptRow(db,`SELECT runtime_id,${receiptTextColumns('runtime_id')} FROM ${table} WHERE singleton=1`);
    if(row===undefined)throw new AbandonmentRowMissingError();return receiptText(row,'runtime_id')!;
  };
  const app=read('codex_app_server_runtime'),wire=read('codex_mutation_runtime');
  if(rustTrim(app)===''||rustTrim(wire)==='')return invalid('runtime identity is unavailable');
  return Object.freeze({app,wire});
}
export function verifyAbandonmentMessageIn(db: DatabaseSync, input: AbandonmentTarget, id: string, requireExecuting: boolean): unknown {
  const target=cloneOwnedSerdeValue(input) as AbandonmentTarget;
  for(const text of [target.job,target.thread])requireDiscordText(text);
  if(typeof requireExecuting!=='boolean'||typeof target.owner!=='bigint'||typeof target.channel!=='bigint')throw new TypeError('Expected abandonment target');
  const saved=readIngress(db,id),content=serdeField(saved.payload,'content');
  if(typeof content!=='string')return invalid('proposal command is missing');
  const words=content.split(/[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u).filter(Boolean);
  const runtime=readAbandonmentRuntimeIn(db);
  if(saved.kind!=='message'||saved.application!==null||saved.event===null||saved.event<=0n||saved.message!==saved.event
    ||saved.channel!==target.channel||saved.owner!==target.owner||saved.target!==target.thread||saved.runtime!==runtime.app
    ||serdeField(saved.payload,'version')!==1n||serdeField(saved.payload,'author_is_bot')!==false
    ||words.length!==2||words[0]!=='!discard-request'||words[1]!==target.job
    ||!serdeValueEqual(serdeField(saved.payload,'plan'),{Execute:{DiscardRequest:{job_id:target.job}}})||saved.owner_kind!==null||saved.owner_id!==null)
    return invalid('proposal source is not the exact authenticated owner request');
  if(requireExecuting)executing(saved);
  return cloneOwnedSerdeValue({id,event:saved.event,application:saved.application,channel:saved.channel,owner:saved.owner,message:saved.message,
    payload:saved.payload,runtime:saved.runtime,target:saved.target,created_at_bits:publicationTimeBits(saved.created_at)});
}
export function verifyAbandonmentClickIn(db: DatabaseSync, input: StoredAbandonmentProposal, id: string,
  decision: AbandonmentDecision, fresh: boolean): bigint {
  if((decision!=='AbandonOnly'&&decision!=='KeepHeld')||typeof fresh!=='boolean')throw new TypeError('Expected abandonment decision');
  const stored=cloneOwnedSerdeValue(input) as StoredAbandonmentProposal,p=stored.proposal,saved=readIngress(db,id);
  const event=saved.event;if(event===null||event<=0n)return invalid('interaction event is missing');
  const delivery=receiptRow(db,`SELECT revision,message_id,body_sha256,${receiptTextColumns('body_sha256')} FROM cdr_recovery_abandonment_deliveries WHERE proposal_id=?`,p.id);
  if(delivery===undefined)throw new AbandonmentRowMissingError();
  const revision=decodeI64(delivery.revision,'revision'),message=decodeI64(delivery.message_id,'message_id'),hash=receiptText(delivery,'body_sha256');
  const context=serdeField(stored.snapshot,'context'),runtime=serdeField(context,'runtime');
  const appValue=serdeField(runtime,'app'),expectedApp=typeof appValue==='string'?appValue:null;
  const work={Component:{RecoveryAbandonDecision:{proposal_id:p.id,revision:p.revision,decision}}};
  const historical={version:1n,work},normal={version:1n,processing_mode:'normal',work,settings_binding:null,request_rejection:null};
  if(saved.kind!=='interaction'||revision!==p.revision||message<=0n||hash!==p.review_sha256||saved.application!==p.application_id
    ||saved.channel!==p.channel_id||saved.owner!==p.owner_user_id||saved.message!==message||saved.target!==p.thread_id
    ||saved.runtime!==expectedApp||(!serdeValueEqual(saved.payload,historical)&&!serdeValueEqual(saved.payload,normal)))
    return invalid('saved interaction does not match the displayed abandonment decision');
  if(fresh){
    executing(saved);
    if(!serdeValueEqual(readAbandonmentRuntimeIn(db),runtime))return invalid('runtime changed before decision');
    if(receiptExists(db,`SELECT EXISTS(SELECT 1 FROM cdr_recovery_abandonment_decisions
      WHERE (ingress_id=? OR interaction_id=?) AND proposal_id!=?) AS held`,id,event,p.id))return invalid('interaction was already consumed elsewhere');
  }
  return event;
}
