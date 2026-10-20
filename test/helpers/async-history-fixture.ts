import {serializeSerdeValue} from "../../src/core/serde-json.ts";
import type {AsyncObligation} from "../../src/store/async-resolution-records.ts";
export function historicalQuestionFixture(){
  const body={index:3n,source_text:"",title:"Question",options:["yes","no"]};
  const claim={id:"q",runtime_id:"resident",generation:1n,thread_id:"target",turn_id:"turn",item_id:"item",origin_job_id:"job",
    channel_id:1n,owner_user_id:2n,body:serializeSerdeValue(body),chosen:1n,message_id:"message",dispatch_mode:"steer"};
  const job={job_id:"job",target_thread_id:"target",turn_id:"turn",channel_id:1n,owner_user_id:2n};
  const seal={identity:{question:["resident","target","turn","item","job"],generation:1n,channel:1n,actor:2n,message:"message",
    chosen:1n,body,reply_job_id:null,job}};
  const row:AsyncObligation={question_id:"q",thread_id:"target",origin_job_id:"job",turn_id:"turn",version:1n,revision:7n,
    answer_state:"unresolved",execution_state:"unresolved",admission_state:"held",policy:"ordinary",claim_sha256:"hash",
    original_seal:serializeSerdeValue(seal),claim:serializeSerdeValue(claim),original_error:"original"};
  return {body,claim,job,seal,row};
}
