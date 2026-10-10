import type {IngressKind} from "./ingress-read.ts";
/** Internal parsed-value contract. Transport adapters must parse JSON before admission. */
export interface NewIngress {
  ingressId:string;kind:IngressKind;eventId:bigint|null;applicationId:bigint|null;
  channelId:bigint;ownerUserId:bigint;sourceMessageId:bigint|null;payload:unknown;
  targetThreadId:string|null;canonicalOwner:string|null;now:number;
}

import {types} from "node:util";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
/** Snapshot before the owned adapter's first await. Payload follows the parsed-value contract above. */
export function snapshotNewIngress(input:NewIngress):NewIngress{
  if(input===null||typeof input!=="object"||types.isProxy(input))throw new TypeError("Expected ingress data");
  const field=(key:string):unknown=>{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own ingress field");return d.value;};
  const text=(v:unknown):string=>{if(typeof v!=="string"||/[\uD800-\uDFFF]/u.test(v))throw new TypeError("Expected well-formed text");return v;};
  const integer=(v:unknown):bigint=>{if(typeof v!=="bigint"||v<-(1n<<63n)||v>=(1n<<63n))throw new TypeError("Expected i64 identity");return v;};
  const optInteger=(v:unknown)=>v===null?null:integer(v),optText=(v:unknown)=>v===null?null:text(v);
  const kind=field("kind"),now=field("now");if(kind!=="message"&&kind!=="interaction"&&kind!=="action")throw new TypeError("Expected ingress kind");if(typeof now!=="number")throw new TypeError("Expected numeric timestamp");
  return {ingressId:text(field("ingressId")),kind,eventId:optInteger(field("eventId")),applicationId:optInteger(field("applicationId")),channelId:integer(field("channelId")),
    ownerUserId:integer(field("ownerUserId")),sourceMessageId:optInteger(field("sourceMessageId")),payload:parseSerdeValue(serializeSerdeValue(field("payload"))),targetThreadId:optText(field("targetThreadId")),canonicalOwner:optText(field("canonicalOwner")),now};
}
