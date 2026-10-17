import {openExisting} from './existing-store.ts';
import {verifyCurrentCatalogIn} from './owned-driver.ts';
import {recordOrigin,userOriginMarker,isWellFormedUnicode} from './mirror-origin.ts';
import {StoreIntegrityError} from './schema-assembly.ts';

/** Runtime-only origin write. No initialization, migration, repair or creation.
 * The worker owns this short transaction; the original marker algorithm and
 * INSERT OR IGNORE first-custody semantics are shared with the legacy writer. */
export function recordUserOriginExisting(path:string,thread:string,turn:string,prompt:string,now:number):void{
 if(typeof path!=='string'||!isWellFormedUnicode(path)||path.includes('\0'))throw new StoreIntegrityError('Invalid origin path');
 userOriginMarker(thread,turn,prompt);
 if(typeof now!=='number')throw new StoreIntegrityError('now must be a number');
 const db=openExisting(path,100);
 try{
  db.exec('BEGIN IMMEDIATE');
  verifyCurrentCatalogIn(db);
  recordOrigin(db,thread,turn,prompt,now);
  db.exec('COMMIT');
 }finally{
  try{if(db.isTransaction)db.exec('ROLLBACK');}finally{db.close();}
 }
}
