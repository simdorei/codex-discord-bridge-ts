import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseStoredAbandonmentProposal, serializeStoredAbandonmentProposal,
  parseAbandonmentDecisionReceipt, serializeAbandonmentDecisionReceipt,
  type StoredAbandonmentProposal, type AbandonmentDecisionReceipt} from '../../src/store/abandonment-codec.ts';

const stored: StoredAbandonmentProposal = {version:1n,proposal:{id:'a'.repeat(32),revision:1n,job_id:'job',thread_id:'한글🌌',owner_user_id:2n,
  channel_id:3n,application_id:4n,created_at_bits:18446744073709551615n,expires_at_bits:9007199254740993n,review_text:'review',review_sha256:'b'.repeat(64)},
  source_ingress:'message:5',snapshot:{z:2n,a:1n}};
const receipt: AbandonmentDecisionReceipt = {proposal_id:'a'.repeat(32),revision:1n,job_id:'job',thread_id:'한글🌌',ingress_id:'interaction:6',
  interaction_id:6n,decision:'AbandonOnly',recorded_at_bits:18446744073709551615n};
const raw = () => serializeStoredAbandonmentProposal(stored);
test('abandonment seal uses declared struct field order and preserves exact u64 bits',()=>{
  const text=raw();
  assert.equal(text,'{"version":1,"proposal":{"id":"'+ 'a'.repeat(32)+'","revision":1,"job_id":"job","thread_id":"한글🌌","owner_user_id":2,"channel_id":3,"application_id":4,"created_at_bits":18446744073709551615,"expires_at_bits":9007199254740993,"review_text":"review","review_sha256":"'+'b'.repeat(64)+'"},"source_ingress":"message:5","snapshot":{"a":1,"z":2}}');
  assert.deepEqual(parseStoredAbandonmentProposal(text),stored);
  assert.equal(serializeStoredAbandonmentProposal(parseStoredAbandonmentProposal(text)),text);
});
test('strict root and nested struct reject unknown, duplicate and missing fields',()=>{
  for(const text of [raw().replace('"version":1','"version":1,"extra":0'),raw().replace('"version":1','"version":1,"version":1'),
    raw().replace('"source_ingress":"message:5",',''),raw().replace('"job_id":"job"','"job_id":"job","extra":0'),
    raw().replace('"revision":1','"revision":1,"revision":1'),raw().replace('"review_text":"review",','')])
    assert.throws(()=>parseStoredAbandonmentProposal(text));
});
test('typed struct sequences preserve declaration order while nested Values remain arbitrary',()=>{
  const proposal=raw().slice(raw().indexOf('"proposal":')+11,raw().indexOf(',"source_ingress"'));
  assert.deepEqual(parseStoredAbandonmentProposal(`[1,${proposal},"message:5",{"z":2,"a":1}]`),stored);
  const values='["'+'a'.repeat(32)+'",1,"job","한글🌌",2,3,4,18446744073709551615,9007199254740993,"review","'+'b'.repeat(64)+'"]';
  assert.deepEqual(parseStoredAbandonmentProposal(`[1,${values},"message:5",{"z":2,"a":1}]`),stored);
  assert.throws(()=>parseStoredAbandonmentProposal(`[1,${values},"message:5"]`));
  assert.throws(()=>parseStoredAbandonmentProposal(`[1,${values},"message:5",{},0]`));
});
test('receipt exact declaration order, both decisions, unit-map decode and sequence decode',()=>{
  for(const decision of ['AbandonOnly','KeepHeld'] as const){
    const input={...receipt,decision},text=serializeAbandonmentDecisionReceipt(input);
    assert.deepEqual(parseAbandonmentDecisionReceipt(text),input);
    assert.deepEqual(parseAbandonmentDecisionReceipt(text.replace('"decision":"'+decision+'"','"decision":{"'+decision+'":null}')),input);
    assert.deepEqual(parseAbandonmentDecisionReceipt('["'+'a'.repeat(32)+'",1,"job","한글🌌","interaction:6",6,"'+decision+'",18446744073709551615]'),input);
    assert.equal(Object.keys(JSON.parse(text)).join(','),'proposal_id,revision,job_id,thread_id,ingress_id,interaction_id,decision,recorded_at_bits');
  }
});
test('receipt rejects wrong enum, extra or duplicate variant, non-null payload and numeric overflow',()=>{
  const text=serializeAbandonmentDecisionReceipt(receipt);
  for(const variant of ['"abandon_only"','{"AbandonOnly":1}','{"AbandonOnly":null,"KeepHeld":null}','{"AbandonOnly":null,"AbandonOnly":null}','{}','[]'])
    assert.throws(()=>parseAbandonmentDecisionReceipt(text.replace('"AbandonOnly"',variant)));
  for(const changed of [text.replace('18446744073709551615','18446744073709551616'),text.replace('"interaction_id":6','"interaction_id":9223372036854775808'),
    text.replace('"revision":1','"revision":-9223372036854775809'),text.replace('"decision":"AbandonOnly"','"decision":"AbandonOnly","decision":"KeepHeld"')])
    assert.throws(()=>parseAbandonmentDecisionReceipt(changed));
});
test('decoded copies are immutable and serializers reject accessors without invoking them',()=>{
  const parsed=parseStoredAbandonmentProposal(raw());
  assert.ok(Object.isFrozen(parsed));assert.ok(Object.isFrozen(parsed.proposal));assert.ok(Object.isFrozen(parsed.snapshot));
  let calls=0;const hostile={...stored};Object.defineProperty(hostile,'source_ingress',{get(){calls++;return 'message:5';},enumerable:true});
  assert.throws(()=>serializeStoredAbandonmentProposal(hostile));assert.equal(calls,0);
  assert.throws(()=>serializeAbandonmentDecisionReceipt({...receipt,extra:true} as AbandonmentDecisionReceipt));
  assert.throws(()=>parseStoredAbandonmentProposal(raw().replace('review"','\\ud800"')));
});
