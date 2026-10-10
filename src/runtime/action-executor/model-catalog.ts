import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serdeField,serdeObject,rustTrim} from '../../app-server/value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {InvalidActionRequestError} from './errors.ts';
export const RESERVE_MODEL='gpt-reserve';
const lower=(s:string)=>s.replace(/[A-Z]/gu,c=>c.toLowerCase());
const rows=(v:unknown):readonly unknown[]=>{const data=serdeField(v,'data');return Array.isArray(data)?data.filter(r=>serdeField(r,'hidden')!==true):[];};
const name=(v:unknown):string|null=>{for(const key of ['model','id']){const s=serdeField(v,key);if(typeof s==='string'&&rustTrim(s)!=='')return rustTrim(s);}return null;};
export function reserveRequested(value:string):boolean{requireDiscordText(value);return [RESERVE_MODEL,'reserve','luna-reserve','Luna Reserve'].some(s=>lower(s)===lower(rustTrim(value)));}
export function canonicalModel(input:unknown,request:string):string{
 const catalog=cloneOwnedSerdeValue(input);requireDiscordText(request);const requested=reserveRequested(request)?RESERVE_MODEL:rustTrim(request),matches=new Set<string>();for(const row of rows(catalog)){const model=name(row),display=serdeField(row,'displayName');if(model!==null&&(lower(model)===lower(requested)||typeof display==='string'&&lower(display)===lower(requested)))matches.add(model);}if(matches.size===1)return [...matches][0]!;throw new InvalidActionRequestError(`model '${requested}' is not an unambiguous available model; use !settings --model to see available names`);
}
export function modelOptions(input:unknown,field:string|null):string {
 const catalog=cloneOwnedSerdeValue(input);if(field!==null)requireDiscordText(field);const models:string[]=[],efforts:string[]=[];for(const row of rows(catalog)){const model=name(row);if(model!==null&&!models.includes(model))models.push(model);const values=serdeField(row,'supportedReasoningEfforts');if(Array.isArray(values))for(const value of values){const effort=serdeField(value,'reasoningEffort');if(typeof effort==='string'&&!efforts.includes(effort))efforts.push(effort);}}
 let result:string;switch(field){case 'model':result=models.join('\n');break;case 'effort':case 'reasoning':result=efforts.join('\n');break;case 'speed':result='standard\nfast';break;case null:result=`model: ${models.join(', ')}\neffort: ${efforts.join(', ')}\nspeed: standard, fast`;break;default:throw new InvalidActionRequestError(`unknown settings field: ${field}`);}if(result==='')throw new InvalidActionRequestError('model/list returned no available options');return result;
}
export function modelEffortOptions(input:unknown,model:string):string{requireDiscordText(model);const matches=rows(cloneOwnedSerdeValue(input)).filter(r=>name(r)===model);if(matches.length!==1)throw new InvalidActionRequestError('target model has no unambiguous catalog entry; no effort options confirmed');return modelOptions({data:matches},'effort');}
export function validateModelEffort(input:unknown,model:string,effort:string):void{
 requireDiscordText(model);requireDiscordText(effort);const matches=rows(cloneOwnedSerdeValue(input)).filter(r=>name(r)===model);if(matches.length===0)throw new InvalidActionRequestError('current model is absent from model/list; effort cannot be verified');if(matches.length!==1)throw new InvalidActionRequestError('current model is ambiguous; effort cannot be verified');const values=serdeField(matches[0],'supportedReasoningEfforts');if(Array.isArray(values)&&values.some(v=>serdeField(v,'reasoningEffort')===effort))return;throw new InvalidActionRequestError('reasoning effort is not supported by the selected model; no settings update was sent');
}
const reserveError=(s:string)=>new InvalidActionRequestError(`Luna Reserve: ${s}; no settings update was sent`);
/** Detached current account snapshot, not a quota grant or automatic recovery. */
export function reserveSnapshot(input:unknown):Readonly<Record<string,unknown>>{
 const buckets=serdeField(cloneOwnedSerdeValue(input),'rateLimitsByLimitId');if(!serdeObject(buckets))throw reserveError('quota information unavailable');const candidates=Object.values(buckets).filter(r=>serdeField(r,'limitName')===RESERVE_MODEL);if(candidates.length===0)throw reserveError('no Reserve quota returned for this account');if(candidates.length!==1)throw reserveError('ambiguous Reserve quota');const row=candidates[0],normal=serdeField(row,'normalModelSlug');if(typeof normal!=='string'||rustTrim(normal)===''||normal===RESERVE_MODEL)throw reserveError('normal-model metadata unavailable');return row as Readonly<Record<string,unknown>>;
}
export function reserveCatalog(input:unknown,rates:unknown):unknown{
 const quota=reserveSnapshot(rates),blocked=serdeField(quota,'rateLimitReachedType'),spend=serdeField(quota,'spendControlReached');if(blocked!==undefined&&blocked!==null||spend!==undefined&&spend!==null&&spend!==false)throw reserveError('Reserve is blocked by the server');let observed=false;
 for(const key of ['primary','secondary']){const window=serdeField(quota,key);if(window===undefined||window===null)continue;const raw=serdeField(window,'usedPercent'),used=typeof raw==='number'?raw:typeof raw==='bigint'?Number(raw):NaN;if(!Number.isFinite(used)||used<0)throw reserveError('invalid quota window');if(used>=100)throw reserveError('Reserve quota exhausted');observed=true;}if(!observed)throw reserveError('Reserve capacity is unknown');
 const catalog=cloneOwnedSerdeValue(input),matches=rows(catalog).filter(r=>name(r)===quota.normalModelSlug);if(matches.length===0)throw reserveError('normal model missing from model/list');if(matches.length!==1)throw reserveError('normal model is ambiguous');const alias={...matches[0] as Record<string,unknown>,id:quota.limitName,model:quota.limitName,displayName:'Luna Reserve'},data=serdeField(catalog,'data');if(!Array.isArray(data))throw reserveError('model catalog unavailable');return cloneOwnedSerdeValue({...catalog as Record<string,unknown>,data:[...data.filter(r=>name(r)!==RESERVE_MODEL),alias]});
}
export function reserveEffort(catalog:unknown,explicit:string|null,previous:string|null):string{
 if(explicit!==null){validateModelEffort(catalog,RESERVE_MODEL,explicit);return explicit;}if(previous!==null){try{validateModelEffort(catalog,RESERVE_MODEL,previous);return previous;}catch(error){if(!(error instanceof InvalidActionRequestError))throw error;}}
 const row=rows(cloneOwnedSerdeValue(catalog)).find(r=>name(r)===RESERVE_MODEL),value=serdeField(row,'defaultReasoningEffort');if(typeof value!=='string')throw reserveError('supported default reasoning effort unavailable');validateModelEffort(catalog,RESERVE_MODEL,value);return value;
}
