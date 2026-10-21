import {Ajv,type ValidateFunction} from 'ajv';
import {Ajv2019} from 'ajv/dist/2019.js';
import {Ajv2020} from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {serdeField,serdeObject} from './value.ts';
import {AppServerInvalidReplyError} from './client-errors.ts';

export const mcpInvalid=(message:string)=>new AppServerInvalidReplyError(message);
function checkSchemaExtensions(value:unknown):void{
 if(value===null||typeof value!=='object')return;
 if(serdeObject(value)&&(value.$async===true||['$ref','$dynamicRef','$recursiveRef'].some(key=>typeof value[key]==='string')))throw mcpInvalid('MCP forms must use synchronous, self-contained field schemas; the request remains pending.');
 for(const child of Object.values(value))checkSchemaExtensions(child);
}
/** No schema retrieval, coercion, defaults or removal of submitted properties. */
export function validationJson(value:unknown):unknown{
 const text=serializeSerdeValue(value);
 if(Buffer.byteLength(text)>65536)throw mcpInvalid('MCP form exceeds the 64 KiB input limit; the request remains pending.');
 const parsed:unknown=JSON.parse(text);
 const visit=(item:unknown,depth:number):void=>{
  if(depth>32)throw mcpInvalid('MCP form nesting exceeds the supported limit; the request remains pending.');
  if(typeof item==='number'&&(!Number.isFinite(item)||(Number.isInteger(item)&&!Number.isSafeInteger(item))))throw mcpInvalid('MCP numeric values must be within the exact integer range; use a string for a large identifier if the form permits it.');
  if(item!==null&&typeof item==='object')for(const child of Object.values(item))visit(child,depth+1);
 };visit(parsed,0);return parsed;
}
export function compileMcpFormSchema(params:unknown):{schema:Record<string,unknown>;validate:ValidateFunction}{
 const raw=serdeField(params,'requestedSchema');
 if(!serdeObject(raw)||serdeField(raw,'type')!=='object')throw mcpInvalid('MCP input needs an object schema; the request remains pending.');
 const schema=validationJson(raw) as Record<string,unknown>,draft=schema.$schema;
 checkSchemaExtensions(schema);
 const Constructor=typeof draft==='string'&&draft.includes('/2020-12/')?Ajv2020:typeof draft==='string'&&draft.includes('/2019-09/')?Ajv2019:Ajv;
 const engine=new Constructor({strict:false,allErrors:false,ownProperties:true,coerceTypes:false,useDefaults:false,removeAdditional:false,validateFormats:true});
 addFormats.default(engine);
 try{return {schema,validate:engine.compile(schema)};}
 catch{throw mcpInvalid('The MCP input schema is invalid or references an unavailable schema; the request remains pending.');}
}
