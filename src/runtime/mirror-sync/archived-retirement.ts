import {DiscordChannelClient} from '../../discord/channel-client.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import type {ThreadInfo} from '../../codex-state/thread.ts';
import type {StaleMirrorThread} from '../../store/mirror-stale.ts';
import type {MirrorTarget} from '../../store/mirror-policy-read.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {now} from '../../store/queue-attach-goal.ts';
import {NativeMirrorStore} from './store-native.ts';
import {NativeArchivedCleanup,consumeArchivedCleanupPermit} from './archived-native.ts';
import {MirrorCleanupProtectedError} from '../cleanup-refusal.ts';
import {DiscordMirrorContainerTransport} from './container-http.ts';
import {DiscordMirrorDeletionTransport} from './delete-http.ts';
import {MirrorDeletionGuard} from './delete-guard.ts';
import {validateMirrorThreadInfo} from './source-record.ts';
function id(value: bigint): bigint { if (typeof value !== 'bigint' || value <= 0n || value >= 1n << 63n) throw new TypeError('Expected positive database-compatible room'); return value; }
export async function assertExactMirrorMapping(store:NativeMirrorStore,thread:string,room:bigint,parent:bigint,signal:AbortSignal):Promise<void>{
  const rows=await NativeMirrorStore.prototype.execute.call(store,{kind:'MirrorTargets',args:[]},signal) as readonly MirrorTarget[];
  const owners=rows.filter(row=>row.discordThreadId===room);
  if(owners.length!==1||owners[0]!.codexThreadId!==thread||owners[0]!.discordChannelId!==parent)throw new Error('exact cleanup mapping changed or room is shared; preserved');
}
/** Exact archived non-dispatch retirement only. Caller retains global operation
 * serialization/deadline and reconciles earlier unknown deletion outcomes. */
export class MirrorArchivedRetirement {
  readonly retire:(guild:bigint,started:number,row:StaleMirrorThread,archived:ThreadInfo,signal:AbortSignal)=>Promise<boolean>;
  constructor(codex:string,mirror:string,store:NativeMirrorStore,client:DiscordChannelClient){
    NativeMirrorStore.prototype.assertPath.call(store,mirror);
    const native=new NativeArchivedCleanup(codex,mirror),rooms=new DiscordMirrorContainerTransport(client),guard=new MirrorDeletionGuard(store,new DiscordMirrorDeletionTransport(client));
    this.retire=async(guild,started,input,expected,signal)=>{
      id(guild);signal.throwIfAborted();if(typeof started!=='number'||!Number.isFinite(started))throw new TypeError('Expected finite cleanup cutoff');
      const row=cloneOwnedSerdeValue(input) as StaleMirrorThread,archived=cloneOwnedSerdeValue(expected);validateMirrorThreadInfo(archived);requireDiscordText(row.threadId);const room=id(row.discordThreadId);
      if(archived.id!==row.threadId)throw new TypeError('Archived cleanup source and mapping differ');
      const reason=await native.pending(room,row.threadId,now(),signal);
      if(reason!==null)throw new MirrorCleanupProtectedError(room,reason);
      const mappings=await NativeMirrorStore.prototype.execute.call(store,{kind:'MirrorTargets',args:[]},signal) as readonly MirrorTarget[];
      const owners=mappings.filter(mapping=>mapping.discordThreadId===room);
      if(owners.length!==1)throw new Error('archived cleanup room ownership is ambiguous');
      const parent=id(owners[0]!.discordChannelId);
      await assertExactMirrorMapping(store,row.threadId,room,parent,signal);
      const remote=await rooms.channel(room,signal);
      if(remote!==null&&(remote.id!==room||remote.guildId!==guild||remote.kind!==11n||remote.parentId!==parent))throw new Error('archived cleanup Discord identity mismatch');
      await assertExactMirrorMapping(store,row.threadId,room,parent,signal);
      const permit=await native.begin(room,row.threadId,parent,now(),archived,signal);
      if(remote!==null)await guard.dispatchPreparedDelete(room,permit,signal);
      else {const token=consumeArchivedCleanupPermit(permit,store,room);await NativeMirrorStore.prototype.execute.call(store,{kind:'CompleteCleanup',args:[room,token]},signal);}
      if(!await NativeMirrorStore.prototype.execute.call(store,{kind:'RetireThread',args:[row.threadId,row.discordThreadId,started]},signal))throw new Error('archived cleanup mapping changed after confirmed deletion; preserved');
      return true;
    };
    Object.freeze(this);
  }
}
Object.freeze(MirrorArchivedRetirement.prototype);
