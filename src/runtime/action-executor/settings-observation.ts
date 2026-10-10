import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serdeField,serdeObject,rustTrim} from '../../app-server/value.ts';
import {updateThreadSettings,type ThreadSettingsUpdate} from '../../app-server/requests.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {InvalidActionRequestError} from './errors.ts';
const invalid=(reason:string)=>new InvalidActionRequestError(`settings observation invalid: ${reason}; no verified success`);
function nullable(value:unknown,key:string):string|null {
 const field=serdeField(value,key);if(field===null)return null;
 if(typeof field==='string'&&rustTrim(field)!=='')return field;
 throw invalid('setting field missing or malformed');
}
/** Complete immutable server observation. Missing fields never imply defaults. */
export class ObservedSettings {
 readonly model:string;readonly effort:string|null;readonly tier:string|null;
 private constructor(model:string,effort:string|null,tier:string|null){this.model=model;this.effort=effort;this.tier=tier;Object.freeze(this);}
 static parse(input:unknown):ObservedSettings {
  const value=cloneOwnedSerdeValue(input),model=serdeField(value,'model');
  if(typeof model!=='string'||rustTrim(model)==='')throw invalid('model missing');
  return new ObservedSettings(model,nullable(value,'effort'),nullable(value,'serviceTier'));
 }
 static fromResume(input:unknown):ObservedSettings {
  const value=cloneOwnedSerdeValue(input);if(!serdeObject(value))throw invalid('resume is not an object');
  // Deliberately ignore any notification-shaped effort field in a resume.
  const settings:Record<string,unknown>={...value};delete settings.effort;
  if(Object.hasOwn(value,'reasoningEffort'))settings.effort=serdeField(value,'reasoningEffort');
  return ObservedSettings.parse(settings);
 }
 matches(update:ThreadSettingsUpdate):boolean {
  // The request builder validates and captures own data fields before comparison.
  const params=updateThreadSettings('',update).params;
  const model=serdeField(params,'model'),effort=serdeField(params,'effort'),tier=serdeField(params,'serviceTier');
  return (model===undefined||model===this.model)&&(effort===undefined||effort===this.effort)&&(tier===undefined||tier===this.tier);
 }
 display(thread:string,label:string):string {
  requireDiscordText(thread);requireDiscordText(label);
  const speed=this.tier===null||this.tier==='default'?'standard':this.tier==='priority'?'fast':this.tier;
  return `${label}\nthread: ${thread}\n모델: ${this.model}\n추론: ${this.effort??'모델 기본값'}\n속도: ${speed}`;
 }
}
Object.freeze(ObservedSettings.prototype);Object.freeze(ObservedSettings);
