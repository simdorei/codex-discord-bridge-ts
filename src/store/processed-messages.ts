import {openInitialized} from './owned-driver.ts';
function id(value:bigint):void{if(typeof value!=='bigint'||value<-(1n<<63n)||value>=1n<<63n)throw new TypeError('Expected i64 message identity');}
/** Source processed.rs: these rows are deduplication markers, not executable
 * ingress custody. Atomic INSERT OR IGNORE shares the unique key with admission. */
export async function claimProcessedMessage(path:string,messageId:bigint,now:number):Promise<boolean>{
 id(messageId);if(typeof now!=='number')throw new TypeError('Expected numeric timestamp');const db=await openInitialized(path);
 try{return db.prepare('INSERT OR IGNORE INTO discord_processed_messages (message_id, seen_at) VALUES (?, ?)').run(messageId,now).changes===1;}finally{db.close();}
}
export async function isProcessedMessage(path:string,messageId:bigint):Promise<boolean>{
 id(messageId);const db=await openInitialized(path);try{return db.prepare('SELECT 1 FROM discord_processed_messages WHERE message_id = ?').get(messageId)!==undefined;}finally{db.close();}
}
export async function markProcessedMessage(path:string,messageId:bigint,now:number):Promise<void>{
 id(messageId);if(typeof now!=='number')throw new TypeError('Expected numeric timestamp');const db=await openInitialized(path);
 try{db.prepare('INSERT OR REPLACE INTO discord_processed_messages (message_id, seen_at) VALUES (?, ?)').run(messageId,now);}finally{db.close();}
}
