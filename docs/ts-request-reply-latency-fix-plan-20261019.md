# TS 봇의 Rust 실행 구조와 응답 성능 이식 수정계획

작성일: 2026-10-19. 대상: gung PC의 TS 봇과 사용자가 사용한 로컬 Rust판.
이 문서는 구현 계획이다. 이번 작업에서는 운영 코드 수정, 봇 재시작, 배포를 하지 않는다.

사용자가 요청한 이식의 기준은 **Rust의 기능, 실행 구조, 동시 처리 특성, 응답 성능을 함께 보존하는 것**이다. 기능 목록이 같거나 Worker 생성 횟수가 줄었다는 사실만으로 이식 완료라고 판정하지 않는다. 앞서 정한 TS 자체의 2~3초 목표는 이 기준을 대신할 수 없어 폐기한다.

현재 브랜치는 `codex/ts-npm-windows-20261018`, HEAD는 `bf5c2f4f4bb0cba0888fd0b46a6be50ca9db45d2`다. 기존 미커밋 수정과 추가 파일이 많고, 설치된 gung에는 이전 Worker 재사용 수정이 적용돼 있다. 따라서 HEAD만을 수정 전 상태로 취급하지 않는다. 구현 시작 시 실제 작업 파일과 설치 파일의 해시를 별도로 보존한다.

## 무엇을 바꾸려는가

여기서 모듈은 봇 내부 코드 파일과 그 파일이 불러오는 다른 코드 파일을 뜻한다. MCP 서버나 플러그인을 새로 연결한다는 뜻이 아니다. Worker는 봇 프로세스 안에서 별도의 JavaScript 실행 환경을 가진 작업 스레드다.

목표는 Rust의 요청 처리 단위, 실행 주체의 수명, 잠금 범위, 독립 작업의 동시 진행, 답변 알림과 전송 순서를 TS에서 보존하는 것이다. Worker 재사용은 이를 달성할 수단이며, 기존 TS의 단계를 그대로 두고 Worker만 재사용하는 방안을 최종 구조로 미리 확정하지 않는다.

Rust 코드를 Node 메인 이벤트 루프에 그대로 옮겨 동기 DB 호출로 전체 봇을 막는 방식도 피한다. Node에서 필요한 작업 분리는 유지하면서, 실행 환경을 요청마다 재생성하거나 Rust에 없는 대기 단계를 추가하지 않는 방식으로 대응시킨다. 요청 내용·선택 상태·처리권을 오래된 값으로 캐시해 속도를 얻지 않는다.

## 확인한 근거와 측정 범위

gung의 설치된 코드로 임시 DB, 가짜 Discord 서버, 100ms 후 응답하는 가짜 Codex를 사용했다. Discord 서버는 localhost에서 실행했고 실제 Discord에 시험 메시지를 보내지 않았다.

| 구간 | 수정 전 격리 시험 |
|---|---:|
| 요청 시작부터 Codex `turn/start` 호출까지 | 6,742ms |
| 호출부터 가짜 답변 수신까지 | 약 102ms |
| 답변 수신부터 localhost 최종 전송까지 | 3,241ms |
| 전체 | 10,085ms |
| 위 요청 구간의 새 Worker 수 | 59개, 백그라운드 작업 포함 |
| 메인 이벤트 루프 지연 최댓값 | 약 37ms |

별도 SQL 계측 시험에서 `native-mutation-worker` 4회의 Worker 본문 실행 시간 합계는 2,141ms, 계측된 SQLite 메서드 실행 시간 합계는 77ms였다. Worker 준비와 그 밖의 JS 처리에 상당한 비용이 있음을 뒷받침한다.

SQLite 생성자와 연결 열기 시간은 이 계측에 포함되지 않았다. 따라서 SQL 밖의 시간을 전부 코드 파일 로딩 시간이라고 단정하지 않는다. 계측 자체의 비용도 있고, Worker별 실행 시간에는 겹치는 구간이 있어 전체 지연처럼 단순 합산하지 않는다. 잘못 연결된 최초 SQL 계측의 0ms 결과는 근거에서 제외했다.

Rust 최근 5건의 봇 접수 기록부터 Codex 호출까지는 약 0.85~0.88초였고, TS 실사용 2건은 약 5.9~7.7초였다. 서로 다른 PC의 실사용 관측이며 언어 자체의 동일 조건 성능 비교는 아니다. 수정 전후 비교는 같은 gung에서 한다.

근거:
- [격리 시험 결과](../.runtime/latency-isolation-gung-20261019.json)
- [이전 CPU 개선 검증 기록](../.runtime/worker-reuse-20261019-validation.json)
- gung runtime의 `latency-probe-20261019/summary.json`, `result-sql-proto.json`, `sql-proto-summary.json`.
- 위 `.runtime` 파일은 로컬 진단 산출물이다. 공유할 때는 민감 정보가 없는 요약을 구현 검증 기록에 함께 보존한다.

## Rust와 대조할 실행 구조

기준은 Git 원격 main만이 아니라 사용자가 사용한 로컬 Rust 작업 트리다. 확인 시 Rust HEAD는 `6b6255d44e465572c33cb051e13bf889cbfb7646`이고 로컬 수정도 있으므로, 소스 해시와 실제 비교 바이너리의 빌드 입력을 함께 고정한다. 운영 Rust 봇을 교체하거나 재시작하지 않고 별도의 격리 시험 산출물을 만든다.

Rust에도 질문 접수에서 DB 함수를 직접 호출하는 경로와 완료 알림에서 `spawn_blocking`으로 DB 작업을 분리하는 경로가 모두 있다. 따라서 대응해야 할 대상은 실제 작업 단위와 대기 관계다. Worker 유무만으로 동등성을 판단하지 않는다.

| 비교 대상 | Rust 근거 | TS에서 대조할 내용 |
|---|---|---|
| 메시지 접수와 질문 제출 | [message_worker.rs](../../codex-discord-remote-rust/crates/cdr-runtime/src/message_worker.rs), [prompt_intake.rs](../../codex-discord-remote-rust/crates/cdr-runtime/src/action_executor/prompt_intake.rs) | `message-worker/processor.ts`, `prompt-intake/native-state.ts`의 순서, 추가 왕복, 실행 환경 준비 |
| 스레드별 순서와 독립 작업 | [queue_runner.rs](../../codex-discord-remote-rust/crates/cdr-runtime/src/queue_runner.rs) | [keyed-locks.ts](../src/core/keyed-locks.ts)에도 대상별 잠금이 존재함. TS의 추가 전역 Control 대기가 독립 작업을 더 막는지 확인 |
| 결과 준비 후 깨우기와 전송 | [completion driver](../../codex-discord-remote-rust/crates/cdr-runtime/src/completion_worker/driver.rs), queue_runner의 Notify | [TS scheduler](../src/runtime/completion/scheduler/run.ts)에도 깨우기가 있음. 알림부터 DB 준비와 실제 HTTP까지 연결·대기 범위 비교 |
| DB 처리 단위와 수명 | Rust 직접 호출 및 spawn_blocking 사용 지점 | 필요 이상으로 작은 작업을 여러 왕복으로 나눴는지, 코드와 실행 주체의 유지 단위 |
| stop과 일반 요청 | [control_turn.rs](../../codex-discord-remote-rust/crates/cdr-runtime/src/action_executor/control_turn.rs) 및 실제 호출 경로 | stop 접수·앱서버 전달·DB 확정의 대기와 실패 격리 |
| 실패와 종료 | [shutdown.rs](../../codex-discord-remote-rust/crates/cdr-runtime/src/discord_runtime/shutdown.rs) 및 실제 해제 경로 | 확정/불명확 결과, 진행 중 I/O, 소유권 해제, 재시작 후 복구 범위 |

표는 대조의 출발점이다. TS에도 존재하는 구조를 누락이라고 주장하지 않는다. 코드로 확인한 차이, 계측으로 확인한 영향, 미확인 사항을 구분한다. Python의 과거 지연을 TS와 같은 원인의 증거로 사용하지 않는다.

## 수정 범위

기존 [작업 허용 목록](../src/runtime/reusable-worker-operations.ts), [작업 실행 루프](../src/runtime/reusable-worker-entry.ts), [Worker 할당](../src/runtime/owned-worker-slot.ts), [재사용 수명 관리](../src/runtime/owned-worker-reuse.ts)는 활용 가능한 기반이다. Rust 구조와 맞는 부분을 재사용하고 불필요한 대기나 수명 경계를 만드는 부분을 필요한 범위에서 수정한다.

아래 14개는 요청 구간에서 생성이 확인된 일회성 Worker 조사 목록이다. 모두 같은 래퍼로 감싸는 작업을 최종 설계로 확정한 목록이 아니다. 기본 경로는 `src/runtime/`다.

| 처리 단계 | 대상 파일 | 기존 동작에서 보존할 것 |
|---|---|---|
| 원본 메시지 접수·처리 결과 기록 | `message-worker/native-journal-worker.ts` | 원본 메시지 식별, 접수·결과·확정 순서 |
| 질문 접수·처리권·미러 대상 확인 | `prompt-intake/native-state-worker.ts` | 처리권 토큰, 대상 재확인, 실패 판정 |
| 앱서버 변경 요청 기록 | `native-mutation-worker.ts` | 요청 시작·완료 기록, 결과 불명확 판정 |
| 대기열과 실행 가능 상태 조회 | `queue-runner/native-read-state-worker.ts` | 전체 행 검증, 대상·세대 확인 |
| 실행 시도·실행 상태·최종 결과 준비 | `queue-runner/native-attempt-worker.ts` | 원래 처리권에 묶인 조건부 갱신 |
| 접수된 질문을 대기열로 이동 | `queue-runner/native-submission-worker.ts` | 원자적 이동, 명확한 사전 거절과 불명확 결과 구분 |
| 앱서버 idle 전환 전 상태 확인 | `native-idle-before-worker.ts` | 소유자·세대·종료 확인 |
| 답변 후보 메타데이터 | `completion/native-heads-worker.ts` | 후보 수와 출력 크기 제한 |
| 답변 소유 요청 확인 | `completion/native-owner-read-worker.ts` | 원본 요청·스레드·turn 결합 |
| 이미 처리한 답변과 과거 기록 확인 | `completion/native-history-read-worker.ts` | 중복 방지 및 이전 실행 증거 |
| 실제 전송할 내용 읽기 | `completion/native-http-payload-worker.ts` | 출처·실행 세대 검증 |
| 최종 전송 전후 상태 기록 | `completion/native-final-state-worker.ts` | 전송 전 확인, 실패 및 완료 기록 |
| 전송 영수증 처리 | `completion/native-receipt-store-worker.ts` | Begin·Confirm·Release·Block의 기존 트랜잭션 |
| 선택 스레드와 설정 JSON 처리 | `bridge-state-native-worker.ts` | 단일 소유자, 선택 세대, 파일 쓰기 순서 |

Bridge 상태 JSON은 SQLite 경로와 성격이 달라 단일 소유자와 파일 쓰기 순서를 별도로 보존한다. Rust 대응표를 먼저 완성하고 필요한 작업 단위와 수명에 맞춰 파일별 변경 범위를 확정한다.

공개 명령과 응답 형식, DB 스키마, MCP·컴퓨터 유즈 기능, 앱서버 사용 방식, 모델 설정, Discord 권한은 보존한다. 내부 실행 통로·수명·잠금 배치는 사용자가 요청한 Rust 구조 동등성을 위해 필요한 범위에서 수정 대상에 포함한다. 근거가 없는 전면 재작성은 하지 않는다.

## 구현 순서

1. **Rust 기준과 동일 조건 비교 시험을 고정한다.**

   양쪽 소스·설치 파일 해시, Node 버전, Rust 빌드 종류, 설정, 미러 수를 기록한다. 같은 gung PC에서 별도의 임시 DB와 가짜 Discord·Codex로 시험한다. 두 봇을 실제 Discord에 동시에 연결하지 않는다.

   Rust의 [offline soak 진입점](../../codex-discord-remote-rust/crates/cdr-runtime/src/bin/cdr-offline-soak.rs)과 가짜 앱서버 fixture를 활용해 공통 입력과 관측 지점을 맞춘 비교 어댑터를 준비한다. Rust는 release 빌드, TS는 설치본과 같은 컴파일된 JS를 사용한다.

   메시지 처리 진입, 접수 기록, Codex 호출, 답변 수신, 최종 HTTP 완료를 양쪽에서 같은 의미로 측정한다. 각 실행 내부의 단조 시계를 사용하고 Discord 시각과 PC 시각을 섞지 않는다. 계측은 시험 프로세스에만 적용하고 사용자 질문·토큰·파일 내용은 출력하지 않는다.

2. **기능별 실행 구조 대응표를 완성한다.**

   접수 → 대상 확인 → 처리권 → 대기열 제출 → 앱서버 호출 → 결과 관찰 → 전송 영수증 순서로 실행 주체·대기열·잠금·트랜잭션·외부 I/O·취소 경계를 나란히 기록한다.

   차이는 Rust와 동일한 구조, Node 특성 때문에 필요한 대응, 근거 없이 추가된 비용으로 구분한다. Node 대응에는 이유와 같은 외부 동작·동시 진행을 보장하는 시험을 붙인다. 이 대응표를 실제 패치의 근거로 사용한다.

3. **Rust에 맞는 작업 단위와 실행 수명을 구현한다.**

   짧은 DB 단계마다 실행 환경을 생성하고 종료하는 비용을 제거한다. 재사용 풀을 활용해도 Bridge 처리와 DB 작업 사이에서 Worker를 계속 교체한다면 그 원인까지 수정한다.

   가능한 구현은 런타임이 소유하는 유한한 상주 실행 주체에 작업을 전달하는 방식이다. 통로 수와 역할은 Rust의 호출·잠금 경계와 Node 메인 루프의 응답성을 함께 만족하도록 정한다. 현재 TS의 Control=1이나 30초 유휴 종료를 최종 불변 요구사항으로 삼지 않는다.

   하나의 Rust 작업 단위를 불필요하게 여러 왕복으로 나눈 부분은 필요한 경우 묶는다. 외부 I/O나 잠금 해제 뒤에 해야 하는 대상 재확인·처리권 갱신·DB 기록은 앞당기거나 생략하지 않는다. 결합은 데이터 최신성과 취소 경계가 같다는 시험을 통과해야 한다.

   요청별 변수와 createMutationCustodyFence 같은 입력에 묶인 객체는 매 요청 새로 만든다. 이전 요청·결과·대상·runtime ID·오류가 다음 작업에 남지 않아야 한다. DB 정리 완료와 정확한 응답 결합을 확인한 뒤 다음 작업을 받는다.

4. **Rust와 같은 동시 진행 범위와 실패 격리를 맞춘다.**

   같은 대상에서 순서를 지켜야 하는 작업은 직렬화한다. Rust에서 진행 가능한 독립 스레드의 작업까지 TS의 전역 대기로 막히는지 시험하고 확인된 차이만 수정한다. 공유 SQLite 쓰기 잠금처럼 양쪽에 존재하는 제한은 구분한다.

   완료 알림·stop·일반 질문·미러 작업의 실행 자원 대기를 비교한다. Promise.all 추가나 Worker 한도 상향만으로 해결했다고 판단하지 않는다. 자원과 대기열은 계속 유한하게 유지하고 배치 변경에는 기존 값·변경 값·Rust 대응 근거·최대 자원량을 기록한다.

   DB 경로 제한, 원본 요청 식별, 진행 중 I/O 소유권, 중복 방지를 보존한다. 정상 작업은 정리 완료로 다음 단계에 진행하고, 취소·타임아웃·실행 환경 오류는 실제 종료와 결과 불명확 상태를 정확히 처리한다. 시작 전 취소와 시작 후 취소를 구분하고 작업을 임의로 재실행하지 않는다.

5. **구조와 성능을 함께 검증한다.**

   공통 정상·경합·실패 입력으로 외부 효과와 필수 순서를 비교한다. UUID·타임스탬프 같은 비결정 값은 정규화하되 중복 호출·추가 재시도·추가 대기 장벽을 숨기지 않는다.

   시작 직후, 연속 질문, 40초 이상 유휴 후, 3개 스레드 동시 요청을 측정한다. 한 대상의 앱서버 응답을 지연시킨 동안 다른 대상과 stop이 진행되는 범위도 Rust와 대조한다. 개별 일회성 시험뿐 아니라 최종 설치 런타임이 사용하는 실제 실행 주체와 수명으로 시험한다.

6. **설치 산출물에서도 같은 결과를 확인한다.**

   npm 설치 산출물의 파일 포함·Worker 경로·빌드 해시를 확인하고 그 산출물로 공통 시험을 반복한다. 비교 환경이나 일부 경로가 미검증이면 그 범위를 명시한다. 기능만 확인하고 구조·성능까지 이식 완료라고 보고하지 않는다.

## 보존해야 하는 계약과 회귀 시험

| 상황 | 통과 기준 |
|---|---|
| 같은 Worker에 서로 다른 질문을 연속 전달 | 각 질문의 ID·대상·내용이 정확하고 이전 값이 남지 않음 |
| 파일 경로나 스레드가 바뀐 입력 | 기존 경로·선택 세대 검증을 통과한 작업만 실행 |
| DB 연결 정리가 누락된 작업 | 성공 응답 금지, Worker 종료 및 권한 정리 |
| 대기 중 취소 | 실제 DB 작업이 시작되지 않음 |
| 실행 중 취소·타임아웃 | 중복 실행 없음, 실제 종료 전 슬롯과 저장소 권한 유지 |
| 처리권 만료·다른 소유자의 갱신 | 기존 조건부 갱신과 명확한 거절 동작 유지 |
| SQLite 잠금과 Worker 예외 | 실패를 빈 정상 결과로 바꾸지 않음, 다음 요청에 오염 없음 |
| 최종 답변 전송 직후 DB 확정 실패 | 전송 영수증과 기존 불명확 결과 처리로 중복 전송 방지 |
| stop·새 질문·최종 답변 기록이 겹침 | Rust와 대응하는 진행 범위와 우선순위, 처리권과 유한 대기열 유지 |
| 3개 스레드 동시 작업 | Rust에서 독립적으로 진행되는 작업이 TS에서도 진행되고 답변·소유권이 섞이지 않음 |
| 종료·재시작 | 미종료 Worker를 남긴 채 단일 실행 권한을 넘기지 않음 |
| npm 설치 산출물 | 실제 `.js` 실행, 올바른 Worker 파일 포함, 소스 TS 경로 의존 없음 |

현재 물리 한도 Background=3, Control=1, Observation=2, Discovery=1, Maintenance=1, 총 8개는 TS 비교 기준값이다. 이 배치를 최종 불변 조건으로 고정하지 않는다. 변경이 필요하면 Rust와 대응시키고 최대 Worker 수·대기열 수·CPU·메모리 비용을 명시한다. 취소·중복 방지를 느슨하게 하거나 자원을 무제한으로 늘려 얻은 속도는 개선으로 인정하지 않는다.

기존 `owned-worker-reuse.test.ts`에 실행 수명 계약을, 새 `test/runtime/prompt-roundtrip-reuse.test.ts`에 요청 구간 계측을, 새 `test/windows-runtime/windows-rust-parity.test.ts`에 런타임 비교를 두는 구성을 우선한다. 새 파일명은 계획상의 이름이며 아직 생성하지 않았다. 최종 구조에 맞춰 프로필과 설치 산출물 시험에 등록한다.

기존 windows-workers 프로필 외에 메시지 journal, mutation transport, Bridge 상태, receipt store, stop, intake cancellation, Windows application 시험을 실행한다. 구현을 그대로 따라 쓰는 시험 대신 실제 소유권·경합·외부 효과·지연을 검증한다.

## 구조와 성능 완료 기준

기준은 **같은 PC에서 같은 입력을 처리하는 로컬 Rust 구현**이다. 기존 다른 PC 실사용 수치는 문제 발견의 근거이며 완료 판정용 비교가 아니다.

| 조건 | 완료 판정 |
|---|---|
| 요청 처리 순서 | 필수 확인·DB 기록·외부 효과 순서가 Rust와 대응하고 TS만의 불필요한 대기가 없음 |
| 시작 직후·40초 유휴 후 | 각 조건 최소 5회 비교하며 실행 환경 준비·재생성에 따른 초 단위 추가 지연이 없음 |
| 연속 요청 | 런타임별 최소 20회에서 Codex 호출 전과 답변 후 전송 지연의 p50·p95를 각각 비교 |
| 3개 스레드 동시 요청 | Rust 대비 독립 작업의 추가 직렬화, 완료 순서 제약, 지연 누적이 없음 |
| 한 대상 지연 및 stop | Rust에서 진행되는 다른 대상·제어 경로가 TS의 추가 공용 대기로 막히지 않음 |
| 실패와 재시작 | 확정/불명확 결과 분류, 중복 방지와 복구 범위 보존 |
| 자원 사용 | 유한한 Worker·대기열·연결이 누적되지 않음. CPU, 전체 RSS와 처리 중 추가 메모리를 Rust·수정 전 TS와 함께 보고 |
| 설치 산출물 | 실제 배포할 컴파일된 JS와 설치 경로에서도 비교 시험 통과 |

지연 회귀 허용 편차 초안은 각 구간의 Rust p50·p95에 대해 `max(100ms, 해당 Rust 값의 20%)` 이내다. 사용자가 지정한 SLA나 이미 달성한 수치가 아니라 이 계획의 검증 기준 제안이다. 측정 잡음이 크면 기준을 임의로 완화해 통과시키지 않고 환경과 표본을 점검한다. 표본 수와 원자료도 함께 제시한다.

시작 조건, 임시 DB, 미러 수, 가짜 응답 시간, 런타임 버전과 빌드, 계측 유무를 맞춘다. 실행 순서를 교차해 캐시·온도·백그라운드 부하의 편향을 줄이고, 무거운 계측 후 최소 계측으로 재확인한다. 필요한 Node 대응의 비용도 수치화하며 검증 기준을 넘으면 완료로 표시하지 않는다.

Rust에도 DB 작업을 분리하는 경로가 있으므로 스레드 전환 횟수의 숫자 일치보다 같은 의미의 작업 단위와 대기 관계를 검증한다. 메모리까지 같다고 주장하려면 해당 자원 비교도 통과해야 하며 언어 런타임의 기본 메모리 차이를 숨기지 않는다.

CI에서는 외부 효과·순서·소유권·추가 대기 장벽을 확정적으로 시험하고 시간 기준은 gung의 동일 조건 비교로 판단한다. Rust 비교 환경이 준비되지 않으면 TS 개선 결과는 보고할 수 있어도 Rust 동등성 완료로 보고하지 않는다.

## 실행할 검사

Node는 패키지 요구사항인 24.21.x를 사용하고 아래 명령은 TS 저장소 루트에서 실행한다. Rust release 빌드와 공통 fixture 실행 명령은 비교 어댑터를 구성한 뒤 검증 기록에 포함한다.

```powershell
$nodeExe = 'C:\repos\simdorei\codex-discord-bridge-ts\.runtime\node-v24.21.0-win-x64\node.exe'
& $nodeExe .\node_modules\typescript\bin\tsc --noEmit
& $nodeExe .\node_modules\typescript\bin\tsc -p tsconfig.build.json
& $nodeExe .\tools\stage-pro-helper.mjs
& $nodeExe .\tools\run-tests.mjs --profile windows-workers
& $nodeExe .\tools\run-tests.mjs test/runtime/message-worker/native-journal.test.ts test/runtime/message-worker/native-journal-recovery.test.ts test/runtime/message-worker/native-new-input.test.ts test/runtime/native-mutation-owner.test.ts test/runtime/native-mutation-transport.test.ts test/runtime/native-completion-receipt-store.test.ts test/runtime/bridge-state-native.test.ts test/runtime/stop-worker.test.ts test/runtime/queue-runner/intake-cancellation-boundaries.test.ts test/windows-runtime/windows-application.test.ts
git diff --check
```

현재 package.json에는 별도 lint 스크립트가 없다. 타입 검사, 빌드, 관련 시험, 기존 저장소 권한 코드 검사와 diff 검사를 수행하고 미실행 항목을 명시한다. 위 명령과 신규 시험은 구현 단계에서 실행할 계획이며 이 문서 작성 단계에서는 실행하지 않았다.

이전 확장 시험에는 Windows에서 열린 SQLite 파일을 교체하는 두 fixture의 실패와 저장소 권한 검사·manifest 개수의 기존 실패가 기록돼 있다. 구현 전 현재 상태에서 관련 실패를 재현해 기준을 고정하고, 수정으로 새로 발생한 실패와 분리한다. 기존 실패를 삭제하거나 성공으로 계산하지 않는다.

## 설치본 적용과 복구

구조·기능·성능 검증 완료 후 빌드 파일과 최종 실행 구조가 일관된 설치 산출물을 만든다. 기존 미커밋 기능 변경을 덮어쓰거나 무관한 변경을 이 패치의 개선으로 계산하지 않는다. 설치 산출물 자체로 localhost 요청 시험을 통과시킨다.

gung의 현재 Node·entry·runtime 경로는 supervisor 기록에서 읽는다. 토큰이나 MCP 설정을 다시 입력받는 절차는 필요하지 않다. 교체 전 설치 파일의 깨끗한 백업과 해시 목록을 만들고, 실행 중 작업 상태를 확인한 뒤 기존 supervisor 경로로 적용한다. 현재 대화를 처리하는 5060의 Rust 봇은 유지한다.

적용 후 자식 프로세스가 하나인지, MCP 연결·미러 대상·대기 작업 상태가 정상인지 확인한다. 실제 사용 질문의 접수·호출·최종 전송 기록도 확인한다. 별도 실제 Discord 시험 메시지는 이 계획만으로 보내지 않는다.

회귀가 있으면 이번 교체 전의 설치 파일로 복구한다. DB 스키마가 바뀌지 않으므로 실행 파일 복구를 이유로 대화 DB·영수증·미러 상태를 과거 사본으로 되돌리지 않는다. 이전 임시 계측이 들어 있을 수 있는 오래된 백업 대신, 이번 작업 시작 시 검증한 깨끗한 백업을 사용한다.

## 산출물

- 로컬 Rust와 TS의 실행 주체·수명·잠금·대기·DB 작업 단위·전송 경로 대응표와 남은 차이.
- 대응표에 근거한 실행 방식 변경과 관련 테스트·프로필 변경.
- 소스·설치 파일 해시, 테스트 결과와 기존 실패를 구분한 검증 기록.
- 같은 PC의 Rust·수정 전 TS·수정 후 TS를 비교한 시작 직후·유휴 후·연속·동시 요청 계측 표.
- 배포 산출물과 정확한 복구 파일 목록.
- 동등성 기준을 통과하지 못한 경로와 필요한 후속 변경을 명시한 미완료 기록.

2026-10-19 실행 결과: 질문 경로의 Worker 수명과 대기 범위를 수정하고 gung에 적용했다. 상세한 변경·계측·검증·복구 기록은 [적용 기록](ts-rust-structure-latency-applied-20261019.md)을 참조한다. 같은 PC의 Rust 전체 경로 벤치마크는 아직 수행하지 않았으므로 모든 부하의 성능 동등성을 확정하지 않는다.
