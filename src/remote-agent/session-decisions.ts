import {gatewayOwnField as own} from '../discord/gateway/values.ts';
import {requireDiscordText} from '../discord/text.ts';
export interface RemoteSessionIdentity {readonly connectionGeneration:bigint|null;readonly sessionGeneration:bigint;readonly sessionId:string;readonly computerMode:'project'|'device';}
export type RemoteActivationDecision=Readonly<{kind:'Create'|'Reuse'}>|Readonly<{kind:'Reject';message:string}>;
export type RemoteSessionRequirement=Readonly<{kind:'Current'}>|Readonly<{kind:'Reject';message:string}>;
const rejected=(message:string)=>Object.freeze({kind:'Reject' as const,message});
function gen(v:unknown):bigint{if(typeof v!=='bigint'||v<0n||v>18446744073709551615n)throw new TypeError('Expected u64 session generation');return v;}
function connection(v:unknown):bigint|null{return v===null?null:gen(v);}
function text(v:unknown):string{requireDiscordText(v);return v;}
function mode(v:unknown):RemoteSessionIdentity['computerMode']{if(v!=='project'&&v!=='device')throw new TypeError('Expected remote computer mode');return v;}
/** Pure source decision only, never an activation permit. The concrete owner
 * must perform/revalidate it while holding its project-session ownership across
 * resource creation. No resource, lock, project binding or connection is made. */
export function decideRemoteSessionActivation(currentConnection:bigint|null,active:RemoteSessionIdentity|null,requested:RemoteSessionIdentity):RemoteActivationDecision{
 const current=connection(currentConnection),incoming=connection(own(requested,'connectionGeneration'));
 if(incoming!==null&&incoming!==current)return rejected('The command belongs to a stale local bridge connection.');
 if(active!==null){
  if(connection(own(active,'connectionGeneration'))!==incoming)return rejected('The project session belongs to a stale bridge connection.');
  const next=gen(own(requested,'sessionGeneration')),previous=gen(own(active,'sessionGeneration'));
  if(next<previous)return rejected('The project session command is older than the active session.');
  const session=text(own(requested,'sessionId')),prior=text(own(active,'sessionId'));
  if(next===previous&&session!==prior)return rejected('The project session generation conflicts with another session.');
  if(next===previous&&session===prior){
   if(mode(own(requested,'computerMode'))!==mode(own(active,'computerMode')))return rejected('The project session mode conflicts with the active session.');
   return Object.freeze({kind:'Reuse'});
  }
 }
 // Validate the owned identity needed by the later creation phase, not resources.
 gen(own(requested,'sessionGeneration'));text(own(requested,'sessionId'));mode(own(requested,'computerMode'));
 return Object.freeze({kind:'Create'});
}
/** Matches require_session's exact connection/session checks. A Current result
 * is transient information, not authority transferable beyond the owner's lock. */
export function requireRemoteSessionIdentity(currentConnection:bigint|null,active:RemoteSessionIdentity|null,sessionId:string|null,connectionGeneration:bigint|null):RemoteSessionRequirement{
 const current=connection(currentConnection),incoming=connection(connectionGeneration);
 if(incoming!==null&&incoming!==current)return rejected('The command belongs to a stale local bridge connection.');
 if(active!==null){
  const actual=text(own(active,'sessionId'));if(sessionId!==null&&text(sessionId)===actual&&connection(own(active,'connectionGeneration'))===incoming)return Object.freeze({kind:'Current'});
 }
 return rejected('The ChatGPT session is stale or was not acknowledged locally.');
}
