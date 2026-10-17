import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import type {RemoteUtcDateTime} from './datetime.ts';

/** Chrono 0.4.45 DateTime<Utc> Serde formatter: RFC3339 AutoSi with Z,
 * signed expanded years and retained leap seconds. Only two passive own
 * bigint fields are read; this does not call caller coercions or toJSON. */
export function formatRemoteUtcDateTime(value:RemoteUtcDateTime):string{
 const seconds=own(value,'seconds'),nanosecond=own(value,'nanosecond');
 if(typeof seconds!=='bigint'||seconds< -8640000000000n||seconds>8640000000000n||typeof nanosecond!=='bigint'||nanosecond<0n||nanosecond>=2000000000n)throw new TypeError('Invalid UTC datetime');
 const date=new Date(Number(seconds)*1000),year=date.getUTCFullYear();
 if(!Number.isFinite(year)||year< -262143||year>262142)throw new RangeError('UTC datetime outside Chrono range');
 const leap=nanosecond>=1000000000n;
 if(leap&&date.getUTCSeconds()!==59)throw new TypeError('Invalid UTC leap second');
 const nanos=nanosecond-(leap?1000000000n:0n);
 const y=year>=0&&year<=9999?String(year).padStart(4,'0'):(year<0?'-':'+')+String(Math.abs(year)).padStart(4,'0');
 const two=(n:number)=>String(n).padStart(2,'0');
 const fraction=nanos===0n?'':nanos%1000000n===0n?'.'+String(nanos/1000000n).padStart(3,'0'):nanos%1000n===0n?'.'+String(nanos/1000n).padStart(6,'0'):'.'+String(nanos).padStart(9,'0');
 return y+'-'+two(date.getUTCMonth()+1)+'-'+two(date.getUTCDate())+'T'+two(date.getUTCHours())+':'+two(date.getUTCMinutes())+':'+two(date.getUTCSeconds()+(leap?1:0))+fraction+'Z';
}
