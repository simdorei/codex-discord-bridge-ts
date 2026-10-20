# TS 요청·응답 지연 수정 및 gung 적용 기록 — 2026-10-19

## 수정 범위와 원인
사용자의 “Rust 구조까지 이식” 요구에 맞춰, 질문의 DB 처리 수명과 대기 범위를 수정했다. 기능 이름만 같다는 이유로 성능 동등성을 주장하지 않는다.

수정 전 gung의 같은 가짜 Discord/Codex 시험에서 질문 왕복 10,085ms 중 turn/start까지 6,742ms, 모델 답변 수신 뒤 전송까지 3,241ms가 걸렸다. 이 구간에 백그라운드 작업을 포함해 59개의 네이티브 Worker가 새로 생성됐다. 이벤트 루프 지연의 최대값은 36.7ms였다. 네트워크나 모델 생성만으로 설명되는 지연이 아니었다.

- 질문 저널, intake, queue, mutation, completion 등 13개 DB 작업과 Bridge 파일 작업 1개를 기존 검증된 재사용 실행기에 등록했다.
- Bridge 파일 작업은 별도의 직렬 처리 자리 1개로 분리했다. Rust BridgeState의 자체 mutex에 대응한다.
- 읽기 전용 메시지 분류를 Background 자리로 옮겼다. 분류가 Control 쓰기 Worker를 매 질문마다 폐기시키던 문제를 제거했다.
- 유휴 30초 후 Worker를 종료하던 동작을 없애고 런타임 종료·실패·다른 경로의 용량 요구 때 정리하도록 했다.
- 전체 물리 Worker 상한은 9개다: Background 3, Control 1, Bridge 1, Observation 2, Discovery 1, Maintenance 1.
- DB 연결은 각 작업 끝에 실제로 닫는다. 연결·이전 입력·선택 결과를 캐시하지 않는다. 취소나 타임아웃 뒤 실제 I/O 종료를 기다리는 보장, 불확실한 작업의 자동 재실행 금지, target별 순서와 요청 식별 검증을 보존한다.

## 파일
소스 변경은 19개 파일이다. 정확한 배포 파일과 이전/이후 SHA-256은 로컬 `.runtime/rust-parity-20261019/payload.json`에 있다.

중심 파일:
- `src/runtime/owned-worker-slot.ts`
- `src/runtime/owned-worker-reuse.ts`
- `src/runtime/reusable-worker-operations.ts`
- `src/runtime/bridge-state-native.ts`
- `src/runtime/message-worker/classification.ts`
- 위 실행기에 등록한 14개 `*-worker.ts`

회귀 계약:
- `test/runtime/prompt-roundtrip-reuse.test.ts`: Bridge와 DB 대기 분리, 실제 분류→저널→intake→Bridge 반복 시 warm Worker 유지, 40초 유휴 수명.
- `test/windows-runtime/windows-application.test.ts`: 세 스레드 반복 final, 하나가 실행 중인 동안 다른 두 스레드 final, stop 이후 재개, 실제 자식 프로세스와 native owner 종료.
- `test/runtime/message-worker/native-classification.test.ts`: Background 용량과 취소·타임아웃 후 실제 종료. Windows에서 열린 SQLite 파일을 rename하려던 기존 시험 fixture는 DB를 닫고 rename하도록 고쳤다. 검사 조건은 유지했다.
- Worker 사용량의 새 Bridge 항목에 맞춘 기존 검증과 `test/profiles/windows-workers.json`.

## gung 동일 PC 측정
실제 Discord로 메시지를 보내지 않고 localhost 가짜 Discord와 100ms 가짜 Codex를 사용했다. 각 구간은 같은 프로세스의 단조 시계로 쟀다. 실제 모델 생성 시간에 대한 약속이 아니다.

| 시나리오 | 질문→turn/start | 전체 질문 왕복 | 답변 수신→전송 |
|---|---:|---:|---:|
| 수정 전 첫 질문 | 6,742ms | 10,085ms | 3,241ms |
| 최종 수정 첫 질문 | 897ms | 1,421ms | 411ms |
| 연속 질문 1 | 384ms | 925ms | 429ms |
| 연속 질문 2 | 354ms | 826ms | 367ms |
| 연속 질문 3 | 310ms | 939ms | 516ms |
| 40초 유휴 후 | 404ms | 873ms | 329ms |

40초 유휴 후 측정 구간에서 새 Worker 생성은 0개였다. 해당 시험의 작업 중 RSS 최대값은 약 335MiB였다. 장기간 운영 메모리 상한을 입증하는 측정은 아니다.

유효 원본: gung `runtime/latency-probe-20261019/result.json`, `result-candidate-v2-rounds.json`.
중간 `result-candidate-rounds.json`은 반복별 trace 배열을 복사하지 않아 구간별 trace가 덮어써졌다. 최종 표에는 사용하지 않았다. 최종 v2 계측은 각 round의 trace를 복사한다.

## 검증
- Node 24.21.0, TypeScript build와 전체 테스트 소스 컴파일 통과.
- 최종 확장 회귀 실행: 443개 중 442개 통과, 기존 Windows fixture의 열린 SQLite rename에서 1개 실패.
- 해당 fixture를 닫은 뒤 분류 시험 27개 전체 재실행 통과. 런타임 동작을 바꾸거나 assert를 제거해 해결하지 않았다.
- 별도 동시성 시험 통과: 실제 9개 처리 자리, FIFO, 취소, 실제 종료, 총 292개 제출 중 미제출 거부 검증.
- 새 동작의 RED→GREEN 확인: DB가 막힐 때 Bridge 진행 실패→성공; 분류 포함 반복에서 Worker 9개 생성→3개만 생성하고 17회 재사용.
- 소스와 emitted JS의 native authority AST 감사 통과.
- 공백 오류 검사 통과. 별도 lint 명령은 이 저장소에 없다.
- 로그: `.runtime/rust-parity-20261019/regression-final.log`, `classification-final.log`, `mixed-lanes.log`.

## 적용
2026-10-19 20:13 KST 적용을 확인했다. gung 설치본의 수정 전 19개 파일 해시가 테스트 기준과 모두 일치했고, 교체 후 19개 해시도 모두 일치한다. 설정·토큰·DB는 변경하지 않았다.

첫 적용 시도는 MCP의 재시작 준비가 해당 터미널 작업을 종료하여 파일 교체 없이 정상 재시작만 수행했다. 기존 파일은 보존됐다. 두 번째 적용은 자기 종료에 영향받지 않는 일회성 예약 작업으로 진행했다. drain ACK 확인 후 교체했고 supervisor가 강제 종료 없이 정상 재시작했다. 예약 작업의 성공 코드 0을 확인한 뒤 제거했다.

- 현재 봇 PID 13440, supervisor PID 22764. 교체 전 PID 16800에서 변경됐다.
- MCP 재연결과 실제 원격 명령 실행 확인. 큐 0개, 미러 매핑 8개 유지. 확인 시 봇 RSS 298.8MiB.
- 실제 설치 경로를 불러오는 별도 격리 왕복 시험도 통과했다. 첫 질문 왕복 1,291ms. 모델은 동일한 100ms 가짜 응답이다.
- gung 증거: `runtime/rust-parity-20261019-deploy2.receipt.json`, `runtime/rust-parity-20261019-health.json`, `runtime/latency-probe-20261019/result-postinstall.json`.
- 실행 파일 백업: `C:\Users\rnd45\AppData\Local\CodexDiscordTS\runtime\rust-parity-20261019-backup2`. 문제가 생기면 정상 drain 후 이 19개 실행 파일만 복원한다. DB·접수증은 과거 상태로 되돌리지 않는다.

## 남은 검증 범위
Rust 실행 구조를 참고한 이번 지연 원인 수정은 검증했지만, 같은 PC·같은 입력의 Rust 전체 경로 벤치마크는 실행하지 않았다. 따라서 모든 부하에서 Rust와 성능이 같다고 확정하지 않는다. 실제 모델 응답 지연과 장기 CPU/RSS는 실제 사용 기록으로 추가 확인해야 한다. 5060의 대화용 Rust 봇은 변경하거나 재시작하지 않았다.
