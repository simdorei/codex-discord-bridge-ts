import {cloneOwnedSerdeValue} from '../../core/owned-serde-value.ts';
import {serdeField,serdeObject} from '../../app-server/value.ts';
import {requireDiscordText} from '../../discord/text.ts';
import type {CommandAction} from '../command-plan.ts';
import type {NewActionContext} from './new-journal.ts';

const units=new Set(['Help','Where','Doctor','Approval','Runners','MirrorCheck','QaButtons','RestartCodex','ForceRestartCodex','Identity','Resources','HostReboot']);
type Field='text'|'optionalText'|'bool'|'u32'|'optionalU32'|'optionalI64';
const fields:Readonly<Record<string,Readonly<Record<string,Field>>>>=Object.freeze({
 List:{limit:'u32'},ArchivedList:{limit:'u32'},Use:{reference:'text'},Status:{reference:'optionalText'},
 Settings:{reference:'optionalText',model:'optionalText',effort:'optionalText',speed:'optionalText'},
 AutoReserve:{reference:'optionalText',enabled:'bool'},Context:{all_threads:'bool',refresh:'bool',limit:'u32'},Usage:{days:'u32'},
 New:{prompt:'text'},Ask:{prompt:'text'},Interview:{prompt:'text'},Steer:{prompt:'text'},
 Retract:{reference:'optionalText'},SavedRequest:{request_id:'text'},DiscardRequest:{job_id:'text'},
 MirrorInspect:{limit:'optionalU32',list:'bool'},BridgeSync:{limit:'optionalI64'},Open:{reference:'text',abort:'bool'},
 Stop:{reference:'optionalText'},Recover:{reference:'optionalText'},Repair:{reference:'optionalText'},Archive:{reference:'optionalText'},Resume:{reference:'optionalText'},
 SettingsOptions:{reference:'optionalText',field:'optionalText'},DeleteArchivePreview:{reference:'text'},DeleteArchiveConfirm:{reference:'text'},
});
function check(value:unknown,kind:Field):void{
 if(kind.startsWith('optional')&&value===null)return;
 if(kind==='text'||kind==='optionalText'){requireDiscordText(value);return;}
 if(kind==='bool'){if(typeof value!=='boolean')throw new TypeError('Expected command boolean');return;}
 if(typeof value!=='bigint'||(kind==='optionalI64'?(value<-(1n<<63n)||value>=1n<<63n):(value<0n||value>0xffffffffn)))throw new TypeError('Expected lossless command integer');
}
/** Owned in-process command boundary, not a wire Serde deserializer. All declared
 * fields must exist (nullable options use null); extra fields are rejected. No
 * getter/proxy/coercion is consulted and callers cannot change data across awaits. */
export function snapshotRuntimeCommand(input:CommandAction):CommandAction{
 const value=cloneOwnedSerdeValue(input);
 if(typeof value==='string'){if(!units.has(value))throw new TypeError('Unknown command unit');return value as CommandAction;}
 if(!serdeObject(value)||Object.keys(value).length!==1)throw new TypeError('Expected single command variant');
 const name=Object.keys(value)[0]!;if(!Object.hasOwn(fields,name))throw new TypeError('Unknown command variant');
 const body=serdeField(value,name),shape=fields[name]!;
 if(!serdeObject(body)||Object.keys(body).length!==Object.keys(shape).length)throw new TypeError('Expected exact command fields');
 for(const [key,kind] of Object.entries(shape))check(serdeField(body,key),kind);
 return value as unknown as CommandAction;
}
export function snapshotActionContext(input:NewActionContext):NewActionContext{
 const value=cloneOwnedSerdeValue(input);if(!serdeObject(value)||Object.keys(value).length!==4)throw new TypeError('Expected exact action context');
 for(const key of ['channelId','userId','discordMessageId']){const id=serdeField(value,key);if(key==='discordMessageId'&&id===null)continue;if(typeof id!=='bigint'||id<0n||id>=1n<<64n)throw new TypeError('Expected u64 action identity');}
 if(typeof serdeField(value,'autoQueueWhenBusy')!=='boolean')throw new TypeError('Expected action queue policy');
 return value as unknown as NewActionContext;
}
