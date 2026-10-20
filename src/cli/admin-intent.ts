import {parseSerdeValue} from '../core/serde-json-parse.ts';
import {serdeValueEqual} from '../core/serde-value-equal.ts';
/** Saved lifecycle facts only. A consistent record never proves a current
 * route, completed effect, or permission to replay stop/archive. */
export function inspectLifecycleIntent(metadata:Record<string,any>,encoded:string|null){
 let payload:any=null;try{const value=encoded===null?null:parseSerdeValue(encoded);if(value!==null&&typeof value==='object'&&!Array.isArray(value))payload=value;}catch{}
 const binding=payload?.lifecycle_binding,command=payload?.plan?.Execute;
 let control:{kind:string;explicit:boolean}|null=null;
 if(command!==null&&typeof command==='object'&&!Array.isArray(command)&&Object.keys(command).length===1){
  const kind=Object.keys(command)[0]!,fields=command[kind];
  if(['Stop','Archive'].includes(kind)&&fields!==null&&typeof fields==='object'&&!Array.isArray(fields)&&Object.keys(fields).length===1&&Object.hasOwn(fields,'reference')){
   if(fields.reference===null)control={kind,explicit:false};else if(typeof fields.reference==='string'&&fields.reference.trim()!=='')control={kind,explicit:true};
  }
 }
 const route=['Explicit','Mapped','Selected'].includes(binding?.route)?binding.route:null;
 const shape=binding!==null&&typeof binding==='object'&&!Array.isArray(binding)&&Object.keys(binding).length===3&&typeof binding.target==='string'&&binding.target.trim()!==''&&Buffer.byteLength(binding.target)<=512;
 const target=!!shape&&binding.target===metadata.thread_id,commandMatches=control!==null&&binding!==undefined&&Object.hasOwn(binding??{},'command')&&serdeValueEqual(command,binding.command);
 const source=metadata.kind==='message'&&typeof metadata.event_id==='bigint'&&metadata.event_id>0n&&metadata.source_message_id===metadata.event_id&&metadata.ingress_id===`message:${metadata.event_id}`&&metadata.channel_id>0n&&metadata.owner_user_id>0n&&metadata.owner_kind===null&&metadata.owner_id===null&&payload?.version===1n;
 const consistent=source&&target&&commandMatches&&(route==='Explicit'?control?.explicit===true:['Mapped','Selected'].includes(route)&&control?.explicit===false);
 return {diagnostic_only:true,replay_authorized:false,live_route_verified:false,effect_verified:false,payload_status:encoded===null?'unavailable':payload===null?'invalid':'valid',binding_presence:binding===undefined?payload===null?'unknown':'missing':binding===null?'null':typeof binding==='object'&&!Array.isArray(binding)?'object':'invalid',declared_control:control?.kind??'unknown_or_other',route,stored_source_envelope_consistent:source,stored_target_matches:target,stored_command_matches:commandMatches,stored_custody_consistent:consistent,disposition:consistent?'preserve_reconcile_original_effect':'preserve_require_fresh_bound_intent',existing_obligations_preserved:true};
}
