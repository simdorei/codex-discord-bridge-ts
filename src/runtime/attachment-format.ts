import {types} from 'node:util';
import {requireDiscordText} from '../discord/text.ts';
import {rustTrim} from '../app-server/value.ts';
import {gatewayOwnField} from '../discord/gateway/values.ts';
const TEXT_EXTENSIONS=new Set(['bat','cmd','css','csv','html','ini','js','json','log','md','ps1','py','rs','sh','toml','ts','tsx','txt','xml','yaml','yml']);
const asciiLower=(s:string)=>s.replace(/[A-Z]/g,c=>c.toLowerCase());
function leaf(path:string):string{if(process.platform==='win32')throw new TypeError('Windows attachment path grammar is not implemented');const parts=path.split('/').filter(p=>p!==''&&p!=='.'),last=parts.at(-1);return last===undefined||last==='..'?'':last;}
/** Rust Unix Path file_name + ASCII filename projection. No file is opened. */
export function sanitizeAttachmentFilename(filename:string,index:bigint|number):string {
 requireDiscordText(filename);if(typeof index!=='bigint'&&(typeof index!=='number'||!Number.isSafeInteger(index)))throw new TypeError('Expected lossless usize index');const i=BigInt(index);if(i<0n||i>=1n<<64n)throw new RangeError('Expected u64 usize index');
 const safe=Array.from(leaf(filename),c=>/^[a-zA-Z0-9._ -]$/.test(c)?c:'_').join('').replace(/^[ .]+|[ .]+$/g,'').slice(0,120);return safe===''?`attachment-${i}`:safe;
}
export function isTextAttachment(filename:string,contentType:string|null):boolean {
 requireDiscordText(filename);if(contentType!==null){requireDiscordText(contentType);if(asciiLower(contentType).startsWith('text/'))return true;}
 const name=leaf(filename),dot=name.lastIndexOf('.');return dot>0&&TEXT_EXTENSIONS.has(asciiLower(name.slice(dot+1)));
}
function vector(value:unknown):readonly unknown[]{if(!Array.isArray(value)||types.isProxy(value))throw new TypeError('Expected owned vector data');return value;}
/** Pure source rendering only: not proof of download, hashing or durable input. */
export function renderAttachmentPrompt(basePrompt:string,detailsInput:readonly string[],previewsInput:readonly (readonly [string,string])[]):string {
 requireDiscordText(basePrompt);const details=vector(detailsInput),previews=vector(previewsInput),captured:string[]=[],pairs:[string,string][]=[];
 for(let i=0;i<details.length;i++){const value=gatewayOwnField(details,String(i));requireDiscordText(value);captured.push(value);}
 if(captured.length===0)return basePrompt;
 for(let i=0;i<previews.length;i++){const pair=vector(gatewayOwnField(previews,String(i)));if(pair.length!==2)throw new TypeError('Expected filename/preview pair');const name=gatewayOwnField(pair,'0'),text=gatewayOwnField(pair,'1');requireDiscordText(name);requireDiscordText(text);pairs.push([name,text]);}
 const lines=[rustTrim(basePrompt),'','Discord attachments saved locally:',captured.join('\n')];if(pairs.length!==0){lines.push('','Attachment text previews:');for(const [name,text] of pairs)lines.push(`--- ${name} ---\n\`\`\`text\n${text}\n\`\`\``);}return rustTrim(lines.join('\n'));
}
