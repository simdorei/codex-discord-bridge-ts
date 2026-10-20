# Rust / TypeScript 전체 이식 후속 대조

검사일: 2026-10-20 KST. 통합 대상: `0.1.0-alpha.10`.

## 결론

공개 명령과 원격 도구 목록에는 누락이 없고, Windows 이식 및 설치 검사는
아래 범위에서 통과했다. 그러나 **Rust의 내부 동작과 성능까지 모두 같아서
실사용 버그만 관찰하면 되는 단계는 아니다.** archive 미실행 거절의 DB 기록,
미러 로그 append 시 기존 구간 재검증 비용, 런타임 진단 전달에 차이가 남아 있다.

이번 병합은 GUNG에 적용했던 CMD 독립 실행·트레이 보강과 검사 중 확인한
Windows 원자적 파일 교체 보강을 반영한다. 아래 잔여 차이 세 가지를 해결한
것으로 집계하지 않는다. 기존 일곱 항목 보고서는
[이전 통합 보고서](rs-ts-feature-comparison-2026-10-20.md)를 참고한다.

## 비교 기준과 방법

| 기준 | 검사한 버전/범위 |
|---|---|
| Rust 원격 main | `859bb62a0f0873521ce9c78ab1a5ff8d8612bdae` |
| Rust 원격 tree | `da1da21d68428fa84244c176c4efe28b42d2af1f` |
| 5060 Rust 로컬 | `C:\repos\simdorei\codex-discord-remote-rust`의 실제 파일. HEAD는 `6b6255d44e465572c33cb051e13bf889cbfb7646`이지만 미커밋·미추적 파일을 포함한다. |
| TS main 시작점 | `84f1bf372212bc79e5a8f08f6de17fe3b484117d`, tree `b6eaa4dde8ddbb90e122c945b72d6a92877e6586` |
| GUNG 입력 | `C:\codex-discord-bridge-ts\source`, alpha.9. 소스·테스트·스크립트·도구·플러그인·문서 및 최상위 설정의 2,325개 파일을 비교했다. 생성된 플러그인 lib와 실행 데이터는 제외했다. |
| 통합 후보 | 위 TS main에 GUNG의 실제 차이 12개 파일을 해시 검증 후 반영하고, 원자적 파일 교체 보강과 이 보고서를 추가한 alpha.10 |

Rust 로컬은 오래된 HEAD의 `git diff`만으로 판단하지 않았다. 인덱스에서는
삭제로 보이지만 디스크에 미추적 파일로 존재하는 구현도 읽었다. 지정한
소스 확장자 범위에서 Rust main과 로컬의 바이트 차이는 357개였으며,
그중 변경된 Rust 파일 181개를 rustfmt 출력으로 대조하면 149개가 같고
32개가 달랐다. 이 수치는 누락 기능 개수가 아니다. 남은 차이에는 테스트,
조건부 컴파일, 함수 추출과 실제 동작 변경이 섞여 있어 호출 경로를 추가 확인했다.

원격 PC의 토큰·`.env`·DB를 저장소로 복사하지 않았다. 가동 중인 5060 Rust와
GUNG TS를 중지하거나 DB를 변경하지 않았다.

## 공개 계약과 실행 경로

아래 목록 대조는 Rust main과 Rust 로컬 양쪽에 대해 동일한 결과였다.
목록·스키마 일치와 런타임 동등성 증명은 구분한다.

| 영역 | 결과 | 확인한 구현/검증 경로 |
|---|---|---|
| Discord 명령 | CommandAction 38/38, slash 19/19, 누락·추가 없음 | 명령 해석 → `RuntimeCommandExecutor.executeWithIngressContext` → 메시지/interaction 처리 |
| 원격 요청 | Core 18, Computer 12, Terminal 9, 총 39/39 | 원격 dispatcher 및 Windows project/files/terminal/computer provider 구성 |
| 자체 MCP 서버 | 51/51, 전체 도구 정의와 스키마 일치 | OAuth worker, HTTP gateway, WebSocket broker, 설치 CLI |
| Pro 커넥터 | LF 정규화 후 Rust main·로컬과 동일 | connector/helper/release-tools, 설치된 plugin helper |
| 설정 | 비교 대상으로 추출한 24개 키 일치 | Rust runtime/remote 설정의 `DISCORD_`, `CODEX_REMOTE_MCP_`, `CODEX_APP_SERVER_` 접두사 범위. 모든 환경변수의 전수 증명은 아니다. |
| Codex 발견·fallback | 최신 main의 완전한 설치 선택 조건 존재 | `runtime-paths`가 matching code-mode-host와 기존 실행 파일 후보를 검사. 잘못된 명시적 경로를 조용히 무시하지 않는다. |
| 큐·final·busy | 최신 main의 핵심 보강 경로 존재 | confirmed-delivery 빠른 정리, preflight, 채널 한정 final-current 조회, `held/result_recorded`의 확정 busy 거절 구분 |
| 비동기·동시 작업 | 대상별 순서와 독립 대상 진행 경로 존재 | worker 재사용, shared mapping lease, 세 스레드 final/stop/resume 및 두 대상 backlog 검사 |
| 첨부·원격 파일 | 설치 구성에서 연결됨 | proxy 첨부, file CAS, 5 MiB 이미지 입력, DPAPI handoff 등 로컬 provider 통합 |
| recover·repair·archive·관리 | 실행 경로 존재, archive 잔여 차이 있음 | Windows recovery/host/archive-delete controller, native admin 및 보호된 삭제 검사 |
| 트레이·워치독·로그인 실행 | GUNG alpha.9 보강을 통합 | 아래 변경과 실제 GUI launcher/예약 작업 자산 검사 |

Pro 커넥터 SHA-256:
`a9aa97457ff73e93117d18efa3fa48dd924f00f54935af5c78359cbd5779ccf8`.

## 이번에 반영한 변경

### CMD 종료와 독립된 상주 실행

`--start`와 `--watchdog`는 숨김 상주 프로세스를 시작하고 호출한 터미널에서
분리된다. 로그인 작업은 `wscript.exe` GUI 호스트와 패키지의
`codex-discord-hidden.vbs`를 사용한다. GUI 호스트는 자식 종료를 기다리고
실제 종료 코드를 보존하여 Task Scheduler의 실패 재시작 판단이 유지된다.

워치독은 실제 봇 자식이 시작된 뒤 트레이를 한 번 시작한다. 같은 설치의
이전 트레이 예약 작업만 정리한다. cutover는 실제 task executable/arguments를
저장하며, 예전 journal에 `taskExecute`가 없는 경우도 처리한다.

관련 파일: `src/cli/windows-control.ts`, `src/cli/cutover.ts`,
`src/cli/startup.ts`, `src/runtime/windows/supervisor.ts`,
`scripts/CdrRuntimeCutover.ps1`, `scripts/codex-discord-hidden.vbs`,
`scripts/Test-NativeWorkspace.ps1`.

### 잠깐의 파일 잠금 때문에 워치독이 종료되는 문제

처음 회귀 검사에서 restart 영수증이 `drain_pending`으로 진행하지 않는
실패를 재현했다. native 결과를 확인하니 영수증 교체가 Windows 오류 5로
실패하고 supervisor가 종료했다. 단순 검사 시간 초과로 처리하지 않았다.

`src/runtime/windows/windows-atomic-file.ts`에서 Windows 오류 5/32/33으로
**실패가 확인된 동일한 임시 파일 rename**만 20ms 간격으로 최대 약 500ms
재시도한다. RPC나 사용자 명령을 재실행하지 않으며, 결과가 불명확한 native
호출은 재시도하지 않는다. 계속 잠겨 있으면 기존 파일을 보존하고 실패한다.

실제 Windows handle로 교체를 잠깐 막는 회귀는 수정 전 실패했고 수정 후
통과했다. 영구 잠금의 유한 실패·원본 보존·임시 파일 정리도 검사했다.
공유 writer를 사용하는 marker 및 DPAPI handoff 인접 검사도 통과했다.

## 남아 있는 차이 — 이번 병합에서 미수정

### F01 / 높음: archive 미실행 거절이 미해결 요청으로 남는다

Rust main의 `crates/cdr-runtime/src/action_executor/archive_action.rs`는
archive를 보내기 전의 `ActionError::Invalid`에 `archive_not_dispatched`
결과를 저장한다. 이미 보낸 archive와 typed app-server hold는 그대로 보존한다.

TS `src/runtime/action-executor/archive-action.ts:65`는 이 결과 저장 없이
오류를 던진다. 상위 `message-worker/processor.ts`의 실패 처리도
`mirror_cleanup_refused` 전용이며 archive 거절을 정산하지 않는다.
`message-worker/custody.ts`의 종료 처리는 결과 없는 요청을 held로 남긴다.

기존 archive fixture의 `scope-change` 상황을 사용한 별도 재현:

```text
thread/archive RPC: 0
실패 직후: state=executing, phase=processing, outcome 없음
custody와 같은 hold 전이 후: state=held, phase=processing, outcome 없음
unfinishedArchiveRequest(root): own
```

따라서 거절한 archive 자체가 다음 archive의 미완료 요청으로 잡힌다.
과거 async obligation이 있는 대상에서는
`src/store/async-resolution-admission.ts`의 lifecycle 판정도 다음 입력을
막을 수 있다. 이번 재현은 실제 사용자 DB에 조작을 가하지 않은 fixture이며,
현재 GUNG 장애가 반드시 이 원인이라는 주장은 아니다.

후속 수정은 최신 Rust의 **원래 요청·원래 대상이 확인되고 archive 미전송이
확정된 거절만** 정산해야 한다. unknown mutation, 실제 archive 전송 후 timeout,
취소된 원래 소유권까지 풀면 안 된다. 재시작 후 다음 질문/다음 archive,
알림 전송 실패, 잘못된 actor, 실제 전송 후 timeout을 함께 검증해야 한다.

### F02 / 중간: 로그 append마다 이미 소비한 prefix 전체를 다시 읽는다

TS `local-session-mirror-profile.ts`는 full-prefix 검증을 사용한다.
`session-mirror/continuity-observation.ts`의 SHA 캐시는 파일 stamp가 같을 때만
재사용되므로 append로 크기·시간이 바뀌면 기존 prefix를 다시 해시한다.
Rust `session_mirror_worker.rs`의 `read_new_session_events(path,cursor,None)`는
cursor 뒤의 새 구간을 읽는다.

Windows 실제 파일의 소비한 이력 32 MiB에 18바이트를 추가한 실측:

| 상황 | 파일에서 읽은 바이트 | 관측 시간 |
|---|---:|---:|
| 변경 없음 | 512 | 1.34 ms |
| 첫 append | 33,554,944 | 31.71 ms |
| 다음 append | 33,554,944 | 31.42 ms |
| 그다음 append | 33,554,944 | 31.51 ms |

이 측정은 continuity observer의 I/O이며 Discord 전송·모델 지연의 측정이나
Rust와의 동일 장비 시간 비교가 아니다. 변경 없는 polling, 512 MiB 제한,
대상 간 전역 직렬화 문제를 고쳤어도 append 비용까지 같아진 것은 아니다.

전체 해시를 그냥 끄면 같은 파일의 중간 재작성 검출을 잃는다.
검증된 append 경계/producer 계약과 재시작 복원 방식을 정하고,
append·중간 rewrite·truncate·파일 교체·재시작을 함께 검사해야 한다.

### F03 / 중간: 런타임 진단 콜백이 오류 문맥을 버린다

`src/runtime/discord-runtime/local-application.ts:66`의 `report`는 전달된
인자를 사용하지 않고 `runtime_diagnostic: inspect protected local evidence`만
쓴다. `render`도 항상 `runtime operation failed`를 반환한다. 이 콜백이
gateway·mirror·completion·시작 처리 등에 연결되어 해당 경로의 원인과 대상
문맥이 소실된다. 이 함수에는 별도의 상세 증거 저장 호출도 없다.

Rust `crates/cdr-runtime/src/session_mirror/background.rs`는 mirror 오류,
대상과 채널을 보고한다. 모든 TS 진단이 없다는 뜻은 아니지만, 해당 런타임
콜백은 장애 분석에 필요한 정보를 보존하지 않는다.

후속 수정은 검증된 오류 분류·단계·correlation ID와 허용된 대상 정보를
구조화하여 기록해야 한다. 원문 payload·토큰을 무조건 로그에 쓰는 방식은 피한다.

## 검사 기록

환경: Windows x64, Node 24.21.0, 저장소 고정 dependency. 실제 모델/Discord
서비스 대신 로컬 child provider와 loopback 전송을 사용하는 검사가 포함된다.

| 검사 | 결과 |
|---|---|
| production build / 전체 테스트 소스 컴파일 | 통과 |
| rs-parity + cutover + npm CLI, 19개 파일 | 101/101 통과 |
| windows-migration 프로필, 39개 파일 | 664/664 통과 |
| Windows atomic marker + DPAPI handoff 인접 검사 | 42/42 통과 |
| 현재 Pro composer 계약 | 30/30 통과 |
| alpha.10 별도 npm prefix 설치 검사 | 104/104 통과 |

검증한 내용에는 실제 GUI 호스트의 콘솔 숨김, Unicode 인수, 종료 코드 37의
전달, 세 스레드 반복 final·stop·resume, 양쪽 대상 backlog, 원격 연결 구성과
설치된 JS/plugin/PowerShell 자산이 포함된다.

최초 검사의 npm CLI fixture는 10초 한도에서 시간 초과했으나 단독 재실행
3/3과 최종 통합 실행에서 통과했다. 이 경로의 코드는 바꾸지 않았다.
워치독 실패는 위의 native 파일 교체 오류로 별도 추적·수정했다.

Windows에서 POSIX restart-handoff fixture를 잘못 선택한 실행은
POSIX 경로/권한 조건 때문에 실패했다. 실패 로그는 보존했고 올바른 Windows
handoff 검사로 대체했다. 이를 전체 저장소 테스트 성공으로 계산하지 않는다.

재현 로그와 원본 비교 자료는 검사 PC의
`C:\repos\simdorei\cdr-ts-full-parity-20261020\.runtime\audit-20261020`에 있다.
`contracts.json`, `append-measurement.json`, `archive-gap.log`,
`parity-final.log`, `migration.log`, `atomic-windows-adjacent.log`,
`installed-alpha10.log`가 주요 결과다. `.runtime` 증거에는 임시 경로 등이
포함되어 저장소에 일괄 추가하지 않는다.

## 적용 범위와 남은 확인

main 병합과 실행 중인 PC의 교체는 별개다. GUNG에는 이전 작업의 alpha.9
CMD 독립 실행 수정이 적용되어 있다. 이번 alpha.10 원자적 파일 교체 보강은
저장소/패키지 변경이며 이 검사에서 GUNG를 다시 시작하지 않았다.

실제 Windows 로그아웃·재부팅, 모든 컴퓨터 유즈 UI, 실제 OAuth 사용자 흐름,
모델/네트워크 지연의 Rust 대비 전체 A/B 측정은 완료로 주장하지 않는다.
F01~F03을 닫기 전에는 전체 동등성 또는 '실사용 버그만 남음'으로 표시하지 않는다.
