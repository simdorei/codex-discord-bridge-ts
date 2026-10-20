import {serdeObject,serdeField,trimmedText} from "./value.ts";
export type ThreadGoalStatus="Active"|"Paused"|"Blocked"|"UsageLimited"|"BudgetLimited"|"Complete";
export interface ThreadGoalUpdate{readonly threadId:string;readonly turnId:string|null;readonly status:ThreadGoalStatus}
export type GoalParseErrorKind="InvalidGoal"|"DifferentThread"|"InvalidStatus"|"UnknownStatus"|"MissingThreadId"|"UpdateDifferentThread";
const messages:Record<GoalParseErrorKind,string>={InvalidGoal:"thread/goal/get returned an invalid goal payload",DifferentThread:"thread/goal/get returned a goal for a different thread",InvalidStatus:"thread goal payload returned an invalid goal status",UnknownStatus:"thread goal payload returned an unknown goal status",MissingThreadId:"thread/goal/updated had no thread id",UpdateDifferentThread:"thread/goal/updated carried a goal for a different thread"};
export class GoalParseError extends Error{readonly kind:GoalParseErrorKind;constructor(kind:GoalParseErrorKind,detail?:string){super(kind==="UnknownStatus"?`${messages[kind]}: ${detail}`:messages[kind]);this.name="GoalParseError";this.kind=kind;}}
export function isTerminalGoalStatus(status:ThreadGoalStatus):boolean{return status==="Blocked"||status==="Complete";}
function status(value:unknown):ThreadGoalStatus{
  if(typeof value!=="string")throw new GoalParseError("InvalidStatus");
  switch(value){case "active":return "Active";case "paused":return "Paused";case "blocked":return "Blocked";case "usageLimited":return "UsageLimited";case "budgetLimited":return "BudgetLimited";case "complete":return "Complete";default:throw new GoalParseError("UnknownStatus",value);}
}
/** Goal/get uses exact thread identity; unlike update it does not trim this field. */
export function parseThreadGoalStatus(result:unknown,expectedThreadId:string):ThreadGoalStatus|null{
  const goal=serdeField(result,"goal");if(goal===undefined||goal===null)return null;if(!serdeObject(goal))throw new GoalParseError("InvalidGoal");
  if(serdeField(goal,"threadId")!==expectedThreadId)throw new GoalParseError("DifferentThread");return status(serdeField(goal,"status"));
}
export function parseThreadGoalUpdate(params:unknown):ThreadGoalUpdate{
  const threadId=trimmedText(serdeField(params,"threadId"));if(threadId==="")throw new GoalParseError("MissingThreadId");
  const goal=serdeField(params,"goal");if(!serdeObject(goal))throw new GoalParseError("InvalidGoal");if(trimmedText(serdeField(goal,"threadId"))!==threadId)throw new GoalParseError("UpdateDifferentThread");
  const parsed=status(serdeField(goal,"status")),turn=trimmedText(serdeField(params,"turnId"));return Object.freeze({threadId,turnId:turn===""?null:turn,status:parsed});
}
