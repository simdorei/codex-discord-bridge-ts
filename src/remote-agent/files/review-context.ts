/** Occurrence-based exceptions ported from the local Rust file redactor.
 * No exception applies to generic logs, diffs or credential masking. */
export function remoteReviewRanges(text:string,path:string):readonly (readonly [number,number])[]{
 const ranges:[number,number][]=[];
 const local=(value:string)=>value!==''&&!value.includes('://')&&!/[\p{Cc}?#]/u.test(value)&&(/[\\/]/u.test(value)||/\.(py|rs|json|md|exe|ps1|txt|log)$/u.test(value));
 const sensitive=(key:string)=>/secret|password|passwd|credential|token|api_key|apikey|api-key|authorization|private_key|private-key|access_key/i.test(key)||key.toLowerCase()==='pwd';
 if(path.endsWith('.py')){
  for(let i=0;i<text.length;){const char=text[i];
   if(char==='#'){while(i<text.length&&text[i]!=='\n')i++;}
   else if(char==='"'||char==="'"){const begin=i,width=text.slice(i,i+3)===char.repeat(3)?3:1;i+=width;const body=i;
    while(i<text.length){if(text[i]==='\\')i+=2;else if(text.slice(i,i+width)===char.repeat(width)){
     const value=text.slice(body,i),suffix=text.slice(i+width).trimStart();
     if(width===1&&(text.slice(0,begin).trimEnd().endsWith('/')&&local(value)||value==='InitializeProcThreadAttributeList'&&/^:\s*\((w|ctypes)\./u.test(suffix)))ranges.push([body,i]);i+=width;break;
    }else i++;}
   }else if(/[A-Za-z_]/u.test(char!)){const start=i;while(i<text.length&&/[A-Za-z0-9_]/u.test(text[i]!))i++;
    const prefix=text.slice(0,start).trimEnd(),suffix=text.slice(i).trimStart();if(prefix.endsWith('.')||/(def|class)$/u.test(prefix)&&/^[(:]/u.test(suffix))ranges.push([start,i]);
   }else i++;
  }
 }else if(path.endsWith('.json')){
  // Walk lexical occurrences as well as the parsed object. Duplicate keys or
  // mismatched syntax refuse all exceptions instead of blessing a hidden key.
  try{
   let cursor=text.startsWith('\uFEFF')?1:0;const root:unknown=JSON.parse(text.slice(cursor));
   const space=()=>{while(/[\x20\t\r\n]/u.test(text[cursor]??'!'))cursor++;};
   const take=(char:string)=>{space();if(text[cursor++]!==char)throw Error('syntax');};
   const string=():{value:string;range:[number,number]}=>{space();if(text[cursor]!=='"')throw Error('string');const begin=cursor++;while(cursor<text.length){if(text[cursor]==='\\')cursor+=2;else if(text[cursor++]==='"')return {value:JSON.parse(text.slice(begin,cursor)) as string,range:[begin+1,cursor-1]};}throw Error('string');};
   type Context={hidden?:boolean;length?:number;hashes?:boolean;path?:boolean};
   const walk=(value:unknown,context:Context,depth=0):void=>{if(depth>128)throw Error('depth');space();
    if(Array.isArray(value)){take('[');value.forEach((child,index)=>{if(index)take(',');walk(child,{hidden:context.hidden===true},depth+1);});take(']');}
    else if(value!==null&&typeof value==='object'){take('{');const object=value as Record<string,unknown>,seen=new Set<string>(),fileRecord=['path','source'].some(key=>typeof object[key]==='string'&&local(object[key] as string));
     Object.keys(object).forEach((_,index)=>{if(index)take(',');const {value:key,range}=string();if(seen.has(key)||!Object.hasOwn(object,key))throw Error('key');seen.add(key);take(':');
      const hidden=context.hidden===true||sensitive(key),entry=context.hashes===true&&local(key);if(entry&&!hidden)ranges.push(range);
      const length=key==='sha256'&&fileRecord||entry?64:key==='head'&&Object.hasOwn(object,'repository')&&Array.isArray(object.files)?40:undefined;
      walk(object[key],{hidden,...(length===undefined?{}:{length}),hashes:key==='source_hashes',path:['path','source','snapshot','repository','cwd'].includes(key)},depth+1);
     });take('}');
    }else if(typeof value==='string'){const parsed=string();if(parsed.value!==value)throw Error('value');if(!context.hidden&&(context.length!==undefined&&value.length===context.length&&/^[a-f0-9]+$/iu.test(value)||context.path&&local(value)))ranges.push(parsed.range);}
    else{const begin=cursor;while(cursor<text.length&&!/[\s,}\]]/u.test(text[cursor]!))cursor++;const decoded:unknown=JSON.parse(text.slice(begin,cursor));if(!Object.is(decoded,value)||typeof decoded==='number'&&!Number.isFinite(decoded))throw Error('literal');}
   };
   walk(root,{});space();if(cursor!==text.length)throw Error('trailing');
  }catch{return [];}
 }
 return ranges.sort((a,b)=>a[0]-b[0]);
}
