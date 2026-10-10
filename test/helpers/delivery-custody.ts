import type {DatabaseSync} from "node:sqlite";
import {openInitialized} from "../../src/store/owned-driver.ts";
import {admitIngress} from "../../src/store/ingress-admission.ts";
import {receiptHash} from "../../src/store/delivery-receipt-key.ts";
import {serializeSerdeValue as json} from "../../src/core/serde-json.ts";
async function edit<T>(path:string,run:(db:DatabaseSync)=>T):Promise<T>{const db=await openInitialized(path);try{return run(db);}finally{db.close();}}
const key=(channel:bigint,domain:string,logical:string,index=0n)=>json([channel,domain,logical,index]);
export async function newReply(path:string,turn:string|null="turn",kind:"message"|"interaction"="message"):Promise<void>{
  await admitIngress(path,{ingressId:"original",kind,eventId:3n,applicationId:kind==="interaction"?4n:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n},targetThreadId:"target",canonicalOwner:null,now:1});
  const identity={ingress_id:"original",job_id:"job",thread_id:"target",cwd:"C:/work",state_db:"C:/state.db",channel_id:2n,origin_channel_id:1n,event_id:3n,kind,creation_generation:1n,prompt_sha256:"a".repeat(64),acknowledgement:"accepted"};
  await edit(path,db=>{
    db.prepare("UPDATE discord_ingress_journal SET state='owned',phase='durable_prompt',owner_kind='prompt',owner_id='job',outcome_json=?").run(json({new_creation:{version:1n,cwd:"C:/work"},new_verification:{thread_id:"target",channel_id:2n,prompt_sha256:"a".repeat(64)}}));
    db.exec("INSERT INTO mirror_threads VALUES ('target','p','title',1,2,1)");
    db.prepare("INSERT INTO codex_new_first_replies(job_id,ingress_id,identity_json,turn_id,state,warning_due) VALUES ('job','original',?,?,'verified',1)").run(json(identity),turn);
  });
}
export async function finalGrant(path:string):Promise<string>{
  const receipt=key(1n,"message/error/v1","inbound-message/3/error-report"),final=key(1n,"completion/v1","final");
  await admitIngress(path,{ingressId:"original",kind:"message",eventId:3n,applicationId:null,channelId:1n,ownerUserId:2n,sourceMessageId:null,payload:{version:1n},targetThreadId:"target",canonicalOwner:null,now:1});
  await edit(path,db=>{
    db.exec("UPDATE discord_ingress_journal SET state='owned',owner_kind='prompt',owner_id='job'; INSERT INTO mirror_threads VALUES ('target','p','title',10,1,1); INSERT INTO codex_delivery_outbox(delivery_id,job_id,target_thread_id,turn_id,channel_id,content,created_at,updated_at) VALUES ('final','job','target','turn',1,'restored final',1,1)");
    db.prepare("INSERT INTO codex_delivery_receipts(receipt_key,content_hash,message_id) VALUES (?,?,'error-message')").run(receipt,receiptHash("old error"));
    const payload=db.prepare("SELECT payload_json FROM discord_ingress_journal").get()?.payload_json;
    const ingress={id:"original",kind:"message",event:3n,channel:1n,actor:2n,thread:"target",state:"owned",confirmed:false,canonical:null,payload};
    const request={delivery_id:"final",job_id:"job",thread_id:"target",turn_id:"turn",channel_id:1n,original_sha256:receiptHash("original final"),ingress_id:"original",error_receipt_key:receipt,error_message_id:"error-message",error_sha256:receiptHash("old error")};
    db.prepare("INSERT INTO cdr_final_recovery VALUES ('final',?,1)").run(json({request,content_sha256:receiptHash("restored final"),chunks:[receiptHash("restored final")],ingress}));
  });return final;
}
