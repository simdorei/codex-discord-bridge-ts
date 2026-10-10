import {MirrorFileWindow,type MirrorFileStamp} from './file-window.ts';
import {readStableMirrorItems,type MirrorReadLimits} from './read-window.ts';
import {snapshotMirrorItemOptions,type MirrorItemOptions,type MirrorItemsWindow} from './decode-reader.ts';
import type {MirrorItem} from './collect.ts';
import type {MirrorWindowStop} from './record-window.ts';
const token=Symbol('native mirror batch observation');
/** Seals one authentic file window, exact complete-record boundary and its
 * owned native decoder result. This is an observation only: it proves neither
 * cross-poll append-only history, persisted file-generation binding, successful
 * delivery nor durable handoff. Cursor writers must establish those separately.
 * A held suffix is explicit and never included in nextOffset. */
export class MirrorBatchObservation{
 readonly thread:string;readonly priorTurn:string|null;readonly path:string;readonly fileStamp:MirrorFileStamp;readonly startOffset:bigint;readonly nextOffset:bigint;readonly currentTurn:string|null;readonly items:readonly MirrorItem[];readonly scannedRecords:number;readonly stop:MirrorWindowStop;readonly heldSuffix:boolean;readonly #window:MirrorFileWindow;
 constructor(key:symbol,window:MirrorFileWindow,options:MirrorItemOptions,decoded:MirrorItemsWindow){
  if(key!==token)throw new TypeError('Expected owned native mirror batch observation');
  if(!window.isCompleteRecordBoundary(decoded.nextOffset))throw new TypeError('Mirror batch cursor is not a complete captured record boundary');
  this.#window=window;this.thread=options.thread;this.priorTurn=options.currentTurn;this.path=window.path;this.fileStamp=window.generation;this.startOffset=window.offset;this.nextOffset=decoded.nextOffset;this.currentTurn=decoded.collection.currentTurn;this.items=decoded.collection.items;this.scannedRecords=decoded.scannedRecords;this.stop=decoded.stop;
  this.heldSuffix=['IncompleteRecord','OversizedRecord','InvalidUtf8','InvalidJson'].includes(decoded.stop);Object.freeze(this);
 }
 async verifyCurrent(signal?:AbortSignal):Promise<void>{await this.#window.verifyCurrent(signal);}
}
Object.freeze(MirrorBatchObservation.prototype);
export async function observeMirrorBatch(path:string,offset:bigint,limits:MirrorReadLimits,input:MirrorItemOptions,signal?:AbortSignal):Promise<MirrorBatchObservation>{
 const options=snapshotMirrorItemOptions(input);const {window,decoded}=await readStableMirrorItems(path,offset,limits,options,signal);signal?.throwIfAborted();return new MirrorBatchObservation(token,window,options,decoded);
}
