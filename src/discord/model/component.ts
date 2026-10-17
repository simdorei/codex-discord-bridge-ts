import {parseSerdeField,type StructField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake,modelStruct as struct,modelVector as vector,modelShape as shape} from './fields.ts';

const customEmoji=shape([['animated','bool'],['id',modelSnowflake],['name','string?']],['name'],{animated:false});
const unicodeEmoji=shape([['name','string']]);
/** Untagged Content is checked before either map-only variant is attempted. A
 * malformed custom identity may legitimately fall through to a Unicode name. */
export const discordEmojiField:StructFieldDecoder=(raw,_depth,context)=>{
 context.value();if(raw.trim()[0]!=='{')throw new SyntaxError('Expected emoji map');
 try{return {kind:'Custom',...context.struct(customEmoji)};}catch(error){if(!(error instanceof SyntaxError))throw error;}
 return {kind:'Unicode',...context.struct(unicodeEmoji)};
};
export const discordUnfurledMediaField=struct(shape([
 ['url','string'],['proxy_url','string?'],['height',option(unsigned(32))],['width',option(unsigned(32))],['content_type','string?'],
],['proxy_url','height','width','content_type']));
export const discordMediaGalleryItemField=struct(shape([
 ['media',discordUnfurledMediaField],['description','string?'],['spoiler',option('bool')],
],['description','spoiler']));
const selectOption=struct(shape([
 ['default','bool'],['description','string?'],['emoji',option(discordEmojiField)],['label','string'],['value','string'],
],['description','emoji'],{default:false}));
const tags=new Set(['user','role','channel']);
const stringTag:StructFieldDecoder=(_raw,_depth,context)=>{const value=context.decode('string');if(!tags.has(value as string))throw new SyntaxError('Unknown select default type');return value;};
const mapTag:StructFieldDecoder=(raw,_depth,context)=>{
 const value=context.value();if(typeof value==='string')return context.decode(stringTag);
 if(value===null||Array.isArray(value)||typeof value!=='object')throw new SyntaxError('Invalid select default type');
 const keys=Object.keys(value);if(keys.length!==1||!tags.has(keys[0]!))throw new SyntaxError('Unknown select default type');
 const tag=keys[0]!,decoded=context.struct(shape([[tag,'value']]));if(decoded[tag]!==null)throw new SyntaxError('Expected unit select default type');return tag;
};
const selectDefault:StructFieldDecoder=(raw,_depth,context)=>context.struct(shape([['type',raw.trim()[0]==='['?stringTag:mapTag],['id',modelSnowflake]]));
const signed32:StructFieldDecoder=(_raw,_depth,context)=>{const n=context.decode('i64') as bigint;if(n<-(1n<<31n)||n>=(1n<<31n))throw new SyntaxError('Expected i32');return n;};
const u8=unsigned(8),u16=unsigned(16),u32=unsigned(32);

/** The source visitor validates every recognized field before inspecting type,
 * even fields unused by a known variant or by Unknown. It accepts maps only.
 * Nullable default_values and sku_id are special: a null leaves the duplicate
 * guard empty. Other nullable fields count as seen even when their value is null. */
export const discordComponentField:StructFieldDecoder=(_raw,_depth,context)=>{
 const fields:ReadonlyMap<string,StructField>=new Map<string,StructField>([
  ['channel_types',vector(u8)],['components',vector(discordComponentField)],['custom_id',option('value')],
  ['default_values',option(vector(selectDefault))],['disabled','bool'],['emoji',option(discordEmojiField)],
  ['label','string?'],['max_length',option(u16)],['max_values',option(u8)],['min_length',option(u16)],['min_values',option(u8)],
  ['options',vector(selectOption)],['placeholder','string?'],['required',option('bool')],['style','value'],['type',u8],
  ['url','string?'],['sku_id',option(modelSnowflake)],['value','string?'],['id',signed32],['content','string'],
  ['items',vector(discordMediaGalleryItemField)],['divider','bool'],['spacing',u8],['file',discordUnfurledMediaField],
  ['spoiler','bool'],['accessory',discordComponentField],['media',discordUnfurledMediaField],['description','string?'],
  ['accent_color',option(u32)],['component',discordComponentField],
 ]);
 const data:Record<string,unknown>=Object.create(null);
 context.map((key,decode)=>{
  const field=fields.get(key);if(field===undefined)return;
  if(Object.hasOwn(data,key)&&!((key==='default_values'||key==='sku_id')&&data[key]===null))throw new SyntaxError(`Duplicate component field: ${key}`);
  data[key]=decode(field);
 });
 const required=(key:string):unknown=>{if(!Object.hasOwn(data,key))throw new SyntaxError(`Missing component field: ${key}`);return data[key];};
 const text=(key:string):string=>{const value=required(key);if(typeof value!=='string')throw new SyntaxError(`Expected component string: ${key}`);return value;};
 const style=(input:boolean):bigint=>{const value=required('style');if(typeof value!=='bigint'||value<0n||value>255n||(input&&value!==1n&&value!==2n))throw new SyntaxError('Invalid component style');return value;};
 const type=required('type') as bigint;
 const result:Record<string,unknown>=Object.assign(Object.create(null),{type,id:data.id??null});
 const copy=(keys:readonly string[]):void=>{for(const key of keys)result[key]=data[key]??null;};
 switch(type){
  case 1n:result.components=required('components');break;
  case 2n:
   result.style=style(false);if(data.custom_id!==undefined&&data.custom_id!==null)text('custom_id');
   copy(['custom_id','emoji','label','url','sku_id']);result.disabled=data.disabled??false;break;
  case 3n:case 5n:case 6n:case 7n:case 8n:
   result.custom_id=text('custom_id');if(type===3n)required('options');
   copy(['channel_types','default_values','max_values','min_values','options','placeholder','required']);result.disabled=data.disabled??false;break;
  case 4n:
   result.custom_id=text('custom_id');result.style=style(true);copy(['label','max_length','min_length','placeholder','required','value']);break;
  case 9n:result.components=required('components');result.accessory=required('accessory');break;
  case 10n:result.content=required('content');break;
  case 11n:result.media=required('media');copy(['description','spoiler']);break;
  case 12n:result.items=required('items');break;
  case 13n:result.file=required('file');copy(['spoiler']);break;
  case 14n:copy(['divider','spacing']);break;
  case 17n:result.components=required('components');copy(['accent_color','spoiler']);break;
  case 18n:result.label=text('label');result.component=required('component');copy(['description']);break;
  case 19n:result.custom_id=text('custom_id');copy(['max_values','min_values','required']);break;
  default:return Object.assign(Object.create(null),{type});
 }
 return result;
};
/** Validation model only; not component serialization or Discord request limits. */
export function decodeDiscordComponent(text:string):Record<string,unknown>{return parseSerdeField(text,discordComponentField) as Record<string,unknown>;}
