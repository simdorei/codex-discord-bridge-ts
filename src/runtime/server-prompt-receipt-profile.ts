import {types} from 'node:util';
/** Capture the installed receipt-only profile without invoking source accessors.
 * Direct callers retain compatibility unless they explicitly supply true. */
export function captureNativePromptReceipts(input:unknown):boolean {
 if(input===null||typeof input!=='object'||types.isProxy(input))throw new TypeError('Expected prompt receipt profile data');
 const field=Object.getOwnPropertyDescriptor(input,'nativePromptReceipts');
 if(field===undefined)return false;
 if(!Object.hasOwn(field,'value')||typeof field.value!=='boolean')throw new TypeError('Expected native prompt receipt profile flag');
 return field.value;
}
