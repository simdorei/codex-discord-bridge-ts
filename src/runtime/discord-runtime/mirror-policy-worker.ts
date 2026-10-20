import {serveReusableWorker} from '../reusable-worker-entry.ts';
import type {ReusableNativeOperation} from '../reusable-worker-operations.ts';
import {usingExistingReadOnlyStore} from '../../store/owned-scope.ts';
import {boundedRemainingDiscordIdsIn} from '../../store/mirror-policy-snapshot.ts';
import {boundedMirrorTargetsIn} from '../../store/mirror-target-snapshot.ts';
export const runNativeOperation:ReusableNativeOperation=(q,parentPort)=>{
try{
 const ids=usingExistingReadOnlyStore(q.path,db=>boundedRemainingDiscordIdsIn(db,q.maxRows,q.maxValueBytes));
 // Separate opens and transactions preserve source query order. This adapter
 // requires prior initialization; unlike the legacy API it never migrates.
 const targets=usingExistingReadOnlyStore(q.path,db=>boundedMirrorTargetsIn(db,q.maxRows,q.maxValueBytes));
 const values=new Set<bigint>();
 for(const id of [...ids.threadIds,...ids.projectChannelIds])if(id>=0n)values.add(id);
 for(const row of targets)for(const id of [row.discordChannelId,row.discordThreadId])if(id>=0n)values.add(id);
 if(values.size>q.maxOutputIds)throw new RangeError('Complete dynamic policy exceeds output budget');
 parentPort.postMessage({ok:true,ids:[...values].sort((a,b)=>a<b?-1:a>b?1:0)});
}catch(error){parentPort.postMessage({ok:false,detail:[...(error instanceof Error?error.message:'Native mirror policy failed')].slice(0,2048).join('')});}
finally{parentPort.close();}
};
await serveReusableWorker(runNativeOperation);
