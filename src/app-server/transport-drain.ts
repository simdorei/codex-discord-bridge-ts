import type {TransportLineDispatcher} from "./transport-dispatch.ts";
import type {ClientCloseCoordinator} from "./close-coordinator.ts";
import type {BoundedDiagnostics} from "./diagnostics.ts";
export interface AppServerLineReader{
  /** Owned reader adapter: fatal UTF-8 decoding, source-compatible LF/CRLF framing,
   * null only for true EOF; cancellation/pipe disposal belongs to its process owner. */
  nextLine():Promise<string|null>;
}
export type ReadErrorRenderer=(stream:"stdout"|"stderr",error:unknown)=>string;
function readFailure(stream:"stdout"|"stderr",error:unknown,render:ReadErrorRenderer,diagnostics:BoundedDiagnostics):void{
  const detail=render(stream,error);if(typeof detail!=="string"||/[\uD800-\uDFFF]/u.test(detail))throw new TypeError("Expected public-safe pipe diagnostic text");
  diagnostics.push(`${stream} read failed: ${detail}`);
}
/** Await logical close cleanup before this owned stdout drain completes. An error
 * inside dispatch is not an I/O error; it remains visible to the process supervisor. */
export async function drainStdout(reader:AppServerLineReader,dispatch:Pick<TransportLineDispatcher,"handleStdoutLine">,close:Pick<ClientCloseCoordinator,"markClosed">,diagnostics:BoundedDiagnostics,render:ReadErrorRenderer):Promise<void>{
  while(true){
    let line:string|null;
    try{line=await reader.nextLine();}
    catch(error){readFailure("stdout",error,render,diagnostics);await close.markClosed("app-server stdout read failed");return;}
    if(line===null){await close.markClosed("app-server stdout closed");return;}
    dispatch.handleStdoutLine(line);
  }
}
/** stderr EOF/error terminates only this diagnostic drain, never closes stdout. */
export async function drainStderr(reader:AppServerLineReader,diagnostics:BoundedDiagnostics,render:ReadErrorRenderer):Promise<void>{
  while(true){
    let line:string|null;
    try{line=await reader.nextLine();}
    catch(error){readFailure("stderr",error,render,diagnostics);return;}
    if(line===null)return;diagnostics.push(line);
  }
}
