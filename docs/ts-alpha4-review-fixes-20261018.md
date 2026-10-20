# TS alpha.4: 재검수 지적 R1/R2 수정

2026-10-18. 대상은 `C:\repos\simdorei\codex-discord-bridge-ts-npm`의 로컬 변경 전체를 포함한 alpha.4다. 기준 HEAD는 `bf5c2f4f4bb0cba0888fd0b46a6be50ca9db45d2`이며 아직 커밋하지 않았다.

## 수정한 동작

### R1: 변경 전 파일 충돌이 프로젝트 전체 쓰기를 막던 문제

`NativeRemoteCore`의 명시적인 사전 검사에서만 `RemoteCoreInputConflict`를 발생시키고, native project adapter가 해당 요청에 묶인 확정 실패 결과로 변환한다. 기존 파일 생성·이미지 저장·patch CAS·move 목적지 충돌 이후에도 같은 세션에서 다른 정상 쓰기를 진행할 수 있다.

실제 checkpoint mutation 이후 발생한 오류, rollback/cleanup 실패, 기타 결과가 불분명한 쓰기는 기존 dispatcher 보호를 유지한다. 모든 파일 오류를 안전한 실패로 취급하지 않는다.

변경 파일: `src/remote-agent/native-core.ts`, `src/remote-agent/native-project.ts`, `test/windows-runtime/windows-remote-conflicts.test.ts`, 테스트 프로필과 설치 패키지 검증 목록.

### R2: OAuth 쓰기 잠금 대기가 다른 인증 요청을 지연시키던 문제

초기 schema 준비 후 SQLite의 동기 busy 대기를 끈다. `BEGIN IMMEDIATE`가 SQLITE_BUSY로 거절되고 transaction이 시작되지 않았음이 확인된 경우에만 worker가 최대 5초, 최대 25ms 간격으로 비동기 입장 대기를 한다. 그동안 유효한 bearer token의 access 조회와 MCP 요청이 진행된다.

이미 시작한 transaction의 body/commit/rollback은 재실행하지 않는다. 종료 시 대기 작업을 취소 결과로 정리하고 worker를 닫는다. 같은 authorization code의 동시 교환은 하나만 성공하며 refresh 재사용에 대한 family 폐기도 유지된다.

변경 파일: `src/mcp-server/oauth-store.ts`, `src/mcp-server/oauth-worker.ts`, `test/mcp-server/gateway.test.ts`. 패키지 및 MCP server version은 `0.1.0-alpha.4`로 맞췄다.

## 검증

Node 24.21.0, Windows에서 실행했다. `.runtime/alpha4-*.log` 원본을 별도 artifact 폴더에도 UTF-8로 보존한다.

| 검사 | 결과 |
|---|---|
| 수정 전 회귀 재현 | R1 네 경로 및 R2 인증 지연 실패 확인 |
| 집중 회귀: gateway, dispatcher, native conflicts | 48/48 통과 |
| `npm run test:features` | 125개 중 124 통과, POSIX 1 skip |
| `npm run typecheck` | 통과 |
| `npm pack` | 빌드 및 alpha.4 생성 성공 |
| 별도 prefix에 tarball 설치 후 실제 dist 검사 | 93/93 통과 |

설치 검사에는 실제 native 파일/체크포인트/terminal/DPAPI 및 3개 fixture 스레드의 동시 final·Stop·재개 흐름이 포함된다. 설치 검사는 약 144초였으며 3개 스레드 시나리오는 약 82초였다. 이는 기능 검증이며 실서비스 지연 기준 통과나 성능 개선 수치를 의미하지 않는다.

패키지: `C:\ai\codex\artifacts\codex-discord-bridge-ts-20261018-alpha4\codex-discord-bridge-ts-0.1.0-alpha.4.tgz`

SHA-256: `5de7a59dc0d1fee4789311306f8c4666afc64a102950955588cc69e728654058`

## 범위와 남은 검증

R1은 MCP project binding의 쓰기 차단 문제다. 과거 Discord job/Stop DB 잠금 사고의 원인까지 동일하다고 입증한 것은 아니다. R2는 새 별도 OAuth/MCP 서버 경로이며 모든 Discord bot 요청이 이 worker를 통과하지는 않는다.

이 문서 작성 시점에 Pro 검수는 미제출이다. 코드·로그·manifest를 `.runtime/pro-review/alpha4/`에 고정하고 별도 review-state에서 제출과 실제 판정을 구분해 기록한다. 내장 browser/Node kernel은 assets path 오류가 있지만 Simdorei Local Project Oauth의 컴퓨터 유즈 연결은 확인됐다. Chrome의 다른 작업과 조작 충돌이 관찰되어 사용자와 조정 중이다.

이번 변경으로 전체 Rust 의미 동등성, 실제 Task Scheduler/reboot/cutover, 실서비스 Discord/ChatGPT end-to-end를 입증하지 않았다. 기존 F06 append/restart 전체 prefix 검증 비용도 그대로다. 기존 별도 helper 검사에서 발견된 Windows fixture 관련 3개 실패(CRLF hash, symlink EPERM, regular-file root Content/Io 차이)를 전체 통과로 바꾸어 보고하지 않는다. 현재 기능 프로필의 helper 검사는 통과했지만 그 별도 검사 전체를 이번에 다시 실행한 것은 아니다.

실행 중인 봇, 운영 DB, 시작 예약, 브라우저 설정은 변경하지 않았다. npm registry 게시, 배포 전환, commit/push/merge도 수행하지 않았다.
