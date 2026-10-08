import {parseSerdeField,type StructField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelStruct as struct,modelVector as vector,modelShape as shape,unsignedText} from './fields.ts';
import {discordInteractionResolvedField} from './interaction-resolved.ts';
const u8=unsigned(8);
const signed32:StructFieldDecoder=(_raw,_depth,context)=>{const value=context.decode('i64') as bigint;if(value<-(1n<<31n)||value>=(1n<<31n))throw new SyntaxError('Expected modal i32 id');return value;};
function valueId(value:unknown):bigint{const result=typeof value==='string'?unsignedText(value,64):value;if(typeof result!=='bigint'||result<=0n||result>=(1n<<64n))throw new SyntaxError('Expected modal selection snowflake');return result;}
/** Dedicated incoming modal visitor, not the outgoing message Component schema.
 * Every known field is decoded before variant selection, including Unknown.
 * id is required even for Unknown, although that variant discards its value. */
export const discordModalComponentField:StructFieldDecoder=(_raw,_depth,context)=>{
 const fields=new Map<string,StructField>([['component',discordModalComponentField],['components',vector(discordModalComponentField)],['custom_id','string'],['id',signed32],['type',u8],['value','string'],['values',vector('value')]]);
 const data:Record<string,unknown>=Object.create(null);
 context.map((key,decode)=>{const field=fields.get(key);if(field===undefined)return;if(Object.hasOwn(data,key))throw new SyntaxError(`Duplicate modal field: ${key}`);data[key]=decode(field);});
 const required=(key:string):unknown=>{if(!Object.hasOwn(data,key))throw new SyntaxError(`Missing modal field: ${key}`);return data[key];};
 const type=required('type') as bigint,id=required('id') as bigint,result:Record<string,unknown>=Object.assign(Object.create(null),{type,id});
 switch(type){
  case 1n:result.components=required('components');break;
  case 3n:case 5n:case 6n:case 7n:case 8n:case 19n:
   result.custom_id=required('custom_id');result.values=(required('values') as unknown[]).map(value=>{if(type===3n){if(typeof value!=='string')throw new SyntaxError('Expected modal string selection');return value;}return valueId(value);});break;
  case 4n:result.custom_id=required('custom_id');result.value=required('value');break;
  case 10n:break;
  case 18n:result.component=required('component');break;
  default:return Object.assign(Object.create(null),{type});
 }
 return result;
};
export const discordModalDataField=struct(shape([['components',vector(discordModalComponentField)],['custom_id','string'],['resolved',option(discordInteractionResolvedField)]],['resolved']));
export const discordMessageComponentDataField=struct(shape([['custom_id','string'],['component_type',u8],['resolved',option(discordInteractionResolvedField)],['values','string[]']],['resolved'],{values:[]}));
export function decodeDiscordModalData(text:string):Record<string,unknown>{return parseSerdeField(text,discordModalDataField) as Record<string,unknown>;}
