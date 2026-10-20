# RS/TS 잔여 차이 F01–F03 수정

기준: `c1fbf1953f5dd9a44ece85c4f44f082e0728f53b` 이후, TS `0.1.0-alpha.11`.
이 문서는 [2026-10-20 대조 보고서](rs-ts-full-parity-audit-20261020.md)의
F01–F03 후속 수정 기록이다. 전체 Rust/TS 동작 또는 실제 모델 지연이 같다는
주장과는 구분한다.

## F01: archive 미실행 거절이 다음 요청을 막는 문제

원래 입장한 사용자·채널·명령을 검증한 뒤, archive 전송과 예약이 시작되기
전에 확실히 거절된 경우에만 `archive_not_dispatched` 결과를 기록한다.
네이티브 DB 쓰기 경로에도 같은 결과 기록을 연결했다. 알림 실패로 이 요청이
`held`가 되더라도, 확인된 미전송 결과는 다음 archive의 미완료 작업으로
집계하지 않는다.

다른 사용자의 요청, 변경된 원본 입장 기록, 외부 취소, 응답 없는 resume,
시작된 예약, 전송 후 불명확한 결과는 해제 대상으로 삼지 않는다. 기존 DB
스키마와 보류 요청을 자동으로 고쳐 쓰거나 재전송하지 않는다.

변경 파일:

- `src/runtime/action-executor/archive-action.ts`
- `src/runtime/action-executor/archive-write-native.ts`
- `src/runtime/action-executor/archive-write-native-worker.ts`
- `src/store/archive-fence.ts`

## F02: 큰 rollout append마다 소비한 구간 전체를 다시 읽는 문제

16MiB 이상 소비한 Windows 로그에서는 NTFS 변경 기록이 기존 검증 이후의
변경을 append로 확인해 줄 때 SHA 상태를 재사용한다. SHA 상태는 프로세스
메모리에만 최대 32개 보관하며 본문을 메모리에 저장하지 않는다.

파일 ID·볼륨·생성 시점과 journal ID, 유효한 USN 범위를 확인한다. 처음
기준점의 기록도 포함해 검사하므로, 열린 writer에서 같은 종류의 변경이
합쳐지는 경우를 빠뜨리지 않는다. 중간 덮어쓰기·truncate·불명확한 변경
기록은 전체 검증으로 돌아간다. 마지막 USN과 파일 경로/핸들 메타데이터도
다시 확인한다.

변경 기록은 읽기 전용으로 조회하며 관리자 권한을 요구하거나 writer를
잠그지 않는다. 기록 조회는 최대 32 × 64KiB와 조회 사이 250ms 예산으로
제한한다. 파일 본문 해시의 기존 1MiB 버퍼·10초 예산은 유지한다.

16MiB 미만, Windows가 아닌 환경, 비지원 파일시스템, 권한 거절, journal
교체·유효 범위 이탈, 조회 예산 초과, 프로세스 재시작은 전체 prefix를
검증한다. 따라서 모든 환경에서 O(추가된 바이트)라고 주장하지 않는다.
이 16MiB 기준은 검증을 생략하는 파일 크기 제한이 아니라 조회 비용을
절약하기 위한 최적화 기준이다.

실제 Windows 파일에서 128MiB 소비 후 18바이트 append를 3회 비교한 결과:

| 구간 | 기존 | 수정 |
|---|---:|---:|
| 매 append의 rollout 본문 읽기 | 134,218,240 B | 512 B |
| 검증 시간 | 92.8 / 96.5 / 100.9ms | 8.7 / 7.0 / 7.2ms |

본문 읽기 수치는 NTFS metadata/journal 조회량을 제외한다. 같은 PC의 국소
벤치마크이며 Discord 전송·Codex 모델·Rust 런타임의 종합 A/B 수치가 아니다.

변경 파일:

- `src/runtime/session-mirror/continuity-observation.ts`
- `src/runtime/session-mirror/windows-append-journal.ts`

API 근거: [Microsoft change journal records](https://learn.microsoft.com/en-us/windows/win32/fileio/change-journal-records),
[READ_USN_JOURNAL_DATA_V1](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-read_usn_journal_data_v1),
[FSCTL_READ_FILE_USN_DATA](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_read_file_usn_data),
[Microsoft Windows SDK header](https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/um/winioctl.h).
파일의 최신 USN 조회에서 반환되는 `Reason`은 유효하지 않으므로 판정에
쓰지 않고, 실제 journal 기록의 `Reason`을 사용한다.

## F03: 런타임 진단이 고정 문구로 바뀌는 문제

gateway, mirror, completion, ingress, heartbeat, 종료·재시작 등의 발생
구간을 구조화 로그에 남긴다. 허용된 오류 종류·코드·단계·대상 ID와 원인
체인의 분류를 보존한다. 사용자에게 표시한 추적 번호를 같은 로컬 로그에서
찾을 수 있으며, 같은 실패의 번호는 실행 중 안정적으로 유지해 retry의
중복 억제를 방해하지 않는다.

원문 메시지·stack·요청 본문·임의 객체 속성·경로는 출력하지 않는다.
식별자는 형식을 제한하고 설정된 토큰은 가린다. accessor/proxy/coercion을
실행하지 않으며 깊이·개수·출력 크기에 상한을 둔다. 정상 mirror poll은
오류 로그를 만들지 않는다.

변경 파일:

- `src/runtime/discord-runtime/diagnostics.ts`
- `src/runtime/discord-runtime/local-application.ts`

## 검증

실행 증거 디렉터리: `.runtime/parity-fixes-20261021/`.

- archive 거절·네이티브 DB·원본 입장·custody·인접 명령: **145/145**.
- 초기 mirror/anchor 검사: **18/18**. 최종 16MiB 기준은 아래 전체 검사와 설치본에서 재검증했다.
- 진단 단위 검사와 실제 Windows 런타임 구성: **8/8**.
  3개 동시 스레드의 반복 final, 하나의 stop, 다른 스레드 진행, stop 이후
  재질문과 실제 gateway 진단 콜백을 포함한다.
- production build 및 전체 테스트 소스 TypeScript 컴파일 통과.
- 별도 npm 설치본: **143/143**, 실패·skip 없음. 소스 실행 없이 설치된
  `dist`에서 archive·append·진단과 기존 Windows 시작·트레이·MCP·재시작
  경로를 검사했다. 패키지 SHA-256:
  `baba33d891769c8205e3289d1c76e95b16609e9c1528683ca3a1e3dffa3c8062`.
- 전체 mirror 68개 파일: **475개 중 463 통과, 12 실패**. 실패 12개 모두
  미러 변경 전 컴파일 스냅샷에서도 같은 조건과 예상값 차이로 재현했다.
  이 실행을 전체 통과로 표시하지 않는다.

| 기존 실패 | 개수 | 근거 |
|---|---:|---|
| Linux 실행을 명시적으로 요구하는 crash fixture | 2 | `win32 !== linux` |
| 심볼릭 링크 생성 권한을 요구하는 fixture | 5 | Windows `symlink EPERM` |
| `/original`을 그대로 기대하는 경로 fixture | 1 | 실제 Windows 정규 경로는 `C:/original` |
| 새 Bridge worker 슬롯을 빠뜨린 frozen 기대값 | 3 | 실제 값에 `Bridge: 0` 추가 |
| native startup 교란 시 예외 이름 기대값 | 1 | `Error` 대 `MirrorStartupIntentConflictError` |

재현 로그: `mirror-baseline-failures.log`, `mirror-baseline-platform.log`,
`mirror-baseline-final.log`. 비교에 사용한 변경 전 mirror 모듈은
`green-profile.json`이 지정하는 컴파일 스냅샷이다. 기존 측정 fixture와
플랫폼별 테스트 구성 정비는 이번 F01–F03 수정과 별도이며, 이 실패를
숨기기 위해 테스트를 수정하거나 skip 처리하지 않았다.

이전 검사 중 변경 범위와 관계없는 native migration 검증은 기존 보고서의
결과를 유지하며 새 실행으로 합산하지 않는다. 검사별 겹치는 항목이 있어
통과 수를 합산해 독립 검사 수로 표시하지 않는다.
