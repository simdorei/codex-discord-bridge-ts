import {PortableResidentLifecycle} from '../../app-server/portable-resident-lifecycle.ts';
import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {updateThreadSettings,type ThreadSettingsUpdate} from '../../app-server/requests.ts';
import {ObservedSettings} from './settings-observation.ts';
import {InvalidActionRequestError} from './errors.ts';
export function settingsReady(server:PortableResidentLifecycle,generation:bigint):void {
 const state=server.lifecycleSnapshot();
 if(state.generation!==generation||!state.healthy||state.quarantined||state.restartPending)throw new InvalidActionRequestError('settings connection changed or is unavailable; no verified success');
}
/** Caller provides its complete exact-thread resume response under the shared
 * target lock, then rechecks generation and route before recording success. */
export async function applyOrConfirmSettings(server:PortableResidentLifecycle,thread:string,generation:bigint,currentInput:unknown,updateInput:ThreadSettingsUpdate,signal?:AbortSignal):Promise<Readonly<{settings:ObservedSettings;alreadyApplied:boolean}>> {
 requireDiscordText(thread);signal?.throwIfAborted();
 const current=ObservedSettings.fromResume(currentInput),update=cloneOwnedSerdeValue(updateInput) as unknown as ThreadSettingsUpdate;
 updateThreadSettings(thread,update);settingsReady(server,generation);
 if(current.matches(update))return Object.freeze({settings:current,alreadyApplied:true});
 const events=server.subscribeNotifications();
 try {
  const before=await server.updateSettingsWithWatermark(thread,update,generation,signal);signal?.throwIfAborted();
  const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(),3000),owned=signal?AbortSignal.any([signal,timeout.signal]):timeout.signal;
  try {
   while(true){
    signal?.throwIfAborted();settingsReady(server,generation);
    const observed=server.observedThreadSettings(thread,generation);
    if(observed!==null&&observed[0]>before){const settings=ObservedSettings.parse(observed[1]);if(!settings.matches(update))throw new InvalidActionRequestError('settings update acknowledgement received, but observed values do not match; no success or local settings change recorded');return Object.freeze({settings,alreadyApplied:false});}
    let event;
    try{event=await events.receive(owned);}catch(error){signal?.throwIfAborted();if(timeout.signal.aborted)throw new InvalidActionRequestError('settings update acknowledgement received, but no fresh matching settings observation arrived; outcome unverified, do not blindly retry');throw new InvalidActionRequestError('settings observation stream was interrupted or lost events; outcome unverified');}
    if(event.kind==='Gap')throw new InvalidActionRequestError('settings observation gap; outcome unverified');
    if(event.generation!==generation)throw new InvalidActionRequestError('settings observation generation changed; outcome unverified');
   }
  }finally{clearTimeout(timer);}
 }finally{events.dispose();}
}
