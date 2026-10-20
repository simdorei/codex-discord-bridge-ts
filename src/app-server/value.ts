import {types} from "node:util";
/** Accessors for already-decoded Serde Value; not a general arbitrary-JS validator. */
export function serdeObject(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==="object"&&!types.isProxy(value)&&!Array.isArray(value);}
export function serdeField(value:unknown,key:string):unknown{if(!serdeObject(value))return undefined;const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,"value")?d.value:undefined;}
export const rustTrim=(value:string):string=>value.replace(/^\p{White_Space}+/u,"").replace(/\p{White_Space}+$/u,"");
export const trimmedText=(value:unknown):string=>typeof value==="string"?rustTrim(value):"";
