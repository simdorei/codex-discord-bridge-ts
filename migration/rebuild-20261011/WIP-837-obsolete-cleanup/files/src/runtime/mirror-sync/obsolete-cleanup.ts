import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {MirrorTarget} from '../../store/mirror-policy-read.ts';
import type {StaleMirrorThread} from '../../store/mirror-stale.ts';
import {NativeMirrorStore} from './store-native.ts';
import {NativeMirrorSourceReader} from './source-reader.ts';
import {MirrorArchivedRetirement,assertExactMirrorMapping} from './archived-retirement.ts';
import {MirrorCleanupAdmission} from './cleanup-admission.ts';
import {DiscordMirrorContainerTransport} from './container-http.ts';
import {DiscordMirrorDeletionTransport} from './delete-http.ts';
import {MirrorDeletionGuard} from './delete-guard.ts';
function id(value:bigint):bigint{if(typeof value!=='bigint'||value<=0n||value>=1n<<63n)throw new TypeError('Expected positive database-compatible room');return value;}
/** Source cleanup ordering with complete active inventory, shared-room refusal,
 * fresh rechecks after slow HTTP, narrow archived exception and durable fences.
 * Caller owns serialization, reconciliation and the total operation deadline. */
export class MirrorObsoleteCleanup {
  readonly retireObsolete:(guild:bigint,started:number,signal:AbortSignal)=>Promise<number>;
  readonly retireRow:(guild:bigint,started:number,row:StaleMirrorThread,parent:bigint|null,signal:AbortSignal)=>Promise<boolean>;
  constructor(codex:string,mirror:string,store:NativeMirrorStore,client:DiscordChannelClient){
    NativeMirrorStore.prototype.assertPath.call(store,mirror);
    const source=new NativeMirrorSourceReader(codex),archived=new MirrorArchivedRetirement(codex,mirror,store,client),admission=new MirrorCleanupAdmission(store),rooms=new DiscordMirrorContainerTransport(client),guard=new MirrorDeletionGuard(store,new DiscordMirrorDeletionTransport(client));
    this.retireRow=async(guild,started,input,parent,signal)=>{
      id(guild);if(parent!==null)id(parent);if(typeof started!=='number'||!Number.isFinite(started))throw new TypeError('Expected finite cleanup cutoff');signal.throwIfAborted();
      const row=cloneOwnedSerdeValue(input) as StaleMirrorThread;requireDiscordText(row.threadId);const room=id(row.discordThreadId);
      if(parent===null&&await NativeMirrorStore.prototype.execute.call(store,{kind:'CleanupPending',args:[room,row.threadId]},signal)==='ingress'){
        const expected=await source.thread(row.threadId,true,signal);
        if(expected!==null)return archived.retire(guild,started,row,expected,signal);
      }
      await admission.ensureNoRequests(room,signal);
      const channel=await rooms.channel(room,signal);
      if(await source.thread(row.threadId,false,signal)!==null||parent!==null&&await source.thread(row.threadId,true,signal)!==null)return false;
      if(parent!==null)await assertExactMirrorMapping(store,row.threadId,room,parent,signal);
      if(channel!==null){
        if(channel.id!==room||channel.guildId!==guild||channel.kind!==11n||parent!==null&&channel.parentId!==parent)throw new Error('obsolete cleanup Discord identity mismatch');
        await admission.ensureNoRequests(channel.id,signal);
        await guard.deleteGuarded(channel.id,row.threadId,signal);
      }else await guard.fenceMissingRoom(room,row.threadId,signal);
      if(!await NativeMirrorStore.prototype.execute.call(store,{kind:'RetireThread',args:[row.threadId,row.discordThreadId,started]},signal))throw new Error(`mapping ${row.threadId} changed during cleanup; run sync again`);
      return true;
    };
    this.retireObsolete=async(guild,started,signal)=>{
      id(guild);signal.throwIfAborted();if(typeof started!=='number'||!Number.isFinite(started))throw new TypeError('Expected finite cleanup cutoff');
      const retained=new Set(await source.activeIds(signal));
      const mappings=await NativeMirrorStore.prototype.execute.call(store,{kind:'MirrorTargets',args:[]},signal) as readonly MirrorTarget[];
      const shared=new Set(mappings.filter(mapping=>retained.has(mapping.codexThreadId)).map(mapping=>mapping.discordThreadId));
      const stale=await NativeMirrorStore.prototype.execute.call(store,{kind:'StaleThreads',args:[[...retained],started]},signal) as readonly StaleMirrorThread[];
      let count=0;
      for(const row of stale){
        if(await source.thread(row.threadId,false,signal)!==null)continue;
        if(shared.has(row.discordThreadId))throw new Error(`shared Discord room ${row.discordThreadId} has an active mapping; room and mappings preserved`);
        if(await this.retireRow(guild,started,row,null,signal))count++;
      }
      return count;
    };
    Object.freeze(this);
  }
}
Object.freeze(MirrorObsoleteCleanup.prototype);
