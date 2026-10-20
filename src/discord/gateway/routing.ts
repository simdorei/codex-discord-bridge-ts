import {rustTrim,asciiLower} from '../../config/remote.ts';
function words(content:string):string[]{if(typeof content!=='string'||/[\uD800-\uDFFF]/u.test(content))throw new TypeError('Expected gateway text');const trimmed=rustTrim(content);if(!trimmed.startsWith('!'))return [];const rest=rustTrim(trimmed.slice(1));return rest===''?[]:rest.split(/\p{White_Space}+/u);}
/** Routing hints only, never command authorization or durable deduplication. */
export function isForceRestartMessage(content:string):boolean{const parts=words(content),name=asciiLower(parts[0]??'');return (name==='force_restart'&&parts.length===1)||(name==='restart_codex'&&parts.length===2&&['force','--force'].includes(asciiLower(parts[1]!)));}
export function isEmergencyMessage(content:string):boolean{if(isForceRestartMessage(content))return true;const parts=words(content),name=asciiLower(parts[0]??'');return ['recover','복구','repair','도구복구'].includes(name)&&parts.length<=2;}
