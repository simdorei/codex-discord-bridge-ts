import {types} from "node:util";
import type {StoredIngress} from "./ingress-read.ts";
import {parseSerdeValue} from "../core/serde-json-parse.ts";
import {serializeSerdeValue} from "../core/serde-json.ts";
import {serdeValueEqual} from "../core/serde-value-equal.ts";
const FIELDS=["ingressId","kind","eventId","applicationId","channelId","ownerUserId","sourceMessageId","payload","runtimeId","state","phase","targetThreadId","canonicalOwner","ownerKind","ownerId","outcome","confirmationDelivered","holdReason","createdAt","updatedAt"] as const;
export function snapshotStoredIngress(input:StoredIngress):StoredIngress{
  if(input===null||typeof input!=="object"||types.isProxy(input))throw new TypeError("Expected stored ingress data");
  const copied:Record<string,unknown>=Object.create(null);
  for(const field of FIELDS){const d=Object.getOwnPropertyDescriptor(input,field);if(!d||!Object.hasOwn(d,"value"))throw new TypeError("Expected own stored ingress field");copied[field]=d.value;}
  copied.payload=parseSerdeValue(serializeSerdeValue(copied.payload));if(copied.outcome!==undefined)copied.outcome=parseSerdeValue(serializeSerdeValue(copied.outcome));
  return copied as unknown as StoredIngress;
}
export function storedIngressEqual(a:StoredIngress,b:StoredIngress):boolean{return FIELDS.every(field=>field==="payload"||field==="outcome"?serdeValueEqual(a[field],b[field]):a[field]===b[field]);}
