import {readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
const dir=process.argv[2];
const lines=readFileSync(dir+"/stdout.ndjson","utf8").split(/\r?\n/).filter(Boolean);
const rows=lines.map(JSON.parse),metadata=rows.shift(),cases=rows;
if(metadata.metadata.case_count!==58||cases.length!==58)throw Error("Case count mismatch");
if(new Set(cases.map(x=>x.name)).size!==58)throw Error("Duplicate case names");
const summary=cases.map(x=>({name:x.name,ok:x.ok,error:x.error??null,rawSha256:createHash("sha256").update(x.raw,"utf8").digest("hex"),rawUtf8Bytes:Buffer.byteLength(x.raw,"utf8")}));
if(summary.some(x=>x.rawUtf8Bytes>12000))throw Error("Raw input bound exceeded");
const get=name=>{const row=cases.find(x=>x.name===name);if(!row)throw Error("Missing case "+name);return row};
for(const name of ["unknown_lone_surrogate","known_string_lone_surrogate","toplevel_key_lone_surrogate","nested_unknown_key_lone_surrogate"]){
 if(!get(name).raw.includes("\\uD800")||get(name).raw.includes("\ufffd"))throw Error("Raw surrogate fixture changed "+name);
}
if(!get("known_string_valid_surrogate_pair").raw.includes("\\uD83D\\uDE00"))throw Error("Pair not raw escaped");
writeFileSync(dir+"/cases.ndjson",cases.map(x=>JSON.stringify({name:x.name,raw:x.raw})).join("\n")+"\n");
const observed={metadata,caseCount:cases.length,accept:summary.filter(x=>x.ok).length,reject:summary.filter(x=>!x.ok).length,rawInputsPreserved:true,summaryOmitsTypedNumericValues:true,authoritativeTypedValues:"Unmodified stdout.ndjson contains exact Rust serde integer spellings",cases:summary};
writeFileSync(dir+"/observed-results.json",JSON.stringify(observed,null,2));
console.log(JSON.stringify({caseCount:observed.caseCount,accept:observed.accept,reject:observed.reject,observations:summary.filter(x=>/duplicate|missing_event|array_|i64_|enum_|e999|surrogate|256/.test(x.name)).map(x=>({name:x.name,ok:x.ok,error:x.error}))}));
