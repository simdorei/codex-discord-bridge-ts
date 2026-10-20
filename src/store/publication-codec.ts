import {createHash} from 'node:crypto';
import {parseSerdeField, type StructFieldDecoder, type StructShape} from '../core/serde-struct-json.ts';
import {serializeSerdeValue} from '../core/serde-json.ts';
import {cloneOwnedSerdeValue} from '../core/owned-serde-value.ts';
export interface PublicationProposal {readonly id:string;readonly revision:bigint;readonly job_id:string;readonly thread_id:string;readonly owner_user_id:bigint;readonly channel_id:bigint;readonly application_id:bigint;readonly created_at_bits:bigint;readonly expires_at_bits:bigint;readonly review_text:string;readonly review_sha256:string}
export interface StoredPublicationProposal {readonly version:bigint;readonly proposal:PublicationProposal;readonly snapshot:unknown;readonly review_context:unknown}
const proposalShape:StructShape={fields:[['id','string'],['revision','i64'],['job_id','string'],['thread_id','string'],['owner_user_id','i64'],['channel_id','i64'],['application_id','i64'],['created_at_bits','u64'],['expires_at_bits','u64'],['review_text','string'],['review_sha256','string']]};
function strict(shape:StructShape):StructFieldDecoder{return (raw,_depth,context)=>{
  if(raw.trimStart().startsWith('['))return context.struct(shape);
  const values:Record<string,unknown>=Object.create(null),fields=new Map(shape.fields);
  context.map((key,decode)=>{const field=fields.get(key);if(field===undefined)throw new SyntaxError('Unknown publication field: '+key);if(Object.hasOwn(values,key))throw new SyntaxError('Duplicate publication field: '+key);values[key]=decode(field);});
  for(const [key]of shape.fields)if(!Object.hasOwn(values,key))throw new SyntaxError('Missing publication field: '+key);return values;
};}
const storedShape:StructShape={fields:[['version','i64'],['proposal',strict(proposalShape)],['snapshot','value'],['review_context','value']]};
export function parseStoredPublicationProposal(raw:string):StoredPublicationProposal{return cloneOwnedSerdeValue(parseSerdeField(raw,strict(storedShape))) as StoredPublicationProposal;}
function record(value:unknown,shape:StructShape):Record<string,unknown>{
  if(value===null||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==shape.fields.length||shape.fields.some(([key])=>!Object.hasOwn(value,key)))throw new TypeError('Expected exact publication struct fields');return value as Record<string,unknown>;
}
/** Derive-Serialize declaration order, not BTreeMap order. Nested Value objects
 * continue to use the existing lossless Serde serializer. */
export function serializeStoredPublicationProposal(input:StoredPublicationProposal):string{
  const value=record(cloneOwnedSerdeValue(input),storedShape),proposal=record(value.proposal,proposalShape);
  const encodedProposal='{'+proposalShape.fields.map(([key])=>JSON.stringify(key)+':'+serializeSerdeValue(proposal[key])).join(',')+'}';
  const raw='{'+storedShape.fields.map(([key])=>JSON.stringify(key)+':'+(key==='proposal'?encodedProposal:serializeSerdeValue(value[key]))).join(',')+'}';
  parseStoredPublicationProposal(raw);return raw;
}
export const publicationDigest=(text:string):string=>createHash('sha256').update(text,'utf8').digest('hex');
export function publicationTimeBits(value:number):bigint{if(typeof value!=='number')throw new TypeError('Expected f64 timestamp');const b=Buffer.alloc(8);b.writeDoubleBE(value);return b.readBigUInt64BE();}
export function publicationTimeFromBits(value:bigint):number{if(typeof value!=='bigint'||value<0n||value>=1n<<64n)throw new TypeError('Expected u64 timestamp bits');const b=Buffer.alloc(8);b.writeBigUInt64BE(value);return b.readDoubleBE();}
export const validPublicationId=(id:string):boolean=>typeof id==='string'&&id.length===32&&/^[0-9a-f]{32}$/u.test(id);
