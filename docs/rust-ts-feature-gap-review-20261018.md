# Rust → TypeScript 미구현·불일치 상세 리뷰

검토일: 2026-10-18. 대상: Windows/npm `0.1.0-alpha.2`.

## 판정과 검증 결과

**전체 이식 완료가 아니다.** 기존 테스트가 통과한 기능도 실제 설치 경로에서는 빠진 실행 파일, 로컬 Rust의 추가 복구 로직, 용량 제한과 출력 정책의 차이가 남아 있다. 이전의 “전부 구현됐다”는 설명은 철회해야 한다.

- 재사용한 검증: 설치 패키지 **38/38**, app-server 실행 환경 비교 **10/10**, 최종 타입 검사 PASS. 로그는 각각 `.runtime/npm-installed-release-final.log`, `.runtime/rust-launch-parity-20261018.log`, `.runtime/typecheck-package-final.log`이다.
- 이번에 패키지의 `dist/src` **1,040개 파일**을 현재 체크아웃과 바이트 단위로 비교했다. 불일치 **0개**다. 아래 재현은 이전에 전달한 alpha.2의 실행 코드에도 해당한다.
- 새로 실행한 **재현 스크립트 4개는 모두 예상한 결함을 재현했다.** 이것은 제품의 정상 동작 테스트가 통과했다는 뜻이 아니다.
- Rust 바이너리를 새로 빌드하거나 실제 Discord 메시지, 모델 요청, GUI 입력, 재시작·예약 작업을 실행하지 않았다. Rust 쪽 기대 동작은 명시된 소스에서 확인했다.

이번에 확정한 항목은 **13개**다. 기능·하위 로직 누락, 부분 구현, 동작 차이를 포함한다. 별도의 검증 부족 항목은 이 수에 넣지 않았다.

## 비교한 소스

| 대상 | 식별자 |
| --- | --- |
| TS 저장소 | `C:/repos/simdorei/codex-discord-bridge-ts-npm` |
| TS 브랜치 / HEAD | `codex/ts-npm-windows-20261018` / `bf5c2f4f4bb0cba0888fd0b46a6be50ca9db45d2` |
| TS 소스 tree | `b133b92eb015a8b90b1a93349e9144e4ce549f36` |
| Rust 이식 기준 | `d7e1aa0106b2eefd9ea3f96e8e4bc5afdd296d34` |
| 로컬 Rust | `C:/repos/simdorei/codex-discord-remote-rust`, HEAD `6b6255d44e465572c33cb051e13bf889cbfb7646` + 작업 트리 |
| 배포 후보 | `codex-discord-bridge-ts-0.1.0-alpha.2.tgz` |
| 배포 후보 SHA-256 | `9fdaa0cb397ba3504916cb38bff0c59c9a75bc2c6cd5f60e56bfc60ca2470895` |
| 실행 환경 | Windows x64, Node 24.21.0 |

Rust의 Git 상태에는 삭제 처리된 뒤 같은 경로에 다시 존재하는 파일도 있다. 따라서 `git diff`의 파일 수를 곧바로 실제 기능 차이로 계산하지 않았다. 기준 커밋의 `crates` 내용과 **현재 디스크의 `.rs`·`.toml` 내용**을 CRLF/LF만 정규화해 비교했다. 기준 1,631개, 로컬 1,645개 중 실제 차이는 **356개 경로: 변경 322, 추가 24, 삭제 10**이다. 테스트·예제·서식 차이도 포함된 수이며, 356개 기능이 빠졌다는 뜻은 아니다.

F02·F04는 이 로컬 Rust 추가분에서 찾았다. 다른 항목은 기준 Rust와 TS 설치 경로를 비교했다. 실제 로컬 Rust 배포 바이너리가 작업 트리와 같은지는 이번 검토 범위에 포함하지 않았다.

증거 묶음: `C:/ai/codex/artifacts/rust-ts-feature-gap-review-20261018/`.
`source-inventory.json`에는 TS 소스 해시, 비교한 Rust 파일 해시, 패키지 일치 결과, 공개 명령 목록을 기록했다. `rust-local-delta.json`에는 356개 경로의 실제 내용 차이를 남겼다.

## 확정 항목

P1은 교체 사용 전에 해결해야 할 문제, P2는 기능 동등성을 선언하기 전에 구현하거나 범위를 명시해야 할 문제다. 영향이 특정 사용 환경에 한정되는 경우 그 조건을 함께 적었다.

| ID | 우선순위 | 구분 | 빠진 부분 / 다른 동작 |
| --- | --- | --- | --- |
| F01 | P1 | 실행 경로 누락 | Pro 스킬·훅이 호출하는 `cdr-pro-helper` 실행 파일/TS CLI 없음 |
| F02 | P1 | 로컬 Rust 로직 누락 | Discord Gateway nonce echo로 미확정 전송 영수증 복구 |
| F03 | P1 | 정책 적용 누락 | Git status/diff가 파일 접근 제한을 적용하지 않음 |
| F04 | P1 | 로컬 Rust 로직 누락 | JSON 자격정보 마스킹, 파일 문맥 처리, 줄 수 보존 |
| F05 | P1 | 부분 구현 | 원격 이미지 입력이 자체 허용 크기보다 훨씬 작은 단계에서 실패 |
| F06 | P1 | 동작 차이 | 미러가 매번 누적 로그 전체를 해시하고 512MiB 초과를 거부 |
| F07 | P1 | 동작 차이 | Rust의 독립 target 동시 처리가 TS 전역 잠금에서 직렬화됨 |
| F08 | P2 | 부분 구현 | Git diff에서 미추적 파일 누락, staged/dirty 의미 차이 |
| F09 | P2 | 별도 서버 미이식 | OAuth·MCP HTTP·브리지 중계 서버 없음 |
| F10 | P2 | 설치 자동화 누락 | Codex 플러그인 marketplace 등록·설치 단계 없음 |
| F11 | P2 | 운영 UI 미이식 | Windows 트레이 실행기·메뉴 없음 |
| F12 | P2 | 운영 도구 부분 이식 | 기존 런타임 전환·작업 정리 자동화와 재시작 옵션 일부 없음 |
| F13 | P2 | 네트워크 동작 차이 | 첨부 다운로드의 환경변수 프록시 지원 없음 |

### F01 — Pro helper가 패키지에 없다

**증상:** 새 PC에서 이 npm 패키지만 설치하면 포함된 Pro 스킬의 필수 helper 명령을 실행할 수 없다. 기존 Codex 플러그인 설치에 Rust helper가 남아 있는 환경은 이 누락을 가릴 수 있다.

- TS 포함 스킬 `plugins/codex-discord-remote/skills/ask-chatgpt-pro/SKILL.md:33`, `:48`, `:77`, `:86`은 `bin/cdr-pro-helper`의 probe/conversation 명령을 요구한다.
- 포함 훅 `plugins/codex-discord-remote/hooks/browser-evidence.json:9`, `pro-connector-evidence.json:9`도 같은 실행 파일을 호출한다.
- 실제 패키지 플러그인 파일 24개에는 `bin/cdr-pro-helper.exe` 또는 비 Windows 실행 파일이 없다. TS `src`에도 `browser-probe-code`, `connector-probe-code`, `browser-hook`, `connector-hook` CLI 진입점이 없다. npm의 bin은 `package.json`에 정의된 `codex-discord-bridge` 하나다.
- Rust 기준의 `crates/cdr-pro/src/bin/helper.rs:20` 이후에는 release evidence, cachebuster 검증, conversation, 세 가지 probe, 두 가지 hook 명령이 있다. `scripts/CdrInstallPluginHelper.psm1:7`은 helper를 플러그인 `bin`에 설치한다.

**필요 작업:** helper의 각 명령을 TS CLI로 연결하고, 스킬·훅이 실제 포함된 실행 경로를 사용하도록 맞춰야 한다. 일부 내부 함수가 존재하는 것만으로는 부족하다. `codex-code-mode-host.exe` 탐색 fallback과는 별개 파일이다.

**수락 검증:** Rust 바이너리와 기존 플러그인 캐시가 없는 임시 설치에서 모든 helper 명령을 실제 프로세스로 실행한다. 훅의 입력·출력 형식, conversation 저장/재개, 정상·실패 종료 코드를 검증한다.

### F02 — 로컬 Rust의 Gateway 전송 영수증 복구가 빠졌다

**조건:** Discord는 전송을 수락했지만 HTTP 응답이 유실되고, 이후 봇 자신의 메시지가 Gateway로 돌아온 경우.

- 로컬 Rust `crates/cdr-runtime/src/discord_runtime/message_create.rs:210` 이후는 일반 메시지 분류 전에 `receipt_echo::confirm`을 호출한다.
- `.../message_create/receipt_echo.rs:9`는 nonce, 실제 봇 작성자, webhook/편집 여부, 채널, 내용/컴포넌트 해시를 확인한다. 일치하는 기존 영수증만 확정하며 재전송 권한을 만들지 않는다.
- 로컬 `crates/cdr-store/src/delivery_receipt/gateway.rs:16`은 미확정 후보를 찾고, `:29`는 모든 조각이 확인된 기존 일반 답변의 `confirmation_delivered`를 갱신한다.
- TS `src/runtime/discord-runtime/message-create.ts:74` 이후에는 이 확인 단계가 없고, `src/runtime/message-plan.ts:45`는 자기 작성 메시지를 무시한다. Gateway nonce를 영수증 확정으로 연결하는 대응 경로도 찾지 못했다.

**영향:** 기존 전송 영수증/중복 방지 기능이 전부 없는 것은 아니다. 다만 위의 응답 유실 상황에서 로컬 Rust가 추가로 복구하는 경로가 없어, 전달이 됐어도 미확정 상태·출력 대기가 남을 수 있다. 과거 실사용 장애의 원인이 이것이었다고 단정하지는 않는다.

**필요 작업:** nonce 보존 → 인증된 자기 메시지 확인 → 동일 영수증 확정 → 대기 중인 전달 작업 깨우기를 연결한다. 재전송이나 요청 재실행으로 대체하면 안 된다.

**수락 검증:** HTTP ACK 유실 + 정상 echo, 틀린 nonce/내용/채널, webhook, 수정 메시지, 중복 echo, 다중 조각 중 일부만 확인된 경우를 검사한다. 실제 Discord 없이 재현 가능하다.

### F03 — Git 조회가 민감 경로 차단을 우회한다

- Rust 기준 `crates/cdr-remote-agent/src/git/diff.rs:60`의 `visible_tracked`와 `git/status.rs:132`는 `ProjectFileAccess::validate_path`로 공개할 경로를 제한한다.
- TS `src/remote-agent/files/path-policy.ts:7`과 `:16`에는 `.env`, `.ssh`, `secrets` 등 차단 규칙이 있다.
- 그러나 `src/remote-agent/native-core.ts:44`의 status와 `:63`의 diff는 그 규칙 없이 저장소 전체 결과를 반환한다. 텍스트 마스킹은 경로 차단과 같은 보장이 아니다.

**재현:** 임시 저장소에서 `files.path('.env')`는 거부했지만, `repo_diff`에는 `.env` 경로와 더미 값 `INTERNAL_REVIEW_LABEL=fixture-after`가 그대로 나왔다. 실제 사용자 비밀정보는 사용하지 않았다.

**필요 작업:** 허용된 경로만 Git 조회 인자로 전달하고 반환되는 경로에도 같은 정책을 적용한다. status와 diff를 함께 확인해야 한다.

**수락 검증:** 추적된 민감 파일·이름 변경·정상 파일이 섞인 저장소에서 민감 경로와 내용이 결과에 없고, 정상 변경은 계속 보여야 한다.

### F04 — 로컬 Rust의 파일 마스킹 개선이 빠졌다

로컬 Rust `crates/cdr-remote-agent/src/files/redaction.rs:10` 이후와 `files.rs:102` 이후는 다음을 추가했다.

1. 따옴표로 둘러싸인 JSON `token`, `password`, `authorization`, `private_key` 등의 값 마스킹.
2. 파일 전체 문맥을 보고 Python 식별자·FFI 서명·일부 JSON 파일 해시/경로처럼 확인 가능한 비밀정보가 아닌 값만 보존.
3. 마스킹 시 줄 수 보존 후 요청한 줄 범위를 선택.

TS `src/remote-agent/files/redaction-cpu.ts:18` 이후에는 기존 규칙만 있고, `read-file-worker.ts:7`은 먼저 줄을 자른 다음 문맥 없이 마스킹한다.

**재현:** 실제 TS 마스킹 워커에서 더미 JSON `token`/`password`가 그대로 나왔고, `InitializeProcThreadAttributeList`는 `[REDACTED]`로 바뀌었다. 더미 다중 행 PEM 블록은 개행 4개가 2개로 줄었다. Rust 쪽 기대 결과는 현재 로컬 소스에서 확인했으며 새 Rust 실행 비교는 하지 않았다.

**영향:** 자격정보가 든 일반 JSON 파일은 보호가 약하고, 반대로 검토에 필요한 코드·해시는 훼손될 수 있다. 반환 내용과 표시된 줄 번호도 어긋날 수 있다.

**필요 작업:** JSON 자격정보 규칙, 파일 전용 문맥 처리, 줄 보존을 각각 이식한다. 일반 로그·diff의 보수적인 마스킹까지 무조건 완화하면 안 된다.

### F05 — 원격 MCP 이미지 입력의 실제 한도가 맞지 않는다

이 항목은 **원격 MCP `save_image`** 경로다. Discord 첨부파일 전송이 모두 실패한다는 뜻이 아니다.

- Rust 기준 `crates/cdr-remote-agent/src/images.rs:12`는 이미지 5,242,880바이트를 허용하고, 브리지 프레임은 `bridge/client.rs:17`에서 12,000,000바이트다.
- TS 요청 규격 `src/remote-agent/core-request.ts:73`도 base64 7,000,000자를 허용한다.
- 하지만 `src/remote-agent/project-dispatcher.ts:36`, `:46`은 4MiB 예산의 1/3만 문자열 단위 예산으로 허용하고, 각 문자열 길이를 다시 3배로 계산한다.
- 더 바깥 `src/remote-agent/command-loop.ts:61`은 프레임 4MiB 초과를 일시적인 `bridge_busy`로 응답한다.

**재현:** 실제 command loop·codec·dispatcher에 이미지 크기의 합성 데이터를 넣었다. 이미지 해독·쓰기 전에 거절되는 검사이므로 유효한 이미지 내용이어도 같은 크기 제한을 만난다.

| 바이너리 상당 크기 | base64 길이 | 결과 |
| --- | --- | --- |
| 1MiB | 1,398,104 | 요청 형태 검증 통과 후 `Native remote input text exceeds budget`; loop는 `RemoteCommandLoopError`로 종료, 응답 없음 |
| 3.25MiB | 4,543,832 | 실제 작업 0회, `bridge_busy` 반환 |

**필요 작업:** 프로토콜 허용량·실제 메모리 예산·동시 작업 수를 함께 설계해 맞춰야 한다. 영구적인 크기 거부를 “잠시 후 재시도”로 응답해서도 안 된다. 큰 요청 하나 때문에 다른 작업의 연결 수명이 종료되는 경계도 검사해야 한다.

**수락 검증:** 작은 이미지, 1MiB, 5MiB 경계, 초과 요청과 다른 스레드 작업을 함께 시험한다. 입력뿐 아니라 결과·캐시·오류 응답 한도도 통과해야 한다.

### F06 — 증분 미러링 대신 누적 이력을 매번 다시 읽는다

- 설치 경로 `src/runtime/discord-runtime/local-session-mirror-profile.ts:38`은 항상 `fullPrefix:true`를 선택한다.
- `src/runtime/session-mirror/continuity-observation.ts:51`은 조회마다 기존 cursor까지 다시 anchor를 만들고, `:94`는 그 전체 구간을 SHA-256 해시한다. `bound-poll.ts:42`의 이 검사가 끝난 뒤에야 새 이벤트가 없는지를 확인한다.
- cursor가 진전될 때도 `continuity-observation.ts:76`에서 다음 경계를 다시 해시한다.
- 같은 파일 `:95`는 512MiB 초과를 거부하고, `:96` 이후에는 10초 마감이 있다.
- Rust 기준/로컬 `crates/cdr-runtime/src/session_mirror_worker.rs:109`는 cursor부터 tail을 읽는다.

**재현:** 변경 없는 8,388,608바이트 파일을 두 번 조회했는데 각각 **8,389,120바이트**를 읽었다. 파일 크기만 513MiB인 합성 파일은 `Mirror history exceeds 512 MiB verification budget`로 거부됐다. 측정한 두 조회는 로컬 캐시 환경에서 약 6.5–6.9ms였다. 이 수치를 실제 서비스 지연 전체의 원인으로 해석하면 안 된다.

**영향:** 새 내용이 없어도 작업량이 누적 대화 길이에 비례한다. 긴 이력은 영구적인 거부 한도에 도달한다. 원래 이식 요구사항 `migration/rebuild-20261010/requirements/ts-runtime-parity-pro-reviewed-20261007.md`의 B항도 매 폴링 전체 해시를 금지한다.

**필요 작업:** 이력 변조 감지를 유지하면서 producer의 연속성 증거·checkpoint를 증분 관리해야 한다. 단순히 해시를 끄거나 cursor를 리셋하는 수정은 적절하지 않다.

**수락 검증:** 큰 이력에서도 변경 없는 조회 비용이 일정한지, 중간 수정+append와 재시작을 검출하는지, 512MiB 초과 정상 이력을 처리하는지 함께 검증한다.

### F07 — 미러의 전역 잠금 때문에 독립성이 부족하다

- `src/runtime/session-mirror/mapping-owner.ts:23`은 스레드 잠금을 먼저 얻고 전역 `mirror-sync-operation` 잠금을 얻는다.
- `bound-poll.ts:84`는 bootstrap·폴링·전달·정리가 끝날 때까지 이 잠금을 유지한다. 코드 주석도 직렬화를 명시한다.
- 같은 전역 잠금을 `src/runtime/mirror-sync/new-mirror-link.ts:51`, `inspection.ts:32`, `sync.ts:52`가 사용한다.

**재현:** A 작업을 유지하면 독립 스레드 B는 작업에 들어가지 못하고, 매핑 작업도 대기했다. B는 아직 실행 전인데 B의 스레드 잠금까지 보유했다. A가 끝나면 모두 정상 해제됐으므로 이 재현 자체가 영구 deadlock을 입증한 것은 아니다.

**실제 Rust 호출 경로:** `SessionMirrorWorker.poll_once`만 보면 순차 루프지만, 운영 runner는 `crates/cdr-runtime/src/session_mirror/runner.rs:133`에서 `poll_background`를 호출한다. 기준 Rust `session_mirror/background.rs:20`은 최대 8개 in-flight 작업을 허용하고, `:141` 이후는 서로 다른 target/channel을 `FuturesUnordered`에 넣는다. 현재 로컬 Rust도 같은 방식을 사용한다(`:17`, `:127` 이후). 따라서 이 항목은 실제 Rust 동시 처리와의 차이이며, TS 이식 요구사항 C항의 독립 target 공정성에도 미달한다.

**필요 작업:** 전역 잠금은 매핑 변경/검증에 필요한 짧은 구간으로 제한하고, 전달 중에는 정확한 target/매핑 세대 소유권으로 보호한다. 취소와 실제 native 작업 종료 확인은 유지해야 한다.

### F08 — Git 변경 조회의 동작이 덜 구현됐다

- Rust `crates/cdr-remote-agent/src/git/diff.rs:37`과 `:81`은 미추적 파일도 읽어 추가분 diff 또는 binary 표시로 반환한다.
- TS `src/remote-agent/native-core.ts:63`은 `git diff HEAD`만 호출한다. 미추적 파일은 이 명령에 나오지 않는다.
- 추가로 TS `:46`은 staged-only 파일도 `dirty_files`에 넣는다. Rust `git/status.rs:109`는 staged와 unstaged를 구분한다. 이것은 소스 비교 결과이며 별도 실행 재현은 하지 않았다.

**재현:** 임시 저장소의 `new-file.txt`는 TS status에는 나왔지만 diff의 `files`와 patch에는 없었다.

**필요 작업:** 허용된 미추적 파일을 포함하고 크기·파일 수·binary·마스킹 규칙을 보존한다. F03과 같은 Git 어댑터 영역이지만, 테스트는 누락과 경로 보호를 각각 검증해야 한다.

### F09 — 원격 MCP 서버 자체는 TS에 없다

- Rust workspace에는 `cdr-mcp-server`가 있다. `crates/cdr-mcp-server/src/server/router.rs:34`는 OAuth 저장소·provider·broker를 구성하고 OAuth, bridge WebSocket, MCP HTTP, `/healthz`를 연결한다. `server/run.rs:24`에는 실제 listen 진입점이 있다.
- TS에는 서버로 접속하는 `src/remote-agent`가 있고 설정된 gateway 연결도 구현돼 있다. 반면 위 OAuth/MCP 서버를 실행하는 대응 진입점·서버 모듈은 없다.

**영향:** 기존 원격 Rust 서버를 계속 쓰는 구성은 가능하다. 다만 저장소 전체를 TS/npm만으로 대체해 자체 호스팅하는 기능은 완성되지 않았다. 별도 서버를 유지하기로 범위를 정하면 독립 구성요소로 명시해야 한다.

여기서 구분해야 할 것은 세 가지다. Codex app-server가 불러오는 기존 MCP 도구들, 이 저장소의 PC 쪽 remote agent, 그리고 OAuth/MCP gateway 서버다. PC 에이전트가 연결된다고 서버까지 TS로 이식된 것은 아니다.

### F10 — npm 설치가 Codex 플러그인 설치까지 마치지는 않는다

- Rust `install.ps1:55`의 설치 흐름은 helper 설치 후 `:71`에서 marketplace를 등록하고, `:72`에서 플러그인을 설치한 다음 inventory를 검증한다.
- TS `src/cli/admin.ts:29`의 `configure-install`은 환경 설정을 기록하고, `:31`의 `verify-plugin-inventory`는 주어진 inventory를 검증한다. Codex marketplace 등록·플러그인 설치를 수행하는 단계는 없다.
- 패키지에는 스킬/manifest가 들어 있지만, 파일을 포함하는 것과 Codex에 등록·활성화하는 것은 다르다.

**필요 작업:** F01을 해결한 뒤 명시적인 설치 명령으로 패키지의 marketplace/플러그인 경로를 등록하고 검증한다. 기존 설치와 신규 설치를 구분해야 한다. Node 24.21 이상과 Codex 설치 등 전제도 설치 안내에 남겨야 한다.

### F11 — Windows 트레이가 없다

- Rust `codex-discord-tray.ps1:135` 이후에는 상태, 로그 열기, 폴더 열기, 재시작, 강제 재시작, 트레이 종료 메뉴가 있다.
- TS npm 패키지에는 대응 트레이 런처·메뉴가 없다.
- TS의 `--start`, `--watchdog`, supervisor control/status, 로그온 작업 등록은 구현돼 있다. 트레이 누락을 워치독 전체 미구현으로 확대하면 안 된다.

**필요 작업:** TS supervisor의 실제 상태/세대 확인을 사용하는 트레이 UI와 시작·종료 경로가 필요하다. 메뉴를 누르면 다른 설치나 다른 세대 프로세스를 건드리지 않는지도 확인해야 한다.

### F12 — 운영 전환 도구와 재시작 옵션 일부가 다르다

- Rust에는 `codex-discord-runtime-cutover.ps1`과 maintenance/stabilization 도구가 있다. 일부는 특정 운영환경을 전제로 하므로 그대로 복사할 대상은 아니다.
- TS `src/cli/windows-control.ts:9` 이후는 자기 `CodexDiscordTS-*` 로그온 작업을 설치·제거한다. 기존 Rust watchdog/트레이/예약 작업 조사·정지·전환·롤백을 묶은 경로는 없다. README도 사용자가 이전 런타임을 먼저 멈추도록 안내한다.
- 포함 `plugins/codex-discord-remote/scripts/restart.ps1:26`은 기존 `ExpectedBotIdentity` 사용을 거부하고, `:27`은 사용자 지정 `QuietSeconds`·`WaitTimeoutSeconds`를 거부한다. 기본 재시작 기능은 있지만 공개 옵션까지 동일하지 않다.

**필요 작업:** 전환 전에 기존 작업/프로세스와 DB·마커를 목록화하고, 정확히 식별된 대상만 중지하며, 백업·TS 시작·실패 시 복귀를 검증하는 전환 명령이 필요하다. 이전 stop/미확정 요청을 무조건 지우는 방식은 전환 구현이 아니다. 재시작 옵션은 같은 의미로 구현하거나 명시적으로 변경된 인터페이스로 문서화해야 한다.

### F13 — 첨부 다운로드의 프록시 설정 동작이 다르다

- Rust `crates/cdr-runtime/src/discord_runtime.rs:122`는 기본 `reqwest::Client::new()`를 사용한다. 로컬에 설치된 reqwest 0.13.4의 `async_impl/client.rs:309`, `:415`는 기본 system/env proxy matcher를 연결한다.
- TS `src/runtime/attachment-client.ts:13`, `:35`는 프록시 옵션 없는 자체 HTTP/HTTPS Agent를 사용한다. 파일 `:11`도 프록시 환경변수 지원 미구현을 명시한다.
- 이 환경의 Node 24.21 `_http_agent`는 자체 Agent의 `options.proxyEnv`가 주어져야 해당 설정을 구성하는 것을 확인했다.

**영향:** 프록시 경유가 필요한 환경에서 첨부 다운로드가 Rust와 다르게 실패할 수 있다. 직접 접속 환경의 첨부 다운로드 전체가 미구현이라는 뜻은 아니다.

**필요 작업:** 적용할 HTTP(S)_PROXY/NO_PROXY 정책을 명시적으로 연결하고 프록시 인증정보가 로그에 노출되지 않게 검증한다. 이 항목은 소스 확인이며 실제 프록시 서버 시험은 하지 않았다. HTTP/2나 압축은 Rust의 선택된 feature도 고려해야 하므로 별도 누락으로 세지 않았다.

## 공개 기능 목록 대조 결과

아래는 이름·라우팅·설치 연결 여부의 검토다. “있음”은 모든 오류/재시작 경계에서 Rust와 같다는 인증이 아니다. 특히 F02·F04처럼 이름을 추가하지 않고 바뀐 내부 복구 로직은 명령 수로 찾을 수 없다.

| 범위 | 확인한 TS 연결 | 판정 / 남은 부분 |
| --- | --- | --- |
| Rust `CommandAction` 38종 | `command-plan.ts`, `prefix-plan.ts`, `command-snapshot.ts` | 대응 이름 존재. 없음으로 분류할 명령 variant는 찾지 못함 |
| 조회: help/list/archived/use/status/where/context/usage/doctor/runners/saved/settings-options | `action-executor/basic-dispatcher.ts`, 개별 action | 실행 분기 존재 |
| 실행: new/ask/interview/settings/open/resume/steer | `action-executor/command-executor.ts:168` | 실행 분기 존재 |
| stop/recover/repair/retract | 같은 executor 및 `local-application.ts:82` | Windows 설치 연결 존재. 실사용 복구와 전체 로컬 Rust 차이 검증은 별도 |
| archive/delete preview/delete confirm | executor, `archive-delete/controller.ts`, `local-application.ts:84` | 실제 삭제 어댑터 존재; 테스트 DB 검증 재사용 |
| approval·비동기 질문·busy 선택·discard-request | component worker, message worker, native state owners | 처리 경로 존재; F02 영수증 복구는 누락 |
| restart/force restart/host reboot/resources | service actions, Windows host control/resource probe | 구현 존재; F12 운영 옵션 차이 |
| mirror inspect/sync/자동 session mirror | mirror-sync, session-mirror, local profile | 구현 존재; F06·F07 |
| 원격 CoreRequest 18종 | `remote-agent/native-core.ts`, `native-project.ts` | 각 operation 분기 존재; F03·F04·F05·F08 |
| 원격 ComputerRequest 12종 | `session-computer.ts`, `windows-computer.ts`, `window-native.ts` | Windows 어댑터 연결 존재. 실제 GUI 상호작용 미검증 |
| 원격 TerminalRequest 9종 | `native-terminal.ts`, `windows-terminal.ts` | 실행/창 어댑터 연결 존재. 실제 창별 입력 미검증 |
| 프로젝트 바인딩·세션·파일 list/read/write | configured remote, project dispatcher, native project | 연결 존재; 파일 읽기는 F04 영향 |
| 파일 create/patch/checkpoint list/show/restore | native core/checkpoints/files | 구현·임시 파일 테스트 존재. 용량 한도 있음 |
| Discord 첨부 다운로드/업로드 | attachment client/download, admin attachment | 구현 존재. F13 및 실제 Discord 파일·오디오 검증 부족 |
| Pro preflight·inventory·원격 프로젝트 선택 | Pro runtime/bootstrap, configured remote | 내부 경로 존재; F01 helper·F10 설치 누락으로 새 설치 완결성 없음 |
| Codex 실행 파일 fallback | runtime-paths executable/discovery, Windows launch | 기존 검증 재사용. 잘못 지정한 명시적 경로는 자동 무시하지 않는 정책 |
| Windows 프로세스 트리·mutex·마커·DPAPI | Windows native adapters | 구현과 native fixture 검증 존재 |
| 워치독·로그온 자동 실행 | supervisor, Windows control CLI | 구현 존재. 트레이와 이전 런타임 전환은 F11·F12 |
| 관리 CLI | `cli/admin-args.ts`, `cli/admin.ts` | 파싱된 관리 명령의 실행 분기 존재; 설치·전환 완성도는 F10·F12 |
| 별도 OAuth/MCP HTTP 서버 | 대응 서버 진입점 없음 | F09 |

CoreRequest 18종은 rules/status/search/patch/create/command list/run/repo status/diff/commit/push/image save/URL save/list/retrieve/checkpoint list/show/restore다. ComputerRequest 12종과 TerminalRequest 9종의 정확한 이름은 `source-inventory.json`에 남겼다.

### 미구현으로 잘못 세면 안 되는 항목

- **`SKY_CUA_NATIVE_PIPE="0"`:** Rust 기준과 현재 로컬 Rust도 같은 값을 사용한다. TS만 컴퓨터 유즈를 꺼 둔 차이가 아니다. app-server 인자·상속 환경 비교 10개 테스트를 재사용했다. 이 값 하나로 모든 화면 제어 가능 여부를 판정해서도 안 된다.
- **`!detail`:** TS `message-plan.ts:30`에서 미지원이지만, 기준 Rust `message_plan.rs:165`도 동일하게 미지원이다.
- **auto reserve:** 기존 제거/거부 정책이 있으므로 이름이 남아 있다는 이유로 되살릴 기능으로 취급하지 않는다.
- **기본 구현의 Windows unsupported 오류:** POSIX용 기본 adapter와 실제 Windows 주입 경로를 구분했다. 설치 경로에서 Windows 어댑터가 주입되는 기능을 누락으로 세지 않았다.
- **`command_run`의 제한된 npm 스크립트 허용:** Rust `commands/catalog.rs:115`도 `node --test` 형태만 안전한 package command로 취급한다. TS만 생긴 축소로 세지 않았다.
- **지속 DB worker 최적화:** 실험 구현이 설치 runtime에 선택되지 않은 것은 성능/자격 검증 문제다. 현재 매 작업 worker 경로가 존재하므로 DB 기능 자체가 없다는 뜻은 아니다.
- **이미지/컴퓨터/터미널 DTO 존재:** 반대로 타입과 파서가 존재하는 것만으로 실행 기능 완료로 계산하지 않았다. F01·F05가 그 구분이 필요한 사례다.

## 검증만 부족한 항목과 검토 한계

1. 실제 Discord에서 최종 답변·여러 조각·첨부 이미지·음성 파일·수신 확인이 동작하는지. 오디오 파일 전달과 모델의 오디오 해석은 별도 항목이다.
2. 실제 OAuth/MCP 서버, Pro 브라우저 대화, 컴퓨터 화면 캡처/입력, 실제 콘솔 창 상호작용. fixture PASS를 실사용 PASS로 바꿔 쓰지 않는다.
3. 실제 로그온 자동 실행, 이전 Rust 예약 작업이 있는 PC의 전환/롤백, Desktop/tools recovery. 작업 생성 문자열과 복구 스크립트 파싱 검증만으로는 충분하지 않다.
4. 세 스레드 장시간 운영·큰 이력·DB 경합·중간 프로세스 사망·재시작. 기존 설치 fixture는 3스레드×3회 + stop 후 다음 요청, final 10회까지다. 장시간 soak가 아니다.
5. 동일 조건 Rust/TS 성능 비교와 요구사항 G7. 기존 fixture의 100ms provider 응답에 최종 전달 약 **6.65초**, 3스레드 run peak 약 **290MiB**, 종료 약 **0.24초**는 남아 있는 측정값이다. 모델 응답 대기와 bridge 자체 비용을 분리해 봐야 한다.
6. 로컬 Rust 356개 변경 경로의 전체 의미 대조. 공개 인터페이스, 추가 모듈, 주요 설치·복구·출력 경로를 확인했지만 모든 변경 줄에 대한 동일성 증명은 하지 않았다. F02·F04 외에도 추가 차이가 없다고 보증할 수 없다. 변경 경로 목록을 후속 대조의 입력으로 보존했다.
7. 현재 자격 검증 환경은 Windows x64다. Linux/macOS·ARM64·UNC 루트를 지원 완료라고 선언할 근거는 없다. `local-application.ts`의 일부 native 연결은 Windows 조건부다.
8. npm 설치 가능한 tgz는 존재하지만 `package.json`은 `private:true`이며 npm registry 배포/메인 병합은 하지 않았다. `npm install <tgz>`와 registry에서 패키지 이름만으로 설치하는 경험은 다르다.

## 이번 검토에서 만든 재현 자료

개발 체크아웃의 `.runtime/review-20261018/`에서 아래 명령을 실행했다. `node`는 위에 명시한 24.21.0 바이너리를 사용했다. 모두 종료 코드 0이며, 결함을 관찰하는 assertion이 성공했다.

```text
node --no-strip-types .runtime/review-20261018/mirror-gap-repro.mjs
node --no-strip-types .runtime/review-20261018/git-gap-repro.mjs
node --no-strip-types .runtime/review-20261018/image-admission-repro.mjs
node --no-strip-types .runtime/review-20261018/redaction-gap-repro.mjs
python .runtime/review-20261018/capture-inventory.py
```

| 자료 | 확인 범위 |
| --- | --- |
| `mirror-gap-repro.json` | 변경 없는 파일 전체 재읽기, 513MiB 거부, 독립 target의 잠금 대기 |
| `git-gap-repro.json` | `.env` 경로 정책 우회, 새 미추적 파일 diff 누락 |
| `image-admission-repro.json` | 1MiB/3.25MiB 입력의 서로 다른 거부 경로, backend 미호출 |
| `redaction-gap-repro.json` | 더미 JSON 미마스킹, 코드 식별자 과마스킹, 개행 손실 |
| `source-inventory.json` | 검토 소스와 패키지의 식별, 명령 목록, 재현 결과 해시 |
| `rust-local-delta.json` | Git 인덱스가 아닌 현재 로컬 파일 내용 기준 차이 |

프로덕션 코드·설정·DB·예약 작업은 수정하지 않았다. 새 파일은 이 리뷰 문서와 검토용 증거뿐이다. 기존 broad suite를 다시 돌리지 않은 이유는 구현을 변경하지 않았고, 기존 설치본 로그와 일치하는 실행 코드를 확인했기 때문이다.

## 수정 순서 제안

1. **F01·F02:** 실제 빠진 Pro 실행기와 로컬 Rust의 전송 확인 복구를 각각 독립 변경으로 이식한다.
2. **F03·F04:** Git 경로 보호와 파일 마스킹을 각각 수정한다. 기존 파일 읽기·diff·줄 번호 계약을 함께 검증한다.
3. **F05:** 이미지 입력/결과 한도와 실패 시 연결 처리를 맞춘다.
4. **F06·F07:** 증분 미러링과 잠금 범위를 설계 요구사항에 맞춰 수정하고 긴 이력·다중 스레드 성능을 측정한다.
5. **F08·F10·F11·F12·F13:** Git 동등성, 새 PC 설치, 트레이, 전환 도구, 프록시 환경을 보완한다.
6. **F09:** 전체 TS 서버 이식을 포함할지, 기존 별도 서버를 유지하는 구성인지 명확히 기록한다. 유지한다면 “Rust 저장소 전체 이식 완료”로 표기하지 않는다.
7. 남은 로컬 Rust 차이를 대조하고 실제 사용 검증을 마친 뒤 교체 여부를 판단한다.

**전체 이식은 미완료다.** 위 13개 확정 항목과 별도로 적은 검증 범위가 남아 있다. 실사용 교체·메인 병합은 이번 작업에서 수행하지 않았다.
