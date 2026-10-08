import {parseSerdeStruct,type StructShape} from "../../core/serde-struct-json.ts";
import {serializeSerdeValue} from "../../core/serde-json.ts";
import {cloneOwnedSerdeValue} from "../../core/owned-serde-value.ts";
import {serdeObject,serdeField} from "../../app-server/value.ts";
import type {BridgeState} from "../bridge-state.ts";
import {StateAccessFacade,type IStateAccessFacade} from "../../store/state-access-facade.ts";
import {InvalidActionRequestError} from "./errors.ts";
export interface FrozenSettingsBinding{readonly target:string;readonly route:"Explicit"|"Mapped"|"Selected";readonly command:unknown}
const SHAPE:StructShape={fields:[["target","string"],["route","value"],["command","value"]]};
/** Decode an already admitted binding. Does not resolve references or authorize
 * arbitrary command input; original ingress/store validation remains mandatory. */
export function snapshotSettingsBinding(input:unknown):FrozenSettingsBinding{
  let b:Record<string,unknown>;try{b=parseSerdeStruct(serializeSerdeValue(input),SHAPE);}catch{throw new InvalidActionRequestError("invalid stored settings binding");}
  let route=b.route;if(serdeObject(route)&&Object.keys(route).length===1){const key=Object.keys(route)[0]!;if(serdeField(route,key)===null)route=key;}
  if(route!=="Explicit"&&route!=="Mapped"&&route!=="Selected")throw new InvalidActionRequestError("invalid stored settings route");
  return cloneOwnedSerdeValue({target:b.target,route,command:b.command}) as FrozenSettingsBinding;
}
export function validateSelectedSettingsSnapshot(binding:FrozenSettingsBinding,bridge:Pick<BridgeState,"selectedThreadId">):void{
  if(binding.route==="Selected"&&bridge.selectedThreadId()!==binding.target)throw new InvalidActionRequestError("selected target changed after admission; no replacement will be used");
}
/** Current route check only. Full Codex thread-reference resolution is separate. */
export async function validateLifecycleSettingsSnapshot(path:string,binding:FrozenSettingsBinding,channel:bigint,bridge:Pick<BridgeState,"selectedThreadId">,state:Pick<IStateAccessFacade,"mirroredThreadId">=StateAccessFacade):Promise<void>{
  const valid=binding.route==="Explicit"?true:binding.route==="Mapped"?(await state.mirroredThreadId(path,channel))===binding.target:(await state.mirroredThreadId(path,channel))===null&&bridge.selectedThreadId()===binding.target;
  if(!valid)throw new InvalidActionRequestError("lifecycle target changed after admission; no replacement target will be used");
}
