import {types} from 'node:util';
import {NativeMirrorCursorStore} from './cursor-store.ts';
import {NativeMirrorStartupIntentStore} from './startup-intent-store.ts';

/** Explicit startup-only DDL against an existing base store, never called by
 * discovery, bootstrap reads or polling. The caller owns startup and stable DB
 * identity until both sequential stages join. Failure may leave only the first
 * schema prepared; it is not rollback evidence or permission to start polling. */
export async function prepareMirrorBootstrapSchemas(databasePath:string,timeoutMs=5000,signal?:AbortSignal):Promise<void>{
 if(signal!==undefined&&(types.isProxy(signal)||!(signal instanceof AbortSignal)))throw new TypeError('Expected owned schema preparation signal');
 signal?.throwIfAborted();
 const cursor=new NativeMirrorCursorStore(databasePath,timeoutMs),startup=new NativeMirrorStartupIntentStore(databasePath,timeoutMs);
 try{
  await cursor.initializeSchema(signal);signal?.throwIfAborted();
  await startup.initializeSchema(signal);signal?.throwIfAborted();
 }finally{await startup.close();await cursor.close();}
}
