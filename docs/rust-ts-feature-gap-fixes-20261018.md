# Rust → TS alpha.3 수정 및 검증 기록

대상: `C:/repos/simdorei/codex-discord-bridge-ts-npm`, 브랜치 `codex/ts-npm-windows-20261018`.
수정 기준 HEAD: `bf5c2f4f4bb0cba0888fd0b46a6be50ca9db45d2`. 작업 트리의 미커밋 수정이다.
검증 환경: Windows x64, Node 24.21.0. npm registry 배포·메인 병합·실제 봇 전환은 수행하지 않았다.

## 판정

독립 미러 대상이 전역 배타 잠금 때문에 서로 기다리던 F07을 수정했다.
대상별 배타 소유권은 유지하면서 매핑 조회 소유권을 공유하고, 매핑 변경만 배타적으로 처리한다.
A의 HTTP 전송을 멈춘 상태에서 B가 실제 SQLite 커서와 전송 영수증을 확정하는 테스트로 검증했다.
원래 리뷰의 13개 항목 모두에 수정 또는 구현을 추가했지만, **F06은 부분 개선**이며 전체 Rust 동등성 선언은 하지 않는다.

원본 [상세 리뷰](rust-ts-feature-gap-review-20261018.md)는 alpha.2 당시의 결함과 증거로 보존했다.
이 문서는 그 리뷰를 대체하는 수정 상태 기록이다. 과거 Discord 실사용 장애의 원인을 이번 테스트만으로 확정하지 않는다.

## 항목별 변경

| 항목 | 변경 및 검증 근거 | 남은 경계 |
| --- | --- | --- |
| F01 Pro helper | Node 실행기, conversation SQLite/lease, 3개 probe, 2개 hook, cachebuster 및 release evidence 명령 추가. 새 플러그인 복사본에서 실행 검증. 로컬 Rust의 최신 composer 스크립트도 반영하고 원래 증거 해시와 DOM 계약을 확인했다. | release evidence의 실제 Codex 설치 목록·새 app-server 검사는 이번에 실행하지 않았다. 개발 명령 2개는 빌드된 소스 저장소를 명시해야 한다. |
| F02 전송 확인 복구 | Gateway nonce 보존, 자기 봇·채널·본문·컴포넌트 해시와 기존 영수증 일치 확인. 모든 답변 조각이 확인된 경우에만 전달 대기 상태 갱신. | HTTP ACK 유실을 로컬 fixture로 검증. 실제 Discord echo는 별도 검증 대상. 요청 재실행·메시지 재전송 권한을 만들지 않는다. |
| F03 Git 경로 정책 | status/diff 양쪽에 파일 경로 정책 적용. 변경된 두 경로를 검사하고 허용 파일만 Git diff에 전달한다. | 경로 수·인자·출력 크기 제한 유지. |
| F04 마스킹 | JSON 자격정보 값, 중복 키·문맥 제한, 파일 전체에서 마스킹한 뒤 줄 자르기, PEM 개행 보존. 코드 식별자·파일 해시 예외는 확인한 파일 문맥으로 제한한다. | 일반 로그/diff의 비밀정보 마스킹은 완화하지 않는다. |
| F05 이미지 | 실제 5 MiB 입력이 프레임·DTO·워커 단계를 통과하도록 예산 정렬. base64 정규식의 스택 초과 제거. 입력 초과는 작업 실패로 확정하고 다음 요청을 계속 처리한다. | 전체 동시 작업·결과/캐시의 별도 유한 예산은 유지한다. |
| F06 로그 재읽기 | 같은 파일 세대의 검증된 SHA 상태를 최대 32개 캐시. 변경 없는 8 MiB 로그의 연속 두 조회에서 총 1,024바이트만 읽는 테스트 통과. 512 MiB 고정 거부 제거, 513 MiB 테스트 통과. | **추가 기록·파일 변경·재시작 시에는 여전히 기존 prefix 전체 검증.** 10초 검증 제한도 유지한다. producer와 연결된 영속 증분 연속성 프로토콜은 미구현이다. |
| F07 동시 미러 | 공유 조회/배타 변경 잠금, 대상별 순서 유지, 대기 중 writer 공정성, 취소·빌린 lease 종료 처리. 실제 4 MiB A backlog와 멈춘 전송 중 B 완료 검증. | 매핑 변경은 진행 중인 독자의 종료를 기다린다. 같은 대상은 순서를 지킨다. |
| F08 Git 조회 | 미추적 텍스트/binary diff 포함, staged-only와 unstaged 구분. 실제 임시 Git 저장소에서 검증. | 미추적 파일 수·파일 크기 한도 유지. |
| F09 서버 | `cdr-mcp-server` 실행기, OAuth SQLite 워커, HTTP MCP, protocol-10 WebSocket broker, 51개 tool 및 범위 검사 추가. OAuth→MCP→PC 브리지와 A 지연/B 완료, DB 쓰기 잠금 중 health 응답 검증. | 실제 HTTPS/WSS 배포·ChatGPT connector·장시간 부하 검증은 미실행. GET SSE 스트림을 제공하지 않는 JSON 응답형 HTTP 전송이다. |
| F10 플러그인 설치 | 명시적 `--admin install-plugin`, 패키지 marketplace 등록→plugin add→실제 inventory 검증. 실패 시 다음 단계로 진행하지 않는 테스트 추가. | 사용자 Codex 프로필에 실제 설치하지 않았다. npm 설치만으로 사용자 설정을 변경하지 않는다. |
| F11 트레이 | 숨김 실행, 상태/로그/재시작/명시적 강제 재시작/트레이 종료 메뉴 및 singleton 추가. | PowerShell 파싱·인자/설치 경로 바인딩 검증. 실제 UI 클릭·화면 검증은 미실행. |
| F12 운영 전환 | 지연/quiet/wait 옵션, 예상 프로세스·runtime 바인딩, cutover journal·백업·Rust 작업 비활성화·종료·커서 검증·TS 시작·관찰·복구 구현. 각 단계 실패와 미확인 종료 시 fence 유지 검증. | 실제 예약 작업 전환·재부팅 미검증. 실행 중 Rust의 자동 복귀에는 원래 활성화된 인식 가능한 watchdog/runtime 예약 작업이 필요하다. 임의 encoded wrapper는 자동 정리하지 않는다. |
| F13 프록시 | 첨부 HTTP/HTTPS Agent가 생성 시점의 프록시 환경을 사용. 실제 로컬 프록시 및 NO_PROXY 우회, 환경 변경 격리, 소켓 종료 검증. | 사용자 외부 프록시 서비스는 사용하지 않았다. |

## 재시작과 전환의 추가 결함 수정

TS supervisor는 drain ACK를 기다리는 내부 루프에서 새 제어 요청을 처리하지 못했다.
이를 폴링 상태 기계로 바꿔, ACK나 quiet 기간을 기다리는 중에도 stop·명시적 force 요청을 처리한다.
실제 fixture 프로세스에서 60초 ACK 대기 중 force가 5초 내에 완료되는 것을 확인했다.
`restart.ps1 -Immediate`는 예약 지연 없는 정상 재시작이며, 강제 취소는 별도의 `-Force`다.
drain 만료가 자동 강제 종료로 바뀌지 않는다.

설치본 검사에서는 별도로 Stop worker의 공용 2초 마감도 확인했다.
조회가 1.5초 걸리고 interrupt가 0.65초 걸리는 정상 사례가 총 마감을 넘으면,
이미 claim한 중단이 `dispatching`에 남는 재현 테스트가 수정 전 실패했다.
조회/검증·claim·interrupt·오류 저장에 각각 2초의 협력적 마감을 부여하도록 바꾸었다.
한 폴링에서는 claim을 한 번만 시도해 여러 중단이 긴 배치를 이루지 않게 했다.
외부 shutdown 취소, 실제 응답 미확인 시 보류, 동일 중단의 중복 전송 금지는 유지한다.
이는 최초 설치본의 간헐적 실패와 같은 정체를 만들 수 있는 확인된 경로이며,
처음 실패한 실행의 모든 내부 원인을 사후 확정했다는 뜻은 아니다.

cutover 복귀 시 Rust를 cutover 명령의 자식으로 시작하면 그 명령의 Job Object 종료 때 함께 종료될 수 있다.
따라서 원래의 예약 작업을 다시 활성화한 뒤 Task Scheduler를 통해 시작한다.
기존 프로세스가 살아 있으면 재실행하지 않고, 작업 정의가 바뀌었으면 거부한다.
이 PowerShell 함수 경로도 실제 PowerShell에서 제어 포트를 대체해 검사했다. 실제 예약 작업은 만들지 않았다.

전환의 단계는 백업 → Rust 비활성화/종료 → 기존 미러 커서 검증/이행 → TS logon task → heartbeat 관찰이다.
실패 시 먼저 TS 종료를 확인하고 원래 작업 설정을 복원한다. 최신 DB를 과거 백업으로 덮어쓰지 않는다.
종료가 확인되지 않으면 fence와 journal을 남기며, `--recover-cutover`로 명시적으로 복구한다.

## 검증 기록

최종 기능 검사와 독립 npm 설치본 검사가 통과했다. 아래 재현 중 실패한 실행도 최종 증거에 보존한다.

| 검사 | 결과 | 로그 |
| --- | --- | --- |
| 기본 suite 재사용 | 117개 중 115 통과, 2 플랫폼 skip. 최종 Stop 수정 전 기록 | `.runtime/alpha3-default-tests.log` |
| 최종 기능 suite | 119개 중 118 통과, 1 POSIX skip | `.runtime/alpha3-features-final.log` |
| CLI/매핑 인접 계약 | 33/33 | `.runtime/alpha3-cli-mapping-final.log` |
| cutover 추가 회귀 | 9/9, 예약 작업 복귀 수정 포함 | `.runtime/alpha3-cutover-final.log` |
| Stop 마감 재현 RED | 14개 중 13 통과, 새 재현 1개 예상 실패 | `.runtime/alpha3-stop-budget-red.log` |
| Stop 및 인접 native 계약 GREEN | 51/51, 취소·중복 금지·단계 마감·폴링 공정성 포함 | `.runtime/alpha3-stop-budget-green.log` |
| 소스 애플리케이션 진단 | 2/2, 최종 Stop 수정 전 3스레드 재현 | `.runtime/alpha3-application-stop-diagnostic.log` |
| 최초 npm 설치본 | 71개 중 70 통과, stop 후 running 해제 대기 실패 1개 | `.runtime/alpha3-installed-first-attempt.log` |
| 중간 npm 설치본 | 72/72였지만 진단에서 공용 마감 발생 확인, 추가 수정 진행 | `.runtime/alpha3-installed-before-stop-budget.log` |
| **최종 npm 설치본** | **87/87**, 타입 제거 비활성화·설치된 dist만 사용. 3스레드 반복 답변, stop 후 재개 및 종료 확인 | `.runtime/alpha3-installed-final.log` |
| 타입 검사 | PASS | `.runtime/alpha3-typecheck-final.log` |
| helper 실제 CLI cachebuster | PASS | `.runtime/alpha3-cachebuster-final.log` |

최종 기능 suite에는 예약 작업 복귀 경로와 새 Stop 회귀 테스트가 포함되어 있다.
기본 suite의 이전 통과 기록을 새 서버의 실서비스 검증으로 해석하지 않는다.
중간 검증의 fake tick이 무한히 즉시 완료되면서 테스트의 `setImmediate`를 굶기는 문제도 수정했다.
그 두 실행은 작업 소유 테스트 프로세스만 종료했고 성공 기록에서 제외했다(`*-fixture-rejected.log`).
기존 `test/pro/plugin-files.test.ts`의 Windows 실패 3개(CRLF golden, symlink 권한, native 파일 형식 오류 분류)는
변경하지 않은 영역의 별도 기록이며 `.runtime/helper-tests.log`에 보존한다. 전체 저장소의 모든 테스트가 통과했다고 주장하지 않는다.

## 설치 및 사용

설치에는 Node 24.21 이상 25 미만이 필요하다. Rust/Cargo나 전역 TypeScript 컴파일러는 필요 없다.
`npm install --ignore-scripts <alpha.3.tgz>` 후 `codex-discord-bridge --help`를 실행할 수 있다.
플러그인 등록·워치독 시작·예약 작업·Rust 전환은 각각의 명시적 명령으로 수행한다.
실행 예시는 [README](../README.md)의 Install / Watchdog / Remote 절에 있다.

최종 설치 파일:
`C:/ai/codex/artifacts/codex-discord-bridge-ts-20261018-alpha3/codex-discord-bridge-ts-0.1.0-alpha.3.tgz`

- 크기: 1,450,428바이트, 파일 1,102개.
- SHA-256: `94a3287a65fdddd0b21070352aac8871cee02e181dd4aceb20e07697ff4f7f13`.
- 같은 디렉터리에 검증 로그, 수정 전/후 문서, `validation.json`, 소스/패키지 해시 inventory와 `SHA256SUMS`를 보존했다.
- 압축된 각 실행 파일·자산을 현재 빌드와 비교해 불일치가 없는지 검사했다. 자격정보·DB·테스트·캐시는 패키지에 포함하지 않았다.

OAuth HTTP 구현은 [MCP Streamable HTTP 명세](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)의
JSON 응답·선택적인 GET 스트림·명시적 취소 규칙을 따른다. 이것은 모든 MCP 클라이언트에 대한 적합성 인증이 아니다.

## 남은 검증과 범위

- F06의 영속 증분 연속성, 느린 디스크/매우 큰 로그, 장시간 3스레드 soak 및 동등 조건 Rust 성능 비교.
- 실제 Discord, Codex 모델, Pro 브라우저/커넥터, GUI 컴퓨터 입력·캡처, 재부팅, Task Scheduler 전환/복구.
- 원본 리뷰에 기록한 로컬 Rust의 변경 356개 경로 전체에 대한 의미 단위 대조. 이번 수정으로 그 대조까지 끝났다고 볼 수 없다.
- Windows x64 외 플랫폼과 npm registry 공개 배포.

실제 사용자 DB·봇·워치독·예약 작업·Codex 플러그인 설정은 이 작업에서 변경하지 않았다.
