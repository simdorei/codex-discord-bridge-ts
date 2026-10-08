import {serializeInteractionResponse,type InteractionResponse} from './interaction-response.ts';
function tokenValid(token:unknown):token is string{if(typeof token!=='string'||token==='.'||token==='..')return false;const match=/^[A-Za-z0-9._-]+$/u.exec(token);return match!==null&&match[0]===token;}
/** Supported opaque ASCII URL-safe token profile. No percent/path/query/fragment
 * normalization or arbitrary endpoint fallback; other tokens fail before IO.
 * This is not full Rust hyper::Uri acceptance parity for arbitrary strings. */
export function isInteractionCallbackPath(path:unknown):path is string{if(typeof path!=='string')return false;const match=/^interactions\/([1-9][0-9]{0,19})\/([^/]+)\/callback$/u.exec(path);return match!==null&&match[0]===path&&BigInt(match[1]!)<(1n<<64n)&&tokenValid(match[2]);}
export function interactionCallbackRequest(id:bigint,token:string,response:InteractionResponse):{readonly method:'POST';readonly path:string;readonly body:string;readonly authorization:null}{if(typeof id!=='bigint'||id<=0n||id>(1n<<64n)-1n||!tokenValid(token))throw new TypeError('Unsupported interaction callback identity/token profile');return Object.freeze({method:'POST',path:`interactions/${id}/${token}/callback`,body:serializeInteractionResponse(response),authorization:null});}
