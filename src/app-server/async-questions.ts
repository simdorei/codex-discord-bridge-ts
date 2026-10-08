import {cloneOwnedSerdeValue} from "../core/owned-serde-value.ts";
import {parseSerdeStruct,type StructShape} from "../core/serde-struct-json.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {isAsyncAgentMessage} from "./outcomes.ts";
import {serdeField,rustTrim} from "./value.ts";
export {isAsyncAgentMessage} from "./outcomes.ts";
export interface AsyncQuestion{readonly title:string;readonly options:readonly string[]}
export interface AsyncQuestions{readonly threadId:string;readonly turnId:string;readonly itemId:string;readonly text:string;readonly questions:readonly AsyncQuestion[]}
export class AsyncQuestionParseError extends Error{readonly kind="AsyncQuestionParse";constructor(message:string){super(message);this.name="AsyncQuestionParseError";}}
const QUESTION:StructShape={fields:[["title","string"],["options","value"]],defaults:{options:null}};
/** Already decoded JSON input. Classification never depends on renderable choices.
 * Invalid vector bodies retain original text + serialized metadata as unsupported UI.
 * Typed decoder diagnostics use the shared TS Serde adapter; exact Rust error wording
 * for malformed struct bodies is not independently qualified. */
export function parseAsyncQuestions(input:unknown):AsyncQuestions|null{
 const params=cloneOwnedSerdeValue(input),item=serdeField(params,"item");if(!isAsyncAgentMessage(item))return null;
 const field=(value:unknown,key:string):string=>{const v=serdeField(value,key);if(typeof v!=="string"||rustTrim(v)==="")throw new AsyncQuestionParseError(`async question missing ${key}`);return v;};
 const rawText=serdeField(item,"text"),raw=serdeField(item,"questions");let text=typeof rawText==="string"?rawText:"",questions:AsyncQuestion[]=[];
 let error:string|null=null;
 if(raw!==undefined&&raw!==null){
  if(!Array.isArray(raw))error="invalid async questions: expected an array";
  else try{
   questions=raw.map(value=>{const q=parseSerdeStruct(serializeSerdeValue(value),QUESTION),options=q.options??[];if(!Array.isArray(options)||options.some(v=>typeof v!=="string"))throw new SyntaxError("Expected Serde nullable string vector");return {title:q.title as string,options:options as string[]};});
  }catch(cause){if(!(cause instanceof SyntaxError))throw cause;error=`invalid async questions: ${cause.message}`;questions=[];}
 }
 if(error!==null)text=`${text}\n질문 형식 오류: ${error}\n원문 질문 데이터: ${serializeSerdeValue(raw)}`;
 return cloneOwnedSerdeValue({threadId:field(params,"threadId"),turnId:field(params,"turnId"),itemId:field(item,"id"),text,questions}) as AsyncQuestions;
}
