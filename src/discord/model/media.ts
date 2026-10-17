import {parseSerdeField,type StructField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake,modelStruct as struct,modelVector as vector,modelShape as shape} from './fields.ts';
import {modelTimestamp} from './timestamp.ts';
const attachmentFlags:StructFieldDecoder=(_raw,_depth,context)=>(context.decode(unsigned(64)) as bigint)&4n;
const attachmentFields:readonly (readonly [string,StructField])[]=[['content_type','string?'],['ephemeral','bool'],['duration_secs',option('f64')],['filename','string'],['flags',option(attachmentFlags)],['description','string?'],['height',option(unsigned(64))],['id',modelSnowflake],['proxy_url','string'],['size','u64'],['title','string?'],['url','string'],['waveform','string?'],['width',option(unsigned(64))]];
export const discordAttachmentField=struct(shape(attachmentFields,['content_type','duration_secs','flags','description','height','title','waveform','width'],{ephemeral:false}));
const author=struct(shape([['icon_url','string?'],['name','string'],['proxy_icon_url','string?'],['url','string?']],['icon_url','proxy_icon_url','url']));
const field=struct(shape([['inline','bool'],['name','string'],['value','string']],[],{inline:false}));
const footer=struct(shape([['icon_url','string?'],['proxy_icon_url','string?'],['text','string']],['icon_url','proxy_icon_url']));
const imageFields:readonly (readonly [string,StructField])[]=[['height',option(unsigned(64))],['proxy_url','string?'],['url','string'],['width',option(unsigned(64))]];
const image=struct(shape(imageFields,['height','proxy_url','width']));
const provider=struct(shape([['name','string?'],['url','string?']],['name','url']));
const video=struct(shape([['height',option(unsigned(64))],['proxy_url','string?'],['url','string?'],['width',option(unsigned(64))]],['height','proxy_url','url','width']));
export const discordEmbedField=struct(shape([
 ['author',option(author)],['color',option(unsigned(32))],['description','string?'],['fields',vector(field)],['footer',option(footer)],['image',option(image)],['type','string'],['provider',option(provider)],['thumbnail',option(image)],['timestamp',option(modelTimestamp)],['title','string?'],['url','string?'],['video',option(video)],
],['author','color','description','footer','image','provider','thumbnail','timestamp','title','url','video'],{color:null,fields:[]}));
export function decodeDiscordAttachment(text:string):Record<string,unknown>{return parseSerdeField(text,discordAttachmentField) as Record<string,unknown>;}
export function decodeDiscordEmbed(text:string):Record<string,unknown>{return parseSerdeField(text,discordEmbedField) as Record<string,unknown>;}
