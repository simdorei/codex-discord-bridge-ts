import {parseSerdeField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {formatRustF64Display} from '../../core/rust-f64-display.ts';
import {modelOption as option,modelUnsigned as unsigned,modelSnowflake as id,modelStruct as struct,modelVector as vector,modelShape as shape,unsignedText} from './fields.ts';
import {discordInteractionResolvedField} from './interaction-resolved.ts';
const u8=unsigned(8),MIN=-(1n<<63n),MAX=(1n<<63n)-1n;
const commandType:StructFieldDecoder=(_raw,_depth,context)=>{const kind=context.decode(u8) as bigint;if(kind<1n||kind>11n)throw new SyntaxError('Unknown command option type');return kind;};
type Envelope={kind:'Boolean';value:boolean}|{kind:'Integer';value:bigint}|{kind:'Number';value:number}|{kind:'String';value:string};
const envelope:StructFieldDecoder=(_raw,_depth,context):Envelope=>{const value=context.value();if(typeof value==='boolean')return {kind:'Boolean',value};if(typeof value==='string')return {kind:'String',value};if(typeof value==='bigint'&&value>=MIN&&value<=MAX)return {kind:'Integer',value};if((typeof value==='number'||typeof value==='bigint')&&Number.isFinite(Number(value)))return {kind:'Number',value:Number(value)};throw new SyntaxError('Invalid command value envelope');};
const names=['','SubCommand','SubCommandGroup','String','Integer','Boolean','User','Channel','Role','Mentionable','Number','Attachment'];
/** Map-only custom option visitor; repeated empty options and null focused leave
 * their source duplicate guards open. All known fields validate before selection. */
export const discordCommandOptionField:StructFieldDecoder=(_raw,_depth,context)=>{
 let name:string|undefined,type:bigint|undefined,value:Envelope|undefined,focused:boolean|null=null,options:unknown[]=[];
 context.map((key,decode)=>{switch(key){
  case 'name':if(name!==undefined)throw new SyntaxError('Duplicate option name');name=decode('string') as string;break;
  case 'type':if(type!==undefined)throw new SyntaxError('Duplicate option type');type=decode(commandType) as bigint;break;
  case 'value':if(value!==undefined)throw new SyntaxError('Duplicate option value');value=decode(envelope) as Envelope;break;
  case 'focused':if(focused!==null)throw new SyntaxError('Duplicate option focused');focused=decode(option('bool')) as boolean|null;break;
  case 'options':if(options.length!==0)throw new SyntaxError('Duplicate nonempty options');options=decode(vector(discordCommandOptionField)) as unknown[];break;
 }});
 if(name===undefined||type===undefined)throw new SyntaxError('Missing command option name/type');
 if(focused){if(value===undefined)throw new SyntaxError('Missing focused value');const text=value.kind==='Number'?formatRustF64Display(value.value):String(value.value);return Object.assign(Object.create(null),{name,type,kind:'Focused',value:text});}
 const result:Record<string,unknown>=Object.assign(Object.create(null),{name,type,kind:names[Number(type)]});
 if(type===1n||type===2n){result.value=options;return result;}
 if(value===undefined)throw new SyntaxError('Missing command option value');
 if(type===3n&&value.kind==='String'||type===4n&&value.kind==='Integer'||type===5n&&value.kind==='Boolean')result.value=value.value;
 else if(type===10n&&(value.kind==='Integer'||value.kind==='Number'))result.value=Number(value.value);
 else if([6n,7n,8n,9n,11n].includes(type)&&value.kind==='String'){const snowflake=unsignedText(value.value,64);if(snowflake===0n)throw new SyntaxError('Zero command option ID');result.value=snowflake;}
 else throw new SyntaxError('Command option value/type mismatch');return result;
};
export const discordCommandDataField=struct(shape([['guild_id',option(id)],['id',id],['name','string'],['type',u8],['options',vector(discordCommandOptionField)],['resolved',option(discordInteractionResolvedField)],['target_id',option(id)]],['guild_id','resolved','target_id'],{options:[]}));
export function decodeDiscordCommandData(text:string):Record<string,unknown>{return parseSerdeField(text,discordCommandDataField) as Record<string,unknown>;}
