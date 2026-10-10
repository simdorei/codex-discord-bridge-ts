import {it} from 'node:test';import assert from 'node:assert/strict';
import {HistoryPollState,HistoryPollError,historyMessageWatermark as mark,compareHistoryWatermarks,type HistoryBatchItem} from '../../../src/runtime/history-poll/state.ts';
const item=(micros:bigint,id:bigint,value=String(id)):HistoryBatchItem<string>=>({watermark:mark(micros,id),item:{kind:'Candidate',value}});
const kind=(k:string)=>(e:unknown)=>e instanceof HistoryPollError&&e.kind===k;
it('prime fixes its boundary before failed lookup and proposes oldest-first without moving cursor',()=>{
 const s=new HistoryPollState(),first=s.begin(1n,100n),retry=s.begin(1n,500n),p=s.propose(retry,[item(101n,3n),item(100n,2n),item(99n,1n)]);assert.equal(p.phase,'Prime');assert.deepEqual(p.itemsOldestFirst,[{kind:'ClaimAndDiscard',value:'1'},{kind:'ClaimAndProcess',value:'2'},{kind:'ClaimAndProcess',value:'3'}]);assert.equal(s.watermark(1n),null);assert.equal(s.primedCount,0);assert.deepEqual(s.propose(first,[]).nextWatermark,{micros:100n,messageId:0n});s.commit(1n,p.commitToken);assert.deepEqual(s.watermark(1n),mark(101n,3n));assert.equal(s.primedCount,1);
});
it('incremental uses timestamp then lossless ID and discarded candidates still require durable claim',()=>{
 const s=new HistoryPollState(),p=s.propose(s.begin(1n,-5n),[item(10n,9007199254740993n)]);s.commit(1n,p.commitToken);const q=s.propose(s.begin(1n,999n),[item(10n,9007199254740994n),item(10n,9007199254740993n),item(9n,(1n<<64n)-1n)]);assert.equal(q.phase,'Incremental');assert.deepEqual(q.itemsOldestFirst.map(x=>x.kind),['ClaimAndDiscard','ClaimAndDiscard','ClaimAndProcess']);assert.deepEqual(q.nextWatermark,mark(10n,9007199254740994n));
});
it('ignored valid rows advance proposed watermark but ignore and invalid-position candidates expose no work',()=>{
 const s=new HistoryPollState(),p=s.propose(s.begin(2n,0n),[{watermark:mark(10n,2n),item:{kind:'Ignore'}},{watermark:null,item:{kind:'Candidate',value:'invalid'}}]);assert.deepEqual(p.itemsOldestFirst,[{kind:'NoClaim'},{kind:'NoClaim'}]);assert.deepEqual(p.nextWatermark,mark(10n,2n));assert.equal(s.watermark(2n),null);s.commit(2n,p.commitToken);assert.deepEqual(s.watermark(2n),mark(10n,2n));
});
it('empty batches prime at start and later empty or older windows never move backwards',()=>{
 const s=new HistoryPollState(),p=s.propose(s.begin(3n,10n),[]);s.commit(3n,p.commitToken);assert.equal(s.isPrimed(3n),true);assert.deepEqual(s.watermark(3n),{micros:10n,messageId:0n});const q=s.propose(s.begin(3n,500n),[item(9n,1n)]);s.commit(3n,q.commitToken);assert.deepEqual(s.watermark(3n),{micros:10n,messageId:0n});
});
it('whole-batch commit is explicit and competing or reused tokens cannot overwrite newer cursor',()=>{
 const s=new HistoryPollState(),cycle=s.begin(1n,0n),a=s.propose(cycle,[item(1n,1n)]),b=s.propose(cycle,[item(2n,2n)]);assert.equal(s.watermark(1n),null);s.commit(1n,b.commitToken);for(const token of [a.commitToken,b.commitToken])assert.throws(()=>s.commit(1n,token),kind('StaleCommit'));assert.throws(()=>s.propose(cycle,[]),kind('StaleCycle'));assert.deepEqual(s.watermark(1n),mark(2n,2n));
});
it('channel mismatch and another state owner tokens fail without changing either channel',()=>{
 const s=new HistoryPollState(),other=new HistoryPollState(),c=s.begin(1n,0n),p=s.propose(c,[]);other.begin(1n,0n);assert.throws(()=>s.commit(2n,p.commitToken),kind('ChannelMismatch'));assert.throws(()=>other.commit(1n,p.commitToken),TypeError);assert.throws(()=>other.propose(c,[]),TypeError);assert.throws(()=>s.commit(1n,{} as never),TypeError);assert.equal(s.primedCount,0);s.commit(1n,p.commitToken);assert.equal(s.primedCount,1);
});
it('removing then readding a channel invalidates old tokens without an ABA state match',()=>{
 const s=new HistoryPollState(),old=s.propose(s.begin(1n,10n),[]);s.retainChannels([]);s.begin(1n,10n);assert.throws(()=>s.commit(1n,old.commitToken),kind('StaleCommit'));const fresh=s.propose(s.begin(1n,90n),[]);assert.deepEqual(fresh.nextWatermark,{micros:10n,messageId:0n});s.commit(1n,fresh.commitToken);s.retainChannels([1n,1n]);assert.equal(s.primedCount,1);s.retainChannels([]);assert.equal(s.primedCount,0);
});
it('ten item source window accepts ten and refuses eleven before commit or partial decisions',()=>{
 const s=new HistoryPollState(),c=s.begin(1n,0n),rows=Array.from({length:10},(_,i)=>item(BigInt(10-i),BigInt(10-i)));assert.equal(s.propose(c,rows).itemsOldestFirst.length,10);assert.throws(()=>s.propose(c,[...rows,item(0n,11n)]),kind('BatchTooLarge'));assert.equal(s.isPrimed(1n),false);
});
it('watermark validation preserves signed microseconds and unsigned ID bounds without number rounding',()=>{
 assert.equal(mark(0n,0n),null);assert.deepEqual(mark(-(1n<<63n),(1n<<64n)-1n),{micros:-(1n<<63n),messageId:(1n<<64n)-1n});for(const [t,id] of [[1n<<63n,1n],[-(1n<<63n)-1n,1n],[0n,1n<<64n],[0n,-1n]])assert.throws(()=>mark(t!,id!),TypeError);assert.throws(()=>mark(0 as never,1n),TypeError);assert.equal(compareHistoryWatermarks(mark(1n,1n)!,mark(1n,2n)!),-1);
});
it('passive row capture rejects getters and proxies without executing them or moving state',()=>{
 const s=new HistoryPollState(),c=s.begin(1n,0n);let hooks=0;const row={get watermark(){hooks++;return null;},item:{kind:'Ignore'}};assert.throws(()=>s.propose(c,[row] as never),TypeError);const proxy=new Proxy([],{get(){hooks++;throw Error('trap');}});assert.throws(()=>s.propose(c,proxy),TypeError);assert.throws(()=>compareHistoryWatermarks({get micros(){hooks++;return 0n;},messageId:1n},mark(0n,1n)!),TypeError);assert.equal(hooks,0);assert.equal(s.isPrimed(1n),false);assert.throws(()=>s.retainChannels(Array(51).fill(1n)),TypeError);
});
it('proposal copies and freezes control fields but does not inspect opaque candidate payload',()=>{
 const s=new HistoryPollState(),c=s.begin(1n,0n),payload=new Proxy({},{get(){throw Error('payload inspected');}}),rows=[{watermark:mark(1n,1n),item:{kind:'Candidate' as const,value:payload}}],p=s.propose(c,rows);rows.length=0;assert.equal(p.itemsOldestFirst.length,1);assert.ok(Object.isFrozen(p));assert.ok(Object.isFrozen(p.itemsOldestFirst));assert.ok(Object.isFrozen(p.itemsOldestFirst[0]));assert.equal((p.itemsOldestFirst[0] as {value:unknown}).value,payload);
});
it('a new process-local state intentionally reprimes and never restores another instance cursor',()=>{
 const a=new HistoryPollState(),p=a.propose(a.begin(1n,0n),[item(10n,1n)]);a.commit(1n,p.commitToken);const b=new HistoryPollState(),q=b.propose(b.begin(1n,20n),[item(10n,1n)]);assert.equal(q.phase,'Prime');assert.equal(q.itemsOldestFirst[0]!.kind,'ClaimAndDiscard');assert.equal(b.watermark(1n),null);
});
