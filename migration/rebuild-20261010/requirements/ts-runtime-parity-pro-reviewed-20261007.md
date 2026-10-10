> **Pro 문서/계획 PASS | 2026-10-07 (Asia/Seoul)**
> 이 파일은 Dot 전달용이다. TS 구현·QA·성능·운영·배포의 PASS가 아니다.

- 검수 대화: [ChatGPT Pro의 R1 및 R2 검수](https://chatgpt.com/c/6ac61b79-ece8-83ec-ad50-081387a8b000)
- 최종 검수 ID: `TS-RUNTIME-PARITY-20261007-R2`
- 승인 본문 SHA-256 (UTF-8, LF): `b38ec59008b6a98955ca86b0e13034d05eda3b045152e8df1fa235e02c06f22a`
- 아래 BEGIN/END 주석 사이의 본문은 Pro에 제출한 최종 계약과 동일하다. 검수 기록과 소스 식별 부록은 Codex가 덧붙인 메타데이터다.

<!-- BEGIN_PRO_REVIEWED_BODY -->
# Rust의 병목 회피를 보존하는 TypeScript 이전 기준

## 범위와 결론
이 문서는 제공된 Rust/Python 코드·로그 요약에 대한 기술 설명과 이전 인수 기준이다. TS 코드, 실행파일 일치, 실제 성능, 24시간 운영 또는 배포의 PASS가 아니다. Python에도 offload가 있었으므로 언어 자체를 장애 원인으로 단정하지 않는다. TS/Node의 비동기 I/O 조합과 유지보수 편의는 기대할 수 있지만 Rust보다 자동으로 빠르거나 안전하다는 뜻은 아니다.

## 확인된 Rust 방식과 남은 한계
- 미러링은 영속 cursor 이후의 새 이벤트를 읽으며, 매 poll 전체 token usage 계산을 기다리지 않는다. 별도 context 조회는 여전히 전체 파일을 읽는다. legacy cursor의 turn 복구를 위한 과거 읽기는 존재하고, 정상 저장 뒤 생략된다.
- background mirror는 최대 8개 대상의 진행·완료를 개별 관리하고 같은 thread/channel의 중복 진행을 제한한다. 대기 대상 순서와 대상별 retry/backoff를 관리한다. 8개는 OS thread 수가 아니며 10초 target timeout도 동기 I/O 강제 종료 보장이 아니다.
- context 조회는 spawn_blocking, 동시 1개, 외부 3초 timeout과 실제 worker 수명에 묶인 permit을 사용한다. 내부 2초·128MiB·한 줄 8MiB budget은 context 전용이다. 이 값들을 앱 전체 deadline이나 TS 권장값으로 복제하지 않는다.
- Rust의 단순 processed 조회는 SELECT이고 스키마 검증 캐시가 있다. 그러나 cursor 조회의 Immediate transaction, async 경로의 동기 DB·파일 I/O, 이벤트 수 제한 없는 tail backlog가 남는다. 모든 Rust 읽기가 read-only이거나 Rust 전체가 비차단인 것은 아니다.
- Python의 전체 context 재독·gather 주기·불필요한 write transaction은 확인한 위험 경로다. 관찰한 100초 이상 지연을 이 중 한 원인으로 전부 설명하지 않으며 장기 lock 보유자는 미확정이다.

## A. 기능과 영속 상태의 의미를 보존
기능 이름뿐 아니라 접수·실행·전달·복구의 의미를 이전한다. 요청 ID와 재시작 가능한 상태의 commit을 확인한 뒤에만 접수 완료를 알린다. commit 결과가 불명확하면 같은 요청 ID로 조정하며 성공/실패를 추측하지 않는다. 영속 접수 이전 수신의 복구는 상위 전달원의 계약과 구분한다.
기본 검증 범위는 프로세스 종료·재시작이다. OS 장애·전원 차단 내구성을 주장하려면 journal/synchronous 설정과 저장장치 전제를 따로 고정·검증한다. 이 문서로 운영 DB 설정을 변경하지 않는다.

## B. 부가 조회 분리와 안전한 증분 처리
필수 전달 경로에서 분리할 것은 표시용 사용량·context 계산과 부가 메타데이터다. 실행 허용, 권한, 중복, 실행 소유권, 정확한 run/turn, 취소·종료·보류 및 필요한 설정 검증은 유지한다. 오래되거나 조회 불가인 표시값을 실행 권한으로 사용하지 않는다.
정상 증분과 초기 복구·backlog를 구분하고, 한 차례 bytes/records/계산량 및 한 레코드 크기를 제한한다. 시간 budget은 협력적 중단 조건이다. cursor는 파일 세대·byte 위치·완료 레코드 경계와 함께 해석한다. 교체·축소·동시 변경·UTF-8 분할·불완전 마지막 줄을 처리하고, 과대·손상 레코드는 명시적으로 보류/격리한다. 미처리를 성공처럼 건너뛰거나 매 poll 전체 파일 해시로 증분 이점을 없애지 않는다.
전달 대상의 cursor 전진은 전달 완료 또는 재시작 가능한 영속 인계 뒤에만 허용한다. cursor만 남고 전달 책임이 사라져서는 안 된다. 기존 테이블/전달 상태를 재사용할 수 있으며 새 브로커나 outbox 프레임워크를 강제하지 않는다.

## C. 제한된 동시성, 공정성, 포화 처리
대화별 상태 변경과 시작 권한을 보호하되 정상 대상은 여유 용량에서 계속 진행한다. 전체 묶음 종료를 기다리는 polling barrier를 피한다. 전역·대화별 실행 수, 대기 수, 큰 데이터 경계의 대기 bytes와 하위 worker/DB 드라이버 미완료 제출량을 제한한다.
포화 시 명시적 미접수, 용량이 관리되는 영속 대기, 부가 조회 병합/생략 중 용도에 맞는 정책을 정한다. 이미 영속 접수한 필수 요청은 조용히 버리지 않는다. 제어·수신·heartbeat가 장기 작업에 무제한 밀리지 않도록 하고, 불가능한 작업은 명시적으로 알린다. DB 쓰기 불가 중 영속 접수 성공까지 보장하지는 않는다. 같은 대화의 순서 보존을 취소 명령까지 모델 작업 종료 뒤로 미루는 것으로 구현하지 않는다.

## D. Node 실행 자원 구분
메인 이벤트 루프는 수신·제어·네트워크 조율을 담당한다. 큰 JSON 분석은 분할 또는 제한된 worker로 격리하고 worker 간 복제 비용도 제한한다. 모든 네트워크/파일 I/O를 worker로 보내라는 뜻은 아니다.
DatabaseSync를 쓰면 connection 소유권이 명확한 격리 실행 문맥에서 처리하고, 긴 조회와 lock 대기도 메인 이벤트 루프에서 제외한다. async/Promise로 감싸는 것만으로 동기 호출은 비차단이 되지 않는다. 실제 비차단 DB 드라이버라면 별도 worker는 필수가 아니지만 내부 제출량·콜백·결과 처리 비용은 검증한다. DB 분할·분산 시스템·새 프레임워크는 전제하지 않는다.

## E. DB 동시성과 호환성
순수 조회에 불필요한 write transaction을 사용하지 않는다. 필요한 읽기 snapshot과 원자적 claim/CAS는 유지한다. 네트워크 대기를 DB transaction 안에 넣지 않고 읽기 statement/iterator/transaction도 신속히 종료한다. SQLite single-writer와 WAL checkpoint/장기 reader 제약을 고려한다. worker 증설이나 WAL만으로 해결됐다고 하지 않는다.
Node·드라이버·SQLite 버전과 주요 옵션, busy 대기·재시도·전체 deadline을 명시한다. busy timeout은 전체 요청의 실제 종료 보장이 아니며 Rust 값도 자동 승계되지 않는다. 큰 메시지/요청 ID와 cursor는 string 또는 bigint 등 손실 없는 방식으로 저장·직렬화하고 기존 상태의 의미를 보존한다.

## F. timeout, 재시도, 인계
호출자 대기 timeout, 로컬 작업 종료/자원 회수, 외부 실행 결과 확정을 별도 상태로 다룬다. 자원 슬롯은 실제 회수 확인 후 반환한다. worker 종료는 이미 보낸 외부 요청의 취소를 뜻하지 않는다. 늦은 완료는 이전 시도/소유권으로 현재 상태를 덮어쓸 수 없고, 만료·취소된 큐 항목은 시작 직전 재검증한다.
결과 불명인 부작용은 동일 논리적 작업 ID로 조정한다. 검증된 외부 멱등 계약 또는 확정적인 실행 상태에 근거한 안전한 경우에만 해당 범위의 자동 재시도를 허용한다. 빈 이력이나 임의 ID 부착은 미실행/멱등성 증거가 아니다. 이 기준은 기존에 금지된 실패 사용자 요청의 자동 재전송을 새로 허용하지 않는다. 읽기 등 무해한 재시도까지 일괄 금지하지도 않는다.
해결 불가 결과는 조정 대기로 보존하고 전달 완료/누락 방지 성공으로 집계하지 않는다. 회수 불가 worker는 기능 저하·격리·조정 상태와 복구 조건을 명시하고 무한 재생성하지 않는다. 로컬 자원 회수와 외부 논리 소유권의 해제를 혼동하지 않는다.
Rust에서 TS로 전환할 때 구·신 런타임이 같은 요청을 동시에 시작하지 못하게 한다. 기존 실행은 새 프로세스 시작만으로 무효화하지 않는다. 확실한 실행 권한 회수와 상태 인계로 충족할 수 있으며 새 분산 lease는 강제하지 않는다.

## G. 최소 검증과 사전 합격 기준
아래는 후속 검증 요구이며 이번에 실행한 시험 결과가 아니다. 기존 fixture와 임시 DB·모의 외부 응답을 우선 사용한다.
- G1: 긴 이력에 소량 추가/무변경 poll/큰 backlog, 파일 교체·축소·부분 UTF-8/JSONL·과대/손상 레코드. 읽은 bytes/records, 분할 처리, cursor와 전달 책임 보존을 확인한다.
- G2: 지연 대상 하나 및 실행 한도 전체 포화. 정상 대화·제어·heartbeat의 진행 또는 명시적 불가 안내, 실행/대기 수·bytes 상한을 확인한다.
- G3: 별도 connection의 DB lock 유지·해제 및 commit 후 worker 응답 유실. event loop 생존, 거짓 접수 성공 금지, 같은 ID 조정, lock 해제 후 회복과 claim 원자성을 확인한다.
- G4: worker가 남는 반복 timeout, 만료 큐, 취소 후 늦은 완료. 생존 작업/큐 상한, 늦은 시작·덮어쓰기 방지, 회수 불가 표시와 복구 경로를 확인한다.
- G5: 접수·외부 전송·외부 성공 후 로컬 기록·cursor 인계 경계에서 프로세스 종료. 영속 책임 복원, 검증된 멱등 조건의 재개, 보장 없는 경우의 조정 대기를 구분한다. 모의 서버 계약은 실제 서버 계약 검증을 대신하지 않는다.
- G6: 기존 cursor/요청/run 상태와 큰 ID 이전, 구 프로세스 생존·늦은 완료. 식별자/상태 의미 보존, 단일 실행 소유자, 불가능한 인계를 초기화로 숨기지 않음을 확인한다.
- G7: 식별 가능한 Rust/TS 산출물을 같은 fixture·부하·설정으로 비교한다. 정상 증분·cold 복구·backlog·잠금·반복 timeout을 나누고 실패와 조정 대기를 포함한 지연 분포·최대값, 생존 작업·대기량·메모리 및 부하 해제 후 회복을 기록한다.
시험 전에 절대 지연 기준, Rust 대비 허용 회귀, 용량 상한, 표본/실패 집계, 장애 해제 후 회복 기준을 수치로 고정한다. 수치는 아직 결정/검증되지 않았으며 이를 정하지 않은 상태로 구현·QA PASS를 선언하지 않는다. 결과를 보고 deadline/기준을 늘려 통과시키지 않는다.
통제된 입력 주입 시각과 독립적인 event-loop 지연 관측을 포함해 수신 콜백 전 지연도 포착한다. 수신·영속 접수·안내 발송/확인·시작 요청/실제 시작·결과 준비/전달은 각각 관측하되 나열을 전부 직렬 await하라는 지시로 해석하지 않는다. 모델 생성시간·외부 전달 지연·bridge 내부 지연을 분리한다. 작은 시험 통과는 24시간 운영 안정성이나 배포 승인이 아니다.

## Dot에게 요청할 후속 작업
현재 TS 코드가 위 계약을 충족/미충족/미검증 중 어디에 해당하는지 관련 함수와 증거로 분류한다. 확인된 차이만 최소 패치 단위로 제안한다. 이 문서 자체는 운영 봇·DB 변경, 사용자 요청 재전송, 배포·commit/push를 허가하지 않는다.
<!-- END_PRO_REVIEWED_BODY -->

---

## 부록 1. 검수 결과와 반영 내역

Pro는 1차에 기본 방향을 수용하되 문서/계획 REVISE를 판정했다. 아래 여섯 지적을 반영한 전체 본문을 같은 Pro 대화에 다시 제출했고, 2차에서 문서/계획 PASS를 받았다.

| 1차 지적 | 최종 본문의 반영 위치 |
| --- | --- |
| P1-01: 부가 상태 조회와 실행 안전성 검증의 혼동 | B, C: 표시용 정보만 분리하고 권한·소유권·취소·중복 검증은 유지 |
| P1-02: 영속 접수·cursor·외부 전송의 장애 경계 | A, B, F: commit 확인, 전달 책임 인계, 결과 불명 조정, 내구성 범위 구분 |
| P1-03: timeout 이후 자원 회수·복구 조건 | F: 대기·로컬 자원·외부 소유권 분리, 늦은 완료 차단, 구·신 런타임 인계 |
| P1-04: 작업량·대기량·용량 초과 정책 | B, C: bytes/records/단일 레코드/하위 제출량 상한 및 명시적 포화 처리 |
| P2-01: Node·SQLite의 실제 실행 및 호환성 경계 | D, E: 동기 DB 격리, 짧은 트랜잭션, 버전·옵션·정수 표현 보존 |
| P2-02: 시험 목록과 합격 판정 기준의 혼동 | G: 사전 수치 고정, callback 이전 지연 포함, 실패 포함 집계, 단계별 관측 |

Pro 2차 판정 발췌:

> 판정: 문서/계획 PASS.
>
> 제공된 최종 본문에서 재수정이 필요한 필수 모순·누락은 발견하지 못했습니다. R1의 P1-01~04와 P2-01~02는 문서 수준에서 해소되었습니다.

잔여 조건: G의 정량 기준은 후속 시험 전에 확정해야 한다. 외부 멱등·실행 확인 계약, 기존 상태 호환성, 구·신 실행 권한 인계는 실제 대상의 근거로 확인해야 한다. 이 문서나 모의 서버만으로 충족을 가정하지 않는다.

### 수행 범위와 한계

- Pro 요청 2회: 최초 검수 1회, 수정 본문 재검수 1회. 두 답변 모두 완료 상태를 확인했다.
- Chrome 현주 프로필의 정상 Chat/Pro에서 정리문을 검수했다. 로컬 OAuth 파일 접근을 통한 독립 소스 CODE REVIEW는 아니다.
- 기존 Pro helper는 이전 Node browser runtime 결합을 전제로 하므로 이번 정리문 검수에는 사용하지 않았다. 현재 Unified Computer Use로 Pro 선택·요청·완료 답변을 직접 확인했다. helper/플러그인/설정은 수정하지 않았다.
- Codex는 이전에 읽은 코드 스냅샷과 Node/SQLite 공식 계약을 바탕으로 지적을 평가하고 문서에 반영했다.
- 이번 요청에서 TS/Rust/Python 소스 수정, 시험·빌드 실행, 운영 DB 조회/변경, 봇 재시작·배포, commit/push는 하지 않았다.
- 아래 SHA는 앞서 읽어 보관한 소스 스냅샷을 식별한다. 최신 디스크 파일 전체나 운영 실행파일과의 일치를 인증하지 않는다.
- Dot에게 실제 메시지를 전송한 것은 아니다. 사용자가 전달할 수 있는 이 Markdown 파일을 작성했다.

## 부록 2. 소스 근거

Rust 기준 루트: `C:/repos/simdorei/codex-discord-remote-rust`

Python 비교 루트: `C:/repos/simdorei/codex-discord-remote-python-migration`

| 소스 스냅샷 | SHA-256 |
| --- | --- |
| [src/session_mirror_worker.rs](C:/repos/simdorei/codex-discord-remote-rust/crates/cdr-runtime/src/session_mirror_worker.rs) | `078bdae89d2067b5ccebe7bfd4a87a89625fbdc8b6595f565f524cbf5156c04c` |
| [session_mirror/background.rs](C:/repos/simdorei/codex-discord-remote-rust/crates/cdr-runtime/src/session_mirror/background.rs) | `e40a79cfdd9db6d280ffedb482b264263ba7738602714d9fa44dfdb839366071` |
| [session_mirror/runner.rs](C:/repos/simdorei/codex-discord-remote-rust/crates/cdr-runtime/src/session_mirror/runner.rs) | `ada16326b5dc9ce63f7db9f7f63303a13416289530c7093e1529f7bf016475d5` |
| [session_mirror/turn_context.rs](C:/repos/simdorei/codex-discord-remote-rust/crates/cdr-runtime/src/session_mirror/turn_context.rs) | `0f79a3fd65af81e27a7ee5d93f05169d563ff7f5090c0edbde4c1f3846b3aa95` |
| [src/context_view.rs](C:/repos/simdorei/codex-discord-remote-rust/crates/cdr-runtime/src/context_view.rs) | `58a826e7f2d68527361a785425675c64529b37ebd46f21836b72b095ee839709` |
| [src/context_read.rs](C:/repos/simdorei/codex-discord-remote-rust/crates/cdr-codex-state/src/context_read.rs) | `bd4f7cee9248a6937e61572cce074f4e0ad44cd35932fe3e5cb45b31987fa4cd` |
| [src/tail.rs](C:/repos/simdorei/codex-discord-remote-rust/crates/cdr-codex-state/src/tail.rs) | `1d292bed863672e17e2eb490ceb687155f6cb8ea147d50c72db47e2427514fde` |
| [src/processed.rs](C:/repos/simdorei/codex-discord-remote-rust/crates/cdr-store/src/processed.rs) | `d81f8ff7333ded0d3a9f46ae8a625f3f43c7ce4814c7da1c63eb8f1ffb8ab6df` |
| [src/schema.rs](C:/repos/simdorei/codex-discord-remote-rust/crates/cdr-store/src/schema.rs) | `c6c32fb7308dbdf19939929d336ca73402c645afa9e64ffb6e13fdd39ea81b3c` |
| [src/mirror.rs](C:/repos/simdorei/codex-discord-remote-rust/crates/cdr-store/src/mirror.rs) | `dd79412add510a3e7ff99a5a2d08efd931607499ea01da78da0119bb647206a3` |
| [codex-discord-remote-python-migration/codex_discord_session_mirror.py](C:/repos/simdorei/codex-discord-remote-python-migration/codex_discord_session_mirror.py) | `d7aeec988b53b81b5997e3c4a7c40938be51963015847a95d3c49d463cf2d2a9` |
| [codex-discord-remote-python-migration/codex_discord_session_mirror_event_policy.py](C:/repos/simdorei/codex-discord-remote-python-migration/codex_discord_session_mirror_event_policy.py) | `8560c6e96e47301d6002db502c2b138ef088b5e7010972a47785edffb78b87ad` |
| [codex-discord-remote-python-migration/codex_desktop_bridge_thread_context.py](C:/repos/simdorei/codex-discord-remote-python-migration/codex_desktop_bridge_thread_context.py) | `65a6a2d30d3a3666b0f4f6fcbcdc140a9d369c75314f742baad4357b159318b5` |
| [codex-discord-remote-python-migration/codex_session_events.py](C:/repos/simdorei/codex-discord-remote-python-migration/codex_session_events.py) | `827ec112a3b303e30a86e85033869fb619122a0e5052eb6373c6152b76abaffb` |
| [codex-discord-remote-python-migration/codex_discord_store_custody.py](C:/repos/simdorei/codex-discord-remote-python-migration/codex_discord_store_custody.py) | `951bd44848df6f085def16d44164984f43f7f3355d6f70b7860acdf1fd1fc4cd` |
| [codex-discord-remote-python-migration/codex_discord_processed_message_runtime.py](C:/repos/simdorei/codex-discord-remote-python-migration/codex_discord_processed_message_runtime.py) | `e91c60712097d0585d968a265dc9fc44ba0b1213fe4fbee2ecd1d9eb791eb56e` |

핵심 근거: Rust의 poll_target, background dispatch, bounded_reader, is_processed, get_or_init_cursor와 Python의 미러 루프, context 계산, message_is_covered, 공통 transaction 경로. 위 링크와 본문의 동작 설명을 함께 참조한다.

## 부록 3. 공식 기술 근거

- 이벤트 루프/worker pool의 차단, 큰 계산의 분할·격리: [Node 지침](https://nodejs.org/learn/asynchronous-work/dont-block-the-event-loop)
- 비동기 I/O와 CPU worker의 역할, worker 종료 완료: [Node 24 worker_threads](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html)
- DatabaseSync의 동기 실행과 정수 표현 옵션: [Node SQLite API](https://nodejs.org/api/sqlite.html)
- SQLite 읽기/쓰기 트랜잭션과 Immediate 동작: [SQLite transaction](https://www.sqlite.org/lang_transaction.html)
- writer 직렬화와 snapshot: [SQLite isolation](https://www.sqlite.org/isolation.html)
- busy 대기는 전체 요청 종료 보장이 아님: [SQLite busy timeout](https://www.sqlite.org/c3ref/busy_timeout.html)
- 프로세스 종료와 전원 장애의 내구성 범위 구분: [SQLite synchronous](https://www.sqlite.org/pragma.html#pragma_synchronous)
