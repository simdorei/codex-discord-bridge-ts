/** Complete selected-row/value budget. Native SQLite can materialize one row
 * before this check; this is not a scan, allocation or process RSS bound. */
export class SelectedReadBudget {
 #rows=0n;#bytes=0n;
 constructor(readonly maxRows:bigint,readonly maxValueBytes:bigint){}
 row(row:Record<string,unknown>|undefined):void{
  if(row===undefined)return;
  this.#rows++;if(this.#rows>this.maxRows)throw new RangeError('Complete classification selected rows exceed budget');
  for(const value of Object.values(row)){
   this.#bytes+=typeof value==='string'?BigInt(Buffer.byteLength(value)):value instanceof Uint8Array?BigInt(value.byteLength):value===null?0n:8n;
   if(this.#bytes>this.maxValueBytes)throw new RangeError('Complete classification selected values exceed budget');
  }
 }
}
