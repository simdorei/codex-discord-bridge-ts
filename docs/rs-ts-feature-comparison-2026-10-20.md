# Rust / TS 비교 보고서 후속 통합

기준일: 2026-10-20. 통합 패키지: `0.1.0-alpha.7`, 트레이 보정: `0.1.0-alpha.8`.

기존 비교 기준은 TS `83301de`, Rust `8f35020`이다. 그 TS 메인에는 GUNG
alpha6에서 사용하던 변경이 모두 포함되어 있지 않았다. 기능 이름이나 이전
메인 병합만으로 전체 이식 또는 실행본 동등성을 판단해서는 안 된다.

이 후속 작업은 기존 보고서의 일곱 항목을 모두 수정 범위에 포함한다.
트레이·MCP 서버·Pro·검토 문맥 보존을 선택 기능이라는 이유로 제외하지 않는다.

## 항목별 구현

| 항목 | 반영 내용 | 검증 경로 |
|---|---|---|
| Worker 재사용 | GUNG alpha6의 재사용 실행기와 작업 등록을 소스·npm 빌드에 통합했다. DB Control과 Bridge 파일 작업을 분리하고, 등록된 작업만 제한된 worker를 재사용한다. 물리 worker 상한 9개, 대상별 순서, 취소 후 실제 종료 확인, 불확실한 작업의 자동 재실행 금지를 유지한다. | `owned-worker-reuse`, `prompt-roundtrip-reuse`, `windows-application` |
| Busy 거절과 재시작 | TS의 `completed` 및 `held/result_recorded` 미실행 거절 제외를 보존한다. Rust에서도 부모 요청 선택과 큐 소유권 연결 두 경로에 같은 조건을 적용한다. `control_dispatched`가 JSON boolean `false`인 확정 거절만 제외하며, 새 큐의 확인 장벽과 불확실한 요청은 유지한다. | TS `prompt-intake-busy`; Rust `busy_control_retry_contract` 및 큐 계약 |
| Discord 전송 영수증 | 자기 봇의 Gateway echo를 nonce·채널·본문 및 컴포넌트 해시와 대조하여 기존 전송 의도의 영수증을 회수한다. 중복 echo·위조·모호한 후보는 성공을 만들지 않고 HTTP 전송을 다시 실행하지 않는다. 여러 청크의 legacy 확인은 모든 청크가 일치할 때만 해제한다. | `receipt-echo` |
| Windows 트레이와 워치독 | 트레이 진입점과 상태·로그·정상 재시작·명시적 강제 재시작 메뉴를 패키지에 포함했다. 트레이 singleton과 프로세스 종료 소유권을 유지한다. 최신 메인의 숨김 PowerShell 예약 실행기도 함께 보존하여 alpha6 통합 시 창 숨김이 회귀하지 않게 했다. | `windows-admin`, `windows-supervisor`, 설치 자산 검사 |
| 자체 MCP 서버 | `cdr-mcp-server` 실행기, OAuth 저장소·워커, HTTP MCP, protocol-10 WebSocket broker 및 51개 도구를 패키지에 포함했다. 도구 정의는 Rust 기준과 구조적으로 동일하다. PC 에이전트와 서버는 별도 역할이며 서버 추가가 기존 VPS의 자동 교체를 뜻하지 않는다. | `mcp-server/gateway`, `oauth-worker-deadline`, `broker`, 설치 CLI 검사 |
| Pro 커넥터 | 현재 Work composer, 모델 선택 및 컨텍스트 UI 대응 스크립트와 Node Pro helper·증거 hook을 패키지에 포함했다. 커넥터 스크립트는 Rust `8f35020`의 파일과 LF 정규화 후 동일하다. | `pro/connector-current`, `connector-script`, `helper`, `release-tools` |
| 민감정보 가림과 검토 문맥 | 자격정보 가림을 먼저 적용하면서 제한된 `.py` 코드 식별자·`.json` 파일 검토 메타데이터를 보존한다. 민감한 상위 키, 중복 JSON 키, 일반 로그·diff에는 문맥 예외가 확대되지 않는다. | `windows-review-gaps`, 원격 파일 검사 |

## 재현 가능한 검사

```powershell
npm run test:parity
node tools/run-tests.mjs --profile windows-features
node tools/run-tests.mjs --profile windows-workers
node tools/test-installed-package.mjs .\codex-discord-bridge-ts-0.1.0-alpha.8.tgz
```

`test:parity`는 이 보고서의 항목들을 한 번에 검사하는 회귀 진입점이다.
새로운 worker 작업을 등록하거나 패키지 자산·Pro·MCP·가림 처리를 바꿀 때
관련 단위 검사와 설치된 패키지 검사를 함께 유지한다.

## 이번 검증 기록

- Windows x64 / Node 24.21.0에서 프로덕션 빌드와 전체 테스트 소스 컴파일 통과.
- Windows 기능·worker 및 인접 회귀 86개 파일: 705개 중 704개 통과,
  POSIX 전용 1개 제외, 실패 0개.
- 현재 Pro composer 계약 30개 통과.
- Pro 스크립트의 Rust/TS SHA-256 일치:
  `a9aa97457ff73e93117d18efa3fa48dd924f00f54935af5c78359cbd5779ccf8`.
- MCP 도구 정의 51개 전부 Rust 기준과 일치.
- Rust의 새로운 재시작/거절 연결 재현 2개는 수정 전 실패, 수정 후 통과.
  잘못된 boolean 형식과 불확실한 실행 결과를 포함한 Busy·큐 검사 총 18개
  및 `clippy -D warnings` 통과.
- 별도 npm prefix에 설치한 alpha7의 통합 검사 99개 전부 통과.
  설치된 dist, CLI, PowerShell 자산, 자체 MCP 서버, Pro helper와 세 스레드
  응답·중지·재개 경로를 검사했다.
- Rust runtime의 Busy 재접수·lifecycle·재시작 복구 통합 검사 4개 통과.

검증 중 전체 수정 파일을 무조건 선택한 임시 실행기는 Windows 명령줄
길이 한도에 걸렸다. 이후 추가로 선택된 기존 POSIX lifetime fixture에서는
Windows에서 사용할 수 없는 `PosixDrainMarkerStore` 및 플랫폼 의존 조건이
실패했다. 해당 실패·중단 기록은 보존하고, 저장소의 Windows 프로필로 검증한
결과와 구분했다. 이를 전체 저장소 테스트 성공으로 집계하지 않는다.

## 성능과 실서비스 확인 범위

GUNG에서 alpha7 전환 후 실제 트레이 실행을 확인하는 과정에서, PowerShell의
기본 `Restricted` 정책 때문에 패키지 트레이 스크립트가 실행되지 않는 경우를
재현했다. alpha8은 해당 자식 PowerShell 프로세스에만 실행 정책을 지정한다.
사용자·컴퓨터의 실행 정책은 변경하지 않는다. 실제 프로세스로 제한 정책을
상속하는 회귀 검사를 추가했으며, 대화형 트레이 UI는 유한한 검사 스크립트로
대체하여 실행 경로를 검증한다. 수정 전 해당 재현 검사만 실패했고 수정 후
관리·트레이·워치독 검사 20개가 통과했다. 별도 prefix에 설치한 alpha8의
통합 검사도 새 재현 검사를 포함해 100개 전부 통과했다.

TS는 이미 async/Promise 기반이며 이번 수정은 함수에 async를 붙이는 작업이
아니다. 실제 반복 비용을 줄이는 worker 수명과 작업별 잠금 범위를 통합한
것이다. 재사용 대상이 아닌 작업은 기존의 작업별 worker 수명을 유지한다.

가짜 Discord/Codex를 사용하는 세 스레드 반복 응답·중지·재개와 worker 종료
검사는 실제 모델 응답 시간이나 모든 부하에서의 Rust 대비 동일 성능을
보증하지 않는다. 실제 브라우저 UI·OAuth 클라이언트·재부팅의 종단 검증도
모형 기반 계약 검사와 구분한다. 기존 보고서 밖의 기능까지 전부 동등하다는
선언은 하지 않는다.
