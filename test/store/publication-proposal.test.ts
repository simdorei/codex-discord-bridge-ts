import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {storeFixture} from '../helpers/store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {enqueueInTransaction} from '../../src/store/queue-enqueue.ts';
import {proposePublication,bindPublicationDelivery,readPublicationProposalIn,type PublicationProposalInput} from '../../src/store/publication-proposal.ts';
import {deliveredPublicationProposal} from '../../src/store/publication-binding.ts';
import {parseStoredPublicationProposal,serializeStoredPublicationProposal,publicationTimeBits,publicationTimeFromBits,publicationDigest} from '../../src/store/publication-codec.ts';
const id='a'.repeat(32),other='b'.repeat(32);
const input=(over:Partial<PublicationProposalInput>={}):PublicationProposalInput=>({proposal_id:id,job_id:'job',application_id:3n,review_text:'정확한 복구 검토',review_context:{z:1n,a:'context'},now:10,expires_at:610,...over});
async function fixture(run:(path:string)=>Promise<void>){await storeFixture(async path=>{const db=await openInitialized(path);try{db.exec('BEGIN IMMEDIATE');enqueueInTransaction(db,{jobId:'job',targetThreadId:'t',channelId:1n,ownerUserId:2n,discordMessageId:null,appServerGeneration:1n,prompt:'prompt',queued:true,ackSent:true,createdAt:1});db.exec("INSERT INTO mirror_threads VALUES('t','p','title',10,1,1); COMMIT");}finally{db.close();}await run(path);});}
function edit<T>(path:string,run:(db:DatabaseSync)=>T):T{const db=new DatabaseSync(path);try{return run(db);}finally{db.close();}}
test('proposal repeats preserve exact revision, immutable seal and Pending queue',()=>fixture(async path=>{
 const p=await proposePublication(path,input());assert.equal(p.revision,1n);assert.equal(p.owner_user_id,2n);assert.equal(p.created_at_bits,publicationTimeBits(10));assert.ok(Object.isFrozen(p));assert.deepEqual(await proposePublication(path,input()),p);
 edit(path,db=>{const stored=readPublicationProposalIn(db,id);assert.equal(stored.proposal.review_sha256,publicationDigest(input().review_text));assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_recovery_publication_proposals').get()!.n,1);assert.equal(db.prepare('SELECT state FROM codex_turn_queue').get()!.state,'pending');assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_recovery_publication_decisions').get()!.n,0);});
 for(const changed of [{review_text:'changed'},{now:11},{review_context:{different:true}},{application_id:4n}])await assert.rejects(()=>proposePublication(path,input(changed)),/producer identity reused/);
}));
test('new revision supersedes old intent without deleting its stored evidence',()=>fixture(async path=>{
 const first=await proposePublication(path,input());const second=await proposePublication(path,input({proposal_id:other}));assert.equal(second.revision,2n);
 await assert.rejects(()=>bindPublicationDelivery(path,id,4n,first.review_sha256,11),/superseded/);await assert.rejects(()=>proposePublication(path,input()),/superseded/);
 await bindPublicationDelivery(path,other,5n,second.review_sha256,11);assert.equal(deliveredPublicationProposal(path,other,2n).message_id,5n);assert.equal(edit(path,db=>db.prepare('SELECT count(*) AS n FROM cdr_recovery_publication_proposals').get()!.n),2);
}));
test('delivery binds one exact message/body and authenticated four-part actor identity',()=>fixture(async path=>{
 const p=await proposePublication(path,input());await assert.rejects(()=>bindPublicationDelivery(path,id,4n,'0'.repeat(64),11),/review text differs/);
 await bindPublicationDelivery(path,id,4n,p.review_sha256,11);await bindPublicationDelivery(path,id,4n,p.review_sha256,11);await assert.rejects(()=>bindPublicationDelivery(path,id,5n,p.review_sha256,11),/already bound/);
 const delivered=deliveredPublicationProposal(path,id,1n);delivered.requireActor(3n,1n,2n,4n);for(const tuple of [[9n,1n,2n,4n],[3n,9n,2n,4n],[3n,1n,9n,4n],[3n,1n,2n,9n],[3n,1n,0n,4n]])assert.throws(()=>delivered.requireActor(...tuple as [bigint,bigint,bigint,bigint]),/identity does not match/);
 assert.throws(()=>deliveredPublicationProposal(path,id,2n),/revision or body changed/);assert.throws(()=>deliveredPublicationProposal(path,id,0n),/invalid delivered/);
}));
test('expiry boundary and earlier clock block writes while historical delivery remains readable',()=>fixture(async path=>{
 const p=await proposePublication(path,input());await assert.rejects(()=>bindPublicationDelivery(path,id,4n,p.review_sha256,9),/expired/);await bindPublicationDelivery(path,id,4n,p.review_sha256,609.999);await assert.rejects(()=>bindPublicationDelivery(path,id,4n,p.review_sha256,610),/expired/);await assert.rejects(()=>bindPublicationDelivery(path,id,4n,p.review_sha256,NaN),/expired/);assert.equal(deliveredPublicationProposal(path,id,1n).message_id,4n);
}));
test('changed local evidence blocks delivery and rolls back its insertion',()=>fixture(async path=>{
 const p=await proposePublication(path,input());edit(path,db=>db.exec("UPDATE codex_turn_queue SET last_error='changed'"));await assert.rejects(()=>bindPublicationDelivery(path,id,4n,p.review_sha256,11),/local evidence changed/);assert.equal(edit(path,db=>db.prepare('SELECT count(*) AS n FROM cdr_recovery_publication_deliveries').get()!.n),0);
}));
test('lost insert and trigger side effects are detected and rolled back',()=>fixture(async path=>{
 edit(path,db=>db.exec('CREATE TRIGGER lose_proposal BEFORE INSERT ON cdr_recovery_publication_proposals BEGIN SELECT RAISE(IGNORE); END;'));await assert.rejects(()=>proposePublication(path,input()),/missing or oversized/);edit(path,db=>db.exec('DROP TRIGGER lose_proposal'));const p=await proposePublication(path,input());
 edit(path,db=>db.exec("CREATE TRIGGER alter_evidence AFTER INSERT ON cdr_recovery_publication_deliveries BEGIN UPDATE codex_turn_queue SET last_error='changed'; END;"));await assert.rejects(()=>bindPublicationDelivery(path,id,4n,p.review_sha256,11),/local evidence changed/);edit(path,db=>{assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_recovery_publication_deliveries').get()!.n,0);assert.equal(db.prepare('SELECT last_error FROM codex_turn_queue').get()!.last_error,'');});
}));
test('producer validation preserves UTF8 byte bounds, finite lifetime and exact lowercase id',()=>fixture(async path=>{
 for(const change of [{proposal_id:'A'.repeat(32)},{proposal_id:id+'\n'},{job_id:'한'.repeat(43)},{review_text:'한'.repeat(2667)},{review_text:'\u0085'},{review_context:[]},{review_context:{x:'a'.repeat(65536)}},{application_id:0n},{now:-1},{now:Infinity},{expires_at:611},{expires_at:10}]){await assert.rejects(async()=>proposePublication(path,input(change)),/invalid or unbounded|finite/);}
 assert.equal(edit(path,db=>db.prepare('SELECT count(*) AS n FROM cdr_recovery_publication_proposals').get()!.n),0);const p=await proposePublication(path,input({now:-0,expires_at:1,review_text:'\ufeff'}));assert.equal(p.created_at_bits,1n<<63n);
}));
test('stored seal rejects digest and header tampering even with compatible catalog',()=>fixture(async path=>{
 await proposePublication(path,input());edit(path,db=>{const trigger=db.prepare("SELECT sql FROM sqlite_schema WHERE name='cdr_recovery_publication_proposal_immutable'").get()!.sql as string;db.exec('DROP TRIGGER cdr_recovery_publication_proposal_immutable');db.prepare('UPDATE cdr_recovery_publication_proposals SET seal_sha256=?').run('0'.repeat(64));db.exec(trigger);assert.throws(()=>readPublicationProposalIn(db,id),/immutable seal/);const raw=db.prepare('SELECT seal_json FROM cdr_recovery_publication_proposals').get()!.seal_json as string;db.exec('DROP TRIGGER cdr_recovery_publication_proposal_immutable');db.prepare('UPDATE cdr_recovery_publication_proposals SET seal_sha256=?,owner_user_id=9').run(publicationDigest(raw));db.exec(trigger);assert.throws(()=>readPublicationProposalIn(db,id),/immutable seal/);});
}));
test('codec keeps declared struct order, strict fields and exact u64 time bits',()=>fixture(async path=>{
 await proposePublication(path,input());const stored=edit(path,db=>readPublicationProposalIn(db,id)),raw=serializeStoredPublicationProposal(stored);assert.ok(raw.startsWith('{"version":1,"proposal":{"id":'));assert.ok(raw.includes('"review_context":{"a":"context","z":1}'));assert.equal(serializeStoredPublicationProposal(parseStoredPublicationProposal(raw)),raw);
 for(const altered of [raw.replace('{"version":1','{"version":1,"version":1'),raw.replace('{"version":1','{"extra":0,"version":1'),raw.replace('"version":1,',''),raw.replace('"revision":1','"revision":1,"unknown":null')])assert.throws(()=>parseStoredPublicationProposal(altered));
 const sequence='[1,['+Object.values(stored.proposal).map(v=>typeof v==='bigint'?String(v):JSON.stringify(v)).join(',')+'],{},{}]';assert.equal(parseStoredPublicationProposal(sequence).proposal.expires_at_bits,publicationTimeBits(610));assert.equal(publicationTimeBits(-0),9223372036854775808n);assert.ok(Object.is(publicationTimeFromBits(9223372036854775808n),-0));
}));
test('invalid application inputs do not invoke inherited or accessor callbacks',()=>fixture(async path=>{
 let calls=0;const evil={...input()};Object.defineProperty(evil,'now',{get(){calls++;return 10;},enumerable:true});await assert.rejects(async()=>proposePublication(path,evil),/invalid or unbounded/);assert.equal(calls,0);
 const context={};Object.defineProperty(context,'secret',{get(){calls++;return 'x';},enumerable:true});await assert.rejects(async()=>proposePublication(path,input({review_context:context})),TypeError);assert.equal(calls,0);
}));
test('readonly routing fails on missing delivery and never creates a missing database',()=>storeFixture(async path=>{
 assert.throws(()=>deliveredPublicationProposal(path,id,1n));const db=await openInitialized(path);try{assert.equal(db.prepare('SELECT count(*) AS n FROM cdr_recovery_publication_proposals').get()!.n,0);}finally{db.close();}
}));
