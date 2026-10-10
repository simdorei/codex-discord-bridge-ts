# TypeScript 마이그레이션 통합 구현·복구·인수 문서 R11

R10 전체 116035 bytes를 아래에 바이트 그대로 포함하는 새 불변 기록이다. R1–R10, 사용자 원본 명세, 원시 실패·반려 기록을 삭제하거나 덮어쓰지 않는다. 과거 문서 수치는 당시 증거이며 최신 완료 상태로 재해석하지 않는다.

## 최신 적용·보존

Checkpoint 443: 실제 전체 6,414/6,414 PASS, 실패·취소·skip 0, strict TypeScript exit 0.

- 로컬 검증 commit: e8aa5404ef443098e8d352ddaa59b8a9ebb2c854
- 원격 source commit: b5de3bcab744eebaa579ed375b7abb9fd81b3651
- 원격 root tree: 004196d2cea4b4b9c61f178c09e17174b918b53d
- 동일 src tree: ef13dbc1bed2ff9863857ce5371535a1e9bb373b
- 동일 test tree: 75acb1ec20762f0c70edbd487610228ab8721483
- 독립 GET 대조 시각: 2026-10-10T23:26:13.704190+00:00

444 bounded continuity observation은 집중 17개·strict TS0 이후 실제 전체 실행 중이며 이 문서의 완료 수치에는 포함하지 않는다.

Linux Node24.21.0 실제 단일 전체 회귀와 strict TypeScript 결과다. 테스트 개수는 전체 구현 완료율이 아니다. Windows 개인 PC, 실제 인증된 Codex 앱서버·Discord, 수치 부하 시험, 24시간 운영, 배포는 미검증이다.

## R10 이후 작업

|번호|단일 전체 PASS|범위|
|---|---:|---|
|434|6352|Codex 상태 → bridge mapping → queue 순서의 실제 native discovery 합본, 완전한 두 조회가 성공할 때만 snapshot 반환|
|435|6358|대상 완료 관찰자 한 개만 등록; 대기 취소가 실제 작업 소유권이나 결과를 없애지 않도록 정리|
|436|6364|native discovery와 dispatch 연결, 각 제출 당시 snapshot을 고정하여 진행 중 작업의 경로·채널이 바뀌지 않음|
|437|6371|즉시 조회 + monotonic 1초 주기, 놓친 tick 누적 실행 방지, 취소 즉시 소유 작업 close 요청 후 실제 join|
|438|6378|전체 미러 runner의 공통 오류 backoff, 새 owner 재생성, 단일 실행 및 오류 보고 실패 보존|
|439|6386|실제 파일 window·native decoder 결과·완전한 기록 끝 위치를 하나의 읽기 관찰값으로 봉인|
|440|6390|전송 취소 시 다음 chunk 중단, 늦게 확인된 전달 receipt 보존, 불명확한 결과의 자동 재전송 금지|
|441|6399|호출자가 지정한 정확한 receipt key/hash 전부에 실제 message ID가 있는지 같은 borrowed transaction에서 읽기 검사|
|442|6404|실제 sender와 같은 chunk markers·serde key·content hash로 검사 대상 receipt를 재현|
|443|6414|현재 대상 queue·완료 marker·사용자 origin 확인을 고정 native readonly worker로 이동; 실제 종료까지 소유|

각 source/test 원격 트리와 해당 로컬 검증 commit의 트리를 별도 GET으로 대조했다. 로컬/원격 history는 raw 로그 업로드 제한 때문에 다르며 src/test 동등성을 사용한다. 압축 로그는 로컬 보존, 원격에는 허용된 코드·테스트·요약만 보존한다.

## 회귀 발견과 한계

- 435: 완료 관찰 대기를 취소해도 대기 등록이 남는 반례를 같은 테스트 SHA로 RED→GREEN 확인했다. 실제 underlying 작업 슬롯은 종료·harvest 전까지 유지된다. 생산 환경 heap 누수 측정 주장 아님.
- 437: 결과 보고 실패 시 이미 수확한 완료 기록 누락, 취소 후 늦은 작업을 Completed로 잘못 분류하는 두 반례를 원시 로그로 보존했다. 최종 7개 focused와 실제 전체 회귀 통과. 예외는 원래 cause와 settled/unreported 결과를 함께 보존한다.
- 440: 같은 테스트 SHA에서 이전 sender 4개 중 3개 실패, 수정 후 기존 sender 포함 10개 통과. 실제 전송 Promise가 끝나기 전 슬롯을 해제하거나 알 수 없는 결과를 성공/재시도 가능으로 바꾸지 않는다.
- 441: ES2023 선언에 없는 String.isWellFormed 호출의 최초 strict TS 실패를 기존 Unicode scalar 검증 방식으로 고쳤다. LF/CRLF 검증 가설은 이미 거부되어 통과했으므로 제품 regex 결함이나 RED→GREEN으로 주장하지 않는다.
- 443: enqueue 입력의 state가 그대로 저장될 것이라는 테스트 작성 가정을 수정했다. enqueue는 원래 Pending으로 기록한다. 명시적인 fixture DB 상태 변경과 positive baseline을 넣었고 제품 검증은 완화하지 않았다. 원시 24/25 실패 로그 보존.

## 미러링 완료와 미완료의 경계

현재 실제 native discovery, 대상별 실행·오류 대기, 전체 runner, bounded file reader/JSON decoder, sender, receipt 확인, ownership 관찰 구성요소가 존재한다. 이들이 전체 운영 poll adapter에 모두 연결되었다고 주장하지 않는다.

1. 439는 한 번 읽은 파일과 완전한 기록 경계를 묶는다. 이전 poll에서 저장한 커서의 파일 세대나 전체 과거 내용이 그대로임을 증명하지 않는다.
2. 441은 전달된 expected key/hash 집합만 검사한다. 호출자가 모든 mirror item을 넣었다는 coverage 증명이나 커서 쓰기 권한은 아니다. 빈 집합이 곧 임의 cursor 이동 허용을 뜻하지 않는다.
3. 442는 실제 sender의 exact receipts를 계산한다. 계산 자체가 전송 성공 증거는 아니다.
4. 443 native ownership 관찰은 source의 현재 queue/marker 확인 순서를 보존한다. 외부 Discord 전송과 DB의 원자적 권한 증명은 아니며 관찰 후 상태 변경을 막지는 않는다.
5. 기존 mirror-cursor primitive는 legacy path/offset/turn만 저장한다. 새 파일 세대 증명으로 묵시적으로 승인하거나 legacy 기록을 자동 reset/skip하면 안 된다.
6. 실제 confirmed delivery 또는 재시작 가능한 durable handoff와 cursor 갱신을 연결하는 최종 DB 작업, event claim과 cursor의 정합성, unknown commit 재조회 및 파일 변경 정책은 계속 구현·검증해야 한다.
7. 기존 receipt persistence와 상당수 StateAccessFacade는 여전히 main-thread DatabaseSync 경로가 있다. async/Promise 이름이나 일부 worker 이전만으로 전부 offload 완료라고 하지 않는다.
8. 프로세스 내 runner 단일화는 OS singleton을 대체하지 않는다. POSIX singleton 412의 EPERM과 Windows singleton/수명 검증은 미해결이다.

## 다음 파일 연속성·커서 구현의 구체 조건

- 저장된 파일 세대, byte offset, 완전한 record boundary를 함께 검증한다.
- replacement, 관찰된 truncate, concurrent 변경, UTF-8 분할, 미완성·초대형·잘못된 JSON suffix는 보류하고 앞부분 성공만으로 전체 성공 처리하지 않는다.
- 매 poll 전체 파일 해시는 금지한다. dev/ino/birthtime/size만으로 임의의 과거 in-place rewrite까지 검증했다고 주장하지 않는다.
- bounded prefix/tail anchors를 쓰더라도 anchors 밖의 과거 수정 후 append는 검출하지 못할 수 있다. append-only producer 계약과 그 한계를 분리해야 하며 해당 가정을 숨겨 새 cursor 승인으로 포장하면 안 된다.
- 기존 generation 미결속 cursor는 보존하고 migration/reconciliation 정책을 명시한다. 파일 세대가 바뀌었다고 임의로 EOF나 0으로 이동하지 않는다.
- 읽기 관찰·전달 evidence·expected old cursor를 같은 최종 쓰기 검증에 묶고, 상태가 바뀌면 CAS 실패로 보류한다.
- 새 outbox framework 자체는 필수가 아니다. 기존 receipt가 정확한 content/identity로 confirmed라면 이를 사용하되 모든 항목 coverage를 따로 확인해야 한다.

## 원본 명세·최신 Rust·사용자 지침

원본 ts-runtime-parity-pro-reviewed-20261007.md:
- 19379 bytes
- SHA256 a0799cfa3d7419a45e7003e1f579167a05dcdca0a8709dc4f891e7b0ac04bb72
- TS-RUNTIME-PARITY-20261007-R2는 문서/계획 PASS이며 구현·QA·성능·운영·배포 PASS가 아니다.

최신 Rust main은 2026-10-10 23:13 UTC GET에서 dfec7dfb55e01516ad6d48a67a4aff4072d6150e로 확인했다. frozen authority 4e213aa69dc89bed1552d8b83e12471d7664b7ae와 차이 전체가 이식됐다고 주장하지 않는다. 이번 session_mirror_worker.rs의 최신 blob dc434a81db54b5a8aaca56b5009f647cdbbabd27은 실제 frozen 파일 Git blob과 같았다.

사용자 요구는 계속 유효하다: 상태 접근 중앙화, 중앙 오류 처리, 재시작 판단 TS 단일화 및 얇은 플랫폼 스크립트, Discord/Codex 경계 타입 선행, 스레드 격리·재시작 회귀, 최신 Rust 추가 변경 반영, 불확실한 원격 결과 자동 재실행 금지. 오래된 stop 명령 예외는 이후 시작하고 정상 완료된 별도 요청의 확실한 증거가 있을 때만 적용한다. Archive 100개·11페이지는 한 번의 보관 subtree 조사 범위이며 전체 누적 보관 수 제한이 아니다.

## 원본 복구·지원

원래 2026-10-08 두 작업 폴더는 별도 보존 대상으로 유지하며 이 재구현을 복구 성공으로 표시하지 않는다. 최신 경로 확인 기록은 별도 status에 보존한다. 기존 dot·원본 경로를 Reset/초기화/덮어쓰기하지 않는다.

지원 사건 16911035의 2026-10-10 22:56 UTC 답변은 기술 검토 담당을 확인하고 장애 전 저장소·스냅샷·로그 존재, 실제 보존 조치, 비파괴 재연결/추출 가능성을 확인하겠다는 내용이다. 보존 완료·복구 가능·ETA는 아직 미확정이다. 사용자 상시 승인에 따라 같은 사건에 원본 보존과 복구 계속 진행을 답장했다. 별도 재구현은 원래 복구 요청을 취소하지 않는다.

아래부터 R10 원문 전체이다.

R10 바이트 SHA256: 10c59d549bbcb64179354084eb118e3d66f152f7cbf2884c3d9dd91b8066856d

# TypeScript 마이그레이션 통합 구현·복구·인수 문서 R10

이 문서는 R9 전체 107450 bytes를 뒤에 그대로 포함하는 새 불변 기록이다. R1–R9와 원본 구현 명세, 실패·반려 증거를 삭제하거나 덮어쓰지 않는다. 이전 문서의 수치는 당시 결과이며 현재 완료 판정으로 재해석하지 않는다.

## 최신 적용·원격 보존 기준

{
  "remoteCommit": "9a814d8f4935309a80a420eeab8aefd3be5f3989",
  "tree": "bea11cc855400d9a84895015e69000492f6d298c",
  "srcTree": "49913e7ac0b3cb7b1cb8675af44fd5d921c1d73e",
  "testTree": "288d25ea9e1c233a5128ede3e6131e695d69ef80",
  "localCommit": "81794ac54c6f81d8eae4f026e7b20c1b48c507c3",
  "tests": 6347,
  "verifiedAt": "2026-10-10T22:38:01.149780+00:00"
}

이 결과는 Linux Node24.21.0 실제 단일 전체 회귀와 strict TypeScript 검사다. 테스트 개수는 구현 완료율이 아니다. 실제 Windows 개인 PC, 인증된 Codex 앱서버, Discord 운영, 부하 수치, 24시간 운영 및 배포는 여전히 별도 미검증이다.

## R9 이후 적용 경로

|체크포인트|전체 PASS|범위|
|---|---:|---|
|420|6258|설치된 플러그인 파일 fingerprint를 전용 작업자로 읽고 경로/크기/내용 해시를 검증|
|421|6263|실제 plugin inventory 자식 프로세스와 fingerprint 작업자를 연결한 초기 snapshot|
|422|6269|원래 활성 Codex 스레드의 프로젝트 경로만 읽는 전용 SQLite 작업자|
|423|6276|ProPromptRuntime에 실제 inventory/설치 파일/세대 확인/단회 재준비와 기존 prompt 전처리 연결|
|424|6281|실제 resident RPC를 사용하는 autocomplete 모델 목록 초기화|
|425|6289|미러링 대기 대상의 기존 순서와 thread/channel 배제 보존|
|426|6298|8개 대상 실행의 실제 종료까지 소유권 유지, 늦은 완료·취소·deadline 결과 구분|
|427|6305|대기·실행·대상별 backoff 및 오류 보고를 합친 미러 dispatch|
|428|6312|Codex 전체 활성 스레드 조회 전 같은 읽기 트랜잭션의 행/값 크기 검사|
|429|6320|원래 Codex 상태 DB의 전체 스레드 해석을 별도 작업자로 옮기고 작은 routing 정보만 반환|
|430|6325|전역 native Worker 제출 한도와 별도 Control 자리, 실제 exit까지 슬롯 유지|
|431+432|6339|미러 연결 목록과 queue 전체 조회의 제한·원본 decoder 재사용, 두 독립 단위를 합쳐 한 번 전체 회귀|
|433|6347|실제 별도 SQLite 작업자에서 mapping·queue 순서대로 완전 조회, 엄격한 해석 후 제한된 결과만 반환|

431의 별도 전체 회귀는 주장하지 않는다. 431과432의 독립 focused 검사 후 합본 actual full을 실행했다. 원래 전체 목록 API는 그대로 유지하며 신규 bounded 경로는 한도 초과를 전체 실패로 돌려 일부 결과를 완전한 목록처럼 사용하지 못하게 한다.

### Pro 및 autocomplete
- Pro 경로는 실제 POSIX plugin list 프로세스, 설치 파일 fingerprint, resident generation, 원래 스레드의 프로젝트 경로를 연결한다. 외부에서 임의로 받은 준비 완료 boolean만으로 준비된 것으로 처리하지 않는다.
- 초기 inventory 수집 실패는 보존하고 동일 resident 세대를 임의로 정상 baseline으로 재인증하지 않는다. 오래된 자기 소유 baseline은 실행 중인 요청이 없을 때만 단회 재준비·재확인한다.
- remote readiness는 명시적 신뢰 포트다. 이 포트가 있다는 사실은 실제 원격 gateway 인증·접속 구현을 완료했다는 의미가 아니다.
- 프로젝트 경로는 존재하는 원래 활성 스레드에서만 읽고 빈 경로, 상대 경로, 파일 경로 및 없어진 경로를 거절한다. 조회 시점 이후 디렉터리 교체에 대한 영속 권한 증명은 아니다.
- 파일 fingerprint는 정렬된 경로/길이/내용을 원본 순서대로 해시한다. POSIX symlink/메타데이터와 실제 파일 읽기를 검사했지만 Windows reparse/프로세스 트리 계약은 남아 있다.
- autocomplete는 실제 resident RPC, 그 세대, 실패·취소를 보존한다. bootstrap 전체 운영 연결 또는 모든 JSON 처리 offload를 완료했다는 뜻은 아니다.

### 미러 discovery·실행 소유권
- 한 대상/한 채널이 중복 실행되지 않도록 대기 순서를 보존하고 동시에 8개 이하를 실행한다. timeout은 요청한 취소일 뿐 실제 종료 증거가 아니며 늦은 완료를 정상 완료로 바꾸지 않는다.
- 대상별 재시도 간격과 60초 오류 보고 제한은 기존 Rust 의미를 보존한다. 불명확한 외부 전송은 receipt 재조정 없이 성공/미전송으로 추측할 수 없다.
- native Worker 공통 초기 한도는 Background3 + Control1이다. Control은 재시작 상태 조회에 사용한다. CPU·부하 측정으로 추천한 최적값이나 Rust의 8개 미러 대상과 같은 의미가 아니다.
- native Worker의 실제 exit 전에는 전역/해당 기능 슬롯을 돌려주지 않는다. 시작 실패·crash는 슬롯을 회수하며 worker 내부에서 다시 worker를 만들어 별도 한도를 갖는 경로를 거절한다.
- 이 전역 한도는 현재 동일 runtime isolate의 중앙 Worker 생성 경로에 적용된다. 별도 서비스 인스턴스나 모든 자식 프로세스·filesystem IO까지 통합 제어했다고 주장하지 않는다.
- 목록 조회의 raw selected-value byte 합계와 행 수를 자료화 전에 검사하고 동일 read transaction에서 원래 query/decoder를 실행한다. 제외될 행의 잘못된 데이터도 먼저 해석해야 하는 원본 의미를 유지한다.
- 크기 한도는 SQLite 자체의 cache/RSS, 전체 scan 시간, decoded 객체 heap의 완전한 상한 증명이 아니다. 최초 malformed 숫자 BLOB도 조회 전 raw 값 예산에 포함한다.
- Codex·미러 mapping·queue의 모든 조회가 하나의 전역 원자 snapshot인 것은 아니다. 기존 소스 순서를 유지하며 각 조회의 완전성만 검증한다.
- 현재 파일 창 읽기/해석/보내기 primitive는 존재하지만 파일 세대에 결합된 durable cursor와 완전 레코드 handoff 원자 갱신, 전체 주기 discovery/poller 조립은 아직 미완료다.

## 반드시 계속 지킬 구현·인수 조건
- 상태 단일 조회/변경 경계, 중앙 오류 정책, TypeScript 재시작 판단, Discord/Codex 경계 타입, thread 격리와 재시작 검증, 원본 Pro A–G 계약을 유지한다.
- Promise 반환은 동기 SQLite offload 증거가 아니다. StateAccessFacade의 남은 동기 본문과 전역/대상별 대기열·바이트/IO 상한, 실제 p99·메모리·Windows24h 측정은 계속 필요하다.
- 412 POSIX singleton 후보는 환경의 native listen EPERM으로 미적용이다. 허용된 동일 재시도에서도 차단되었으며 우회하지 않았다. 단독 실행 증명이 필요한 startup claim release/전체 수명 시작은 승인된 것으로 취급하지 않는다.
- Archive100개·11페이지는 한 번의 하위 대상 수집 완전성 계약이며 전체 Archive 누적 개수 제한이 아니다. 사용자 승인 없이 원본 조건을 삭제하거나 전체 quota로 확대하지 않는다.
- 오래된 Stop 기록은 이후 시작해 정상 완료된 별도 요청이라는 근거가 확인되는 범위에서만 제외한다. 불명확한 원래 기록은 보존한다.
- 최신 Rust main의 관련 파일을 직접 읽고 frozen 소스와 Git blob 동일성을 대조했다. 모든 최신 Rust 변경이 이식 완료되었다는 포괄 판정은 하지 않는다.
- main merge, 실제 DB 변경, 서비스 재시작, 운영 배포 없이 source/test/검증 요약만 별도 브랜치에 보존한다. raw/gzip 로그는 추가 승인 대기라 업로드하지 않는다.

## 원본 작업 공간 복구 상태
- 2026-10-10 22:25 UTC, 원래 두 작업 경로가 현재 파일 시스템에 없는 것을 다시 확인했다. 별도 rebuild는 원본 복구 성공이 아니다.
- 지원 사건16911035의 21:48 답변은 원래 환경·저장소·가능한 snapshot/log 확인을 먼저 진행하겠다는 내용이다. 보존 조치 완료, 복구 가능성, 완료 시점은 확인되지 않았다.
- 21:56 같은 사건에 답장했고 22:36 확인 시 새 수신은 없었다. 별도 재구현은 원본 복구 요청의 철회가 아님을 전달했다.
- 아래 R9와 재귀적으로 포함된 원본 명세 전문은 바이트 그대로 보존한다.

---

# TypeScript 마이그레이션 통합 구현·복구·인수 문서 R9

기준 시각과 최신 적용·원격 동일성은 아래 검증 메타데이터에 기록한다. 이전 R8 전체 100,171 bytes를 뒤에 그대로 포함한다. R1~R8, 원본 명세, 반려 후보를 삭제하거나 덮어쓰지 않는다. 과거 수치는 당시의 스냅샷이며 최신 구현 완료 판정으로 재해석하지 않는다.

## 이번 적용 기준

확인 시각: 2026-10-10T21:34:29.211294+00:00

- 체크포인트419: 실제 전체 6,249/6,249 PASS, 실패·취소·skip 0, strict TS exit0, 집중14 PASS.
- 로컬 commit 2b50c8fa5a81a72a5ecd8bd08c8d4a33b5732a16
- 원격 commit c777652de0ece0148c8b1847feddb591e3b12da8
- root tree 0d5afcf576cfbc92b611b0c4ddac45cf576078cc
- src tree 7a5d4e3cfab14131e6d089244b549c567f5b3bd9
- test tree 85016a449f783c4de162ff4f312818a1842627b3
- 원격 ref/tree 독립 GET과 로컬 커밋 subtree 동일성 확인 완료.

Linux Node24.21.0의 실제 단일 전체 회귀와 strict TS 검사 결과다. 테스트 수를 기능 완성률로 계산하지 않는다. Windows/실제 Codex 앱서버/Discord 운영/24시간 운영·배포 PASS가 아니다.

## R8 이후 진행

|체크포인트|실제 전체 PASS|검증 범위|
|---|---:|---|
|413|6208|최대 1MiB 파일 창, native fd/경로 메타데이터 일치, 실제 close까지 IO 슬롯 유지|
|414|6213|파일 관측 → 실제 worker 해석 → 파일 변경 재확인, 취소 시 해당 worker 종료까지 join|
|415|6219|기존 미러 이벤트 변환·해시·중복 판정을 같은 worker 안에서 실행, 표시 결과만 반환|
|416|6226|소스 기반 플러그인 inventory 및 resident snapshot의 순수 사전검사|
|417|6232|!pro 명령 재작성, 정확한 원래 스레드 scope, 장치 태그, backend 입력 생성 한 곳으로 통합|
|418|6242|실제 POSIX 자식의 plugin list --json, 출력 한도, native timeout, 실제 PID 종료 확인|
|419|6249|소유 진단으로만 한 번의 stale refresh 허용, 실제 비동기 작업 종료 대기, 순수 manifest 정책|

### 미러 파일·화면 표시
- 파일의 dev/ino/birthtime/mtime/ctime/size와 열린 fd/경로를 검사한다. 읽는 동안 append나 교체가 관측되면 전체 결과를 다시 관측하도록 보류한다.
- 하나의 읽기 창은 1MiB 이하, 레코드 262144 bytes 이하, 1024개 이하다. 불완전한 마지막 레코드나 잘못된 UTF8/JSON을 소비한 것으로 처리하지 않는다.
- 디코딩과 표시 변환은 같은 단일 worker 슬롯을 공유한다. timeout/abort는 실행 종료의 증거가 아니며 해당 worker의 실제 종료까지 슬롯을 유지한다.
- 표시 결과는 16384개/직렬화 8MiB를 초과하면 창 전체를 거절한다. 일부만 잘라 전달 완료로 만들지 않는다. 이 수치는 Archive의 전체 보관 개수와 관계없는 작업 메모리 한도다.
- 이 구현은 안정된 한 시점의 파일 관측이다. 영속 cursor의 파일 세대 결합, 완전 레코드 경계에 대한 durable handoff와 원자 갱신, 전체 poller/scheduler 연결은 여전히 미완료다. 지속 append 시 보수적인 재시도로 처리량이 낮아질 수 있으며 실측 인수 검사는 남아 있다.

### Pro 명령 사전검사와 실행 입력
- remote/Chrome 플러그인의 정확한 ID, 중복, installed/enabled, 버전, resident healthy/accepting, snapshot 실패/누락/불일치를 별개의 진단으로 보존한다. 플러그인 엔트리가 있다는 것만으로 Chrome 접속 성공을 주장하지 않는다.
- 명령 재작성과 local-device 태그는 순수 문자열 처리다. 이식 시험에서 다른 에이전트·브라우저·커넥터에 실제 검수를 맡기지 않았다. 원래 프로젝트 경로 검증은 별도 runtime 책임이다.
- native inventory 조회는 명시 실행파일에 literal argv만 전달하고 shell을 사용하지 않는다. 전용 worker 한 개와 대기열 0개를 사용한다. timeout 후 direct child PID가 사라지는 실제 fixture 검사를 수행했다.
- Node의 maxBuffer가 두 출력 통로의 합계에 적용되어 600000+600000 bytes를 오거부하는 반례를 실제로 재현했다. aggregate native cap을 2MiB로 두고 각 통로의 1MiB 수용 한도를 별도로 검사해 교정했다. 실패 로그와 원래 후보를 보존한다.
- 이 portable 경로는 POSIX direct child만 검증했다. Windows 소유권 및 descendant process-tree 정리는 승인되지 않았고 Windows에서는 명시 거절한다. 실제 Codex 설치·인증·플러그인 파일 fingerprint와 전체 ProPromptRuntime 연결은 남아 있다.

## 유지하는 안전 조건과 미완성 부분
- 상태 조회·변경 중앙화, 중앙 오류 정책, TS 재시작 판단, Discord/Codex 경계 타입, 스레드 격리/재시작 테스트와 원본 Pro A–G 명세를 유지한다.
- 412 POSIX singleton 후보는 native listen EPERM으로 미적용이다. 허용된 실행 재시도에서도 같았다. 타 접근 수단이나 네트워크 방식으로 제한을 우회하지 않는다. singleton 확보가 필요한 prompt-intake startup claim release나 heartbeat 전체 운영 수명은 준비 완료로 처리하지 않는다.
- StateAccessFacade의 Promise 반환은 전체 SQLite offload 증거가 아니다. 많은 동기 DB 본문, 전역/대상별 IO·바이트 예산, 실제 부하 p99/Windows24h 검증이 남아 있다.
- 전체 main/gateway/workers 조립, 전체 미러 전달·cursor 영속화, Pro plugin fingerprint/runtime 준비, Windows native process/instance 계약 및 일부 운영 기능이 미완료다.
- Archive의 100개·11페이지는 한 번의 하위 대상 수집/완전성 검사에 관한 기존 source 계약이다. 누적 Archive 전체 수를 제한하는 의미가 아니다. 사용자 승인 없이 제거하거나 전체 보관 quota로 확대하지 않는다.
- 오래된 Stop 기록은 이후 시작해서 정상 완료된 별도 요청이라는 근거가 확인되는 범위에서만 차단 판단에서 제외한다. 근거가 모호하면 보존·보류한다. 이 조건과 최신 Rust 추가 변경의 전체 대조를 계속한다.

## 보존·복구 상태
- 원래 두 작업 경로는 2026-10-10 21:23:04 UTC 재확인에서도 보이지 않았다. 원인/영구 손실/복구 가능성은 확인되지 않았다. 별도 rebuild 디렉터리는 기존 파일 복원 성공이 아니다.
- 지원 사건16911035는 21:25:46 UTC 확인 시 새 답장이 없었다. 마지막 기술 검토 요청 이후 보존·복구 가능 여부·기한은 미확인이다.
- 최신 Rust main은 21:14:08 UTC에 dfec7dfb55e01516ad6d48a67a4aff4072d6150e로 확인했다. 새 Pro authority 파일들은 이 커밋에서 직접 읽었고 frozen 기준과 바이트가 일치함을 확인했다. 이것이 모든 최신 Rust 변경을 이식 완료했다는 뜻은 아니다.
- 소스·테스트·요약·이 문서는 승인된 원격 브랜치에 보존한다. raw/gzip 로그 업로드는 승인 대기이므로 포함하지 않는다. main merge/운영 배포/실사용 DB/서비스 재시작은 하지 않는다.
- 아래 R8 및 포함된 원본 문서 전문은 byte-for-byte 보존한다.

---

# TypeScript 마이그레이션 통합 구현·복구·인수 문서 R8

기준: 2026-10-11 05:54 KST / 2026-10-10 20:54 UTC.
사용자 요청 전체 지침을 보존하는 추가 리비전이다. 이전 R7의 전체 92,270 bytes를 뒤에 그대로 포함하며 R1~R7을 삭제하거나 덮어쓰지 않는다. 과거 수치는 당시 스냅샷이다.

## 현재 검증된 적용 기준
- 체크포인트410: 실제 단일 전체 회귀 6,198/6,198 PASS, 실패·취소·skip 0. strict TypeScript exit0, 집중10 PASS.
- 로컬 commit 1566024b9dc700a57833b8a67ebb1b102a599b8f.
- 원격 소스/테스트/요약 commit 51f2425b0e5ee5a617d38c2aa5a4aa8907c25021, branch sss/async-admission-cloud.
- root tree 664723be2bde3be854f9e1b2af9f291351aabf7a.
- src tree 5b446d63ff0cc22e4126fea94c594c7ef3c3a282, test tree 4e1d340172535559c5906650d5513a96195cc961. 원격 ref/tree 독립 조회와 로컬 commit의 subtree 동일성은 문서 게시 전에 확인한다.
- Linux Node24.21.0 검증이다. 실제 Codex 서비스나 운영 Discord를 사용한 시험이 아니며 Windows/24시간 운영·배포 PASS가 아니다.
- 408은 후보408과409를 합친 단일 검증/적용, 410은 후보410과411을 합친 단일 검증/적용이다. 작업 번호마다 별도 전체 실행이 있었던 것처럼 세지 않는다.

## R7 이후 적용
|체크포인트|실제 전체 PASS|범위|
|---|---:|---|
|397|6087|재시작용 readonly SQLite worker, 실제 종료까지 worker slot 유지, 중앙 상태 facade 연결|
|398|6099|durable/live 상태를 두 차례 검사하는 drain 판정, 실제 resident의 미해결 요청 확인|
|399|6108|입장 gate의 drain 대기, 같은 기한 유지, 취소 시 자기 waiter만 정리|
|400|6118|준비 timeout 후 계속 대기, 제어 입장 닫기와 최종 live 재검사, 취소 후 IO 종료 대기|
|401|6125|prepare/ACK/restart marker와 gateway drain 제어 루프 연결|
|402|6138|중앙 종료 조정, 작업/게이트웨이 join, 앱서버 close, heartbeat 종료 순서와 공통 기한|
|403|6148|제어·worker·shard 종료 감시 경합, 패자 watcher 중단 및 join, 원래 종료 시작시각 유지|
|404|6152|소유한 SIGINT listener, 실제 무해한 POSIX 자식 프로세스 신호 시험|
|405|6161|직렬 heartbeat 쓰기와 안전한 소유 marker 정리, POSIX atomic writer 공유|
|406|6166|durable custody → 실제 native resident 시작 → idle journal 설치, 실패 시 소유 자식 종료|
|407|6173|queue 복구 후 격리 상태의 quiescent restart, 작업이 남으면 기존 generation hold 유지|
|408|6188|정확한 사고 안전 정책 등록·검증·rollback, 동일 queue target lock/control gate로 설치|
|410|6198|exact-ID queue 초기 복구와 native resident 연결, 명시 CODEX_HOME/stdio/client metadata 구성|

## 시작·종료 경로의 실제 한계
- 406/410은 기존 구체 owner와 중앙 상태 접근을 연결한 일부 부트스트랩이다. 전체 main 진입점, 모든 gateway/worker 수명 조립은 여전히 미완료다.
- 기존 정확한 대상 라우팅 backend는 과거 fork의 bridge 소유권 이전을 시작 시 재실행하지 않는다.
- 정책 설치 실패는 보고하며 정확한 사고 대상의 기존 무조건 hold를 유지한다. 다른 대상은 이 실패 때문에 전역 차단되지 않는다. queue 복구 실패와 generation 안정화 실패는 성공으로 바뀌지 않는다.
- 같은 중앙 상태 facade에 248개 실제 함수 매핑이 있다. 이 숫자는 이식 완성률이나 전체 비동기 offload의 증거가 아니다.
- 일반 SQLite 작업 다수는 여전히 동기 본문이다. Promise를 반환한다고 worker offload로 인정하지 않는다. 397의 전용 readonly worker와 전체 DB 정책을 구분한다.
- 405 marker cleanup은 마지막으로 직접 쓴 정확한 바이트와 일치할 때만 삭제한다. Rust의 무조건 Drop 삭제보다 좁다. 읽기/비교/삭제가 타 프로세스 CAS라는 주장은 하지 않는다.
- 404의 실제 POSIX SIGINT 시험은 Linux에서 통과했다. Windows 콘솔 신호 시험은 별도이며 해당 POSIX 시험은 Windows에서 명시적으로 제외한다. 현재 Linux 전체 실행 skip은 0이다.
- 406 cleanup 이중 실패 값의 보존은 단위 시험이다. 실제 native cleanup 이중 실패 주입까지 수행했다는 주장은 하지 않는다.
- 407의 실제 native 격리 시험은 명시 quarantine 상태 전이를 사용했다. 실제 Codex 네트워크 장애 주입을 대체하지 않는다.

## 미적용 후보412: POSIX singleton guard
- TypeScript 검사는 통과했으나 실제 Unix socket listen이 현재 VM에서 EPERM으로 실패했다.
- 일반 실행과 승인된 격리 IPC 시험 경로 모두 같은 결과다. 다른 transport로 바꾸거나 보안/네트워크 설정을 변경하지 않았다.
- 실행 결과 6개 중 3 PASS/3 FAIL이며 전체 적용 수치에 포함하지 않는다. 특히 marker publication 실패 시험은 더 앞선 bind 실패에도 PASS하여 post-bind cleanup 증거로 사용할 수 없다.
- 후보 원문과 두 실행 로그를 .runtime/rebuild-412-posix-instance에 보존, 제품 src/test에는 미적용이다.
- stale socket 자동 삭제를 하지 않는 보수적 후보이며 native lifetime, late server error, 절대 경로 고정과 실패 구별 테스트를 더 검토해야 한다.
- Windows named mutex 및 write-through marker adapter도 미구현이다. 단일 실행 보장이 완료됐다는 근거로 사용하지 않는다.

## 원격 기준과 복구
- Rust main은 20:44 UTC 재조회에서도 dfec7dfb55e01516ad6d48a67a4aff4072d6150e. 전체 변경분 동등성이 자동으로 증명된 것은 아니다.
- 이번 정책/복구 source는 그 고정 commit의 실제 원문과 blob을 독립 조회했다. policy.rs의 실제 식별자도 현재 조회에서 마스킹 없이 확인했으며 과거 마스킹 한계와 구분한다.
- 원래 두 작업 폴더는 20:53:07 UTC 재확인에서도 부재다. 재구현 폴더나 원격 보존은 원본 복구 성공을 뜻하지 않는다.
- 지원 case16911035는 계속 열려 있다. 20:46 UTC 확인까지 새 답신 없음. 보존 확정·복구 가능 여부·ETA는 미확인이다.
- 원격 main 병합/운영 DB 변경/봇 재시작/배포를 하지 않았다. 원시 또는 gzip 로그는 별도 전송 승인 대기 상태를 유지하고 소스·테스트·검증 요약만 보관했다.
- 후속 작업에서도 원본 부재 경로를 생성·덮어쓰거나 실패 기록을 지우지 않는다.

## 계속 유지하는 인수 기준
원본 Pro 문서의 A~G, 상태 조회 단일화, 중앙 오류 경계, TS 재시작 판단, Discord/Codex 경계 타입, 스레드 격리와 재시작 시험을 그대로 유지한다. 특히:
- timeout/취소와 실제 작업 종료·결과를 혼동하지 않는다. 실제 종료 전 slot/소유권을 놓거나 모호한 mutation을 자동 재실행하지 않는다.
- 오래된 Stop은 이후 별도 요청의 정상 완료가 정확한 원래 소유권과 함께 확인된 경우에만 제외한다.
- Archive 100개 descendant/11페이지는 한 번의 subtree 보관 판정 범위다. 전체 보관 저장량 한도가 아니다. 중복·누락된 페이지를 부분 승인하지 않으며 사용자가 상한 제거를 승인한 것은 아니다.
- 전역/스레드별 제한·공정성, 무거운 CPU/DB offload, 전체 mirror 동기화/보관 후처리, Pro 전처리, startup intake 해제의 독점 소유권, native Windows 프로세스/재시작과 수치 성능·24시간 운영 시험은 남아 있다.
- 테스트 수를 완성률로 환산하지 않는다. 불변 문서/실제 소스/실제 로그/원격 SHA를 함께 보존한다.

아래는 이전 R7 원문 전체이며 당시 기록을 현재 결과로 소급 수정하지 않는다.

# TypeScript 마이그레이션 통합 구현·복구·인수 문서 R7

기준: 2026-10-11 05:01 KST / 2026-10-10 20:01 UTC.
사용자가 요청한 전체 지침을 보존하는 추가 리비전이다. R6 전체 바이트를 뒤에 그대로 포함한다. 이전 리비전은 삭제·덮어쓰기하지 않는다. 과거 수치는 당시 스냅샷이며 현재 상태는 이 앞부분을 우선한다.

## 현재 검증된 적용 기준
- 체크포인트396: 실제 단일 전체 회귀 6,077/6,077 PASS, 실패·취소·skip 0, strict TypeScript exit0. 집중23 PASS.
- 로컬 commit 5f7f95ef142ce2282040baa759c471e4b1f488cd.
- 원격 소스/테스트/요약 commit 8896fc43245572cb5a5644bb3fb9b0cb20105e0c, branch sss/async-admission-cloud.
- 원격 root tree 4bc186a9248dc28b4d3130fa66b91bb9a9fbf125.
- 독립 원격 GET과 로컬 commit의 src tree 6a3ce33c93874e784572e7a1577c038ab600eea2, test tree 274e5301c3c912c438898e80021bfb16a53dc0f4가 각각 일치한다.
- 원격 main 병합, 운영 DB/Discord 서비스 변경, 배포 승인이 아니다. Linux Node24.21.0 실제 테스트이며 Windows 실행·24시간 운영 PASS가 아니다.
- 작성 시점397 재시작용 읽기 전용 SQLite worker 후보는 집중18 PASS/strict TS0, 실제 전체 실행 진행 중이다. 396 확정 수치에 포함하지 않는다.

## R6 이후 구현
|checkpoint|전체 PASS|범위|
|---|---:|---|
|389|6008|이미 종료 확인된 작업 결과의 중앙 종료 오류 우선순위|
|390|6014|전체 종료 기한과 heartbeat 여유, 기한 초과 fatal 처리, 소유한 무해 자식에서 실제 abort 시험|
|391|6024|최신 Rust의 실행파일 선택·누락 host fallback, 불완전 설치 건너뛰기|
|392|6032|상태 DB 발견, 엄격 파일명 디코드·mtime 정렬, 미생성 fallback|
|393|6044|중앙 경로 해석과 플랫폼별 lexical 결합, 환경/입력 snapshot|
|394|6054|플랫폼별 home·local app·PATH 검색, 명시 환경 사용|
|395|6065|재시작 marker 엄격 codec와 소유한 임시파일 기반 POSIX 저장|
|396|6077|소유 실행의 drain prepare/ACK/restart 제어, 입장 차단·재검사·취소 후 IO 종료 대기|

## 재시작 안전성의 범위
396은 runtime ID/PID와 정확한 fence key를 검사한 뒤 새 요청 입장을 막는다. ACK 전후 durable prepare와 drain 상태를 재검사하고, stop을 우선하며, 다른 nonce의 restart 요청으로 재시작하지 않는다. 오류는 허가로 바뀌지 않는다. 취소는 진행 중 IO를 기다려 종료하며 gate를 자동 해제하지 않는다.
- 소비자 정지와 독점 runtime 소유권은 호출자가 확보해야 한다. 이 leaf만으로 전체 부트스트랩·정상 종료가 완성됐다고 주장하지 않는다.
- Windows MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH)에 해당하는 adapter는 미구현이다. POSIX marker store는 Windows에서 명시적으로 거부한다.
- read-then-unlink는 타 프로세스에 대한 atomic compare-and-delete가 아니다. 독점 소유권 없이 안전하다고 주장하지 않는다.
- native Windows mutex/Unix socket RuntimeInstanceGuard, 실제 Ctrl-C 연결, 실제 app-server 재시작·이전/새 프로세스 배타성의 통합 검증은 남아 있다.
- 391~394의 Windows 경로 시험은 Linux에서 수행한 정적/스크립트 계약 시험이다. native Windows 경로·파일시스템 동작과 동등하다는 실측은 없다.

## 19:46 실행 연결 중단의 정확한 결과
2026-10-10 19:46:16 UTC 실행 도구가 transport disconnected를 반환했으나 실제로는 394 로컬 commit 후 395 전체 회귀가 시작됐다. 재접속에서 소스·commit이 보존된 것을 확인했다. 초기 전체 로그는 20,389 bytes에서 멈췄고 exit 기록과 생존 프로세스가 없어 최초 실행 결과는 UNKNOWN으로 보존했다.
- 소스 변경 없이 전체 회귀만 다시 실행해 6065 PASS/exit0를 직접 회수했다. 최초 실행을 PASS로 덮어쓰지 않는다.
- 이번 일시 중단으로 소스 손실은 확인되지 않았다. 기존 Oct8 원본 작업 폴더 복구와는 별도 사건이다.
- 기존 원본 두 폴더는 19:53 UTC 마지막 확인에서 부재. 이 재구현 폴더나 원격 보존은 원본 복구 성공을 뜻하지 않는다.
- 지원 case16911035는 기술 검토 중. 19:55 UTC 확인까지 새 답신·보존/복구 가능성·ETA 확답 없음. 요청받은 관련 지원 답신은 계속 확인한다.

## 기존 의무와 남은 작업
원본 Pro TS-RUNTIME-PARITY-20261007-R2는 문서/계획 PASS이고 구현·QA·성능·운영 PASS가 아니다. 원본 SHA a0799cfa3d7419a45e7003e1f579167a05dcdca0a8709dc4f891e7b0ac04bb72를 유지한다.
- 상태 단일 접근, 중앙 오류 처리, TS 중앙 재시작 판단, 얇은 플랫폼 스크립트, Discord/Codex 경계 타입, 격리·재시작 회귀를 계속 적용한다.
- StateAccessFacade 전체가 worker화됐다는 주장은 금지한다. 일부 API는 main thread DatabaseSync를 사용한다. 397은 해당 read-only snapshot만 offload하는 후보이며 일반 DB offload 완료가 아니다.
- Pro 계약 C 전역/스레드별 실행·대기·바이트·IO 예산과 공정성, D CPU/DB 분리, G 사전 수치화 성능·장애·Windows24h 검증은 여전히 남아 있다.
- 전체 mirror sync/create/cleanup·archive 후처리, 세션 미러 파일/cursor/scheduler, 실제 bootstrap/cleanup coordinator, Windows 복구/강제 재시작 통합은 미완료다.
- Archive 100개 하위대상·11페이지는 한 번의 대상 subtree 검증 한도다. 보관된 전체 항목 수 제한이 아니다. >100 subtree는 현재 거부되며 한도 제거 승인을 임의 추론하지 않는다. 중복·단절된 페이지의 중간 결과를 승인하지 않는다.
- 과거 Stop 제외는 이후 별도 정상 완료 요청의 정확한 소유자·채널·스레드·작업 및 종료 증거가 있을 때만 허용한다. 실패·중단·추정 완료를 정상 완료로 취급하지 않는다.
- 원시/gzip 실행 로그 업로드는 승인 대기 상태로 로컬에만 보존한다. 소스·테스트·요약·사용자용 문서만 원격 보존한다. 우회 업로드하지 않는다.

## 보존 방식
R6 원문 SHA256 414dbfc93d62468f1bea78acaec93c52de77ef83b938e7be46d355442c334dfd, 85,731 bytes를 아래 그대로 포함한다. R6 안에 R5 및 이전 지침·계약이 보존된다. 이 파일의 원격 publication과 독립 readback 증거는 별도 proof로 기록한다.

---

# TypeScript 마이그레이션 통합 구현·복구·인수 문서 R6

기준: 2026-10-11 04:20 KST / 2026-10-10 19:20 UTC.
사용자가 요청한 전체 지침 보존용 추가 리비전이다. R5 전체 바이트를 뒤에 그대로 포함하므로 원본 Pro 계약과 R1~R5가 모두 보존된다. 최신 상태·정정은 이 앞부분을 우선한다. 과거 스냅샷에 있는 진행 수치·미완료 항목을 현재 상태로 오인하지 않는다.

## 1. 독립 확인한 현재 기준
- 적용 체크포인트388: 실제 단일 전체 실행 5,999/5,999 PASS, 실패·취소·skip 0, strict TypeScript exit0. 집중 실행33 PASS.
- 로컬 commit: 1efee98b78e72673aaa1561922f23067eb880e57.
- 원격 소스/테스트/요약 commit: 0bc6699e515008c50df8ec75abd6658d2d1bd781, branch sss/async-admission-cloud.
- 원격 독립 GET 및 로컬 commit 대조: src tree159febbe7bc95d759fcf3ef3648512c9febbf557, test tree85934e58f0efa1e036f6657a769f439876207983. 두 tree 모두 일치.
- 실행 환경: Linux, 고정 Node24.21.0, strict TypeScript, 임시 SQLite, 실제 worker와 inert 자식 프로세스, localhost HTTP. 테스트 개수는 구현률·운영 성능·배포 승인 수치가 아니다.
- 작성 당시389 종료 오류 우선순위 후보의 전체 회귀가 진행 중이다. 이 문서의 승인 기준에는 포함하지 않는다.
- main 병합, 실제 Discord/봇/서비스 변경, 운영 DB 접근, Windows 배포 또는 24시간 운영 승인은 없다.

## 2. 반드시 유지할 정정: SQLite offload는 미완료
StateAccessFacade가 모든 DB 작업을 worker에서 실행한다는 설명은 사실이 아니다. 일부 async 함수는 openInitialized를 await한 뒤 현재 스레드에서 DatabaseSync를 실행한다. Promise라는 이유만으로 offload가 되지 않는다.
- history page JSON, 미러 검사 등 특정 owned worker는 구현/테스트됐지만 일반 SQLite 실행과 구분한다.
- 작은 최종 marker INSERT도 현재 스레드에서 실행한다. SQLite lock 대기·큰 중복 스캔이 event loop에 미치는 영향은 해결/측정 대상이다.
- Pro 계약 D의 작업 분리, C의 전역 부하·대기·바이트 예산, G의 성능/Windows 내구성 인수는 여전히 별도 미완료이다.
- 동기 gap fence 안에 Promise를 넣거나, 실제 작업이 끝나기 전에 슬롯을 반환하거나, timeout을 종료 확인으로 처리하면 안 된다.

## 3. R5 이후 실제 적용 범위
|checkpoint|전체 PASS|구현·검증 범위|
|---|---:|---|
|377|5934|owned worker에서 완전한 history DTO 디코드, 원본 정수/시간 보존, 입력/전송 제한|
|378|5941|채널 REST 고정10개 조회, HTTP 수명 내 decode await, 취소·rate limit·body 제한|
|379|5947|실제 HTTP→페이지 전체 검증→oldest-first 분류→SQLite 접수→메시지 실행 gap adapter|
|380|5954|원래 revision notice로만 gap ACK, incomplete/새 gap/오류 시 보존|
|381|5962|Gateway identity 감시 아래 gap 우선·정기 조회 직렬화, losing wait 취소/종료|
|382|5967|7개 실제 수신 consumer 시작·진입 확인 뒤 paused Gateway 활성화|
|383|5972|최종 동기 fence와 단일 processed marker transaction, 잘못된 guard rollback|
|384|5978|채널·clear revision 결합 discard, DB open 동안 gap/취소 변화 재확인|
|385|5982|정기 조회 prime/discard와 실제 처리 연결, 정책 실패 전 최초 기준점 보존|
|386|5988|조회 대상 우선순위·중복 제거·50개 상한·lazy SQLite read, 중앙 facade246항목|
|387|5995|실제 정기 target driver, 성공한 대상 조회 후만 cursor 제거, 오류 분류·gate 적용|
|388|5999|실제 history operations를 수신 작업 소유 gap receiver 및 확정된 봇 identity에 결합|

## 4. History와 startup의 정확한 계약
1. REST 조회창10개는 원본 고정값이다. full page가 누락 시작점까지 닿지 못하면 Incomplete이고 gap을 ACK하지 않는다. 성공한 빈 목록과 조회 실패를 구분한다.
2. 전체 페이지의 채널/DTO/ordering metadata 검증을 먼저 마친다. 상태 의존 명령 분류는 oldest-first claim 직전에 한다. 같은 페이지의 앞선 !new가 뒤 요청에 반영돼야 한다.
3. 정기 조회는 gate 입장→clear gap revision 캡처→시간/prime 기준점 고정→policy refresh→HTTP 순서다. policy 실패 뒤 다음 실행에서 prime 기준점을 뒤로 밀어 새 요청을 버리면 안 된다.
4. 오래된 메시지를 discard하면 unique processed marker만 기록한다. 실행 ingress, !new first-prompt 예약, 실행 permit을 만들지 않는다. Process/Discarded 증거를 구분한다.
5. discard는 앞서 캡처한 같은 채널 revision을 SQL 직전에 재확인한다. DB open 중 새 gap이나 취소가 생기면 marker를 남기지 않는다. 일반 SQL 실패는 tracker 자체를 poison시키지 않는다.
6. 의도적으로 공개한 TS 차이: 연결 초기화와 BEGIN IMMEDIATE가 최종 fence보다 앞선다. marker INSERT와 commit 사이에는 await가 없다. 원본의 완전 동기 open/error 순서와 동일하다고 주장하지 않는다. 현재 fence는 단일 event loop 범위이며 worker 간 mutex가 아니다.
7. 대상 조회는 startup→숫자 정렬 allowed→프로젝트 최근 순→스레드 최근 순이다. 50개 unique nonzero target에 도달하면 뒤 SQL/행을 읽지 않는다. 조회 실패로 빈 집합을 만들어 기존 cursor를 지우면 안 된다.
8. 50개는 한 번의 polling 대상 목록이다. Archive의100개 하위대상/11페이지와 별개이며 총 저장 대화량 제한이 아니다. 중복이 많은 DB에서 스캔 비용은 여전히 성능 검증 대상이다.
9. startup의 history factory는 history consumer가 실제 소유/정리하는 receiver를 받는다. recover와 poll이 같은 상태를 쓰고, 확정된 application/user identity를 사용한다. 별도 가짜 상태나 새 tracker로 갈아끼우면 안 된다.
10. 일곱 consumer가 진입한 후 Gateway를 활성화한다. callback이 시작됐다는 증거와 서비스 전체 건강/운영 검증은 다르다. 반환된 모든 worker handle은 공통 종료 기한 아래 실제 join해야 한다.

## 5. 실패 기록과 검증의 한계
- 382 최초4/5 실패는 전역 READY 객체를 여러 테스트에서 재사용해 'Gateway event already moved'가 난 fixture 문제였다. 대기 시간 연장은 해결하지 못했고 실제 join 오류를 확인한 뒤 각 테스트에서 새 READY 객체를 만들었다. 제품 코드는 바꾸지 않았으며 원래 실패 기록은 남아 있다.
- 385 최초 strict TS 실패는 readonly clock 필드를 테스트에서 대입한 오류였다. 새 context 객체를 만든 fixture로 고쳤으며 제품 검증을 완화하지 않았다.
- 386 NULL fixture는 실제 NOT NULL DDL을 위반했다. DDL을 약화하지 않고 그 fixture를 제거했다. optional NULL decoder 분기는 현재 실제 schema fixture에서 검증됐다고 주장하지 않는다.
- 383/384의 실제 trigger 오류, advanced revision, 중복 marker, 열린 연결 동안 cancellation, cross-channel 거절은 native SQLite로 확인했다.
- 385~388 HTTP/SQLite 연결은 실제 localhost transport와 임시 DB이며, 일부 business service는 scripted fixture다. 실제 Discord/Codex/Windows 통합 성공을 뜻하지 않는다.
- 모든 변경된 소스/테스트의 strict TS와 전체 회귀를 실제 실행했다. 원격에는 소스·테스트·요약·이 요구 문서를 보존한다. 원시/gzip 로그는 로컬에만 남아 있고 외부 전송은 별도 승인 대기 상태다.

## 6. 남은 구현·인수 작업
- 전체 runtime bootstrap: 경로 discovery, 단일 runtime instance, 실제 drain controller/operation marker, 전체 worker와 앱서버·HTTP·큐의 공유 수명, 종료 순서와 공통 deadline.
- 미러 전체 sync/생성·정리/삭제와 archive 후처리, session mirror 파일 generation/cursor/scheduler 연결.
- Windows Recover/강제 재시작/프로세스 트리 수명 및 실제 네이티브 앱 경계.
- 일부 미구현 명령은 명시적 unsupported 상태로 유지한다. 테스트용 port만 존재하는 기능을 구현 완료로 계산하지 않는다.
- Pro A~G 전체 인수, 전역/스레드별 budget·공정성, DB/CPU offload, crash/unknown outcome, 실제 성능·24시간 Windows 운영은 완료 전 별도 검증한다.
- 정상 완료된 별도 요청 증거로만 오래된 Stop을 제외하는 사용자 추가 규칙, 원래 접수/사용자/채널 결합, 손실 없는 정수/JSON, late result fence와 retry 제한은 그대로 유지한다.
- Archive100개 하위대상/11페이지 정책 설명 후 사용자는 계속 진행을 요청했다. 상한 제거 승인은 없었다. 일부 페이지만 승인하거나 중복/끊긴 페이지를 통과시키지 않는다.

## 7. 원본 복구와 안전한 재개
- 원래 두 작업 폴더는 마지막2026-10-10 18:53 UTC 확인에서 현재 파일 시스템에 없었다. 별도 rebuild는 원본 복구가 아니다.
- 지원 사건16911035는 열려 있다. 19:14 UTC 확인에서도 마지막 메일은15:12 UTC 발신본이고 새 답장은 없다. 보존 여부·복구 가능 여부·ETA는 아직 미확인이다.
- 최신 Rust main은19:14 UTC 독립 GET에서 dfec7dfb55e01516ad6d48a67a4aff4072d6150e로 확인됐다. frozen source는4e213aa69dc89bed1552d8b83e12471d7664b7ae이며, 해당 범위의 최신 파일 SHA 대조와 전체 diff parity는 구분한다.
- 현재 재개 기준은 위388 원격 commit 및 이후 확인된 branch commit이다. package-lock과 Node24.21.0을 고정하고 tsc --noEmit 및 node --test --test-concurrency=2로 정렬된 test/**/*.test.ts 전체를 실행한다.
- 원본 복구 폴더를 새로 만들거나 초기화해 복구된 것처럼 표시하지 않는다. 원격 main 병합/배포/실제 서비스 재시작은 별도 범위이다.
- 작업과 검수는 직접 수행한다. 진행/차단은 기존 Slack 스레드에 약5분 간격으로 전달한다. 같은 파일에 쓰는 작업을 겹치지 않고 전체 회귀 중에는 src/test를 변경하지 않는다.

## 8. 불변 이전 문서
아래 R5 원문은75137bytes이며 SHA256=1b43b1b1b5f4c11cb7402878088a1432e57c46edae8aaf52b4a9ec91a83e81bb다. R5 안의 R4 및 그 안의 원본 Pro 계약도 그대로다. 과거 명세나 제한을 삭제하지 않고 후속 정정으로 상태를 구분한다.

----- BEGIN IMMUTABLE R5 -----
# TypeScript 마이그레이션 통합 구현·복구·인수 문서 R5

기준: 2026-10-11 03:28 KST / 2026-10-10 18:28 UTC.
사용자의 전체 명세 보존·작업 지속 요청에 따른 추가 리비전이다. 기존 R1~R4 및 원본 Pro 문서를 그대로 보존하며, 아래에 R4 전체 바이트를 변경 없이 포함한다. 최신 상태는 이 앞부분, 전체 인수 계약과 과거 변경은 뒤의 원문을 함께 읽는다.

## 최신 검증과 보존
- Checkpoint376 실제 단일 전체 실행 5,928/5,928 PASS, fail/cancel/skip 0, strict TypeScript exit0.
- 로컬 검증 commit: 9a5b080e52a32f53d90a92780b083c9c46d30b5c.
- 원격 소스·테스트·요약 commit: 5fffb9aee1b746e1cb4f8e9fa13d009825c15239, sss/async-admission-cloud.
- 독립 GET 대조 src tree147f6d117086ebd1bef50aada3ce28f66064347e, test tree3d376ec1ca553effa8cee9dfe5c6e6188f81f27f.
- 실제 실행 환경은 Linux Node24.21.0, 임시 SQLite, 자체 worker, inert Node 자식 및 localhost HTTP fixture다. 테스트 개수는 전체 구현률이 아니다.
- 실제 Codex/Discord/Windows 운영, 24시간 내구성·성능 또는 배포 PASS가 아니다. main 병합·서비스 재시작 없음.
- 원격에는 승인된 소스/테스트/요약/요구 문서를 보관했다. 압축 원시 로그는 로컬 보존하며 전송 승인 대기 상태를 유지한다.

## R4 이후 적용 범위
|checkpoint|전체 PASS|적용 범위|
|---|---:|---|
|366|5849|실제 resident 진단·자원 상태·quiescent 앱서버 재시작 연결|
|367|5860|기본 명령 dispatcher와 명시적 unsupported 처리, 타입/명령 snapshot|
|368|5870|메시지 실행기, 원래 접수에 결합한 New/Ask/Stop/Resume/Archive/Repair/설정 연결|
|369|5876|실제 Gateway 메시지→접수→실행기→SQLite→HTTP 테스트, ACK 전 결과 기록|
|370|5882|읽기 전용 mirror 매핑/프로젝트 단일 DB snapshot|
|371|5891|owned worker 미러 검사, 원본 조회 순서 보존, 표시 제한과 검사 범위 분리|
|372|5895|MirrorCheck/MirrorInspect 실제 HTTP GET 연결, 403을 정상으로 오인하지 않음|
|373|5900|같은 실행기·큐·control을 slash/승인/Busy Queue 처리에 연결|
|374|5901|폐기 후 확인 알림 전체10초 제한, 실제 HTTP 취소/종료와 receipt 유지|
|375|5913|history prime 기준점·정확한 시간/ID 순서·전체 batch cursor commit|
|376|5928|history claim/process 순서, 오류 시 cursor 유지, inclusive gap 및 incomplete 판정|

## 실제로 발견하고 고친 결함
1. 미러 검사 순서: 원본은 guild 조회 후 rollout 파일 존재를 검사한다. 초기 TS는 앞서 검사하여 guild 조회 중 생성된 파일을 없다고 보고했다. 동일 test SHA272f332c7c100e0a5e6f321b659854c3c2c133a52d49e4da2102c04760f3abe0에서 8/9 RED→9/9 GREEN. inventory worker→guild→rollout worker→remote 검사로 고쳤다.
2. 폐기 확인 알림: 원본은 전송과 버튼 제거를 합쳐10초 제한한다. 초기 TS는6초POST+8초PATCH가14초 뒤 성공했다. 동일 test SHA4b018aaddd1fe584cafa295af45c3ef44314c0d9f4bdb2ed2240487ff306dc58에서 RED→GREEN. 한 AbortSignal을 HTTP 전송/버튼 제거에 전달하고 실제 작업 종료까지 기다린다. 이미 확인된 알림 receipt는 남기며 retry는 PATCH만 한다.
3. 369 최초 실패는 제품 변경이 아니라 테스트 trigger가 native 호출 전 generation 기록까지 막은 fixture 오류였다. result_recorded/response 조건으로 좁혔고 원래 native 호출 개수 검증은 유지했다. 실행 결과를 결함 근거로 혼동하지 않는다.

## 변하지 않는 요구사항과 제한
- TS 직접 구현·직접 검수, 작업 진행/차단은 원래 Slack 스레드에 약5분 간격 보고. 다른 코딩 에이전트에 검수 재위임하지 않는다.
- 상태 접근 중앙화, 에러 분류/처리 중앙화, 재시작 판단은 TS, 플랫폼 스크립트는 얇게. 경계 인터페이스·스레드 격리·재시작 회귀 유지.
- 원본 Pro A~G 계약, 원래 접수/사용자/채널/대상 결합, 손실 없는 정수/JSON, 시간초과와 실제 종료·결과의 구분은 뒤의 R4/원문 그대로 적용한다.
- 오래된 Stop 제외는 이후 정상 완료된 별도 요청의 정확한 증거가 있을 때만 한다. failed/interrupted를 정상 완료로 확대하지 않는다.
- Archive100개 하위대상·11페이지는 한 번의 작업 범위 상한이며 보관 총량 제한이 아니다. 사용자는 설명 후 계속 진행을 요청했으며, 상한 제거 승인은 없었다. 중복/끊긴 페이지의 일부 결과 승인 금지 유지.
- 미러 검사 display limit은 전체 조회 후 표시만 제한한다. 4MiB transfer/output 제한은 worker 전체 heap 한도가 아니다.
- history10개는 원본 REST 고정 조회창이다. 누락 지점까지 도달하지 못한 가득 찬 창은 Incomplete이며 완료 ACK하면 안 된다. 조회 실패를 빈 정상 목록으로 대체하지 않는다.
- history 분류는 전체 페이지의 ordering metadata 수집과 구분해야 한다. 상태 의존 명령 분류는 oldest-first claim 직전에 해야 같은 페이지 앞선 !new의 commit이 후속 일반 메시지에 반영된다.
- 원래 history cursor는 process-local이다. 새 인스턴스는 prime하며, 전체 batch 완료 전 cursor를 commit하지 않는다. ignored/invalid position은 실행 payload를 넘기지 않는다.

## 남은 실제 구현·검증
- history HTTP 조회/전체 Message decoder 연결, 원래 durable claim adapter, 주기/gap 루프와 typed ingress activation. 377 decoder는 작성·별도 검증 중이며 이번5928 적용기준에 포함하지 않는다.
- 전체 서비스 bootstrap, Gateway/queue/server의 단일 소유권 검증, shutdown/신호/worker 감독 결합.
- mirror 전체 동기화/컨테이너 생성/cleanup/archive 삭제, session mirror 파일 세대·cursor·scheduler.
- Windows Recover/강제 재시작/실제 앱/경로 처리 및 실제 네이티브 app-server 통합.
- Pro A~G의 전역 byte/작업/대기·IO 예산, 실제 성능 수치, fault/kill/backlog/reply loss, Windows24시간 검증.
- Linux 테스트가 통과했다는 이유로 Windows/실제 Discord 운영 승인이나 전체 Rust parity로 올리지 않는다.

## 원본 복구 사건
- 16911035는 계속 열려 있다. 원래 recovery-20261008과 migration-recovery-tools-20261008 경로는18:23:09 UTC 확인에서도 현재 파일시스템에 없다. 별도 재구현은 복구 성공이 아니다.
- 지원팀은 기술 검토를 요청한다고 했지만 원본 보존 여부/복구 가능성/ETA는 미확인.18:23:10 UTC 메일 확인에서 새 회신 없음. 새 회신 시 승인된 목적 범위에서 답한다.
- 원래 경로를 생성·초기화·덮어쓰기하지 않는다. 확인되지 않은 과거 전체 실행이나 task ID를 추측하지 않는다.

## 보존된 R4 전문
아래 구간은 SHA256 770450122414a261c5ab9330b043ab70698b3e56b00b823a927a3c1a9357ab65의 R4 바이트를 그대로 포함한다.

# TypeScript 마이그레이션 통합 구현·복구·인수 문서 R4

기준: 2026-10-11 02:25 KST / 2026-10-10 17:25 UTC.
사용자의 전체 명세 보존 요청에 따른 추가 리비전이다. 기존 R1/R2/R3와 원본 Pro 문서를 삭제하거나 덮어쓰지 않는다. 현재 상태는 이 앞부분을, 전체 요구사항과 과거 근거는 뒤의 R3 전문 및 그 안의 R2/R1/원문을 함께 사용한다.

## 검증 및 원격 보존
- 완료 checkpoint365: 실제 단일 전체 실행 5,843/5,843 PASS, fail/cancel/skip 0, strict TypeScript exit 0.
- 로컬 검증 commit: 4422484f525207ac75bddfa631c0db60a93c5e05.
- 원격 소스 보존 commit: 59b653dbb46186db70a47ed007bc68bf39879fc4, branch sss/async-admission-cloud.
- 원격 ref/tree GET과 검증된 로컬 커밋 비교: src 16acbefeb5142be8c925a280333b59f9cb1fb6da, test ef66937b6f27069f13fb889cc56253bef970ee36.
- Node24.21.0 Linux의 실제 임시 SQLite, worker, inert native child fixture 검증이다. 실제 Codex·Discord 서비스, Windows 실환경, 24시간 운영 또는 배포 PASS가 아니다.
- 원격에는 승인된 소스·테스트·요약·요구 문서만 보존한다. 압축 원시 로그 전송은 별도 승인 대기다.
- main 병합·배포·봇 재시작·실제 도구 초기화는 실행하지 않았다.

## R3 이후 완료
|checkpoint|전체 PASS|범위|
|---|---:|---|
|357|5786|Archive 전 원래 대상/세대/실행 상태/미처리 요청 확인|
|358|5791|보관 후 전체 범위의 저장 상태 확인, 불명확 결과 보류|
|359|5801|원래 접수 → 공유 대상 잠금 → 범위 재조회 → 영속 예약 → Archive → 저장 확인 coordinator 연결|
|360|5809|원래 thread ID의 loaded 상태 확인, 필요한 경우에만 resume 후 재확인|
|361|5819|원래 접수에 결합한 Resume 실행 및 취소/대상 변경 검사|
|362|5824|원래 접수에 결합한 Stop, 빠른 영속 접수와 공유 잠금·native interrupt 취소 전달|
|363|5832|Recover/Repair 일회용 claim, 효과 직전 원래 route·archive fence·claim 재검증|
|364|5841|Repair reset → initialize → probe, 단계별 기록, 시간초과/늦은 응답/원래 대상 잠금 유지|
|365|5843|새 native instance의 같은 generation은 old-child 종료 증거가 아님, 동시에 접수한 Stop이 오래된 Repair를 차단함|

## 중요한 해석과 확인된 한계
- Stop 접수 기록은 실행 종료 확인이 아니다. Archive 확인 실패도 실제 보관 실패의 증거가 아니다.
- Repair의 진단 JSON은 복구 권한이 아니다. 실제 mutation journal과 일회용 접수가 불명확한 효과의 재실행을 막는다. 진단 파일 자체의 원자적 power-loss 내구성은 주장하지 않는다.
- 364 RED에서는 중복 reset 전송은 차단됐지만 두 번째 진단 파일 생성까지 진행됐다. 같은 테스트 SHA로 기존 mutation fence를 파일 생성 전에 한 번 더 검사한 GREEN을 확인했다.
- 365 초기 실패는 테스트가 분류되지 않은 mutation-fence 거절에도 로컬 잠금 해제를 기대한 문제였다. Rust는 자체 before-send 거절 플래그 또는 확실한 원격 응답만 인정하므로 이 경우 잠금을 보수적으로 유지한다. 제품을 완화하지 않고 테스트 기대를 바로잡았다. 새 Stop 기록과 원래 queue는 보존되고 reset은 전송되지 않는다.
- 서비스 진단/유휴 재시작 연결 checkpoint366은 현재 focused13 및 strict TS0, 전체 회귀 실행 중이다. 완료365 숫자와 섞지 않는다.

## Archive 한도에 대한 최신 사용자 확인
- 2026-10-10 17:19 UTC 사용자가 Archive 제한의 필요성을 질문했고, 17:21 UTC 설명을 이해했으며 계속 진행하라고 했다.
- 현재 100개는 한 Archive에 포함되는 하위 대화 총수이고, 11은 조회 페이지 상한이다. 전체 계정의 보관 가능 개수 제한이 아니다. 부모 대화는 별도 포함된다.
- 큰 하위 묶음이 이 상한을 넘으면 실제 거절되는 제약이다. 중복/불완전 페이지를 거부하는 검증과 100/11이라는 고정값의 타당성은 별개다.
- 이번 확인으로 한도를 제거하거나 중간 목록을 승인하도록 바꾸지 않았다. 향후 규모 확대 시 범위 완결성, 공유 잠금, 원래 Stop scope, 영속 예약, 메모리/시간 예산을 함께 재설계해야 한다.

## 미완료 인수 항목
- 전체 command dispatcher/bootstrap, 미러 파일 generation+offset+완성 경계 및 영속 전달 cursor/scheduler 결합.
- 동기 store/bridge 접근의 소유 worker 경계 격리, 전역/스레드별 대기·바이트·IO 예산 및 공정성.
- Windows 원래 thread 경로/프로세스 소유권/작업 객체/desktop recovery/host resource 실제 구현·검증과 최신 Rust 변경 전수 대조.
- 명세 A–G의 실제 성능 기준, 장애 주입, 실제 서버/Windows 장시간 운영 및 배포 승인.
- 오래된 Stop 예외는 완료348 정책을 유지한다. 이후 별도 요청의 정상 completed 증거가 확인된 경우만 제외하고 failed/interrupted는 제외하지 않는다.
- 최신 Rust main은 17:14 UTC 재확인 dfec7dfb55e01516ad6d48a67a4aff4072d6150e. frozen 4e213aa 대비 모든 변경의 전체 parity를 주장하지 않는다.

## 원본 복구와 문서 보존
- 원래 두 작업 폴더는 17:23 UTC 확인에도 현재 접근 가능한 파일 시스템에 없다. 별도 재구현을 원본 복구 성공으로 취급하지 않는다.
- 지원 case16911035는 유지 중이다. 17:24 UTC 마지막 메시지는 우리의 발신이며 새 지원 답변은 없었다. 보존 완료/복구 가능/ETA는 미확인이다.
- 원본 Pro MD SHA256: a0799cfa3d7419a45e7003e1f579167a05dcdca0a8709dc4f891e7b0ac04bb72.
- 아래 R3 전체 SHA256: e897b7f01264994423059b75fca117d4f6909cd45d189d4757768ba4c5f5bae5.
- 문서/계획 PASS를 TS 구현·QA·성능·운영·배포 PASS로 바꾸지 않는다.

---
## R3 원문 전체 (불변)

# TypeScript 마이그레이션 통합 구현·복구·인수 문서 R3

기준: 2026-10-11 01:32 KST / 2026-10-10 16:32 UTC.
사용자의 전체 명세 보존 요청에 따른 추가 리비전. 기존 R1/R2 및 원본 MD는 삭제하거나 덮어쓰지 않는다. 아래 현재 상태를 먼저 읽고 뒤의 R2 전문을 역사 기록과 전체 명세로 사용한다.

## 검증 및 보존
- checkpoint356: 전체 5,779/5,779 PASS, fail/cancel/skip 0, strict TypeScript exit 0. 관련 focused25 PASS.
- 로컬 검증 commit: 91ffdd8e79b057c603afc7ddc1253c1d5403da1c.
- 원격 보존 commit: 5011b60f77a9cbf8cc755649ec56248538f43406, branch sss/async-admission-cloud.
- 실제 원격 ref/tree GET과 로컬 검증 tree 일치 확인: src b00ee90c7a3f71e47a9cfe6e610baa05a6c0ea0a / test d5ba34a7e6a6f6894d06ab93861fbed34f63ccb6.
- Node24.21.0 Linux 실제 SQLite, native child/worker 및 fixture 테스트다. 실제 Discord·Codex 서버·Windows 운영, 성능 및 배포 인증이 아니다.
- 압축 원시 로그 공유는 별도 승인 대기. 원격 보존은 소스·테스트·요약·문서 범위다.

## R2 이후 완료한 범위
|체크포인트|전체 PASS|범위|
|---|---:|---|
|349|5721|legacy 미러 cursor/event 저장 API, i64·NULL 의미·SQLite 중복/보존 경계|
|350|5729|Rust 공백 규칙과 동일한 미러 텍스트 digest, TTL·개수 제한 선택적 캐시|
|351|5736|미러 재시도 지연/반복 보고 시간의 순수 상태 계산|
|352|5748|최대 1MiB 바이트 창, 줄/레코드 한도, 엄격한 UTF-8 및 완성 줄 경계 파서|
|353|5754|고비용 파서를 실제 worker로 분리, 프로세스 전체 단일 slot, 종료 확인 전 slot 재사용 금지|
|354|5763|보관 하위 대상 최대100개·최대11페이지, 부분 목록 거부, 원래 명령·사용자·채널 접수 기록 대조|
|355|5773|전체 보관 범위 단일 SQLite 트랜잭션 예약, 늦은 ingress 보류, 확인된 예약만 상태 변경|
|356|5779|정확한 실행 전 거절만 예약 해제, 시간초과·연결 종료·불명확 결과는 잠금과 재시도 금지 유지|

‘보관’은 Codex 대화 archive다. 파일 백업이나 작업 소스 삭제를 뜻하지 않는다. 100개는 하위 대상 총수이며 페이지당100개×11=1100개 허용이 아니다. 부모 대화는 별도 범위에 포함된다. 중복 대상, 부모 재등장, 빈 ID, 잘못된 커서 또는 페이지 종료 증거 누락은 중간 결과 승인을 막는다.

## 현재 이어지는 작업
- checkpoint357은 보관 직전 generation/선택 대상/진행 중 turn/미처리 ingress/queue/intake/저장된 active 대화 확인과 resume/read idle 검증이다. 현재 focused25 및 strictTS는 통과했고 전체 회귀는 실행 중이다. 356 완료 숫자와 섞지 않는다.
- 전체 보관 coordinator 연결은 미완료다. 원래 명령 권한, root/child 제어 잠금, 범위 재조회, 영속 예약, 실제 요청, 저장된 archive 확인, 선택 해제까지의 순서를 연결해야 한다.
- 확인 실패/시간초과가 실제 실행 종료 또는 외부 결과 실패라는 뜻은 아니다. 취소 시 작업 종료 확인 전 소유권·slot을 반납하지 않는 기존 계약을 유지해야 한다.

## 계속 남는 인수 조건
- 미러 파일 generation + byte offset + 완성 레코드 경계와 durable 전달 cursor 결합, 교체·잘림·동시 변경의 보수적 판정.
- worker 파서 및 선택적 캐시는 전체 polling scheduler/전체 메모리 예산/실제 성능 승인으로 확대하지 않는다.
- store/bridge의 동기식 접근 전체를 소유 DB/파일 경계에 격리하고 전역·스레드별 공정성/대기 수/byte budget 검증.
- 최종 명령 dispatcher/bootstrap 및 최신 Rust 변경 전수 대조, Windows 실제 프로세스/24시간/성능/배포 검증.
- R2에 기록한 오래된 Stop 예외는 완료348을 유지한다. 정상 completed 증거에만 허용하며 failed/interrupted는 계속 차단한다.
- 원본 VM 복구는 미확인. 원래 두 폴더는 16:22 UTC 재조회에도 없었다. 별도 재구현과 원격 보존은 원본 복구나 지원 요청 종료가 아니다. 지원 case16911035는 열려 있으며 보존/복구/ETA는 확인되지 않았다.

## 변경 금지 원본과 이전 리비전
원본 MD SHA256 a0799cfa3d7419a45e7003e1f579167a05dcdca0a8709dc4f891e7b0ac04bb72.
R1 SHA256 6db468657d6beed0d90f12cb6777a663e7e6ca576b895a305e977a03b968ef70.
아래 R2 원문 SHA256 70d0d0cd1997734c75e02e55c780a3e707a101c6ea3bc334cdd648365d22c5ed. R2에는 R1 및 원본 Pro 계약 전문이 포함된다. 문서/계획 PASS를 구현·QA·운영 PASS로 바꾸지 않는다.

---
## R2 원문 전체 (불변)

# TypeScript 마이그레이션 통합 구현·복구·인수 문서 R2

작성 기준: 2026-10-11 00:42 KST / 2026-10-10 15:42 UTC.

이 파일은 사용자 요청에 따라 요구 명세 전체와 최신 진행을 함께 보존하는 새 리비전이다. R1 및 원본 MD를 삭제·덮어쓰지 않았다. 아래 ‘현재 상태’가 과거 R1의 진행 숫자·대기 항목보다 최신이며, 사용자 지침과 원본 Pro A–G 계약은 그대로 유지한다. 뒤에는 R1 전문을 원문 그대로 포함하므로 이 파일 하나에서도 전체 명세와 과거 근거를 읽을 수 있다.

**전체 마이그레이션·실제 운영·배포는 아직 미완료다.**

## 현재 상태와 검증된 보존 지점

- 최신 완료 checkpoint348: 실제 전체 **5,712/5,712 PASS**, fail/cancel/skip 0, strict TypeScript exit0. 관련 focused53 PASS.
- 로컬 검증 커밋: dbb3caf7dbef3c4d1934b1b53166738508195a2d.
- 원격 보존 커밋: 5278a1b139bb1f15d8a1bece39ae4a694c76e653.
- 원격 branch GET과 로컬 검증 커밋의 src/test tree를 비교했다. src=5824e2c31a8ec49426619778808445775a6d5c8c, test=73d0d98d4716a07d3dd1dd7ea280e7990ed0e894.
- 보존 branch는 sss/async-admission-cloud다. main 병합이나 배포를 하지 않았다.
- Node24.21.0 Linux x64, 고정 lockfile, 실제 임시 SQLite/worker/fixture 검증이다. 실제 Codex 앱·Discord·Windows 운영 인증과 동일시하지 않는다.
- 압축 원시 로그는 별도 공유 승인 대기로 로컬에만 있다. 원격에는 승인된 소스·테스트·검증 요약·요구 문서를 보존했다.

## R1 이후 완료된 구현

| checkpoint | 실제 전체 PASS | 검증한 범위 |
|---|---:|---|
|343|5,673|확인된 최종 전달 receipt만 단일 트랜잭션으로 정리하는 store 경로|
|344|5,678|최종 응답 runtime에 위 경로 연결, false 시 일반 전달 fallback 유지|
|345|5,690|세션 이벤트의 User/Commentary/Final/Failed/Aborted 분류, turn 및 digest 중복 방지|
|346|5,696|재시작 후에도 동일 nonce/receipt 사용, unknown 전송 재시도 금지|
|347|5,704|매 이벤트 원래 요청/turn 소유권 재조회, Starting·goal 대기·완료 관찰 공백 차단|
|348|5,712|과거 unbound Stop이 별개 새 요청을 계속 차단하는 문제의 제한된 예외|

StateAccessFacade는 현재 exact230 함수 alias/type/inventory 검증을 통과했다. 세션 미러의 전체 background scheduler·증분 파일 generation/cursor·DB worker 격리가 끝난 것은 아니다.

## 최신 Rust 원격과 중단 기록 버그

2026-10-10 15:31 UTC 실제 조회에서 Rust main은 dfec7dfb55e01516ad6d48a67a4aff4072d6150e로 진전했다. R1의 ed47c482420631447f0a38ef55a8d29acc1f6f6a 이후 다음 두 커밋을 추가 확인했다.

- a3b5effe3a6ec20c38897ca2be13ac0903bd684a: fix: scope legacy stop admission to its original work
- dfec7dfb55e01516ad6d48a67a4aff4072d6150e: Merge legacy stop admission fix (#3)

실제 새 lifecycle.rs, lifecycle/legacy_stop.rs, legacy_stop_admission_contract.rs, async_orphan_fixture.rs 전체를 읽고 Git blob SHA와 로컬 바이트를 대조했다.

TS 예외는 다음 조건을 모두 요구한다.

1. version1의 정확한 Execute/Stop/reference:null 형태이며 lifecycle_binding·stop_origin·work·command에 새 바인딩이 없어야 한다.
2. 과거 행은 legacy 입장 순번이고, 별도 입력은 실제 admitted 순번이 더 커야 한다. 벽시계 created_at 비교나 legacy-to-legacy 순서는 증거로 쓰지 않는다.
3. 동일 thread/channel/owner, 원래 message event, prompt owner job이 실제 sealed Running job/시도 횟수/turn과 일치해야 한다.
4. ordinary obligation의 terminal/settled 상태, 같은 revision 및 같은 proof를 가진 보존된 종료 인증이 있어야 한다.
5. 사용자 요구에 따라 canonical terminal status가 **completed**여야 한다.

### 의도적인 좁은 TS 차이

새 Rust SQL을 그대로 옮긴 Node SQLite 재현에서는 인증된 failed terminal도 예외에 들어갔다. 사용자 지시는 ‘이후 시작해서 정상 완료된 별도 요청’이므로 TS는 proof의 canonical_terminal.turn.status='completed' 조건 하나를 추가했다. failed/interrupted는 계속 차단한다. 기존 Rust 저장소는 수정하지 않았다. 이는 Rust 바이너리 실행 결과라는 주장이 아니라 전체 소스·native SQLite producer 및 source-exact SQL 포트로 확인한 차이다.

- 원래 TS는 최종 회귀와 같은 테스트 바이트에서 정상 완료 후 해제 두 경로가 RED였다.
- 고친 TS는 같은 최종 회귀 8개가 GREEN이다. 테스트 SHA256: 2f47983941668900ee00366e98855fb2da6b5efc1ed796498a8cb93067a4f47d.
- 새 Rust SQL 대비 predicate 차이는 위 completed 조건 하나이고 결과 alias만 추가했다는 기계적 비교를 남겼다.
- 원래 Stop ingress는 그대로 보존한다. 이미 사용자가 중단한 개별 요청의 execution hold를 해제하거나 재시도하지 않는다.
- 나중 Stop, Archive, active/failed/interrupted, 원래 actor/channel/job/event 불일치, 인증/순번 누락, 명시 바인딩, 별도 recovery policy는 계속 차단한다.
- 128/129 행·131072-byte 제한, UTF8/UTF16 변환 순서, ordinary의 outcome 미열람, superseded Stop의 outcome 미열람을 유지한다.
- 기존 인위적인 INTEGER ingress ID 테스트 fixture는 실제 schema의 TEXT ID 및 명시한 삽입 순서로 바꿨다. 제품의 타입 검증을 완화하지 않았다.
- 자세한 소스/테스트/한계는 checkpoint-348.json 및 source-preservation-348.json에 기록했다.

## 원본 문서와 복구 상태

- 원본 Pro 문서 19,379 bytes, SHA256 a0799cfa3d7419a45e7003e1f579167a05dcdca0a8709dc4f891e7b0ac04bb72.
- 원본 R1 49,691 bytes, SHA256 6db468657d6beed0d90f12cb6777a663e7e6ca576b895a305e977a03b968ef70.
- 두 파일은 15:28 UTC 재확인에서도 변하지 않았다.
- 원래 20261008 두 작업 폴더는 15:22:10 UTC 재확인에서도 없었다. 재구현 폴더는 원본 복원 성공이 아니다.
- 지원 case16911035: Eddie의 15:06 회신은 이전 작업 전환 설명이 원인 확정이 아니며 7일 창의 dot 적용도 미확인이라고 정정했다. 기술 검토 요청 예정이라는 답변이며 보존·복구·ETA는 미확정이다.
- 요청받은 식별 정보로 15:12 UTC 답장했다. 15:42 UTC 현재 그 이후 새 회신은 없다. 복구 요청은 계속 열려 있다.

## 이어갈 작업과 중단 조건

- 위 정상 완료 예외를 포함한 TS 전환을 계속하며 새 원격 변경은 commit에 고정해 대조한다.
- 완료하지 않은 command dispatcher/production bootstrap, 세션 미러 bounded tail·cursor·generation, 동기 DB/file 작업의 별도 소유 실행 자원과 bounded queue를 조립한다.
- Windows Codex bundle 탐색·incomplete bundle fallback·process identity·owned process cancellation의 최신 Rust 수정도 후속 구현/검증 대상이다.
- Pro A–G 전체 인수 조건과 수치 기준을 고정한 Rust/TS 동일 부하 비교, Windows/실제 server 계약, 재시작·전환 검증은 남아 있다.
- 작업 중 약 5분 진행 보고를 유지한다. 미실행을 실행 중이라고 하지 않는다.
- 이 R2와 R1, 원본 문서는 삭제·덮어쓰지 않는다. 다음 변경은 새 리비전 또는 새 checkpoint로 남긴다.

## 보존된 R1 전문: 아래 진행 수치와 대기 상태는 15:06 UTC의 역사 기록

<!-- BEGIN_IMMUTABLE_R1 -->
# TypeScript 마이그레이션 통합 구현·복구·인수 문서 R1

작성 기준: 2026-10-11 00:06 KST / 2026-10-10 15:06 UTC. 사용자 요청으로 원본 명세, 추가 지침, Git 변경, 실제 진행 상태와 미완료 항목을 한 곳에 모았다.

**상태: 구현 진행 중. 전체 마이그레이션·운영·배포 PASS가 아니다.** 이 문서는 기존 파일을 대체하거나 삭제하지 않는다. R1 원문을 보존하고 향후 변경은 새 리비전 또는 추가 기록으로 남긴다. VM 자체의 보존을 보장할 수 없으므로 Git 원격 커밋과 로컬 파일을 함께 확인한다.

## 1. 반드시 지킬 사용자 지시

- TypeScript 전환은 계속한다. 최신 원격 Git 변경을 실제로 읽고 반영 여부를 확인한다.
- 스레드 상태 조회·변경은 단일 접근 경계로 모은다. 기능마다 별도 조회 구현을 흩뜨리지 않는다.
- 에러 처리는 중앙 정책으로 통일하고 각 기능은 분류 가능한 에러를 전달한다. 모든 함수에 임의의 복구/재시도 처리를 복제하지 않는다.
- 재시작 판단은 TS에 두고 PowerShell 등 플랫폼 스크립트는 얇게 유지한다.
- Discord/Codex 경계의 타입·인터페이스를 먼저 정의하고 기존 동작을 이전한다.
- 스레드 격리·정확한 원래 대상/요청/turn·재시작·취소·늦은 완료를 우선 검증한다.
- 1차 구현 이후 이 문서에 포함된 Pro 승인 A–G 명세와 추가 Rust 안정화 수정까지 점검한다. 기본 안전 요구를 후속 단계라는 이유로 완화하지 않는다.
- 구현과 코드 검수는 현재 담당자가 직접 수행한다. 사용자가 금지한 별도 Codex 앱 검수 스레드 위임은 하지 않는다.
- 기존 Slack 작업 스레드에서 약 5분 간격으로 실제 진행·실패·차단 상태를 보고한다. 실행하지 않은 일을 실행 중이라고 하지 않는다.
- 복구 지원 답변을 확인하고 승인된 복구 문의 범위 안에서 후속 답장을 보낸다. 단순 접수 안내에는 반복 답장하지 않는다.
- 원본 명세, 기존 복구 문서, 반려 후보와 실패 로그를 임의로 삭제하지 않는다. 무단 초기화/리셋/기존 작업 덮어쓰기 금지.

## 2. 원본 명세의 정체성과 전문

원본 파일: `requirements/ts-runtime-parity-pro-reviewed-20261007.md`, 19,379 bytes.
- 원본 파일 SHA256: `a0799cfa3d7419a45e7003e1f579167a05dcdca0a8709dc4f891e7b0ac04bb72`
- 승인 본문 SHA256: `b38ec59008b6a98955ca86b0e13034d05eda3b045152e8df1fa235e02c06f22a`
- 최종 문서/계획 검수 ID: `TS-RUNTIME-PARITY-20261007-R2`.
- 본문 마커 내부 앞뒤 공백을 제거하고 LF 하나를 붙여 계산한 값이 문서의 승인 SHA와 일치했다.
- 최초 Library 복사 권한 오류 후 사용자가 같은 파일을 다시 첨부했다. 새 첨부 전문을 읽고 원본 바이트 그대로 저장했다. 이전 접근 실패를 우회한 것이 아니다.
- 원본 전문은 이 문서 마지막에 빠짐없이 포함된다. Pro 판정은 문서/계획 PASS이며 구현·QA·성능·운영·배포 승인으로 확대하지 않는다.

## 3. Git 기준과 작업 위치

- TS 저장소: https://github.com/simdorei/codex-discord-bridge-ts
- 보존 브랜치: `sss/async-admission-cloud`, draft PR https://github.com/simdorei/codex-discord-bridge-ts/pull/1
- TS main 확인값: `47d0f7f9a3c75a6ec94b38833cd1992740efaeb3`.
- 재구현 출발점: checkpoint 276, 원격 `371018cb132b2578e0aa74e5db85d0debec04ccb`, 5,086 테스트 기준.
- 최신 검증 완료 checkpoint 342: 로컬 `2a95c9c037da1591918e7e8a43c7c79a3121beb4`, 원격 `b1ca9cd071c424e891fb78785e8c5d4638420d27`.
- 해당 원격 src tree: `ed4f3b8387e8a14e6b50f3d16d770239bb455a4a`, test tree: `e477bf7f2f61e779eedd2514842ab509122d3086`. 로컬 커밋의 두 tree와 GET으로 조회한 원격 tree가 일치한다.
- 현재 재구현 디렉터리: `/workspace/scratch/bf1e81df474a/codex-discord-bridge-ts-rebuild-20261010`.
- 로컬 검증 이력과 원격 보존 이력은 분리되어 있다. 억지 merge/reset으로 맞추지 않는다.
- 승인된 소스·테스트·검증 요약·요구 문서를 원격에 보존한다. 압축 원시 테스트 로그는 별도 승인 대기이므로 원격 보존에 포함하지 않는다.
- main 병합, 운영 배포, 실사용 DB 변경, 봇/서비스 재시작은 이 문서 작성이나 단위 테스트 PASS로 승인되지 않는다.

## 4. 원래 작업 공간과 복구 상황

원래 `/workspace/scratch/bf1e81df474a/codex-discord-bridge-ts-recovery-20261008` 및 `migration-recovery-tools-20261008` 경로는 2026-10-10 14:51:26 UTC 확인에서도 존재하지 않았다. 현재 폴더를 원래 작업 복원 성공이라고 부르지 않는다.

당시 오류는 `executor key changed during session recovery`였다. 저장소 소실 원인은 미확정이며 영구 삭제 여부도 입증되지 않았다. 과거 마지막 기록은 checkpoint 632/631 전체 8,183 PASS·TS0, 다음 633의 focused13/TS0 및 전체 실행 결과 미확인이다. 현재 5,662 PASS와 합산하거나 동일 후보라고 하지 않는다.

지원 문의 case 16911035는 담당자 전달 안내 이후 전문 담당자의 복구 결과가 아직 없다(15:06 작성 시 마지막 메일 확인 14:50 UTC). 확인하지 못한 원래 작업 ID를 만들거나 다른 스레드 ID로 대체하지 않는다. 원래 경로를 생성해 복구본인 것처럼 만들지 않는다.

## 5. 실제 검증 환경과 합격 범위

- 고정 Node `24.21.0` Linux x64. 기본 설치 Node와 구분하며 공식 SHASUM 검증 후 설치한 실행 파일을 사용한다.
- package-lock 기반 의존성, `tsc --noEmit`, Node 기본 test runner를 사용한다.
- 전체 실행: `node --test --test-concurrency=2`와 정렬된 모든 `test/**/*.test.ts` 경로.
- checkpoint342 실제 전체 5,662/5,662 PASS, fail/cancel/skip 0, strict TS exit0. focused29 PASS.
- 실제 임시 SQLite 파일/메모리 DB, 파일 읽기/쓰기, worker_threads, 소유권을 관리하는 자식 프로세스, loopback HTTP, 프로토콜 fixture를 사용한다.
- 실제 Codex 앱 또는 실제 app-server 실행 파일에 연결해 운영 적합성을 확인한 결과가 아니다. fixture 프로세스가 Codex와 동일하다는 주장 금지.
- 실제 Discord 전송, Windows 네이티브 동작, 배포 전환, 장기간 안정성, Rust/TS 동일 부하 성능 비교는 아직 별도 검증이 필요하다.
- 전체 테스트가 실행 중일 때 src/test를 변경하지 않는다. 다음 후보는 별도 staging 영역에서만 준비한다.
- 실패를 보존하고 원인과 수정 범위를 기록한다. 로그의 숫자를 수정하거나 타임아웃을 임의로 늘려 PASS로 만들지 않는다.

## 6. 구현된 범위 요약과 한계

| 범위 | 현재 구현 및 검증 | 남은 범위 |
|---|---|---|
| 영속 상태·식별자 | 큰 정수/Serde JSON, SQLite 스키마·claim/CAS·original ownership·StateAccessFacade | 전체 서비스 조립과 메인 루프의 동기 DB 격리 |
| gateway/message/interaction/component | 승인된 원래 요청, persisted admission, 답장 receipt, known/unknown outcome, 중앙 에러 연계 | 전체 명령 dispatcher와 production bootstrap |
| 새 대화 | 원래 프로젝트/매핑, thread/start 기록, mirror 생성 custody, 최초 입력/첫 답장, 취소 | 실제 Codex/Discord 및 Windows 통합 |
| 설정·목록·상태·context | 세대·원래 대상 고정, notification write watermark, read-only 상태, 제한된 context worker | 전체 host/platform 서비스 조립 |
| 완료/전달 | 정확한 turn, receipt, 첫 답장/진행/goal barrier, metadata budget, 채널 head | 최신 Rust confirmed-final 원자 정리 경로 반영 진행 중 |
| 실행·재시작 | portable resident, generation, mutation/response fence, cancellation/join, native fixture | 설치/실행파일 탐색 최신 수정, Windows 및 실제 운영 자격 확인 |
| 진단 | 별도 실제 worker, read-only SQLite/JSON, 값 비노출, 1MiB JSON 한도, 파일 누락 시 생성 금지 | JSON 오류 위치 표시 미이전, Windows protocol registration 미구현 |
| 상태 접근 통합 | checkpoint341 기준 exact facade229개 함수 identity/type/inventory 테스트 | 이후 새 store 경계도 일관되게 추가해야 함 |

지금 ‘테스트만 남음’ 상태가 아니다. 전체 연결과 플랫폼 구현이 남아 있다. 테스트 개수로 완료율을 환산하지 않는다.

## 7. A–G 계약 대비 현 상태

| 조항 | 판단 | 관련 구현·증거 및 남은 일 |
|---|---|---|
| A 기능·영속 의미 | 부분 구현/통합 미검증 | admission/ingress, receipt, new first-reply, mutation custody. 프로세스 종료 경계 전체 조립 및 실운영 전환 검증 필요 |
| B 부가 조회·증분 | 부분 구현 | context-read/worker, completion metadata·payload, cursor 관련 구현. 정상 tail/backlog의 모든 bytes/records/인계 경로 종합 audit 필요 |
| C 동시성·공정성 | 부분 구현 | TargetLocks, owned reader slot, resident generations, completion scheduler. 전역/대화별 queue bytes·하위 제출량과 포화 시 제어 진행의 전체 부하 검증 필요 |
| D Node 자원 구분 | 전체 기준 미충족 | context/diagnostics는 worker 격리. 여전히 BridgeState/CodexThreadStore 및 여러 DatabaseSync 호출이 동기 실행이므로 최종 runtime에 명확한 소유 worker/비차단 경계 필요 |
| E DB 동시성·호환 | 부분 구현 | bigint, native SQLite, CheckedRead, 원자 claim/CAS, 단기 snapshot. 전체 DB lock·checkpoint·요청 deadline 범위 검증 필요 |
| F timeout·재시도·인계 | 부분 구현 | OwnedWorkerSlot 실제 종료까지 슬롯 유지, native process 취소/join, generation/receipt/original-request fences. 실제 외부 계약 및 구·신 운영 전환 증거 필요 |
| G1–G6 | 일부 개별 fixture 근거 있음, 전체 인수 미검증 | 장기 이력·포화·DB lock/commit 후 응답 유실·반복 timeout·강제 프로세스 종료·기존 상태 이전을 통합 검증해야 함 |
| G7 | 미검증 | 식별된 Rust/TS 산출물, 동일 부하와 설정, 실패/조정 대기 포함 분포·최대값·메모리·회복 측정 미실시 |
| G 사전 수치 기준 | 미확정 | 절대 지연, 허용 회귀, 용량, 표본/실패 집계 및 회복 수치를 시험 전에 고정해야 함. 결과를 본 후 기준 확대 금지 |

## 8. 최신 Rust 추가분의 처리

원래 고정 authority는 `4e213aa69dc89bed1552d8b83e12471d7664b7ae`이며 release/stabilization-held-20261002는 그대로다. 최신 main은 `ed47c482420631447f0a38ef55a8d29acc1f6f6a`로 29 commits ahead / 0 behind. 기존 base와 supplemental main을 구분해 checkpoint별 근거를 명시한다.

- 채널별 final head 재검증: checkpoint342 반영 및 native 회귀29/전체5662 PASS. 채널은 ranking 전에 제한하되 delivery ID를 먼저 제한해 앞선 head를 건너뛰지 않는다.
- 이미 확인된 final의 단일 트랜잭션 정리 + 동시 정리 후 fallback: checkpoint343 store 후보 focused46/TS0, 전체 실행 중. runtime 연결 미완료. 따라서 아직 전부 반영된 것으로 보지 않는다.
- Codex 불완전 설치 fallback/Windows bundle 완전성, process identity timestamp/fast exit, owned Unix process-group cancellation, platform fixture/CI 수리: 변경 목록 확보, TS delta audit 미완료.
- 외부 최신 branch가 다시 바뀌면 새 SHA를 고정하고 추가 차이를 별도 기록한다. 검사 없이 main을 그대로 덮어쓰지 않는다.

## 9. 추가 버그: 과거 중단 요청의 오차단

사용자가 2026-10-10 15:01 UTC에 추가한 요구: 질문 처리 기록이 한 번 생기면 해당 스레드의 과거 미처리 중단 요청을 전부 재검사하여 새 요청까지 차단하는 문제.

현재 TS `src/store/async-resolution-admission.ts::asyncLifecycleAdmissionHeldIn`과 확인한 최신 Rust `async_resolution/lifecycle.rs`는 obligation 존재 여부를 확인한 뒤 해당 thread의 미완료/unowned ingress를 검사한다. 요청별 인과관계를 구분하는 예외는 없다.

수정 인수 조건:
1. 같은 스레드에서, 해당 stop 이후 실제 시작했고 정상 완료한 별도 요청의 식별 가능한 증거가 있을 때만 그 오래된 stop의 차단 기여를 제외한다.
2. 단순 created_at/updated_at 증가, 접수·ACK 성공, completed라는 일반 ingress 상태, 빈 이력 또는 질문 레코드만으로 정상 모델 완료를 추정하지 않는다.
3. 다른 스레드/같은 원래 작업/failed/interrupted/unknown, 이전 시작, 모호한 동일 시간, 원래 소유권·turn 불일치에서는 차단을 유지한다.
4. 최신 stop, Archive 등 다른 제어, active unresolved async obligation, recovery policy, incident hold 등 독립 차단을 면제하지 않는다.
5. 원래 stop/ingress/receipt를 삭제·변조하거나 중단·실패 사용자 요청을 재실행하지 않는다.
6. positive와 위 negative 사례의 실행 가능한 회귀, 재시작 뒤 동일 판단, bounded read/131072bytes·128row 기존 제약을 검증한다.

현재 상태: 원인 predicate 확인, 수정은 아직 적용하지 않음. 정상 완료와 실제 시작을 입증할 기존 영속 evidence의 정확한 형태를 먼저 대조해야 한다. 접수 결과와 turn 정상 종료를 혼동한 광범위 SQL 예외를 넣지 않는다.

## 10. 즉시 이어갈 순서

1. checkpoint343 실제 전체 결과 회수; 실패 시 근거 보존 후 최소 수정. confirmed-final transaction은 runtime에 연결하기 전 별도 검수.
2. 통합 문서와 원본 MD의 원격 보존 및 SHA 확인. 기존 문서/체크포인트 삭제 금지.
3. 위 stale-stop 예외의 시작·정상 완료·별도 요청 소유권 증거와 Rust 수정본 여부를 확인하고 제한된 회귀부터 추가.
4. 최신 Rust 나머지 product delta를 source-backed 항목별로 대조.
5. 전체 명령 dispatcher, production bootstrap, 동기 DB/파일 실행 소유권과 bounded queues를 조립.
6. 사전 G 정량 기준을 고정한 뒤 동일 Rust/TS 부하·장애·재시작/전환 검증. 운영 배포는 별도 승인 단계.

## 11. 보존·재개 절차

- 이 R1 파일과 원본 명세를 삭제하거나 다른 내용으로 교체하지 않는다. 향후 문서는 R2 등 새 파일로 만들고 기존 커밋을 유지한다.
- 원격 branch를 GET으로 읽고 local verified src/test tree와 비교한다. push 결과만으로 보존 성공이라고 하지 않는다.
- 새 실행 환경에서는 저장소·branch·실제 SHA·명세 SHA·Node 버전·lockfile을 확인한 뒤 현재 기록에서 재개한다.
- 미완료 작업·staging/반려 후보·마지막 전체 PASS를 구분한다. 마지막 full 테스트 도중 변경된 소스를 해당 PASS에 끼워 넣지 않는다.
- 원시 로그의 별도 공유 승인 대기를 우회하지 않는다. checkpoint summary에 원시 로그 hash와 실제 결과를 기록한다.
- 문서의 파일 경로가 원격에 없을 수 있는 경우 명시한다: `.runtime/` 원문/후보/원시 로그는 local ignored이며 remote tree에는 포함되지 않는다.

## 12. 최신 Rust 변경 커밋 목록

- `95356ff5ee3759077e6ad61a40884a6dbc185d5b` — Reject incomplete managed Windows Codex bundles
- `6dd9e2f4a017aa9b23f64897825ab61706299c2d` — Document automatic Codex discovery without a version pin
- `50a027209b38d1e0f9e1db0bfb64057f2281369f` — fix: fall back from incomplete Codex installations
- `14d14858adf6120029008847d332dedc9ef39f30` — test: isolate Windows PowerShell fixture module paths
- `b8fe59af9bdaf844c81c97fa5f1379a2aa27352f` — fix: use system timestamps for process identity observation
- `1a58a6d3306804e1eef0a2a906ff8652e26c9f35` — fix: scope final head revalidation to its channel
- `be9d27c56ff3bf72c90b294c19a85d6c59016923` — test: use native shell process fixtures on Unix
- `786e18994477f681dae1c48a31121c9f410c48ae` — Merge PR 2 Codex discovery fallback onto stabilization fixes
- `e8386e6d5e5da1564f95ea028e91c080294f67da` — fix: terminate owned Unix process groups on cancellation
- `0b777fee097f6743b511bd654242ff16ea0f621b` — Merge verified Windows regression fix for Unix terminal cancellation
- `4202649c28a2879a808d1a77d2fba3ba0e6538f9` — test: wait for owned child executable metadata
- `e6f393ecd7ca42cdb9d602106554708dd37ea1e0` — build: optimize SQLite store in development profiles
- `33df95ea3ee687da7a043f41b26fd23262b42f35` — fix: preserve native launch identity after fast exits
- `d7f3f9018251ebddbe2b64c23f3de3d78c76f640` — Merge final stabilization repairs into PR 2 candidate
- `b5014006935bef6ae368f931f5561758db1e5f18` — test: use the physical Unix caller path in profile expectations
- `7979931deb2641fc6b3bf369ce30a69e5cd199e5` — ci: report all failing macOS test targets
- `735f430de4dbb868836f4dcad8d635708e4aca02` — Merge macOS profile fixture and complete failure reporting
- `d2e1749b6e38b5d342afa697136fad9c018a4809` — fix: retire confirmed finals in one guarded transaction
- `e27424f849febf9cc8feec979ec2aec8fd972539` — test: use native path fixtures across platforms
- `4a6e70468aae1689971fbbdd9f069b09e10ed7fc` — test: allow concurrent initial preparation order
- `9703897fe5c82c927df8d70a98e06bc3ed0dc38b` — test: wait for force restart fixture completion
- `cf9f452e776ee7376e5482a8d9929d5913da0dc6` — test: confirm request write before quarantine cancellation
- `055c59155ba5bce68268a712a76f47b230ba884f` — Merge guarded final cleanup and platform contract repairs
- `d774be53a32b223d5792322706813e289569e443` — fix: preserve fallback after concurrent final cleanup
- `7dad06fa03c97db7bdc0a537c0e3825f6ab1a1e2` — Merge concurrent final cleanup fallback
- `57ad8c01ae4895a81858c728d8ab2511792c1d9e` — fix: align Windows-only symbols with platform compilation
- `6c9b06b9b898918f7e3a28ad43203bbb789a06df` — Merge macOS strict lint repairs
- `71ba12fdcccddbe15eba4d10ae59f8350cf51fdd` — ci: use built debug runtime for macOS setup dry-run
- `ed47c482420631447f0a38ef55a8d29acc1f6f6a` — Merge macOS setup dry-run binary correction

## 13. 최신 Rust 변경 파일 목록

- `.github/workflows/macos-smoke.yml` (modified)
- `Cargo.toml` (modified)
- `README.md` (modified)
- `crates/cdr-pro/tests/connector_evidence_contract.rs` (modified)
- `crates/cdr-pro/tests/evidence_contract.rs` (modified)
- `crates/cdr-remote-agent/src/commands/process/portable.rs` (modified)
- `crates/cdr-remote-agent/src/files/platform.rs` (modified)
- `crates/cdr-remote-agent/src/terminal.rs` (modified)
- `crates/cdr-remote-agent/tests/process_contract.rs` (modified)
- `crates/cdr-runtime/src/action_executor/repair_custody_tests.rs` (modified)
- `crates/cdr-runtime/src/action_executor/service_actions.rs` (modified)
- `crates/cdr-runtime/src/completion_worker/delivery.rs` (modified)
- `crates/cdr-runtime/src/runtime_instance.rs` (modified)
- `crates/cdr-runtime/src/runtime_paths.rs` (modified)
- `crates/cdr-runtime/src/runtime_paths/helpers.rs` (modified)
- `crates/cdr-runtime/tests/action_selected_enqueue_race_contract.rs` (modified)
- `crates/cdr-runtime/tests/dead_generation_recovery_contract.rs` (modified)
- `crates/cdr-runtime/tests/discovery_environment_contract.rs` (modified)
- `crates/cdr-runtime/tests/fixtures/native_process_kernel_trace.cs` (modified)
- `crates/cdr-runtime/tests/install_profile_contract.rs` (modified)
- `crates/cdr-runtime/tests/native_process_observation_contract.rs` (modified)
- `crates/cdr-runtime/tests/native_process_observation_contract/cross_context_bootstrap.rs` (modified)
- `crates/cdr-runtime/tests/recover_controller_lifecycle_contract.rs` (modified)
- `crates/cdr-runtime/tests/recovery_install_contract.rs` (modified)
- `crates/cdr-runtime/tests/recovery_launcher_contract.rs` (modified)
- `crates/cdr-runtime/tests/resource_report_contract.rs` (modified)
- `crates/cdr-runtime/tests/resources_action_contract.rs` (modified)
- `crates/cdr-runtime/tests/runtime_paths_contract.rs` (modified)
- `crates/cdr-runtime/tests/support/mirror_readonly_projects.rs` (modified)
- `crates/cdr-runtime/tests/support/windows_memory_ab.rs` (modified)
- `crates/cdr-runtime/tests/windows_codex_bundle_contract.rs` (added)
- `crates/cdr-store/src/completion_work.rs` (modified)
- `crates/cdr-store/src/completion_work/current_tests.rs` (added)
- `crates/cdr-store/src/delivery.rs` (modified)
- `crates/cdr-store/src/delivery/confirmed.rs` (added)
- `crates/cdr-store/src/delivery/preflight.rs` (modified)
- `crates/cdr-store/src/delivery/preflight/tests.rs` (modified)
- `crates/cdr-store/src/delivery_receipt.rs` (modified)
- `crates/cdr-store/src/schema/checked_read.rs` (modified)
- `plugins/codex-discord-remote/.codex-plugin/plugin.json` (modified)
- `scripts/CdrNativeProcess.psm1` (modified)

## 14. 현재 재구현 checkpoint 목록

각 checkpoint JSON의 상세 범위·소스 hash·실패/수정 기록을 확인한다. 전체 PASS 수는 각 시점의 단일 실행 결과이며 합산하지 않는다.

| Checkpoint | 범위 | Full PASS | JSON SHA256 |
|---|---|---|---|
| 277 | reimplementation-not-recovered-original | 5095/5095 | `a5fadd95afbad2b6f399420a279f67c0de4d6f68f9376c51457be9189cc2e91c` |
| 278 | source-backed-reimplementation | 5101/5101 | `6e26fb938b286cfd8135316c7c56ae1514196253ea8f45703093fab9e73ecd42` |
| 279 | borrowed-read-reimplementation | 5112/5112 | `2906d890832deac4fc232f527b5a67212c9a741313c1837a6cfeab3e6485ca84` |
| 280 | borrowed-private-snapshot-reimplementation | 5123/5123 | `747ad60f3a87ddc0771b3ca23232d3f71cac6056a7b09de9c3a3802d4d361c4b` |
| 281 | abandonment-proposal-persistence-and-verification | 5141/5141 | `a0c423deb33e624ae00dff54feb6e9c84687dc89635846c18db96b268a45f6a7` |
| 282 | atomic-abandonment-decision-store | 5155/5155 | `546b20de6e343068b70b36c7a525b61b7730bb0e7c58a001e00c5b9ba652c254` |
| 283 | read-only-abandonment-routing-and-central-state-api | 5166/5166 | `9470edcf07cc656addeeea37f6809e68d2ae96f3f5f1bab3f5f57414b9a3822f` |
| 284 | dedicated-no-replay-abandonment-component | 5177/5177 | `f1e926961ea6e4be0805deb9d25973a42abfcc53f004e46f7c18f083f96b1abf` |
| 285 | authenticated-pre-ack-recovery-custody | 5188/5188 | `1f7f41adb90f005523b894bc479652e95e19c833831fb7481a2326d03a211d00` |
| 286 | dedicated-recovery-component-worker-integration | 5192/5192 | `222aec3880b7b01d1b83b4fd828897cf28eea7d7b5f905da25a6baa45159d178` |
| 287 | pure-legacy-prefix-command-grammar | 5207/5207 | `6095c3c934d724c4b4482d10474ca3e7674998879dd29bdea4aae2a60cab8d18` |
| 288 | pure-authenticated-message-policy-and-command-plan | 5218/5218 | `a5f81c2760f9dcad07ce21b20b13e8571d65f09d07104e79dbd3d97e27634796` |
| 289 | owned-message-custody-lifecycle | 5228/5228 | `dbabacc99b9be376ee2b5ac0f1d82983d74f521d6829c53ee81e1d6541b1c251` |
| 290 | shared-original-thread-settings-and-lifecycle-binding | 5236/5236 | `abec5528f6f887d00f28870546dfaa51e9681ac4f70c0836ba3820e7fa888c0d` |
| 291 | authenticated-message-classification-and-frozen-routing | 5248/5248 | `4bce695445da4426cbb31ae3e33db881cdf929c0847d06406bc336621615d180` |
| 292 | durable-message-admission-and-single-owner-transfer | 5263/5263 | `87e0a7847ff27cd0b97014bce62b1458c118362bec6397ef346066bd8ae45c73` |
| 293 | historical-message-dedup-without-execution | 5270/5270 | `bc24ee8d8fee075b53ff5932c257acfad2890b958a878eabcae24121c872c583` |
| 294 | durable-source-message-reply-delivery | 5277/5277 | `0fd975fd8944fa2cf85ab26ba086430251ded1b8e8622ad890748ed25b024741` |
| 295 | authenticated-saved-request-abandonment-proposal-producer | 5285/5285 | `8c4ab25d1db8eadc302986434affe87fb6e593a96f49639670bde63373d93dca` |
| 296 | central-message-error-and-known-cleanup-outcome-boundary | 5295/5295 | `15672a1b3b5ae61879a878958ea9c34df6c2dd62532e80371f6fc2c1e4ceb410` |
| 297 | pure-attachment-filename-text-and-prompt-rendering | 5301/5301 | `0bc56284dd691fbc62bdb08732728943bbf2e13de0a787993a9cc7c9a56a358d` |
| 298 | streaming-attachment-filesystem-download-leaf | 5311/5311 | `06114dde0d2f82b1fe1bbbe8a73a1096b89d95888b027fef035812f5d4948899` |
| 299 | owned-http-attachment-client-and-sequential-message-enrichment | 5320/5320 | `ab3c72ac93d041b42fcc789c909b8986bf3de7125a317bb55d63815d930c1001` |
| 300 | durable-admitted-message-processor-composition | 5335/5335 | `64b557f9ae7bd2f8e6591bc10d808e7bdb503ef3d15a30f530ffdf38a7fbb7a0` |
| 301 | owned-gateway-message-preparation-and-dispatch | 5344/5344 | `2e2a019f3ee2bb9982dc1f649159f5460e245e272dd2a5b17a9930084a6552ef` |
| 302 | per-request-attachment-cancellation-with-joined-ownership | 5349/5349 | `e1f88dbd6f011faea86ea453de4bef4bafe5b0a60a392d89329457e007c1f572` |
| 303 | joined-message-processing-and-receipt-cancellation | 5353/5353 | `def98abb4abfb01a54692d954bb53f73f3444f999afc0b3a66df437a72dcb4c2` |
| 304 | composed-gateway-message-handler | 5362/5362 | `2c1544bdda3e20dbb464311dded60bea4ff828ba4287d72e5a2a1e1d02879cd4` |
| 305 | original-action-thread-selection | 5369/5369 | `2f1f5abc2a0fa5af23840ff0524361988b22f7ab4809aae61216fb73ed5b2d5d` |
| 306 | joined-external-prompt-intake-cancellation | 5375/5375 | `bfebdeabae9c177627c08134cd7b708e34837cbab204508ab923c74ed11034d0` |
| 307 | busy-choice-result-producer | 5382/5382 | `31006210200856328240ad26b9cd6b446060c002a350e2ec0014e1d6fa278c0b` |
| 308 | queue-prompt-action-composition | 5387/5387 | `41609014b7b5736a7ba37e19f1ee716b46c20c9cbee4a52ab4392a84d80bd72d` |
| 309 | new-thread-original-admission-journal | 5394/5394 | `5d40bff05178d364ba8dfb3f5882f7052b14545749d227efc77044ca66911a09` |
| 310 | new-thread-frozen-project-context | 5401/5401 | `ad363fe5d36accd407599ef9e308b6672e758fbbdad032cc72714ed575bb0b88` |
| 311 | owned-new-thread-attempt-cleanup | 5407/5407 | `ff4a88b0ae491d490723c49ce5664bde2de622ce5a6c76cde56e0969b00a9f39` |
| 312 | new-first-prompt-and-reply-composition | 5412/5412 | `abba56b9426bc5d92b05cac9d2f2cda3affac41aca50cafb7e4ec88e784afe1f` |
| 313 | new-thread-native-creation-first-intake-composition | 5418/5418 | `ecd607a4ad13b90d8d4ce00f3bd640f0760fa249e5604ecaca58af459437d268` |
| 314 | mirror-thread-creation-custody | 5430/5430 | `a91cf3ee33cbdca557042198934946f00bd22fc2967d05a6cdeaa7cb2cba0853` |
| 315 | new-mirror-mapping-atomic-commit | 5439/5439 | `d70de82f7038b5716bdbb8e54783e2a31551036ac25f97681d0b7d00ee7a9186` |
| 316 | new-mirror-link-custody-composition | 5449/5449 | `b95cd38e3bd4ba71999511b6d535be3e66da220cefd424d863866f764f049216` |
| 317 | owned-new-mirror-http-adapter | 5458/5458 | `497c9510a9f4fd966d2a26ad179370dea65bcb64b85e867b73c4ff5e3a7080a0` |
| 318 | new-native-mirror-first-reply-end-to-end-tests | 5461/5461 | `9e092ee08dbc654d77218bd7e605ecdbfeca66d2f88dfd7f6b5fdbd364bac903` |
| 319 | original-prompt-approval-and-steer-actions | 5469/5469 | `883dcb14094badcac907857bf8c326c2ae44316e6cc6b7a1189bbf835186376f` |
| 320 | explicit-open-thread-action | 5476/5476 | `59604af125a63f65f8832481af36e15d4fa54c962e070d7192259b21a46c7820` |
| 321 | bounded-thread-state-probe | 5484/5484 | `4bd84aa04f8340980977f42929ed0350e3283ab24caf856bf458dbc5fd6235b1` |
| 322 | lossless-context-usage | 5494/5494 | `0803ef55edc44da50b2383a76c03f65e6fb5eca539a63176ac5adcd73eebf9f3` |
| 323 | bounded-visible-context-text | 5504/5504 | `c982bc4e88973e8fbc394668f83ac2fcbfd69b04b41ce86edc2a96f7162f8568` |
| 324 | bounded-context-file-read | 5516/5516 | `a95ea644760da95bb9afa578112f3392edf0189ca74ba3f52e5c4ac2ca6edf99` |
| 325 | owned-native-context-worker | 5530/5530 | `e3837901806b91129f5359aa744e3e9de3786acf73d04df683eed47ec5a3c935` |
| 326 | historical-context-report | 5540/5540 | `c4540fe043e18ae4d0bdbf9150c1ef24e6ee5e4e6dbfc5227c72f7c442926d41` |
| 327 | original-target-context-action | 5550/5550 | `73dc274943d75b84fb04eb42a4ba43da2e418ac7d4caf152490ccc2428fc0b58` |
| 328 | complete-inventory-thread-list | 5558/5558 | `c9f9f20b3284140289b6c84b9ef02019c11cbfe9f6138c55baa2b09a4dca3e40` |
| 329 | original-thread status action and joined goal/context reads | 5564/5564 | `ebbf6916eb1b8ba1dbd8dbff75dc7c356cf1613ec089d2145020a685b186b2e0` |
| 330 | central state-facade runners report | 5568/5568 | `3c0c827f32035dc0673340d948634373506f1fdcdde02322dadd10c6dbe24038` |
| 331 | model catalog and explicit Reserve observation policy | 5577/5577 | `678aaeb7dd821e754514e5c02ae833cdcda579b70fc58c64c1de2ce1fa50db8e` |
| 332 | live usage observations and lossless account report | 5590/5590 | `294344eb73f4ddcebb879ed243a5c5f579912ba06a0e5f822e0f231ed43312a2` |
| 333 | complete settings observation parsing and exact matching | 5596/5596 | `1daad0119ddc5c2bf4067289f8f044d9223b0f66894b7c2004fd6253572e6706` |
| 334 | native settings writer watermark and original-generation observation | 5602/5602 | `0ad5664dbf45709cbf1723ed177407d0388a869d1268f83be785d34fffef1fb8` |
| 335 | post-write settings confirmation without blind retry | 5608/5608 | `554f727e83fbb8188b18ba44caa6ea8e10909de0a53500eef7825579374119e6` |
| 336 | original-thread settings command with shared lease and verified persistence | 5620/5620 | `908bbc1c052294dd7fcf98098ab090c30ec45d2d5f47d70bdacb5313a75a9e63` |
| 337 | stored original settings admission and stop-origin wrapper | 5627/5627 | `243eeee84548c1f2ca769bbd02dfd956a5efb567c3fb0744a8ce8607e1180605` |
| 338 | bounded model and target-specific effort options | 5635/5635 | `8719884559406a19b5652f60b98cea2ed7c0926522154b6d335789f5a40ffd90` |
| 339 | original-actor saved requests and centralized target counters | 5644/5644 | `cebc66ee384b9b9f736dab630da46383a55198521cba57ce18e752c15b400b91` |
| 340 | Original actor and target pending-request retraction | 5649/5649 | `42eaa0db9f717b5a0ee76f93a177ff06897e5d83b01cf66d08fff3527297d9f7` |
| 341 | Bounded read-only diagnostic workers and centralized store reads | 5656/5656 | `315e82bae289585c231bb8d5eb8d88dcdaf6cad43c0a66e3a8ba864643f9fc84` |
| 342 | Latest Rust channel-scoped final metadata revalidation | 5662/5662 | `f6af6e84fdd6b67f65076077e01b01e12e10b454e253b976e6ee16f1b17f971e` |

## 15. 원본 Pro-reviewed 명세 전문 (변경 없이 삽입)

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

<!-- END_IMMUTABLE_R1 -->

----- END IMMUTABLE R5 -----
