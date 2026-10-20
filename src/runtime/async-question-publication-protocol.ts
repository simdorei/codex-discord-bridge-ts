import {requireDiscordText} from '../discord/text.ts';
import {parseAsyncChoiceQuestion,snapshotAsyncChoiceQuestion} from './component-worker/async-choice-native-snapshot.ts';
import type {StoredAsyncQuestion} from '../store/async-question-read.ts';
// Reuse only the passive row codec. Publication never creates a click handle or
// calls the answer-dispatch owner.
export const snapshotPublicationQuestion=(input:StoredAsyncQuestion):StoredAsyncQuestion=>snapshotAsyncChoiceQuestion(input);
export const parsePublicationQuestion=parseAsyncChoiceQuestion;
export const QUESTION_PUBLICATION_BYTES=1048576;
export type QuestionPublicationOperation='Prepare'|'Bind'|'Error';
export function questionPublicationBinding(id:string,path:string,operation:QuestionPublicationOperation,questionJson:string,detail:string|boolean|null){
 requireDiscordText(path);if(path.includes('\0')||Buffer.byteLength(path)>32768||typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))throw new TypeError('Invalid question publication binding');
 parsePublicationQuestion(questionJson);
 if(operation==='Prepare'){if(detail!==null)throw new TypeError('Unexpected question preparation detail');}
 else if(operation==='Bind'){if(typeof detail!=='boolean')throw new TypeError('Expected interactive question flag');}
 else if(operation==='Error'){requireDiscordText(detail);if(Array.from(detail).length>1000)throw new RangeError('Unbounded question diagnostic');}
 else throw new TypeError('Unknown question publication operation');
 return Object.freeze({id,path,operation,questionJson,detail});
}
