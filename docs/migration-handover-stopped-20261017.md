# TypeScript 마이그레이션 작업 기록 및 중단 인계

- 기준 시각: **2026-10-17 21:24 UTC**, 사용자의 작업 중단 요청 시점
- 저장소: `simdorei/codex-discord-bridge-ts`
- 작업 브랜치: `sss/async-admission-cloud`
- 문서 목적: 이미 커밋된 작업 이력과 검증된 보관 기록을 정리하고, 확인되지 않은 로컬 변경을 분리하여 남긴다.
- **마이그레이션은 완료되지 않았다. 전체 애플리케이션, 컴포넌트 정리, 운영 루트 또는 전체 마이그레이션 PASS를 선언하지 않는다.**

이 인계 문서는 문서만 추가하는 별도 변경이다. 중단된 후속 구현을 재개하거나 검증하지 않았으며, 아래에 나열한 로컬 미공개 변경을 포함하지 않는다. 테스트 실행, 설치, 배포, 병합 또는 강제 푸시는 수행하지 않는다.

## 1. 마지막으로 검증된 구현 보관 지점

문서 추가 전 마지막 원격 보관 지점은 [체크포인트 974](https://github.com/simdorei/codex-discord-bridge-ts/commit/9841e2d9c93b3650e1fcbaba087aa8e78f47339d)이다.

- 원격 커밋: `9841e2d9c93b3650e1fcbaba087aa8e78f47339d`
- 당시 로컬 커밋: `4b61a182ee1dbf2feadf21fe62bd6f2c3a77b892`
- 동일하게 검증된 트리: `616ac0b0ecbdde688d71f558fcaef82e90df4618`
- 원격 부모: `89c58773273b5b65a5a39b1f371c78b2ea17b103`
- 공개 대상 8개 파일의 실제 원격 내용, blob, 변경 범위, 부모 및 트리를 재확인했다.

로컬과 원격은 보관 과정의 커밋 이력이 달라 커밋 SHA가 다르다. 위 시점의 파일 트리는 같으며, 이력을 강제로 일치시키지 않았다. 이후 인계 문서 커밋은 이 원격 커밋 위에 문서 한 개만 추가한다.

## 2. 기존 기록의 주요 진행 과정

아래는 커밋된 기록에서 확인한 주요 작업이다. 개별 테스트 수를 합쳐 전체 커버리지처럼 해석하지 않는다. 같은 테스트의 작성자 실행과 독립 실행은 서로 다른 기능 수가 아니다. 과거 결과는 해당 소스 바이트에만 적용된다.

### 963–968: 기존 소유권과 진단 경계 정리

- **963:** 공유 컴포넌트 회귀 선택은 각 실행에서 40개 중 39개 통과, 필수 정리 검증 1개 실패였다. 315개 선택/312개 운영 소스의 컴파일 일치가 기록되었지만, 보존된 프로토콜 실패 루트의 정리 의무는 해소되지 않았다.
- **964:** 시작 단계의 보류된 세션 오류 소유권을 유지하는 변경. 수동 콜백 기반 8/8 확인과 59/58 컴파일 범위에 한정되었다. 실제 네이티브 정리 실패와 루트 보존의 통합 검증, 전체 애플리케이션 의미 검사는 미실행이었다.
- **965:** 원래 응답 캡처 순서에 관한 테스트·문서 변경. 운영 소스는 변경하지 않았다. 실제 임시 SQLite·resident·네이티브 자식 경로의 4/4 반복 검증과 316/313 컴파일 일치가 기록되었다. 격리 개선이나 전체 운영 루트 통과를 뜻하지 않는다.
- **966:** 비활성 자동 응답 소유권 경계의 설계 문서. 구현·컴파일·실행·설치 활성화 결과는 없었다.
- **967:** 비활성 prompt-read 성공 값 codec의 10/10 수동 테스트와 7/6 컴파일 일치. endpoint, 오류 전달, 네이티브/SQLite 작업 또는 런타임 활성화 검증은 아니었다.
- **968:** 기존 세 가지 네이티브 prompt-read의 저장소 오류 분류와 실제 join 이후 진단 전달. 두 실행 각각 24/24, 엄격 컴파일 336/328 및 선언 178개, 운영 출력 일치가 기록되었다. 당시 baseline JSON 오류의 Integrity 분류는 그대로였으며, 다음 단계에서 수정했다. [원격 기록](https://github.com/simdorei/codex-discord-bridge-ts/commit/856ab38c86699d29cc7242b780ca787b53498034)

### 969–971: 취소 전달, JSON 분류, 자동 form 통합

| 체크포인트 | 작업 및 확인 범위 | 결과와 한계 |
| --- | --- | --- |
| [969](https://github.com/simdorei/codex-discord-bridge-ts/commit/eb2a967bde9c7da53c58c3eca7fa39ef1e6b6951) | 두 캡처된 transport adapter가 원래 수신자와 선택적 AbortSignal을 유지하도록 전달 | 저장된 최종 작성자·독립 실행 각각 33/33. 엄격 668/656 및 선언 178개, 운영 출력 656개 일치. 복구 과정에서 재실행하지 않았다. HTTP 포함 3개 suite는 컴파일만 했고 시작 HTTP adapter는 정적 검토·컴파일에 한정되었다. |
| [970](https://github.com/simdorei/codex-discord-bridge-ts/commit/c758d650aa99b1ff32f5b95283380f6116cef3d4) | 기존 queue baseline 파싱 실패를 Json으로 구분하고 원래 native 진단 경로로 전달. 정상 디코딩, Integrity 오류, 트랜잭션 rollback과 원래 요청 복구 유지 | 새 작성자·독립 실행 각각 137/137, 명시된 9개 suite. 엄격 354/341 및 선언 178개, 운영 출력 341개 일치. 실제 resident·SQLite·native owner를 사용했으나 transport는 수동 fixture였다. |
| [971](https://github.com/simdorei/codex-discord-bridge-ts/commit/f9033b4251e91d62c112067e96491f7c41ff88cf) | 원래 serial receiver/recovery loop, 자동 computer/browser form 응답, native 응답 완료, 비-form 전달의 종료 join을 통합 확인. 운영 소스 변경 없음 | 최종 두 실행 각각 6/6. 엄격 341/338 및 선언 178개, 출력 338개 일치. 최초 4/5 실패는 테스트 기대값 오류로 기록하고 보존했다. 실제 연결된 컴퓨터·브라우저·HTTP 또는 운영 설치 검증은 아니다. |

관련 상세 문서:

- [969 취소 전달](server-request-cancellation-20261017.md)
- [970 저장된 JSON 분류](stored-queue-json-classification-20261017.md)
- [971 자동 form 통합](native-form-integration-20261017.md)

### 972: 미검증 구현 후보의 시간 단위 보관

[972](https://github.com/simdorei/codex-discord-bridge-ts/commit/cce58af84746dfba617e1fa33e603d06686b16cc)는 disposable persistent receiver workflow 후보 16개 공개 파일을 보관했다. 원래 receiver/serial loop, 세 가지 native prompt read와 전체 native receipt sender의 연결을 다룬 소스·테스트 및 설계 문서였다.

이 체크포인트 자체는 **컴파일·실행하지 않은 WIP**였다. 보관 당시 최종 검토 대기 문구를 그대로 유지했으며, 이전 테스트 결과를 새 바이트의 검증 결과로 승계하지 않았다. 뒤의 973은 별도 수정·동결본에 대한 부분 검증이다.

- [972 당시 범위](persistent-receiver-workflow-wip-20261017.md)
- [설계 계약](persistent-receiver-workflow-contract-20261017.md)

### 973: 전체 통과가 아닌 부분 workflow 검증

[973](https://github.com/simdorei/codex-discord-bridge-ts/commit/89c58773273b5b65a5a39b1f371c78b2ea17b103)의 두 최종 실행은 각각 **102개 중 100개 통과, 필수 정리 검증 2개 실패**였다. 실행 종료 코드는 모두 1이다.

실패한 필수 검증:

1. `mandatory protocol-negative cleanup and component qualification`
2. `mandatory receiver-negative cleanup and component qualification`

엄격 컴파일은 선택 소스 690개/운영 소스 673개와 선언 178개였고, 운영 출력 673개가 일치했다. 각 최종 실행은 강제 신호 없이 소유 프로세스가 종료되고 ECHILD 및 출력 EOF를 확인했다. 그러나 이는 애플리케이션 정리 완료가 아니다.

각 최종 실행은 protocol-negative 루트 3개와 receiver-negative 루트 2개를 남겼다. 정상 fixture 루트는 남지 않았고 감사 과정에서 루트를 삭제하지 않았다. 이전 12개 컴파일 진단 실패와 102/98/4 실행 실패도 보존했다. 이전 실패 실행의 루트 6개도 그대로 남았다.

입력 chunk 수 및 native read 수에 관한 잘못된 fixture 기대값만 수정했다. 원래 취소·sender·해제 조건을 느슨하게 바꾸어 통과시키지 않았다. ACK 손실은 원래 delivery의 직접 호출에서 확인한 범위이며, 전체 loop의 ACK 손실 검증은 별개로 남았다.

- [973 상세 결과](persistent-receiver-workflow-validation-20261017.md)
- [973 공개 증거 manifest](persistent-receiver-workflow-validation-20261017-manifest.json)

### 974: 수정 완료가 아닌 pre-admission 진단 기록

[974](https://github.com/simdorei/codex-discord-bridge-ts/commit/9841e2d9c93b3650e1fcbaba087aa8e78f47339d)는 두 진단 시도를 구분하여 보관했다. **이 지점에서 실제 프로토콜 수정은 구현되지 않았다.**

- 첫 시도는 20초 invariant 관찰 한도를 넘겼고 최종 반례 witness가 없었다. 300초 감독 한도에서 새로 소유한 프로세스 두 개에 SIGTERM이 전송되었다. 이후 소유 프로세스 종료·ECHILD·EOF는 확인했지만, 이는 강제 containment이며 자연스러운 정리 완료가 아니다. 실패 루트와 증거를 보존했다.
- 두 번째 시도는 명시된 probe 전용 teardown과 endpoint rescue를 사용했다. **테스트 2개 중 invariant 1개 통과, 필수 논리 정리 1개 실패**, 종료 코드 1이었다. rescue 이후 물리적 프로세스 종료는 확인했지만 client의 논리 join과 루트 해제 의무는 해결되지 않았다. probe 루트 1개를 남겼고 삭제하지 않았다.
- 최종 진단의 엄격 컴파일은 343/341 및 선언 178개, 운영 출력 341개 일치였다. source 및 graph/실행 인자 검토는 있었지만 독립 런타임 반복 실행은 없었다.
- 과거의 positive suite는 이 후보에서 다시 실행하지 않았다. 973의 102/100/2 결과를 974 바이트의 결과로 해석하지 않는다.

- [974 진단 범위와 제한](persistent-receiver-pre-admission-probe-20261017.md)
- [974 공개 증거 manifest](persistent-receiver-pre-admission-probe-20261017-manifest.json)

## 3. 마지막까지 남은 검증·완료 조건

다음 항목은 완료 또는 PASS로 기록하지 않는다.

- 정상 경로만이 아니라 오류·취소·채널 손실에서도 원래 소유 작업의 실제 join과 정리 의무가 끝나는지에 대한 전체 검증
- before-admission 손실, malformed/control-channel 손실, 전체 loop의 ACK 손실 등 아직 별도 검증이 필요한 경계
- 진단용 rescue 없이 성립하는 최종 수정 및 회귀 검증
- 실제 운영 singleton/root 획득, 물리 저장소·외부 writer 배제. 앞서 기록된 Unix-socket EPERM 이후 진짜 운영 루트 검증은 미완료
- persistent resident의 실제 설치·cutover, 실제 Discord HTTP 및 연결된 Computer Use/browser/provider 실행
- 전체 local-application/guard 의미 컴파일, Windows, 성능·장시간 실행·배포 및 전체 Rust 동작 등가성

기록된 Rust 기준은 `simdorei/codex-discord-remote-rust`의 `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34`이다. 부분 소스 비교나 TypeScript fixture 결과가 전체 Rust 실행 비교를 대신하지 않는다. 과거 v4 프로세스 상태는 UNKNOWN으로 유지하며, 현재 프로세스 목록에서 보이지 않는다는 이유로 종료를 추정하지 않는다.

## 4. 공개하지 않은 로컬 변경 6개

문서 작성 전 Git 상태의 **파일명 메타데이터만** 확인했다. 아래 파일은 마지막 보관 지점 이후 로컬에서 수정되어 있었으며, 검증·커밋·원격 공개가 완료되지 않았다.

1. `src/runtime/persistent-receiver-client.ts`
2. `src/runtime/persistent-receiver-protocol.ts`
3. `src/runtime/persistent-resident-bootstrap.ts`
4. `src/runtime/persistent-resident-composition.ts`
5. `src/runtime/persistent-resident-worker.ts`
6. `test/runtime/persistent-receiver-protocol.test.ts`

이 문서 작업에서는 이 6개 파일의 내용을 읽거나 수정·해시 검증·스테이징·커밋·업로드하지 않았다. 원본 로컬 변경은 그대로 남긴다. 파일 목록은 구현 내용이나 정확성에 대한 확인이 아니다. 현재 로컬 작업본 전체를 체크포인트 974와 동일한 검증 상태라고 볼 수 없다.

## 5. 중단 상태와 인계 범위

사용자는 **2026-10-17 21:24 UTC**에 진행한 범위까지만 남기고 작업을 멈추도록 요청했다. 마지막 후속 요청에 따라 이 Markdown 작업 기록만 기존 브랜치에 추가하고 원격 결과를 확인한 뒤 종료한다.

이 문서에 데이터베이스, 원시 실행 로그, 자격 증명, 비공개 작업 디렉터리 또는 중단된 후속 구현의 상세 내용은 포함하지 않는다. 보존된 실패 증거를 삭제하거나 미완료 상태를 성공으로 바꾸지 않는다. 추가 구현·테스트·보관·설치·배포는 이 인계 작업에 포함되지 않는다.
