import {requireDiscordText} from "./text.ts";
export type DiscordFaultKind="BuildingRequest"|"CreatingHeader"|"Json"|"Unauthorized"|"Validation"|"Response"|"Receipt"|"Transport";
export interface DiscordFaultData {readonly kind:DiscordFaultKind;readonly status:number|null;readonly display:string}
const faults=new WeakMap<object,DiscordFaultData>();
/** Only trusted transport code may classify these failures. Detail must be public-safe and contain no credentials. */
export class DiscordTransportFault extends Error{
  constructor(kind:DiscordFaultKind,detail:string,status:number|null=null){
    requireDiscordText(detail);if(!["BuildingRequest","CreatingHeader","Json","Unauthorized","Validation","Response","Receipt","Transport"].includes(kind))throw new TypeError("Unknown Discord fault kind");
    if(kind==="Response"&&(!Number.isInteger(status)||status===null||status<100||status>999))throw new TypeError("Expected HTTP response status");
    const display=kind==="Receipt"?`Discord message receipt decode failed: ${detail}`:`Discord HTTP request failed: ${detail}`;super(display);this.name="DiscordTransportFault";faults.set(this,Object.freeze({kind,status,display}));
  }
}

/** Passive brand lookup; proxies, inherited prototypes and name/code forgery grant no classification. */
export function ownedDiscordTransportFault(error:unknown):DiscordFaultData|undefined{return error!==null&&(typeof error==="object"||typeof error==="function")?faults.get(error):undefined;}
