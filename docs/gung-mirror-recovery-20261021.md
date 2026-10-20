# GUNG 미러 실측 후속 수정 — alpha.12

alpha.11 적용 후 실제 런타임을 확인하면서, 이전부터 남아 있던 미러 상태 문제를
추가로 확인했다. [F01–F03 수정](rs-ts-parity-fixes-20261021.md)을 포함하는 후속판이다.

## 재현과 수정

| 관측 | 원인 | 변경 |
|---|---|---|
| 3개 채널의 `MirrorBootstrapBindingError` | 저장된 `C:\…`와 발견된 `\\?\C:\…`를 다른 파일로 판단 | 두 표기가 실제로 같은 파일 ID·생성 시각을 가리킬 때만 허용. 저장된 경로·커서·세대는 보존 |
| 3개 채널의 `MirrorStartupContextHeldError: RecordBytes` | 과거 이미지·도구 기록 한 줄이 256KiB를 초과해 초기 턴 복원이 중단 | Rust의 첫 200 Unicode scalar 필터상 턴 정보가 아닌 큰 기록은 제한된 창으로 읽고 UTF8 전체 검증. JSON 버퍼에 누적하지 않음 |
| EOF 상태의 채널에서도 `OwnedWorkerBusyError` 반복 | 내용이 없는 창도 공용 decoder를 점유하거나 다른 decoder 종료를 기다림 | 파일 세대를 재검증한 뒤 빈 결과를 반환. decoder 생성·점유·대기 없음 |
| 기존 커서 이후 302,108바이트 기록이 대기 | 1MiB 읽기 창 안에서도 한 줄을 256KiB로 제한 | live record 한도를 기존 창과 같은 1MiB로 조정. 전체 창 상한은 유지 |
| 정상 history poll이 `OperationFailure`로 표시 | 성공 상태 문자열까지 오류 분류기로 보냄 | 알려진 poll 형식을 정보 로그로 기록하고, 초기화 보류 사유는 허용된 enum만 표시 |

파일 경로의 일반 정규화를 넓히지 않았다. 다른 파일, 없는 파일, 점/부모 경로,
끝의 점·공백, DOS 장치명 및 취소 요청은 계속 거절한다. 기존 full-prefix 해시,
미확정 전송 보류, 영수증과 커서의 원자적 갱신 조건도 유지한다.

큰 과거 기록은 UTF8 검증을 생략하지 않는다. 실제 `turn_context`/`task_started`
후보는 기존 JSON 레코드 예산을 유지한다. 원래 저장된 EOF와 operation ID를 그대로
사용하므로, 복원 중 새로 추가된 과거 기록이나 후속 턴을 초기 커서에 섞지 않는다.

## 변경 파일

- 경로: `session-mirror/rollout-path-binding.ts`, `bootstrap-coordinator.ts`, `bound-poll.ts`
- 초기 턴 복원: `session-mirror/startup-context-scan.ts`
- EOF/레코드: `session-mirror/read-window.ts`, `record-window.ts`, `discord-runtime/local-session-mirror-profile.ts`
- 진단: `discord-runtime/diagnostics.ts`
- 재현 검사: `test/runtime/session-mirror/gung-recovery.test.ts`, `read-window.test.ts`, `test/runtime/discord-runtime/diagnostics.test.ts`
- 배포 버전 및 설치본 검사 목록: `package.json`, `package-lock.json`, `README.md`, `test/profiles/rs-parity.json`, `tools/test-installed-package.mjs`

소스 경로의 접두사는 `src/runtime/`이다.

## 검증 기록

최초 5개 재현 검사는 수정 전 모두 실패했다. 수정 후에는 경로 변경 없이 원래
커서에서 final 1회 전달, 3MB 과거 기록 복원, 잘못된 UTF8/큰 실제 턴 후보 거절,
다른 decoder가 busy인 EOF 관측, 300KB live 기록 뒤 final 처리를 검사한다.
별도 검사로 모호한 Windows 경로와 취소도 확인한다.

실행 로그는 `.runtime/parity-fixes-20261021/`에 보관한다.

- production build 및 전체 테스트 소스 TypeScript 컴파일 통과.
- 별도 npm 설치본: **150/150 통과**, 실패·skip 없음 (`installed-alpha12-pinned.log`).
  source TS 실행을 차단하고 실제 설치된 dist를 사용했다.
- 전체 미러: **481개 중 469 통과, 12 실패** (`mirror-alpha12.log`).
  12개는 [alpha.11 보고서의 기존 fixture 실패](rs-ts-parity-fixes-20261021.md#검증)와
  정확히 같은 검사이며 새 실패는 없다. 전체 통과라고 표시하지 않는다.
- 최초 재현 RED: `gung-red.log`; 초기 인접 검사: `gung-green.log`.
  live 한도를 의도적으로 1MiB로 변경했으므로 기존 한도 초과 검사는 1MiB+1로
  경계를 옮겼다. 다른 기존 실패 fixture는 고치거나 skip하지 않았다.
- 설치 검사는 배포와 같은 Node 24.21.0을 PATH에도 고정했다. 첫 실행의 npm shim
  PATH 설정 오류는 별도 `installed-alpha12.log`에 남겨 두었다.

패키지 SHA-256:
`16a164f72831c37a49a0428998ff6521501f3ea564b1336a6f78675372a467cc`.

## 범위

이 변경은 실제 GUNG에서 확인한 정체 원인을 대상으로 한다. live 한 줄은 여전히
1MiB, 초기 전체 스캔은 64MiB와 시간 예산으로 제한된다. 이를 넘는 기록이나
실제 파일 교체, 훼손된 과거 내용, 결과 불명 전송을 자동으로 건너뛰거나 초기화하지 않는다.
모든 Rust 동작 및 모든 환경에서의 동일 성능을 증명하는 결과는 아니다.
