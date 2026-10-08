import {types} from 'node:util';
/** Gateway contracts accept owned data, never execute input accessors/coercions. */
export function gatewayOwnField(input:unknown,key:string):unknown{
 if(input===null||typeof input!=='object'||types.isProxy(input))throw new TypeError('Expected gateway data record');
 const field=Object.getOwnPropertyDescriptor(input,key);if(field===undefined||!Object.hasOwn(field,'value'))throw new TypeError('Expected own gateway data field');return field.value;
}
export function gatewayId(value:unknown):bigint{if(typeof value!=='bigint'||value<=0n||value>=(1n<<64n))throw new TypeError('Expected gateway nonzero u64 identity');return value;}
