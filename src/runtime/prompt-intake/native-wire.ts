import {snapshotStoredPromptIntake} from '../../store/prompt-intake-write.ts';
import type {StoredPromptIntake} from '../../store/prompt-intake.ts';
import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
/** Closed numeric tags preserve original SQLite f64/readiness semantics without
 * treating NaN/Infinity as JSON null or weakening the byte-budget validator. */
export function intakeNumberWire(value:number):number|string{
 if(typeof value!=='number')throw new TypeError('Expected intake number');
 return Number.isNaN(value)?'NaN':value===Infinity?'PositiveInfinity':value===-Infinity?'NegativeInfinity':value;
}
export function intakeNumberFromWire(value:unknown):number{
 if(typeof value==='number'&&Number.isFinite(value))return value;
 if(value==='NaN')return NaN;if(value==='PositiveInfinity')return Infinity;if(value==='NegativeInfinity')return -Infinity;
 throw new TypeError('Invalid intake numeric wire value');
}
const fields=['jobId','targetThreadId','channelId','ownerUserId','discordMessageId','rawPrompt','autoQueueWhenBusy','requireCurrentMirror','attemptCount','lastError','retryAfter','claimToken','claimExpiresAt','createdAt','updatedAt'] as const;
const timestamps=['retryAfter','claimExpiresAt','createdAt','updatedAt'] as const;
export function intakeToWire(input:StoredPromptIntake):unknown{
 const value=snapshotStoredPromptIntake(input);return {...value,retryAfter:intakeNumberWire(value.retryAfter),claimExpiresAt:intakeNumberWire(value.claimExpiresAt),createdAt:intakeNumberWire(value.createdAt),updatedAt:intakeNumberWire(value.updatedAt)};
}
export function intakeFromWire(input:unknown):StoredPromptIntake{
 const record:Record<string,unknown>=Object.create(null);for(const key of fields)record[key]=own(input,key);
 for(const key of timestamps)record[key]=intakeNumberFromWire(record[key]);return snapshotStoredPromptIntake(record as unknown as StoredPromptIntake);
}
