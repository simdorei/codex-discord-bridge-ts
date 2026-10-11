import {it} from 'node:test';import assert from 'node:assert/strict';
import {serializeSerdeValue} from '../../src/core/serde-json.ts';
it('Serde serialization never reads inherited get or set on own data descriptors',()=>{
 const beforeGet=Object.getOwnPropertyDescriptor(Object.prototype,'get'),beforeSet=Object.getOwnPropertyDescriptor(Object.prototype,'set');
 const descriptor=(fn:()=>undefined)=>{const d=Object.create(null) as PropertyDescriptor;d.get=fn;d.configurable=true;return d;};
 let hooks=0,output:unknown,error:unknown;
 const get=descriptor(()=>{hooks++;return undefined;}),set=descriptor(()=>{hooks++;return undefined;});
 const restore=(name:string,prior:PropertyDescriptor|undefined)=>{if(prior)Object.defineProperty(Object.prototype,name,prior);else delete (Object.prototype as Record<string,unknown>)[name];};
 Object.defineProperty(Object.prototype,'get',get);Object.defineProperty(Object.prototype,'set',set);
 try{output=serializeSerdeValue({items:[{value:1n}],text:'safe'});}catch(e){error=e;}
 finally{restore('get',beforeGet);restore('set',beforeSet);}
 assert.equal(error,undefined);assert.equal(hooks,0);assert.equal(output,'{"items":[{"value":1}],"text":"safe"}');
});
it('own accessors still reject without executing their bodies after descriptor hardening',()=>{
 let hooks=0;const record={get value(){hooks++;return 1n;}},array:unknown[]=[];Object.defineProperty(array,'0',{get(){hooks++;return 1n;},enumerable:true,configurable:true});
 assert.throws(()=>serializeSerdeValue(record),TypeError);assert.throws(()=>serializeSerdeValue(array),TypeError);assert.equal(hooks,0);
});
