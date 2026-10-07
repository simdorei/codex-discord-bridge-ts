import { parseSerdeStruct, type StructShape } from "../core/serde-struct-json.ts";
import { serializeSerdeValue } from "../core/serde-json.ts";
import { StoreIntegrityError } from "./schema-assembly.ts";
export interface QuestionBody {index:bigint;source_text:string;title:string;options:string[]}
export interface SealedQuestion {
  id:string;runtime_id:string;generation:bigint;thread_id:string;turn_id:string;item_id:string;origin_job_id:string;
  channel_id:bigint;owner_user_id:bigint;body:QuestionBody;message_id:string;chosen:bigint;
}
export const ANSWER_PREFIX="The user answered exactly this earlier async question through Discord. Apply this selection only to this question; other questions remain unanswered.";
const BODY:StructShape={fields:[["index","u64"],["source_text","string"],["title","string"],["options","string[]"]],defaults:{source_text:""}};
export function decodeQuestionBody(raw:string):QuestionBody {
  const body=parseSerdeStruct(raw,BODY);
  return {index:body.index as bigint,source_text:body.source_text as string,title:body.title as string,options:body.options as string[]};
}
export function answerPrompt(q:SealedQuestion,option:bigint):string {
  if(typeof option!=="bigint"||option<0n||option>=BigInt(q.body.options.length)) throw new StoreIntegrityError("invalid sealed answer option");
  const data={thread_id:q.thread_id,original_turn_id:q.turn_id,question_item_id:q.item_id,question_index:q.body.index,
    question_title:q.body.title,selected_option_index:option,selected_option:q.body.options[Number(option)]!};
  return ANSWER_PREFIX+"\n"+serializeSerdeValue(data);
}
