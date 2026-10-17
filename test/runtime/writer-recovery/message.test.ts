import test from 'node:test';
import assert from 'node:assert/strict';
import {formatRecoveryHandoff} from '../../../src/runtime/writer-recovery/message.ts';
import type {RecoveryHandoffReport} from '../../../src/runtime/writer-recovery/handoff.ts';
const report:RecoveryHandoffReport={phase:'dispatched_tools',thread:'t',cancelled:['a'],startedOrUncertain:0,receipt:'/receipt'};
test('recovery notice preserves cross-chat interruption and unconfirmed restart warnings',()=>{const text=formatRecoveryHandoff(report);assert.match(text,/다른 앱 채팅과 작업도 중단될 수 있습니다/);assert.match(text,/이전 요청은 자동 재실행하지 않습니다/);assert.match(text,/아직 재시작 완료가 확인된 상태는 아닙니다/);assert.ok(text.endsWith('이전 요청 취소 기록: 1개\n복구 기록: /receipt\n'));assert.ok(!text.includes('점유 해제를 확인했습니다'));});
test('recovery formatter refuses other phases and active fields',()=>{assert.throws(()=>formatRecoveryHandoff({...report,phase:'completed'} as unknown as RecoveryHandoffReport),TypeError);let calls=0;assert.throws(()=>formatRecoveryHandoff(Object.defineProperty({...report},'receipt',{get(){calls++;return '/fake';}})),TypeError);assert.equal(calls,0);});
