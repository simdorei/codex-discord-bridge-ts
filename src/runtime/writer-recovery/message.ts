import {gatewayOwnField as own} from '../../discord/gateway/values.ts';
import {requireDiscordText} from '../../discord/text.ts';
import {types} from 'node:util';
import type {RecoveryHandoffReport} from './handoff.ts';
/** Frozen Rust writer_recovery::message dispatched_tools branch. No other phase
 * is promoted to completion here; this formatter creates no recovery authority. */
export function formatRecoveryHandoff(report:RecoveryHandoffReport):string{
 if(own(report,'phase')!=='dispatched_tools')throw new TypeError('Expected dispatched recovery report');
 const jobs=own(report,'cancelled'),receipt=own(report,'receipt');requireDiscordText(receipt);
 if(!Array.isArray(jobs)||types.isProxy(jobs)||jobs.length>128)throw new TypeError('Expected bounded cancellation report');
 for(let i=0;i<jobs.length;i++)requireDiscordText(own(jobs,String(i)));
 return `이전 요청의 취소 기록을 저장했습니다. 데스크톱 앱과 봇·앱서버를 재시작합니다. 다른 앱 채팅과 작업도 중단될 수 있습니다. 이전 요청은 자동 재실행하지 않습니다. 아직 재시작 완료가 확인된 상태는 아닙니다.\n이전 요청 취소 기록: ${jobs.length}개\n복구 기록: ${receipt}\n`;
}
