import type {DatabaseSync} from 'node:sqlite';
import {storeFixture} from './store-fixture.ts';
import {openInitialized} from '../../src/store/owned-driver.ts';
import {enqueueInTransaction} from '../../src/store/queue-enqueue.ts';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
export async function abandonmentStoreFixture(run:(db:DatabaseSync,path:string)=>void,held=true,jobId='job'){const source={version:1n,content:`!discard-request ${jobId}`,author_is_bot:false,plan:{Execute:{DiscardRequest:{job_id:jobId}}}};await storeFixture(async path=>{const db=await openInitialized(path);try{
 db.exec('BEGIN IMMEDIATE');enqueueInTransaction(db,{jobId,targetThreadId:'t',channelId:1n,ownerUserId:2n,discordMessageId:7n,appServerGeneration:1n,prompt:'prompt',queued:true,ackSent:true,createdAt:1});
 db.exec("INSERT INTO mirror_threads VALUES('t','p','title',10,1,1); INSERT INTO codex_app_server_runtime VALUES(1,'app'); INSERT INTO codex_mutation_runtime VALUES(1,'wire')");
 if(held)db.prepare("INSERT INTO cdr_async_recovery_policies VALUES('t',1,'publishing_recovery',?,'turn','origin',?)").run('a'.repeat(64),jobId);
 db.prepare(`INSERT INTO discord_ingress_journal(ingress_id,kind,event_id,application_id,channel_id,owner_user_id,source_message_id,payload_json,runtime_id,state,phase,target_thread_id,created_at,updated_at)
 VALUES('message:5','message',5,NULL,1,2,5,?,'app','executing','processing','t',11,11)`).run(serializeSerdeValue(source));
 db.exec('COMMIT');run(db,path);
 }finally{if(db.isOpen){if(db.isTransaction)db.exec('ROLLBACK');db.close();}}});}
