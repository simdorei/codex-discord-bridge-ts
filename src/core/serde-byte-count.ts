import {types} from "node:util";
import {serializeSerdeValue} from "./serde-json.ts";
/** Serialized UTF-8 byte count with early rejection, without constructing a full JSON
 * string. Object key enumeration/JS representation overhead is not a heap bound. */
export function boundedSerdeByteCount(value:unknown,limit:number):number|null{
  if(!Number.isSafeInteger(limit)||limit<0)throw new RangeError("Expected finite byte budget");let count=0;const stack=new Set<object>();
  const refuse=()=>{throw new TypeError("Unsupported or over-budget Serde Value");};
  const add=(n:number)=>{if(count+n>limit)refuse();count+=n;};
  const string=(s:string)=>{add(2);for(const char of s){const cp=char.codePointAt(0)!;if(cp>=0xD800&&cp<=0xDFFF)refuse();add(cp===34||cp===92?2:cp<32?([8,9,10,12,13].includes(cp)?2:6):Buffer.byteLength(char,"utf8"));}};
  const field=(object:object,name:string):unknown=>{const d=Object.getOwnPropertyDescriptor(object,name);if(!d||!Object.hasOwn(d,"value")||!d.enumerable)refuse();return d!.value;};
  const visit=(v:unknown):void=>{
    if(v===null){add(4);return;}switch(typeof v){case "boolean":add(v?4:5);return;case "string":string(v);return;case "number":case "bigint":add(serializeSerdeValue(v).length);return;case "object":break;default:refuse();}
    const object=v as object;if(types.isProxy(object)||stack.has(object)||Object.getOwnPropertySymbols(object).length!==0)refuse();
    const names=Object.getOwnPropertyNames(object);stack.add(object);
    try{
      if(Array.isArray(object)){
        const len=object.length;if(names.length!==len+1)refuse();add(2);for(let i=0;i<len;i++){if(i>0)add(1);visit(field(object,String(i)));}
      }else{
        const proto=Object.getPrototypeOf(object);if(proto!==Object.prototype&&proto!==null)refuse();add(2);
        for(let i=0;i<names.length;i++){if(i>0)add(1);const name=names[i]!;string(name);add(1);visit(field(object,name));}
      }
    }finally{stack.delete(object);}
  };
  try{visit(value);return count;}catch{return null;}
}
