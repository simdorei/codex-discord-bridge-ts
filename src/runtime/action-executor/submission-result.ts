import type {Submission} from "../queue-runner/saved-submission.ts";
import {INTERVIEW_HEADER} from "./interview-header.ts";
/** Pure no-UI result leaf; broader ActionUi variants are outside this presenter. */
export interface SubmissionActionResult {text:string;waitsForFinal:boolean;ui:null}
export function requestEcho(raw:string):string{
  if(typeof raw!=="string"||/[\uD800-\uDFFF]/u.test(raw))throw new TypeError("Expected well-formed prompt");
  const input=raw.startsWith(INTERVIEW_HEADER)?raw.slice(INTERVIEW_HEADER.length):raw;
  // Rust char::is_whitespace includes NEL and excludes BOM; JS \s differs.
  const normalized=input.split(/[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+/u).filter(Boolean).join(" ");
  const chars=Array.from(normalized);return chars.slice(0,120).join("")+(chars.length>120?"…":"");
}
export function submissionResult(threadId:string,source:string|null,submission:Submission,rawPrompt:string):SubmissionActionResult{
  const warning=submission.warning,origin=source===null?"":`\nsource: ${source}`;
  if(warning!==undefined){
    const prefix=`Codex request was not replayed${origin}\nthread_id: ${threadId}\njob_id: ${submission.jobId}`;
    let held:string|undefined;
    switch(warning.kind){
      case "Quarantined":held=`${prefix}\nstatus: quarantined ambiguous start\nreason: ${warning.message}`;break;
      case "ForkFenced":held=`${prefix}\nstatus: app-server fork outcome is unresolved\nreason: ${warning.message}\nsafety: duplicate fork or request replay was prevented`;break;
      case "StartingCandidatesHeld":held=`${prefix}\nstatus: target queue is held for manual resolution\nreason: ${warning.message}\nsafety: no turn was selected and no request was replayed`;break;
      case "ExecutionHeld":held=`${prefix}\nstatus: request is held pending resolution; no automatic replay${warning.ambiguous?"\nstart_outcome: this saved request may already have reached Codex; outcome remains unknown":""}\nreason: ${warning.message}\nsafety: no request replay was attempted`;break;
    }
    if(held!==undefined)return {text:held,waitsForFinal:false,ui:null};
    const header=warning.ambiguous?"Accepted Codex request; immediate start outcome is unknown and recovery will reconcile it":"Accepted Codex request; queued for automatic retry";
    const kind=warning.ambiguous?"ambiguous backend failure (the start may have reached Codex)":"definite backend failure";
    return {text:`${header}${origin}\nthread_id: ${threadId}\njob_id: ${submission.jobId}\nwarning_kind: ${kind}\nwarning: ${warning.message}`,waitsForFinal:true,ui:null};
  }
  const text=submission.queued?"Queued\nmessage: 앞선 작업이 끝나면 시작합니다.":submission.turnId!==null?`In progress\nmessage: ${requestEcho(rawPrompt)}`:"Preparing\nmessage: 작업 시작을 확인하고 있습니다.";
  return {text,waitsForFinal:true,ui:null};
}
