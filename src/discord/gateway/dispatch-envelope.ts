import {parseSerdeField,type StructField,type StructFieldDecoder} from '../../core/serde-struct-json.ts';
import {scanGatewayPacket} from './packet-control.ts';

/** Bounded dispatch envelope, using the pinned Twilight metadata scan to select
 * the event type and the actual map's s field to validate its sequence. Unknown
 * envelope values are ignored without materializing a generic JSON Value.
 * The trusted payload schema runs in the SAME recursion/numeric context: parsing
 * d separately would reset depth and serializing it would alter f64 semantics.
 * This is not an all-event dispatcher or an authorization decision. */
export function decodeGatewayDispatchPayload(text:string,expectedType:string,payload:StructField):unknown {
 const metadata=scanGatewayPacket(text);
 if(metadata.opcode!==0||metadata.eventType!==expectedType)throw new SyntaxError('Unexpected Gateway dispatch type');
 const envelope:StructFieldDecoder=(_raw,_depth,context)=>{
  let hasData=false,hasSequence=false,data:unknown;
  context.map((key,decode)=>{
   if(key==='d'){
    if(hasData)throw new SyntaxError('Duplicate Gateway dispatch data');
    data=decode(payload);hasData=true;
   }else if(key==='s'){
    if(hasSequence)throw new SyntaxError('Duplicate Gateway dispatch sequence');
    decode('u64');hasSequence=true;
   }
  });
  if(!hasData||!hasSequence)throw new SyntaxError('Missing Gateway dispatch data or sequence');
  return data;
 };
 return parseSerdeField(text,envelope);
}
