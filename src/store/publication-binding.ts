import {DatabaseSync} from 'node:sqlite';
import {withStoreTransaction,commitStore} from './owned-scope.ts';
import {readPublicationProposalIn,invalidPublication} from './publication-proposal.ts';
import {validPublicationId,type PublicationProposal} from './publication-codec.ts';
import {PublicationRowMissingError} from './publication-snapshot.ts';
import {receiptRow,receiptText,receiptTextColumns} from './delivery-receipt-key.ts';
import {decodeI64} from './sqlite-values.ts';
import {requireDiscordText} from '../discord/text.ts';
const owned=Symbol('DeliveredPublicationProposal');
export class DeliveredPublicationProposal {
 readonly proposal:PublicationProposal;readonly message_id:bigint;
 constructor(key:symbol,proposal:PublicationProposal,message:bigint){if(key!==owned)throw new TypeError('Expected stored delivered proposal');this.proposal=proposal;this.message_id=message;Object.freeze(this);}
 requireActor(application:bigint,channel:bigint,actor:bigint,message:bigint):void{
  if([application,channel,actor,message].some(v=>typeof v!=='bigint'||v<=0n||v>=1n<<63n)||this.proposal.application_id!==application||this.proposal.channel_id!==channel||this.proposal.owner_user_id!==actor||this.message_id!==message)invalidPublication('authenticated delivery identity does not match');
 }
}
/** Existing-only readonly routing lookup,100ms busy timeout. May read historical
 * delivery after expiry; this never establishes fresh consent or initializes DB. */
export function deliveredPublicationProposal(path:string,id:string,revision:bigint):DeliveredPublicationProposal{
 requireDiscordText(path);if(!validPublicationId(id)||typeof revision!=='bigint'||revision<=0n||revision>=1n<<63n)return invalidPublication('invalid delivered proposal identity');
 const db=new DatabaseSync(path,{readOnly:true,timeout:100});try{return withStoreTransaction(db,'DEFERRED',()=>{
  const stored=readPublicationProposalIn(db,id),row=receiptRow(db,`SELECT revision,message_id,body_sha256,${receiptTextColumns('body_sha256')} FROM cdr_recovery_publication_deliveries WHERE proposal_id=?`,id);if(row===undefined)throw new PublicationRowMissingError();
  const bound=decodeI64(row.revision,'revision'),message=decodeI64(row.message_id,'message'),sha=receiptText(row,'body_sha256');
  if(stored.proposal.revision!==revision||bound!==revision||message<=0n||sha!==stored.proposal.review_sha256)return invalidPublication('delivered proposal revision or body changed');return commitStore(new DeliveredPublicationProposal(owned,stored.proposal,message));
 });}finally{db.close();}
}
