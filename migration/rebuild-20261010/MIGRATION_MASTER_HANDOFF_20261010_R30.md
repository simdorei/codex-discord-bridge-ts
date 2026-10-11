# 마이그레이션 통합 보존 문서 R30

작성: 2026-10-11 15:17 UTC. 아래 R29 원문 전체는 변경 없이 보존합니다. 최신 상태는 이 머리말이 우선하며, 이전 기록은 당시 시점의 증거입니다.

## 현재 실제 구현과 검증
- 로컬 적용 커밋: 4f44d439998baef7e855df9ebda18fa93941aecf (613).
- 파일 읽기 합본: 실제 POSIX 파일 바이트 읽기 → 엄격한 UTF-8 → Rust 줄 선택 → 비밀값 가리기 → 원본 바이트 SHA256. 취소/시간초과 시 원문 대체 응답을 반환하지 않습니다.
- 순수 CPU 작업만 종료 요청할 수 있는 별도 API를 추가했습니다. 기존 파일/DB 작업의 취소는 실행 중인 작업의 종료까지 소유권을 유지합니다.
- 합본 검증 stage의 컴파일 JS 전체 7,300 PASS / 실패·취소·skip 0, 675개 테스트 파일, 280189.935906ms. 모든 자식에 NODE_OPTIONS=--no-strip-types 적용.
- 실제 적용 후 src/test 1,431개 파일 모두 검증 stage와 SHA256 일치. 실제 루트에서는 집중36 PASS, strict TS exit0, production build exit0. 전체7,300 실행 위치는 stage이며 실제 루트에서 같은 전체를 재실행했다고 주장하지 않습니다.
- 최초 셸 glob 실행은 400파일/4,875 PASS인 부분 검사였습니다. 이를 전체로 취급하지 않았고, 명시적인 재귀675파일 전체 실행으로 바로잡았습니다.
- 앞선609는 실제 컴파일 전체7,273 PASS, 실제 source 집중40 PASS, strict TS0입니다. 이전606 source 전체7,273과 프로필을 구분합니다.

## 유니코드 반례와 수정
- Node24.21.0 Unicode17과 고정 Rust regex1.13.1/regex-syntax0.8.11의 Unicode16 문자표 차이로 U+088F 뒤 password 필드가 가려지지 않는 반례를 적용 전에 재현했습니다.
- 동일 테스트 SHA e5b0cdb7883dfd812e5be6e482f739f4d1b20c5cb3575046774c0e8ca61020e5: 이전 후보 RED1, 교정 후보10 PASS.
- 공식 Rust regex 태그의 word796개 구간/space10개 구간을 고정하고 ASCII 대소문자 접기에는 Kelvin/long-s 대응을 명시했습니다. MIT 고지도 보존합니다.
- 1,112,064 Unicode scalar 전체 문자표 대조와 버전 차이4,699개의 password 앞 경계 검사를 통과했습니다. 이는 공식 표와 TS 실행 대조이며 Rust 실행파일 differential oracle은 아닙니다.
- 원시 RED/GREEN, 고정 표와 해시, 검증 로그는 로컬 .runtime/rebuild-611-remote-redaction 및 rebuild-613-remote-read-file-qualification에 보존했습니다. 원시 로그 외부 업로드는 하지 않았습니다.

## 원격 보존: 제품 소스 전체, 테스트는 1개 제외
- 원격 커밋: 4b88cbcaed0f045bb48f10989f96421b5da0d654.
- root tree: ba3169de1c29d207e00a01cb9729501a6058dc9a.
- src tree: bfbe852204b3d5c3e0f7ba8fa87f49002cf29bbf. 실제 로컬과 정확히 일치합니다.
- 원격 test tree: 25c2cfd9086b5a2de7673995c8b423e5cc81ee70. 로컬 test tree: eea30a0ee2e471244408e8e0818ad5f24b7be44d.
- 유일한 제외: test/remote-agent/redaction.test.ts. GitHub가 합성 AWS 테스트 문자열을 비밀키로 감지하여422로 거부했습니다. 해당 파일은 로컬 커밋에 보존하며 재시도·인코딩 변경·대체 전송·검사 해제를 하지 않았습니다.
- 나머지 원격 test697개 blob의 경로와 SHA를 로컬과 독립 대조하여 추가 차이가 없음을 확인했습니다. 따라서613을 완전한 테스트 백업 또는 원격 전체시험 PASS라고 부르면 안 됩니다.
- 이전 완전 보존609: 32b17de2306aab7c084be10db7732460f4007f3d, root ff89581473601cb5872e5bdbeebdd2dc42af1790.
- 공식 처리 설명: https://docs.github.com/en/code-security/concepts/secret-security/push-protection-from-the-rest-api . 현재 연결 도구에는 정식 오탐 승인 동작이 없습니다. 이 보존 한계는 구현 진행과 별도로 남깁니다.

## 운영·복구 한계와 다음 작업
- 전체 remote 오류 분류/외부 메시지 일치, 실제 프로젝트·세션 권한 및 dispatcher 연결, 파일 목록·쓰기·삭제, Windows UI/터미널/보호된 handoff, 실제 singleton, standalone runtime entry와24시간 운영은 완료되지 않았습니다.
- POSIX 파일 소유자는 악의적인 rename-and-restore와의 원자적 격리를 입증하지 못했습니다. Windows 핸들·재분석지점·프로세스 격리도 미검증입니다. 원격 권한을 활성화하지 않았습니다.
-601에서 발생한 V8 네이티브 SIGTRAP은 원본 실패와 무변경 재시도 통과를 모두 보존합니다. 컴파일 프로필 통과가 엔진 자체의 일반적 해결을 입증하지 않습니다.
- Rust 원격 main은15:06 UTC dfec7dfb55e01516ad6d48a67a4aff4072d6150e로 이전 확인과 동일합니다. 고정 구현 authority4e213aa69dc89bed1552d8b83e12471d7664b7ae와 최신 원격 차이를 혼동하지 않습니다.
- 원본 두 작업 폴더는15:10 UTC 현재 접근 가능한 파일시스템에 여전히 없습니다. 영구 손실을 확정한 것은 아닙니다.
- 지원 사건16911035:14:17 수신에14:23 답장 완료.15:03 확인까지 추가 수신 없음. 담당 기술팀·저장소 발견·보존 완료·추출 가능 여부·ETA는 아직 확인되지 않았습니다. 별도 재구현과 원본 복구 요청을 함께 유지합니다.

---

# TS 마이그레이션 통합 인계 문서 R29 — 2026-10-11 14:24 UTC

R28 전체와 그 안의 R1–R27, 사용자 필수 이전 명세 및 추가 버그 지시를 아래에 바이트 그대로 보존한다. 테스트 통과와 원격 소스 보관은 전체 운영·Windows·24시간 안정성·배포 승인이 아니다.

## 최신 실제 소스 검증과 원격 보관

- 598: 실제 원격 WebSocket 연결 소유자, 제한된 메시지 크기와 읽기·쓰기·취소·종료. 전체 7,240 PASS. 원격 c0ec0579342538d8335364b900678754e0007582.
- 599: 실제 소켓 개설 → protocol10 hello/요청 → 수락 작업 drain → 세션 retirement → 소켓 close → 다음 generation 재접속을 연결했다. 전체 7,250 PASS / strict TS0. 로컬 0db57f0e1c677d040a422c597c61688b0dfeeb55, 원격 256c3189f6c6b188fcb382ddcf5cf4097d3f0867. Concrete project dispatcher와 실제 프로젝트 권한 구현은 아직 완료되지 않았다.
- 601: 민감 경로·상대 경로·glob 순수 정책. native 경로 원문을 보존하고 표시용 슬래시 변환을 별도 함수로 분리했다. 32,768 UTF8 bytes / 4,096 segments / 8,000,000 work cells를 넘으면 전체 요청을 거부하는 TS 제한을 명시했다. 이는 전체 파일 접근 구현이 아니다.
- 601 마지막 변경 없는 재실행: 전체 7,259/7,259 PASS, 실패·취소·skip0, strict TS0. 로컬 2b5355af814b3ce5cba104f6e2666e7e3359d2d4, 원격 437d1a98fbfc0bec84f7db056cda01cea38a6b0e, root tree afdf29c3fdddeeb05ed2f5eefbacfc89da4166f7, src 9fbc4ac6e732ded81700ba6ed940e95d233bb09e, test 30511d4e43795eaea8ef014b4bb31c00c877c121. GitHub ref/tree를 독립 GET으로 대조했다.
- 원격 게시 범위는 소스·테스트·작은 검증 요약이다. 원시/압축 로그의 외부 업로드는 별도 승인 전까지 하지 않는다.

## 중요: 간헐적인 Node native engine 실패가 새로 확인됨

601 최초 전체 실행은 7,258 PASS / 1 FAIL / exit1이었다. diagnostic-report.test.ts의 마지막 병렬 worker 시험 중 SIGTRAP이 발생했다. TAP 원문에는 `jit_page_->allocations_.erase(addr) == 1` 및 `ThreadIsolation::UnregisterWasmAllocation` 스택이 남았다. 원본은 .runtime/rebuild-601-remote-file-policy/initial-full-failed에 보존했다.

현재 고정 Node24.21.0 / V8 13.6.233.17-node.53와 같은 증상을 보고한 공식 저장소 이슈: https://github.com/nodejs/node/issues/66366 . 이는 관련 선행 보고이며 로컬의 정확한 트리거와 수정 완료를 독립 입증한 것은 아니다. 변경 없는 진단 시험 12회(각7개)와 이후 전체 7,259개가 통과했어도 간헐적 엔진 오류가 해소됐다고 판정하지 않는다. 이전570의 같은 파일 실패는 스택이 없었으므로 같은 원인으로 소급 확정하지 않는다.

운영 qualification은 계속 보류한다. 보안/JIT 보호 플래그를 완화하거나 Node 버전을 임의 교체하지 않았다. 사용자 요청인 안정적인 Node 기반 TS 구현을 계속한다.

## 진행 중인 606: native read owner 및 사전 컴파일 실행 경로

- POSIX read owner 후보: 실제 열린 root descriptor와 identity, no-follow 부모/leaf, single-link regular file, 최대1MiB·256경로구성요소·동시4읽기, 수락된 읽기 종료 후 owner close. 임시 파일만 사용한 11개 시험과 strict TS0.
- root를 악의적으로 바꿨다가 복원하는 경쟁에 대한 atomic confinement 증명은 없다. Linux 파일 검사만으로 보안 sandbox나 Windows share/reparse parity를 주장하지 않는다. Native Windows는 효과 발생 전에 명시적으로 거부한다. 이 owner는 remote dispatcher에 활성화하지 않았다. write/delete/list/redaction은 아직 범위 밖이다.
- 사전 컴파일 후보: tsc가 .ts import를 .js로 바꿔 dist/src에 생성한다. 중앙 OwnedWorkerSlot이 compiled .js로 실행될 때에만 local worker .ts URL을 .js로 고르고, 없으면 source로 fallback하지 않는다. source 실행 경로는 유지한다.
- `node --no-strip-types`로 진단/worker 소유권19개 + 추가 DB·remote decode 등75개, 총94개 고유 시험이 통과했다. initial compiled18/19 실패는 data-URL 시험 fixture에 남은 literal .ts import 때문이었으며 원본 로그를 보존하고 URL만 수정했다. worker budget assertion은 유지했다.
- 실행 중 TS stripping 의존성을 제거하는 프로필이며 V8 오류를 완전히 수정했다는 주장이 아니다. 전체 compiled graph, 완성된 main entry, native Windows와 24시간 운영은 미검증이다.
- 606 실제 root 적용 후 strict TS0 / focused39 PASS / production build exit0. 전체 회귀 실행 중이며 아직 606 full PASS나 원격 소스 보관 완료가 아니다.
- 다음 파일 출력 단계는 Rust Unicode word/whitespace/casefold 및 12개 마스킹 순서를 보존해야 한다. JS regex로 단순 치환해 원문을 유출하거나 실패 시 raw content로 fallback하지 않는다. 계획 .runtime/rebuild-603-remote-redaction-plan/PLAN.md. 아직 redaction 구현 완료가 아니다.

## 복구 및 지원 메일

- 기존 두 작업 폴더는 2026-10-11 14:09 UTC 재확인에서도 현재 파일 시스템에 없었다. 원본 영구 삭제나 복구 불가능을 확정하지 않는다. 별도 재구현은 원본 복구가 아니다.
- 최신 Rust main 2026-10-11 14:09 UTC 재확인: dfec7dfb55e01516ad6d48a67a4aff4072d6150e, 변화 없음. 현재 frozen authority는 4e213aa69dc89bed1552d8b83e12471d7664b7ae이며 최신 차이를 기존 명세대로 별도 이행한다.
- 지원 사건16911035: Eddie의 2026-10-11 14:17:48 UTC 새 메일(1a12b53bb235c177)은 기술 담당자 배정·저장소/스냅샷/로그 발견·보존 완료·재연결/파일 추출 가능 여부를 모두 아직 확인하지 못했다고 밝혔다. 추가 사용자 자료나 반복 로그 제출은 요청하지 않았다. 지원팀의 담당자 배정과 저장소 평가를 기다리는 상태다.
- 14:23 UTC 동일 스레드에 회신 SENT(1a12b58c1b5f3458). 우선 처리, 담당 팀 배정 여부와 확인된 다음 업데이트 시점, 원본을 초기화/덮어쓰지 않는 복구 검토를 요청했다. 확인된 복구 진전이나 ETA는 아직 없다.
- Slack 진행 보고와 사용자 요청에 따른 지원 메일 후속 확인을 계속한다. 다른 에이전트/코덱스 검수 위임 없이 현재 root가 구현·검수한다.

---

## 이전 R28 전체 원문 보존

# TS migration master handoff R28 — 2026-10-11 13:48 UTC

This update preserves every byte of R27 below. Its older status statements are chronological evidence, not the current checkpoint. The Pro-reviewed requirements, user constraints, known losses, rejected candidates, source provenance, review limits and original raw failure evidence remain retained. This document is not runtime, Windows, 24-hour or deployment approval.

## Current independently preserved baseline

- Actual checkpoint596: 7,227 / 7,227 PASS, zero failures, cancellations or skips; strict TypeScript exit0. Focused26 PASS. Node24.21.0; full file concurrency2. Actual full duration351644ms.
- Local committed source: 21e4d6059b03cbf983a232052b4990472807707e.
- Remote source preservation: 39d01b9895409156ec0f064177e96fe5f89f24a7, branch sss/async-admission-cloud, draft PR1.
- Independently reread root tree6893f37adfa4db5f2b570bbbf36bb0bde25edaee, src6eb40fc73edfa8ab69df111bcb46aafa4dd5acff, test5542c11fd4eb177bd72e747ca53d6d57b87dcd1a. Both source trees exactly match the committed local baseline.
- Prior preserved checkpoints: 5817199 (cd0b4630f7eac7459b579a7a40707f3561fbfed8), 5877215 (ab3cc49b4e33c9655f9fae6e286be1a6089ab740), 5927224 (59b429a8dff4a87295a4643fad1bc0997de49f46). Checkpoint5847210 and5887218 were independently executed locally and incorporated into later preserved source trees.
- Source/test preservation plus small summaries only. Raw and compressed logs remain local because their upload requires separate approval. No broad git add, force push, main merge, deployment or service restart was performed.

## Native path parity corrections now verified

Actual POSIX fixtures showed that Node path.resolve/path.join and JavaScript realpathSync can select a different lexical sibling when a symbolic link is followed by '..'. This was observed with different DB rows, file bytes, manifest versions and receipt directories, not merely inferred from strings.

1. Common read-only SQLite opening retains raw native path components in an explicit-empty-authority file URI. Repeated leading slash no longer becomes a URI hostname. Migration backup remains beside the actual native source, with invocation cwd captured before asynchronous native work. Windows URI behavior remains unqualified.
2. Startup storage, reserve retirement, ingress recovery and mirror policy use the same native spelling. Whole startup with an actual synthetic resident child verifies the original physical DB and joins child exit. Codex reference, archive row digest, native history targets and new-reply readers received corresponding corrections.
3. Persisted mirror anchor v1 retains its original normalized-path contract and exact bytes. A v2 anchor accepts only non-normalized absolute native spelling. Old lexical-sibling cursor bindings remain held, without automatic reset or adoption. New anchor, cursor, receipt and discovered-job owners use coherent paths. Native SQLite plus synthetic HTTP fixtures verify correct-file send, EOF non-retransmission and different-DB owner refusal. A new-reply inspection regression verifies partial-line persisted v2 continuation, exact first-input identity and revalidation.
4. Abandonment database identity and plugin fingerprints use native canonicalization, matching the inspected Rust canonicalize call. The same three tests failed against the old implementation and passed after correction; the bounded Pro/abandonment suite passed131 tests. This does not certify hostile concurrent path mutation or secure-root containment.
5. Bridge-state exclusive temporary files are created beside the native destination, preserving fsync/rename and identity-checked cleanup. Diagnostics read the actual adjacent session/global files. Attachment envelopes and downloads retain native paths and pin relative destinations before invoking asynchronous transport. Existing size, required-input, partial-file and oversize-cleanup policies remain unchanged.
6. Pro manifest and skill wire paths retain the selected root spelling. Tests use an actual synthetic RPC child and fixture inventory; no reviewer/model/browser is invoked. Repair receipts stay beside the actual native store while preserving original ingress checks, target locks, durable mutation custody and unknown-outcome holds.

Remaining path audit items are recorded separately: relative paths across Pro or diagnostic worker waits and the optional reference-reader bridge path need bounded source/custody review. The fingerprint child join occurs under an already native-canonical root; its presence alone is not evidence of a defect. These fixes are not a claim that all platform path behavior is complete.

## Active work at this document timestamp

Checkpoint598 native remote WebSocket source is on the actual working tree but its full regression has not completed at this timestamp. The existing gateway socket engine is reused rather than duplicating socket/agent/read/write/disposal ownership. The new explicit remote profile has source-compatible wss or loopback-ws destination rules, validated Bearer header, no redirects, normal TLS checks, ten-second opening deadline,12,000,000-byte inbound message cap and fixed ws fragment/chunk budgets. The existing Discord destination allowlist and no-header profile remain intact.

Actual local synthetic-server socket tests passed32. Broader remote-agent plus gateway focused tests passed391 and strict TypeScript exited0. They cover header delivery only to the chosen fixture endpoint, binary refusal, ping/pong payload, exact12MB boundary and overflow refusal, concurrent I/O rejection, cancellation, real socket cleanup and unrelated-connection survival. No user token or external service was used. An actual open-completion cancellation race was reproduced separately for both remote and gateway factories, then corrected before transferring ownership. Initial optional-field validation failures and a nondiscriminating first race probe remain recorded; final race tests distinguish the client opening event.

The ws engine owns automatic pong writes, an explicit adapter scheduling difference from Rust's receive-loop pong. Stream backpressure and a per-message cap do not establish an absolute process-memory bound. Native Windows, real authenticated service, protected filesystem, LocalProjectDispatcher, terminal/UI resources, managed restart handoff and24-hour operation remain unqualified.

Candidate599 composes actual socket opening with existing protocol10 hello/ack, bounded command execution, accepted-work drain, retirement, disconnection and joined native disposal. Its dispatcher is still an explicit fixture/caller port. It is not yet part of the verified applied baseline. Native loopback lifecycle and repeated reconnect tests are being executed; no result is presumed in this document.

## Source and operational boundaries

- Frozen migration Rust authority remains4e213aa69dc89bed1552d8b83e12471d7664b7ae. Remote Rust main reread13:36:48UTC remainsdfec7dfb55e01516ad6d48a67a4aff4072d6150e. Existing documented parity deltas and user-required stale Stop isolation remain binding.
- The original POSIX singleton Unix-socket EPERM is unresolved. Both ordinary and approved escalated attempts failed; the rejected alternate paths are not retried or bypassed. No unlocked singleton fallback is supplied. Windows native mutex/handle/share/reparse guarantees are still missing.
- package.json still explicitly identifies an in-progress migration, with no standalone production main. Prepared worker/lifetime and native transport fixtures do not prove a deployable bot. Real remote dispatcher and protected managed handoff remain substantial unfinished work.
- Keep the first failed checkpoint570 regression retained:7149/7150, diagnostic file-level failure of unresolved cause. Subsequent unchanged isolated/paired/full passes do not erase that failure or establish its cause.
- User principles remain: single state access ownership, central error handling, TS-owned restart decisions with thin platform scripts, typed Discord/Codex boundaries, thread isolation and restart tests. Manual Reserve only. Archive100 targets/11pages is a bounded complete-operation snapshot, not a stored-archive quota.

## Original workspace recovery and support

At13:39:33UTC both original recovery directories were still absent. No original path was recreated, reset, deleted or replaced. Reconstruction is not recovery, and permanent loss is still not proved. No destructive search or session-directory access occurred.

Support case16911035 remains open. The requested follow-up was actually sent at04:20:08UTC, Gmail message1a12930861d4fa9d, to support@openai.com in the original case thread. A case-wide search at13:28 and thread read at13:41 found no newer incoming reply; the latest incoming remains1a12807fb38cac95. No confirmed preservation, recovery result or ETA has been received. Standing authorization permits substantive case replies, not duplicate unchanged mail or unrelated disclosures.

## Immutable prior document

R27 SHA256875d31f1c662cac4266807c0378927661e30318be4b5147e0a647f2272afc0c1,262700bytes, begins below without modification. All earlier nested versions remain intact.

--- BEGIN EXACT R27 ---

# Migration master handoff R27 — 2026-10-11

This is a source and evidence handoff, not runtime, Windows, performance, operations, or deployment approval. The complete R26 document follows byte-for-byte. Earlier requirements and limits remain in force; historical checkpoints do not describe the current applied tree.

## Verified changes since R26

- 570: callable CLI maintenance composes actual environment loading, bounded native path discovery, temporary owned app-server readiness and actual disposal. Admin/help precede environment, readiness precedes bot config, check-config precedes backup. First aggregate execution had one unexplained diagnostic-report test-file failure (7149/7150); original output had no useful stack/exit detail. Unchanged diagnostic tests alone, five paired runs, and the unchanged complete retry passed7150. Initial RED is retained. Cause is unresolved; the successful retry does not prove that initial failure harmless. All subsequent aggregate runs retain both spec and TAP.
- 571: default native directory discovery uses async opendir with fixed buffering and at most10000 raw entries and4MiB raw filename bytes. Invalid UTF8 still consumes budget; later read/budget failure rejects the whole result. Actual handle close failure retains exact owner for cleanup. PATH input is limited before split and supports at most4096 components with source Windows quote behavior. Two actual old-source regression tests fail and the same tests pass on the correction. Actual full7158/7158 and strictTS0. These are explicit finite adapter limits, not exact Rust error-filtering parity, a CPU bound, or Windows filesystem qualification.
- 573/574 candidate: actual native cutover SQLite snapshot and CLI integration initially passed7171 tests. An additional real symlink/.. counterexample then proved that Node lexical path normalization copied the wrong database. That candidate was held and never published as the final source. The passing old suite did not override the demonstrated defect.
- 575: correction reuses raw PathBuf-compatible joins for source, directory and worker target. Same final test fails on the old code with wrong versus correct marker and passes on the corrected source, including physical output-directory checks. Actual full7172/7172, strictTS0 and focused21. Source and tests were preserved at remote924b59173eca51896bcee24a113f64050e094dec, rootc5e8f080b193111680d19cfe08f294f8f3ca17a8, srcf93d51dc373ef3a98b9aed483fb49fb8c50c95c3 and testa5b26f7b275951fec5343fdcc30d52ce85c4fd27; independently reread ref/tree equal local commit2d31023aa3ce947d76d7fb8a35484c4077e2295a.
- Native backup opens only an existing readonly source, checks integrity and lossless schema version, includes committed WAL data via SQLite backup, creates a unique exclusive target, verifies copied integrity/version, and returns only after actual native worker exit. It never initializes or migrates source. Timeout/abort retains an unconfirmed attempt identity and waits for native ownership to end; no automatic retry or fake success. Existing destination collisions preserve foreign bytes. An actual cancellation after target creation removes the owned incomplete main target. Future schema versions are permitted when copied version equals source, as in the standalone Rust snapshot.

## Backup and path limits still open

- Controlled private portable paths only. SQLite opens a pathname; exclusive creation plus dev/ino checks is not an adversarial secure-root/TOCTOU guarantee. Native Windows cutover backup is explicitly unqualified.
- Readonly WAL validation can create matching -wal/-shm sidecars. Do not claim zero filesystem changes or certified partial-sidecar cleanup.
- Cooperative backup cancellation checks progress and joins worker exit; it cannot interrupt every stat, integrity scan, or blocked native call. There is no absolute termination-time proof.
- Bounded worker diagnostics preserve phase/name/message and attempt identity, not original Error object identity across workers. Full outcome-reconciliation APIs, exhaustive source-version-race and injected close/validation failure coverage remain incomplete.
- Configured environment paths were inspected for the same lexical-normalization defect. Their correction and pure admin parser are recorded in the later checkpoint below; do not infer unexecuted admin effects from parser recognition.

## Latest verified checkpoint578

Actual full7182/7182 PASS, zero fail/cancel/skip, strictTS0 and focused47. Pure admin args recognize16 command identities with exact option families, lazy UTF8 error order, duplicate/mutually exclusive flags, attachment separators and raw repo-root joins. Parsing does not execute those commands. Explicit/default environment path regression tests both fail on old lexical-normalizing code and pass unchanged on source-compatible raw-path code; final test SHA a412a8e7cccd472a344f90779a275118406a5cd81e4173321792df758818a37d. Existing environment byte/entry/output limits remain. Native POSIX traversal is tested; Windows filesystem and Rust executable oracle are not.

Local0818fca46eaa9d7e4f455a3dcf5d25af993961d1; remote52a2135dbcad9bbe641588208e44ae5d484e1f53; root2f0824703126aaa4b9dcf9d9bfaaa576e1fd3221; src9d17617a318c8eea2c7b12fbe7858ae5a68f5dc8; test35c5732e2f157691c1adc402b068328808f751a7. Independent ref/tree check completed.

Next579/580 actual admin readonly active-queue-count and standalone backup CLI are applied locally under test, strictTS0/focused72, full regression still running at12:51UTC. They are NOT included in the verified7182 source snapshot or remote commit and have no final PASS yet. Other admin/gateway branches remain plans.

## Recovery and preservation

Original 2026-10-08 recovery workspace and tool paths were still absent at2026-10-11 12:36UTC; neither was recreated or overwritten. Support case16911035 remains open. The authorized reply was sent at04:20:08UTC; the latest thread check12:48UTC still showed that own SENT message, with no newer incoming response. Preservation/recovery/ETA is not confirmed. Separate-folder implementation is not restoration of lost work.

Latest Rust remote main was independently reread at12:36UTC and remained dfec7dfb55e01516ad6d48a67a4aff4072d6150e. Frozen full-authority baseline remains4e213aa69dc89bed1552d8b83e12471d7664b7ae; equality of selected inspected files is not whole-latest-Rust parity. Pro requirements remain the original19379-byte document; its PASS was document/plan-only.

Only approved source, test summaries and user-requested master documents are preserved remotely. Raw and compressed logs remain local pending separate approval. Every publication uses expected-parent compare-and-swap and independent ref/src/test-tree verification. No force overwrite, main merge, live DB, service restart, production login or deployment occurred.

## Remaining operational boundaries

Package still says in-progress and not ready to run. A callable maintenance branch is not a complete bridge executable. Native singleton/Windows mutex and resident process containment, remote dispatcher/protected filesystem and authenticated handoff composition, full gateway/runtime startup and Windows24h performance remain incomplete. The denied singleton socket operation is not bypassed through another transport or an unlocked startup. Test totals are executable regression evidence, not implementation percentage. Continue root-direct implementation and review; no engineering delegation, no masking bypass, and no change to the fixed denial hook.

---

## Complete unchanged R26 historical handoff

# Migration master handoff R26 — 2026-10-11 11:56 UTC

Immutable continuation of R25. The complete R25 bytes and all earlier requirements/history are retained below. This prefix supersedes only the historical status statements it explicitly updates. Regression counts are not completion percentages, operational certification or deployment approval.

## Latest verified and independently preserved source

Checkpoint569 actual full run: 7,143/7,143 PASS, failures/cancellations/skips0, strict TypeScript exit0, focused73 PASS. Full duration333,138ms, file concurrency2. Eight new tests use actual isolated Node JSON-RPC child processes and SQLite fixtures.

- Local commit b189fdd640aa6e02c53aefdefdec9e3d39d2def2.
- Remote branch sss/async-admission-cloud commit77341fb46acdcb792dbcd407c24c96d84260c047.
- Remote root tree04c4f783be1841c3ed9a03916bda1d0491e87327.
- Exact committed-local/remote src treeb4baf53efc5b70f9d95cd1237ab28e0e21a3c845.
- Exact committed-local/remote test tree2ea6190768fb8b87043e645c9f13810fc65ce096.
- Independent post-publication ref/tree reads verified11:55UTC. Only source, tests and bounded preservation summaries were uploaded. Raw/gzip logs remain local pending separate approval.

## Implemented since R25

564: actual7,110 PASS/TS0. Bounded volatile mutation result cache preserves exact thread/session/request identities, canonical root-excluded fingerprints, conflict and LRU semantics. Native hashing/serialization/decoding share the existing owned worker lane. Default256 entries,4MiB conservative retained-text charge,1MiB frame,4096-code-unit identity fields. Input and result DTOs must be immutable before the first await; a real RED test exposed delayed validation, and the same final test bytes passed after correction. Overbudget results are explicitly not retained, never permission to execute again. This remains an in-memory replay cache; a future dispatcher must serialize the whole lookup-execute-remember sequence. It is neither a durable receipt nor crash-safe exactly-once execution. Independently preserved remote262939495e826e58d010b215b2acecfc55188193.

565/566 combined: actual7,120 PASS/TS0, focused155. Passive thread-state classification no longer reads inherited descriptor get/set fields: two isolated executable regressions reproduced eight getter calls each before Object.hasOwn(data-value) gating. Restart snapshot reading now refuses beyond10000 shared rows,64KiB per raw SQL field,4MiB cumulative input or4MiB retained JSON output. SQL LIMIT and CASE projections bound JS materialization, and incremental output charging happens before retaining a new result. NULL/storage-class and UTF16 checks remain strict. Exact boundaries and malformed state are covered; no prefix can become Ready. This does not bound SQLite ORDER BY CPU or its internal sort memory, add transaction isolation, or authorize legitimate overbudget state to restart. Latest and frozen selected Rust store-readiness sources were independently compared as equal. Remote4426f74555e37d2269a783f43d8be8058a2d9e13.

567/568 combined: actual7,135 PASS/TS0, focused131. Concrete restart inspection uses central StateAccessFacade native SQLite snapshots and actual thread/read(includeTurns=false) through the owned resident generation. Source ordering is durable blocker first, one wall-time sample, ordered thread metadata checks, then an exact second durable snapshot. Existing classification and own-data validation are reused. Polling preserves source inspect-first semantics even with zero wait, Ready wins if the completed check is ready, and a blocked check at expiry retains its reason. Polling uses lossless u64 nanoseconds and bounded monotonic waits, pins the same resident generation across the entire operation and never treats timeout as native termination. A real fixture initially omitted the mandatory maintenance adapter and correctly failed; the product guard was preserved and the fixture corrected with a retained negative test. Real across-poll resident replacement was not newly demonstrated; static generation-pin review and existing owner tests remain distinct. Remote78137d5a489f8d2322b8e96d0fa44ccec179f602.

569: actual7,143 PASS/TS0. Callable runOwnedRestartReadiness owns a temporary non-Windows app-server from initialize/initialized through read-only polling and actual process/pipe disposal. It captures config/options before spawning, preserves native inspection or cancellation outcomes, and gives cleanup errors precedence while retaining the earlier error and exact session for explicit retry. Real fixtures cover Ready, blocked zero-wait, bad thread data, missing DB without creation, unanswered initialize timeout, no-spawn validation, cleanup failure retention/retry and post-call configuration mutation. Startup cancellation has a separate close-time cleanup reserve; expiry invokes the existing non-returning fail-stop policy instead of claiming a child exited. That reserve is an explicit Node adaptation from Rust future timeout/drop. Production fail-stop was not invoked by these tests. Actual Codex model service, Windows Job Objects and descendant containment remain unqualified.

## Current integration boundary and next work

CLI preflight, prepared local workers and prepared lifetime now exist, but package.json still explicitly describes an in-progress bridge and there is no runnable whole-product main. Next integration should connect source-backed maintenance branches and remaining runtime ownership without weakening singleton, maintenance, generation or durable authority checks. The earlier native singleton socket EPERM remains a genuine unresolved test/environment boundary; no unlocked fallback, alternative transport or permission bypass has been introduced. Native Windows singleton/process/handle contracts, real authenticated remote transport, LocalProjectDispatcher effects, protected handoff/session resource creation, full end-to-end Discord/Codex operation, performance and24-hour qualification remain open.

The cache and snapshot caps are explicit bounded operational profiles, not a promise of bounded total heap/RSS or SQLite CPU. Archive100-descendant/11-page completeness bounds apply to one requested subtree operation, not total archive storage. No automatic Reserve restoration or known-unknown replay permission was added. Root implements and reviews directly; unchanged aggregate tests are not repeated just to produce progress updates.

## Requirements, authority and recovery

Keep the Pro-reviewed document migration/rebuild-20261010/requirements/ts-runtime-parity-pro-reviewed-20261007.md,19379bytes,SHA256a0799cfa3d7419a45e7003e1f579167a05dcdca0a8709dc4f891e7b0ac04bb72. Its PASS is document/plan-only. Preserve central state access and error taxonomy, TS restart policy, typed boundaries, per-thread isolation/fairness, durable request-before-ack, actual native termination and ownership accounting, bounded rows/bytes, uncertain-outcome reconciliation, and the later stale stop-record correction.

Frozen Rust authority remains4e213aa69dc89bed1552d8b83e12471d7664b7ae. Latest remote main remainsdfec7dfb55e01516ad6d48a67a4aff4072d6150e as independently read11:36UTC. Individual selected-source equality is not whole-delta parity. No Rust executable oracle is installed. No main merge, live service restart or deployment was performed.

Both original recovery folders were still absent11:36UTC and were not recreated or overwritten. This reconstruction is not original-storage recovery, and permanent loss remains unproven. Support case16911035 remains open. Requested follow-up was actually sent2026-10-11 04:20:08UTC; thread reread11:54UTC still showed that sent message as newest. No new incoming reply, confirmed preservation/recovery or ETA is available. Continue bounded replies to substantive support responses, without duplicate unchanged follow-ups.

Preserve this revision and every prior revision. Continue source-only immutable checkpoints and substantive five-minute updates in the existing Slack migration thread.

---
## Historical R25 retained byte-for-byte below

# Migration master handoff R25 — 2026-10-11 11:09 UTC

This is an immutable continuation of R24. The complete R24 bytes, including earlier revisions and reviewed requirements, are retained below. New statements supersede historical status only where specified. Test counts measure regression coverage, not migration percentage or deployment approval.

## Verified checkpoint 563

- Actual full run: 7,100 / 7,100 PASS, zero failures, cancellations or skips. Strict TypeScript exit 0. Focused integration suite: 74 PASS. Full runtime duration: 330,037 ms, two test files concurrently.
- Local commit: cf0740a609c6dd9e2ebf9fe1525476b3c72b66b8.
- Independently read remote branch sss/async-admission-cloud: ff51cf52e519b89f94fdb4d8b1699b70af72d83f.
- Remote root tree: cbb39558951597b345ea642ecd64e3c8722e6959.
- Committed local and remote src trees match: c72ce4b8196eccfc15cf6b657a9dd80d3cca0a4a.
- Committed local and remote test trees match: 00500cdd1f241d1be2f2c61a7caa1c85bed1381a.
- Ref/tree verification completed at 11:08 UTC. Source-preservation-563.json contains the bounded source summary. Raw/gzip test logs remain local and were not uploaded.

## Changes since R24

- 554: completed sequential reconnect ownership, actual 7,060 PASS. Generation increments saturate u64; a new connection never begins before the preceding owner settles. Delays use bounded chunks and a monotonic clock. Actual transport creation remains a borrowed port.
- 556/557: completed pure session identity decisions and sequential resource cleanup, actual 7,071 PASS. Stale connection/session generations and conflicting equal generations preserve source error precedence. Cleanup attempts computer, terminal windows and terminals in order, retains failures and coalesces concurrent close calls. Actual native resource creation and dispatcher integration remain pending.
- 558–560: completed explicit environment-file loading and CLI preflight, actual 7,084 PASS. Input process values win; bounded native UTF-8 reads preserve Rust whitespace/quote/first-key semantics. Missing files are allowed only for the source's not-found case. An explicit empty path must remain empty, rather than resolving to the current directory. The same regression failed before and passed after this correction. CLI ordering is admin/help, environment, readiness, configuration, config check, then backup/gateway plan. No standalone process entry is claimed. A malformed reconnect port returning a non-Promise is now a contract failure rather than an endlessly retried transport error.
- 561: actual 7,088 PASS. Core assembly now preserves supervisor, heartbeat, completion, new reply, stop, prompt, optional session mirror, server request order. Heartbeat remains separately owned. Every accepted task, including interleaved heartbeat, is stopped and actually joined on partial startup failure. Optional configuration is captured before worker allocation.
- 562: actual 7,092 PASS. Prepared local assembly connects seven typed ingress tasks, the interaction worker and source-ordered core tasks with one exit channel and bounded interaction queue. Private ownership prevents duplicate use of the same prepared resident or gateway. Remote must explicitly be disabled until its concrete worker exists. Startup failure joins already accepted work before gateway cleanup; it does not close a resident still borrowed by work.
- 563: actual 7,100 PASS. Authentic prepared-worker ownership is bound to the exact gateway, resident, admission gate and database. The runtime lifetime connects real stop selection, native SQLite/resident quiescence, common-deadline gateway and worker shutdown, native resident closure, matching drain acknowledgement/restart and final heartbeat retirement. Foreign gate/copied owner, early heartbeat exit, marker errors and stalled losing I/O have executable regressions. The original selected timestamp controls the shutdown deadline; waiting for losing observers does not reset it.

## Explicit Node adaptation: final drained heartbeat

A new end-to-end test using actual native marker I/O reproduced a false heartbeat timeout after a successful matching drain/restart transition. Frozen and latest Rust worker supervision both reserve one second for abort/join. Applying that reserve again to a fresh one-second final heartbeat budget leaves zero graceful cleanup time. Node heartbeat removal performs real asynchronous file operations and could be marked timed out despite completing within the existing total bound.

Only the final drained heartbeat now uses the exact-worker join path over the existing full one-second total deadline. Expiry still invokes the non-returning fail-stop policy. It does not certify an unjoined task as terminated, extend the total bound or alter ordinary worker-set grace/abort behavior. Real heartbeat failures remain primary when diagnostic reporting also fails. This is a documented Node profile adaptation, not exact Rust error-outcome parity.

The same strict startup-context test SHA, 1d86d68611e4d975c576074f5dc101245485bd2502371836c5a57f6d6b81a99f, failed with the previous finalizer and passed with the correction. Previously permissive test assertions that allowed the false timeout were strengthened. Original RED logs, the exact prior finalizer, the unchanged-test proof and final GREEN evidence remain retained locally.

## Evidence quality and remaining gaps

- Root directly implemented and reviewed these increments. No engineering or code-review delegation was used.
- Tests use isolated SQLite, real native Node worker/process fixtures, POSIX marker files and loopback HTTP. The child is a JSON-RPC fixture, not the real Codex model backend. No real Discord credentials or live service/database were used.
- The current repository still has no standalone main entry. The application must own singleton acquisition, drain/controller, HTTP, resident and gateway construction. Prepared local assembly is not deployment readiness.
- The POSIX singleton socket attempt remains blocked by EPERM. No unlocked marker or alternate permission route was substituted. Windows named mutex, process containment, pinned handles/share modes, destructive archive confirmation and 24-hour runtime qualification remain unresolved.
- Remote protocol and lifecycle infrastructure now cover bounded native codecs, 39 operations, selected-event decoding, bounded command workers, reconnect, pure session decisions and cleanup. Concrete LocalProjectDispatcher, protected project/file access, session resource creation, Windows UI/terminal operations, authenticated connection setup and protected managed restart handoff remain unfinished.
- The Rust dispatcher holds its per-project mutation mutex across replay lookup, execution and remember. Its 256-entry volatile cache is not durable exactly-once evidence. A TS cache must preserve request/thread/optional-session identity and conflict behavior while bounding retained bytes. Fingerprints alone are never authority to execute or proof of successful mutation.
- Full source reads now include remote dispatcher.rs, dispatcher/state.rs, dispatcher/execution.rs and restart_handoff model/validation/storage. Handoff uses Windows current-user protection, strict format/protocol fields, 120-second resume expiry, 128-project and 1 MiB bounds, explicit claim and cleanup. No unprotected replacement is authorized or implemented.
- Checkpoint 561 retained an interrupted exploratory test process after a fixture attempted to alter a frozen prototype. That interrupted run is not PASS or joined-custody evidence. The final fixture used actual native dependencies and explicit cleanup, and final aggregate checks passed.
- No Rust executable oracle is installed. Latest Rust main was independently reread at 11:06 UTC and remains dfec7dfb55e01516ad6d48a67a4aff4072d6150e. Frozen authority remains 4e213aa69dc89bed1552d8b83e12471d7664b7ae. The selected worker_supervision.rs bytes match between both authorities; this is not whole-delta qualification.
- No main merge, deployment, service restart or remote Windows CI PASS is claimed. Unchanged full test suites were not rerun merely to produce a heartbeat.

## Requirements and recovery continuity

The reviewed specification remains migration/rebuild-20261010/requirements/ts-runtime-parity-pro-reviewed-20261007.md, 19,379 bytes, SHA256 a0799cfa3d7419a45e7003e1f579167a05dcdca0a8709dc4f891e7b0ac04bb72. Its PASS is for the document/plan only. Preserve central thread-state access and errors, TS restart decisions, typed boundaries, thread isolation, durable request-before-acknowledgement custody, bounded native work, uncertain-outcome reconciliation and real termination/ownership accounting. Retain the stale stop-record correction and the archive subtree completeness bounds; those bounds are not an archive-storage quota.

Both original recovery folders remain absent at 11:06 UTC. They were not recreated or overwritten. Rebuilding here does not prove recovery or permanent loss of the original storage. Case 16911035 is still open. The requested follow-up was sent on October 11 at 04:20:08 UTC. At 11:05 UTC it remained the newest message; no new support reply, confirmed preservation, recovery result or ETA was available. Continue replying to substantive support updates within the existing case without duplicating unchanged follow-ups.

Preserve this document and all prior revisions. Continue immutable source checkpoints, actual regression checks and substantive five-minute updates in the existing Slack migration thread.

---
## Historical R24 retained byte-for-byte below

# Migration master handoff R24 — 2026-10-11 09:58 UTC

Immutable continuation of R23. The full original R23 is retained byte-for-byte below the historical boundary, including R1–R22 and the Pro-reviewed requirements. This prefix supersedes older status statements only where explicitly stated. Test counts are evidence of bounded regression coverage, not implementation-completeness percentages or deployment approval.

## Latest independently preserved source checkpoint
- Combined552/553: actual7,054/7,054 PASS, zero failures/cancellations/skips; strict TypeScript exit0. Focused remote suite157 PASS. One combined full run, not two independent full runs.
- Local commit3426ad201d4f214bb0397d6a9668bc005486a467.
- Remote commit6e7161951c796aeb1c87eb080ba594a109ba1136 on sss/async-admission-cloud, draft PR1.
- Remote root tree09ae2c1bb0a8f6805fe2be9e76c47978863909c8.
- Exact committed-local/remote src treead57c9a8657bace92dfa5d48b486090e11acec44 and test tree8c27c11dc526feead459a34c3acc89b0ee8697ca.
- Independent ref/tree reads verified after publication at09:56 UTC. Source-preservation-553 retains the summary; raw and gzip logs remain local, excluded from uploads pending separate approval.
- Checkpoint554 reconnect owner is currently applied for validation: focused163 PASS/strict TS0; actual full suite still running at this document's creation. It has no final full PASS or remote-preservation claim yet. Checkpoint555 is PLAN only.

## Completed increments since R23's verified544 baseline
-545: actual7,010 PASS/TS0. Outbound bridge serialization runs in the shared owned native lane with immutable passive DTO capture, final escaped UTF8 limits and actual worker-exit joining. Already serialized wire text is not incorrectly charged as a doubly escaped IPC JSON string. Large quoted-content fixture leaves main-thread timers progressing; this is not a latency/performance certification.
-546: actual7,017 PASS/TS0. RemoteTextReader owns one borrowed raw receive, handles ping/pong, rejects binary, distinguishes early close from EOF and returns text before decoding. This permits selected-event-only native decoding. A real test exposed wrapped abort reason on an ignored-frame yield; the source correction preserves the original abort reason. Initial RED and unchanged GREEN test evidence retained.
-547: actual7,023 PASS/TS0. Central remote status/control shares state across clones, retains diagnostic generation on disconnect, saturates u64 increments and exposes only explicit sticky restart-handoff request. It creates no automatic Reserve, session permission or cross-worker Atomic state.
-549/550: actual7,037 PASS/TS0. Non-consuming worker readiness retains completed results and pending/byte accounting until the event branch is selected. The command owner holds at most one receive and readiness watcher; uses actual native codecs; admits4active/16pending with explicit4MiB retained-command profile; returns exact bridge_busy without executing rejected work. Close requests cancellation and joins accepted I/O/all workers; unselected failure is not lost. Prior connection error wins, otherwise worker failure survives.548 was planning only.
-551: actual7,044 PASS/TS0. Outer connection lifecycle preserves begin -> protocol10 hello -> hello_ack -> connected status -> commands/drain -> retire -> disconnected. Begin failure still retires; retirement failure overrides and retains previous error. Pending borrowed handshake I/O and accepted execution must settle before retirement. Cancellable hello and pre-aborted no-effect entry are explicitly documented adapter extensions, not full Tokio watch parity. Source/tests independently preserved at remote1c265322066039bde8f6d03ddc26b7409c1f28fd.
-552/553: actual7,054 PASS/TS0. Seven gateway metadata forms and both project/device activation forms are represented. All39 operation kinds preserve the source mutation-cache classification: terminal_exec excluded; readonly-looking computer/window operations included. This classification is not an authorization decision. Central fixed binding/expiry/cancellation/session/conflict results retain source strings. Canonical command fingerprints exclude only root deadline_at/request_id; nested same-name fields, session, contents and expiry remain significant. True native canonicalization/hashing shares the bounded lane with decoding and encoding. Independent literal SHA256 goldens cover Korean text, explicit nulls/defaults, exact u64 and Chrono UTC dates. A1MB fixture tests timer progress and shared busy ownership.

## Retained failed/uncertain evidence and review limits
-551 initial test fixture reassigned readonly port fields and failed TypeScript. The immutable fixture was corrected; product source was unchanged. Initial test and failed typecheck retained.
-553 first immutable create_commit response had no captured structured SHA. Local orchestration stopped before update_ref. The branch was independently confirmed unchanged, metadata refreshed and one immutable commit-creation repeat returned a SHA. Subsequent compare-and-swap and independent source-tree verification succeeded. No uncertain ref update was repeated and no source was discarded.
-Source inspections are direct root review, not delegated code review. Current engineering remains in the user-requested cloud task. No Codex/AGY implementation or review delegation was used.
-Pinned Rust authority remains4e213aa69dc89bed1552d8b83e12471d7664b7ae; latest remote main dfec7dfb55e01516ad6d48a67a4aff4072d6150e was reread09:31 UTC and unchanged. Selected latest dispatcher/state, dispatcher/error and core/canonical_json contents were fetched09:47 and matched the frozen authority. Materialization's extra final LF was separately recorded; it was not treated as a source change. This selected equality is not full31-commit delta qualification.
-No Rust executable oracle is installed. Tests combine exact source review, independent literal goldens and real Node/native/in-memory fixtures. Native graph4096/depth16, bounded byte and actual-exit policies are explicit TS profiles.
-PR1 remained open/draft at09:52 UTC. GitHub Actions returned zero runs for the551 commit. Local PASS is not remote CI PASS; no Windows CI result is implied.

## Operational gap map and next work
-The repository still has no standalone main entry. package.json explicitly says in-progress/not ready to run. Prepared startup, typed consumers, core workers, ingress/control and common-deadline cleanup exist as executable building blocks; fixture composition does not make a deployable bridge.
-Frozen main.rs and all341 lines of discord_runtime.rs were reread. The next integration must own the actual singleton before drain/storage/resident, retain original subscriptions and exact queue/backend/resident/HTTP identities, and join partial-startup resources on failure.
-Global source order interleaves supervisor -> heartbeat -> completion and session-mirror -> server-request. The grouped core-workers helper cannot by itself express these global interleavings. Do not claim source-global ordering from its internal six-worker tests. The new555 plan records this integration constraint; it has no product implementation or approval claim.
-554 sequential reconnect adapter already passed focused163/TS0, including two actual native hello/ack lifecycles and generation1/2. It waits for the previous owned connection to settle, reports raw disconnect errors, and chunks maximalu64 reconnect delays safely against a monotonic clock. Full validation is pending here. It still borrows the actual connection port; no TCP/authentication/session effects have been implemented by that wrapper.
-Remote actual LocalProjectDispatcher, protected filesystem/project bindings, session activation/resources, Windows UI/terminal custody, result cache and managed protected restart handoff remain pending. The source256-entry in-memory cache is not crash-safe exactly-once mutation evidence. Fingerprints alone never authorize execution or certify a completed mutation.
-The original POSIX singleton socket EPERM remains unresolved. No unlocked marker or alternate route was substituted. Windows pinned handle/share-mode/lock/deletion guarantees remain unqualified; destructive archive confirmation remains blocked pending those guarantees. No main merge, deployment, service restart, real remote credential use or live database mutation was performed.
-Keep the user-required central thread-state access and error handler, TS restart decisions/thin platform scripts, typed Discord/Codex interfaces, per-thread isolation/restart scenarios, durable request custody and actual native offload. Retain the historical stale stop-record correction and archive subtree100-target/11-page completeness checks; these are not archive-storage quotas.

## Recovery, support and durable continuity
-Original recovery workspace and tools directory were still absent at09:31 UTC. They were not recreated/reset/overwritten. This rebuild does not prove their recovery or permanent loss.
-Case16911035 remains open. The explicitly requested follow-up was sent04:20:08 UTC to support@openai.com in the existing thread. The09:51 check still showed that SENT message newest, with no new support answer, confirmed preservation/recovery or ETA. Do not duplicate the same follow-up without a new reason or incoming response.
-The local incident status accumulated stale latest/current aliases. At09:57 it was reconciled to553 while preserving its complete prior bytes in a separate chronological snapshot. Historical masters, original incident facts and unknown633 outcome were retained. Future updates should synchronize canonical current fields, rather than add another competing alias.
-Original reviewed specification remains migration/rebuild-20261010/requirements/ts-runtime-parity-pro-reviewed-20261007.md,19,379 bytes, SHA256 a0799cfa3d7419a45e7003e1f579167a05dcdca0a8709dc4f891e7b0ac04bb72. Its PASS is document/plan only, never code/performance/operations/deployment.
-Continue substantive five-minute updates in the user's existing Slack migration thread, actual verification, immutable source preservation and support follow-up. Do not infer complete migration from test counts.

---
## Historical R23 preserved verbatim below

# Migration master handoff R23 — 2026-10-11 09:00 UTC

Immutable continuation of R22. This prefix updates only the facts stated here. The complete original R22 is retained byte-for-byte after the historical boundary, including all earlier masters, Pro-reviewed requirements, recovery evidence, instructions and limitations. Tests are not a migration-completeness percentage, production acceptance, Windows qualification, or deployment approval.

## Current independently preserved checkpoint
- Checkpoint 544: actual 7,005 PASS; zero failures, cancellations or skipped tests; strict TypeScript exit 0.
- Local commit 87e1e1cd97b51da9f030bbdcf240b5455efaf0dc.
- Independently verified remote commit 2ecac4c71b136ef11caee250f009bef95a8b83e7 on sss/async-admission-cloud.
- Remote root tree 085b12342f12f6a3c39b5cb6b0d6737b44715350.
- Exact committed-local/remote src tree e2f6178f2703913ec278e02d2e5c37ab820ce8ea and test tree 0cfcc7f19dfdef9bb51e470257a8121bab81e6de.
- Independent remote branch and tree reads completed at 09:00 UTC; .runtime/source-preservation-544-proof.json retains the receipt.

Only approved source/test content and small verification summaries were uploaded. Raw and compressed execution logs remain local under the existing separate-approval restriction. No main merge, live database mutation, service restart or deployment was performed.

## Completed increments since the R22 baseline
- Combined 534/535: actual 6,957 PASS, strict TS0. Native gateway decoding covers both acknowledgements and all seven command variants. Operation and gateway decoders share one owned native slot and the global Background budget, with actual-exit joining on timeout/abort. Remote RequestBudget converts one captured wall-clock deadline into an immutable monotonic deadline; clones/caps do not restart it. Chrono date/time leap corrections are preserved. This is one combined full run, not two separate full passes.
- 536: actual 6,964 PASS, strict TS0. Connection worker custody owns one generation/cancellation signal, rejects new admission synchronously at close, asks accepted work to cancel and collects every result before releasing accounting. Pending collectors are joined before draining, repeated/reentrant close shares one result, the original connection failure takes precedence and otherwise the first worker failure is retained. A queued operation observes the aborted signal when it starts. The wrapper cannot manufacture native termination and intentionally remains pending while accepted work has not settled. It is not yet wired to a live remote socket or session retirement.
- Combined 537/538: actual 6,976 PASS, strict TS0. All seventeen CoreOutput and four ComputerOutput variants have strict structural decoding and source-order validation. Common output readers deny unknown nested fields, preserve i64/u64 values, defaults/nullability, immutable arrays, source-valid empty/unconstrained strings and Unicode-scalar limits. No filesystem, Git, command or computer action is executed by a decoder. One combined full run was used.
- Combined 539/540/541: actual 6,994 PASS, strict TS0. Six TerminalOutput variants, their execution/window receipts and all nine BridgeInboundMessage envelopes are implemented. Terminal receipt identity and paired exit/duration/timeout/cancel/truncation fields are checked; activate/type/keys/interrupt retain their exact distinct grammars. All 27 ProjectOperationOutput kinds are represented. Explicit datetimes retain nanoseconds and leap seconds. The actual native adapter decodes every bridge envelope through the shared lane, preserves precise version errors and enforces its graph bound. A 4 MB result fixture demonstrates main-thread timer progress; it does not certify latency or absence of main-thread copy cost. One combined full run was used.
- Combined 542/543/544: actual 7,005 PASS, strict TS0, one combined full run. Chrono UTC wire formatting uses the pinned serializer's AutoSi 0/3/6/9 fractional digits, signed expanded years and leap seconds. Bridge DTO serialization snapshots passive bounded data, formats only the known date fields, enforces final escaped UTF-8 bytes and validates the wire envelope before returning it. It does not send or redact a message. The outgoing validation is an explicitly stricter fail-closed profile than Rust's generic send_json serializer.

## Reproduced correction and retained failed evidence
- The shared pre-existing Serde serializer read desc.get and desc.set through a descriptor object's prototype. A dedicated executable regression installed inherited get/set accessors only during serialization, restored them before test-framework assertions and observed eight unintended hook calls.
- The production correction consists of exactly two gate replacements: require Object.hasOwn(desc, 'value') instead of reading desc.get/desc.set or using inherited membership. The same regression bytes pass with zero calls; real own accessors remain rejected without calling their bodies. RED and GREEN logs and source/test identities remain in .runtime/rebuild-544-serde-descriptor-passivity. No full intrinsic/prototype-tampering hardening claim is made.
- A serializer test initially failed strict TypeScript because its intentionally invalid DTO fixture widened the discriminant to string. Only the explicit test-side type assertion was corrected; the initial failed log remains in .runtime/rebuild-543-bridge-wire-serializer. No production validation was weakened.
- Review corrected a core-output negative fixture that had an unrelated extra top-level field masking its intended negative integer. The corrected test isolates the integer failure; earlier stage evidence remains local.
- A source-preservation blob call did not return the expected identity. A read confirmed the exact expected blob was absent, a single same-content retry succeeded, and final branch/ref/src/test trees were independently checked. No failed or uncertain publication was described as a completed push.

## Source authority and serialization boundaries
- Rust frozen authority remains 4e213aa69dc89bed1552d8b83e12471d7664b7ae. Latest remote main checked at 08:31 UTC remains dfec7dfb55e01516ad6d48a67a4aff4072d6150e. Core/computer/terminal output definitions and result/data structures were fetched from that immutable latest commit and matched the frozen bytes independently. Exact proofs are retained beside each candidate.
- Cargo.lock pins Chrono 0.4.45. Official chronotope/chrono commit 170338250e836976a211e64728ec956e45e78a39 formatting.rs is bound to Git blob d95c0acbef42b54a8abb006ef6510b8f11eedc41 in addition to the ten earlier exact authority files. A materialization extra final LF was preserved separately and corrected only after exact Git-blob comparison, not guessed away.
- Pure output decoders accept fresh bounded JSON. Exported internal object decoders are not arbitrary-object inspection APIs. Their immutable data is not proof of device authentication, source provenance, project/session ownership, generation authorization, operation execution or successful delivery.
- Native profiles retain explicit raw-byte, output allowance, graph-node/depth and one-owner/global-capacity bounds. A source-valid graph larger than this profile can be rejected. Main byte checks, property-name enumeration and structured-clone work remain; no universal heap or latency bound is claimed.
- Serde serialization previously output internal datetime DTOs as objects if used directly; the new bridge serializer converts the three known bridge date locations to Chrono strings. Native outbound serialization is the next staged integration. Do not send internal DTOs directly as wire dates.

## Staged continuation and remaining runtime work
Checkpoint 545, .runtime/rebuild-545-native-bridge-serializer, is applied for actual full-suite verification as of 09:00 UTC. Its stage strict TS check and 224 affected core/remote tests passed. It adds actual native bridge DTO serialization with passive immutable-tree capture, shared native admission and actual-exit joining. A 1.5-million-quote fixture confirms escaped wire text is not accidentally counted as a second JSON encoding. Its full-suite outcome and remote preservation are still pending at this document timestamp; do not infer them from checkpoint 544.

The real remote socket/client, connection loop, dispatcher, project/session binding, expiry enforcement, native filesystem/process/computer authority, restart handoff and integration with the full resident bridge remain unfinished or unqualified. Request and result type coverage does not make the remote agent operational. Existing Pro modules are present; do not describe the entire Pro feature as missing.

Preserve the centralized thread-state facade and error handling, TS-only restart decisions, thin platform scripts, typed Discord/Codex boundary, thread-isolation and restart tests. Preserve the original reviewed MD as document/plan PASS only. Preserve the historical stop-record fix and the archive subtree bounds/complete-page checks. Destructive archive confirmation still requires the original ownership, locking, backup and pinned-handle guarantees; Windows share-mode and deletion qualification remain unresolved. No unlocked substitute is authorized.

## Recovery and continuity
- Original recovery workspace and tools folders remained absent on the latest 08:31 UTC check. They were not recreated, reset or overwritten. Separate-folder progress does not cancel original recovery.
- Case 16911035 remains open. The requested follow-up was sent at 04:20 UTC to support@openai.com in the existing thread. The 08:56 UTC check still showed that sent message as newest; no new incoming response or confirmed recovery/ETA was received.
- Work, code review and five-minute Slack reporting continue in the requested root cloud task. No engineering delegation to Codex/AGY was used for these increments. Remote source equality and actual tests are reported separately from still-unverified runtime coverage.

---
## Historical R22 preserved verbatim below


# Migration master handoff R22 — 2026-10-11 08:22 UTC

Immutable continuation. New evidence below supersedes older status statements only where explicitly stated. The entire R21 follows byte-for-byte after the historical boundary; R1–R21 and the original Pro-reviewed requirements remain preserved. This is not full runtime, Windows, performance, 24-hour operation, or deployment approval.

## Current independently preserved baseline
- Checkpoint 533: actual 6,945 tests PASS, zero failures/cancelled/skips; strict TypeScript exit 0.
- Local commit e70e8ec167bd0db734958ddb34e8f75bd3d6419f.
- Remote branch sss/async-admission-cloud commit 72d2beeb3e56f864a46abac419b4d79cceeecbb2.
- Remote root tree 4bc92e65dff77d681c5d90bf0696470a1eed0a5a.
- Exact local-committed/remote src tree 3109cbc9d07c55b01ca18c3c9375957cb7b43292.
- Exact local-committed/remote test tree 4a2eab28c109db8a4910bb8dbcc06cbf684f9aeb.
- Independent remote ref and tree read completed 08:21 UTC; local receipt .runtime/source-preservation-533-proof.json.
- Only source, tests, and small checkpoint summaries were preserved remotely. Raw/gzip logs remain local and must not be uploaded without the separate required approval. No merge to main, live database changes, deployment, or service restart.

## Completed since the R21 baseline
1. Combined 525/526: actual 6,895 PASS. Native archive-deletion preview and complete native thread inventory connected to real list/preview actions. Exact-ID lookup precedes fallback inventory and selected-state reads. A review found premature selected-state loading could defeat exact-ID masking; the first actual full run was interrupted and retained, then the corrected final full run passed. Central bounded BridgeState loading was added. DeleteArchiveConfirm remains unsupported. This was one combined full-suite result, not separate 525 and 526 full runs.
2. 527: actual 6,900 PASS. Remote worker capacity: maximum four active and sixteen pending, including completed-but-uncollected results, with retained declared-byte accounting. Cancelled result waiting does not cancel/release accepted work; collection and actual completion remain explicit. Not yet connected to a real remote session.
3. 528: actual 6,907 PASS. Protocol-v10 hello and acknowledgement contracts. Exact unsigned-version preflight, source hello-ack default, strict unknown fields, binding Unicode-scalar limits, bounded UTF-8 frames, serializer output budget.
4. 529: actual 6,916 PASS. All nine terminal and twelve computer request variants decoded and validated into typed immutable DTOs. Exact u8/u16/u32/u64/i32 representations, source defaults/nullability, Unicode lengths, strict identifiers, sorted environment validation and source-distinct key rules. No terminal or computer action was executed.
5. 530: actual 6,926 PASS. Eighteen remaining CoreRequest variants and full 39-kind ProjectOperation routing. File change action/digest rules, per-file scalar limits versus combined 10 MiB UTF-8 cap, Git/checkpoint patterns, image string contracts and relative request lifetimes. Node WHATWG URL validation is present, but exhaustive Rust url-crate edge parity remains UNVERIFIED.
6. 531: actual 6,932 PASS. All operation JSON parsing/validation runs through a bounded native worker adapter. One local slot shares global Background capacity. Timeout/abort joins the actual native exit; overload starts no extra worker. A 6 MB test demonstrates main timers continue during parsing. This is a coarse scheduling test, not a latency benchmark or proof of zero main-thread copy cost.
7. 532: actual 6,939 PASS. Chrono 0.4.45 DateTime<Utc> Serde decoding. The actual source uses relaxed FromStr syntax, not the existing strict context-report subset and not Twilight timestamps. Retains expanded signed years, component whitespace, UTC/offset forms, nanosecond truncation, Gregorian/range checks, and leap-second representation. Ten official Chrono source files were independently Git-blob matched to commit 170338250e836976a211e64728ec956e45e78a39. A materialization-only extra final LF was detected, preserved separately, and corrected before exact source binding; production/test bytes were unaffected. No Rust executable differential oracle is available.
8. 533: actual 6,945 PASS. All seven GatewayCommand variants and exact session-before-operation semantic validation order. Structural decode now finishes before semantics; existing raw family entry points remain compatible and operation parsing no longer reparses its discriminator. Missing deadlines use now + 60 seconds regardless of nested operation timeout. Explicit dates preserve nanoseconds/leaps. Past deadlines remain parsed data, as in Rust; execution enforcement is not performed by the parser.

Each completed item above has its own actual full-suite result, except the explicitly combined 525/526 run. Counts describe isolated pure/native/fixture tests, not an implementation-completeness percentage or real production coverage.

## Currently applied for verification, not yet a verified/preserved baseline
Combined 534/535 is running one actual full suite as of this document:
- .runtime/rebuild-534-native-gateway-envelope: both acknowledgements and all seven gateway commands decoded natively; gateway and operation parsing share one owned slot; UnsupportedVersion retains its exact u64 value. Large write-content input is parsed without executing a write.
- .runtime/rebuild-535-remote-request-budget: source RequestBudget conversion from one wall snapshot to one monotonic deadline, exact nonmutating caps, clone semantics and expiration. Chrono's date-plus-time leap corrections are retained instead of flattening leap nanoseconds.
- .runtime/rebuild-534-535-combined: stage strict TypeScript exit 0 and 62 focused remote tests PASS; actual full-suite outcome still pending here.
- This must not be called two separate full passes or inferred complete from checkpoint 533.

## Contracts and remaining boundaries
- TS-only/Node migration continues directly in the requested cloud workspace. Engineering implementation and review are not delegated to a Codex/AGY thread. The five-minute Slack updates report actual evidence, and ongoing support replies remain authorized in the existing recovery case.
- Preserve the central state facade, central error classification, TS restart decisions, thin platform scripts, typed Discord/Codex boundaries, thread isolation and restart tests. The original reviewed MD remains document/plan PASS only, never implementation QA PASS.
- Preserve the historical stop-command fix: exclude an older unresolved stop only with verified later distinct original request + started + normally completed evidence. Do not blanket-exempt a thread because some question history exists.
- Archive 100-descendant/11-page limits concern one complete subtree operation, not an archive-storage quota. Duplicate/truncated/broken-page results cannot authorize partial completion.
- Destructive archive confirmation remains blocked on the original ownership/locking/backup/fence contracts, especially Windows share_mode(0), file locking, and deleting the pinned open transcript handle. Never substitute an unlocked check-then-delete sequence.
- Native archive diagnostics are bounded read-only snapshots, not deletion authority. Archive row digests currently reject UTF-16 DBs; native thread-reference profile is POSIX-only. These limitations remain explicit.
- Remote request typing/decoding does not establish device authentication, project/session lease ownership, generation fencing, expiry enforcement, filesystem/process/UI authority or operation completion. No external remote socket has been connected by these increments.
- BridgeResult/output models, real remote dispatcher, connection/reconnect lifecycle, request-budget enforcement, and concrete I/O integration are still unfinished. Existing Pro modules already exist; it is inaccurate to describe the entire Pro feature as missing.
- Node default wall clock is millisecond-resolution. Exact explicit timestamp nanoseconds are preserved, but Rust wall-clock sampling precision is not claimed.
- Bounded native profiles do not mean all storage/intake/status/selection paths have been offloaded. Main input byte checks and structured-clone transport still cost work. No full Windows resident/singleton qualification or 24-hour test has passed. The earlier singleton socket permission denial remains respected; no alternative bypass was used.

## Source and recovery status
- Frozen Rust authority remains 4e213aa69dc89bed1552d8b83e12471d7664b7ae.
- Latest remote Rust main re-read 08:01 UTC: dfec7dfb55e01516ad6d48a67a4aff4072d6150e, unchanged. Selected current remote protocol/bridge/worker files were independently compared and match their frozen sources. This is not a claim that every upstream change has been mapped.
- Original two workspace folders were checked again 08:01 UTC and remain absent from the accessible filesystem. They were not recreated, reset, deleted or overwritten. Separate reconstruction is not original recovery.
- Support case 16911035 remains open. Follow-up was actually sent 04:20 UTC, asking for assigned technical ownership, located storage/snapshots/logs, actual preservation measures and a next update. Latest check 08:16 UTC still shows that sent message as newest; no new incoming reply and no duplicate follow-up sent.
- Actual original preservation, file recovery and ETA remain unconfirmed. Original historical 633 full outcome remains UNKNOWN. Do not claim a proven permanent three-day loss or claim this rebuild recovered the original files.

## Evidence pointers
- Completed source-preservation summaries 526 through 533 under migration/rebuild-20261010/.
- .runtime/rebuild-525-526-combined; .runtime/rebuild-527-remote-worker-capacity; .runtime/rebuild-528-remote-handshake-contract.
- .runtime/rebuild-529-remote-input-contracts; .runtime/rebuild-530-remote-core-contracts; .runtime/rebuild-531-native-remote-decode.
- .runtime/rebuild-532-remote-datetime; .runtime/rebuild-533-gateway-command-contracts; .runtime/rebuild-534-535-combined.
- .runtime/chrono-0.4.45-authority/source-proof.json and .runtime/source-preservation-533-proof.json.
- Prior master R21: 206,639 bytes; SHA-256 06feec312cd16be419402069bd331700e0f7ee160f2cc546bde920a005f6f9c3.

---
## Historical R21 retained verbatim below

# Migration master handoff R21 — 2026-10-11 07:17 UTC

This immutable continuation supersedes status statements below only where newer evidence is explicit. R20 is retained byte-for-byte after the historical boundary. The original implementation requirements, Pro document/plan scope, architecture rules, stop-command correction, latest-Rust comparison requirement, and preservation restrictions remain in the historical document. This is not a complete runtime, Windows, performance or deployment PASS.

## Current verified applied and remotely preserved baseline
- Checkpoint 524: actual 6,882 tests PASS, 0 failures/cancelled/skips; strict TypeScript exit 0.
- Local commit: bc4e68b1924179ef205913df92d3e3ba3121530e.
- Independently read remote branch commit: 5d2d946a566c7fc07e4cdba6f8b099ad7a86e1c7.
- Remote root tree: 2bc0f442c9d0df8d2778cb8ab2f370de6d5802c6.
- Exact local-committed/remote source tree: 9606f2ac59ba1f9a706a73e3276dba5a948bb5ce.
- Exact local-committed/remote test tree: 523f91009bfbb7c55eb2b34e00e9ecb7c4e395be.
- Verification receipt: .runtime/source-preservation-524-proof.json, checked 07:16 UTC.
- Source/test/small-summary preservation only; no raw or compressed logs uploaded. Main was not merged and no service deployed or restarted.

## Completed increments since R20
1. Checkpoint 520: prepared history and typed ingress now carry explicitly captured native history limits into actual periodic history. Duplicate rows count toward the read budget. Failed complete lookup retains previous cursor positions; no partial targets authorize cursor pruning. Actual 6,857 tests PASS.
2. Checkpoint 521: source-exact QA contract notice command, preserving disabled-route gating. This text is an availability notice, not an actual QA certification or generated button set. Actual 6,858 tests PASS.
3. Checkpoint 522: pure bounded archive JSON/index scrub plans. Exact bridge/global fields, own prototype-looking keys, lossless numbers, strict UTF-8, single JSON BOM, Rust line/trim behavior and malformed index-line preservation. Unchanged index produces no replacement. Same-test accessor regression failed before intrinsic typed-array capture correction, then passed; shared backing rejected. Actual 6,869 tests PASS.
4. Checkpoint 523: read-only archive row digest adapter preserving source ordered column labels and 64-bit little-endian null/integer/real/raw TEXT/BLOB encoding, sorted multiset and duplicate counts. SQL masks oversized returned rows before JS conversion; complete row/byte budgets reject partial evidence. Raw invalid UTF-8 TEXT stays raw bytes. UTF-16 databases are explicitly rejected, not silently converted or claimed equivalent. Actual 6,877 tests PASS.
5. Checkpoint 524: that SQLite/hash work now has an existing-only native reader, central owned read-only scope and deferred read transaction. One local slot shares global Background capacity; no hidden wait queue. Timeout/abort joins the real worker exit before returning. Actual file tests prove unchanged DB bytes, missing-file non-creation, later mutation detection and released capacity. Actual 6,882 tests PASS.

Local raw evidence directories:
- .runtime/rebuild-520-native-history-wiring
- .runtime/rebuild-521-qa-contract-command
- .runtime/rebuild-522-archive-metadata-plans
- .runtime/rebuild-523-archive-row-digests
- .runtime/rebuild-524-native-archive-evidence

These actual full-suite results are separate completed runs, not a claim that every integration/OS behavior is exercised.

## Work applied for verification but NOT yet a verified/preserved baseline
Combined 525/526 is undergoing one actual full suite as of this document:
- .runtime/rebuild-525-native-archive-preview: source archive deletion preview, exact ID before complete bounded alias resolution, native ownership, typed reference errors.
- .runtime/rebuild-526-native-thread-inventory: complete bounded native inventory connected to actual thread-list action.
- .runtime/rebuild-525-526-combined: actual combined verification.
- Stage strict TypeScript exit 0 and 100 focused tests PASS. Full-suite outcome is still pending here. Do not relabel it completed using the baseline 524 result.
- Original unsupported preview produces same-test RED. A missing optional native error-envelope field was found during review and corrected without weakening budget/missing-DB assertions; original RED retained.
- Complete fallback inventory cap is 4,096 rows / 4 MiB, exact row cap 256 KiB. Overflow rejects the whole selection, never a truncated successful alias match. This is a bounded operational profile, not unlimited-input parity.
- DeleteArchiveConfirm remains unsupported. The preview's source text does not grant deletion authority. POSIX reference behavior only; Windows reference parity still unqualified.
- No separate 525 full-suite claim: the selected validation is one combined 525/526 run.

## Archive deletion safety and remaining implementation
The original archive deletion parent, action coordinator and all seven child files were independently compared against latest Rust main dfec7dfb55e01516ad6d48a67a4aff4072d6150e; the selected files match the frozen authority. This is selected-file evidence, not all 31 upstream commits mapped.

Still required before destructive runtime integration:
- Complete source and mirror backups, exact identities and protected locations.
- Original source transaction must reverify rows against the verified backup before deletion. A prior native read snapshot is diagnostic only and cannot authorize a later write.
- Windows metadata replacement must preserve exclusive sharing/locking semantics. Transcript deletion must use the original pinned and verified handle. The equivalent Node/platform adapter is not yet qualified.
- Never substitute an unlocked check-then-write, rename or delete path.
- Stage/backup information and durable archive fencing must survive partial failure. No automatic retry after an unknown destructive outcome.
- SQLite internal memory/CPU and OS blocking are not bounded by returned-value budgets. Native ownership retains slots through real completion.
- No live deletion, live DB access or service operation has occurred in these units.

## Recovery/support and remote authority
- Original two Oct08 directories were still absent from the accessible filesystem at 06:56 UTC. No reset, overwrite or fabricated recovery.
- Original case 16911035 remains open. Support reply/follow-up was sent 04:20 UTC after the user's request. At 07:12 UTC the latest message was still that SENT message; no newer support reply, confirmed preservation, recovery or ETA.
- Latest Rust main independently read at 06:54 UTC remained dfec7dfb55e01516ad6d48a67a4aff4072d6150e.
- Rebuild tests and source preservation do not establish recovery of the missing original work.
- Root continues direct coding/review with substantive five-minute Slack updates.

## Immutable historical boundary
The following R20 bytes are unchanged (SHA256 fdd4b55854efa1f8043f681e8cdedb30ceee282ca778601bfa5b39828281584c; 199498 bytes). Its earlier status timestamps remain historical, not current completion claims.

# TS 마이그레이션 통합 인계 문서 R20 — 2026-10-11 06:39 UTC

R19 전체와 그 안의 R1–R18을 아래에 바이트 그대로 보존한다. 기존 사용자 필수 명세와 최신 Rust 대조, 중앙 상태·에러 처리, TS 재시작 판단, 경계 타입 선행, 스레드 격리·재시작 시험 지시는 유지한다. 테스트 수는 전체 구현률이나 운영·배포 승인을 뜻하지 않는다.

## 마지막 완료된 실제 검증과 원격 보존

- checkpoint 519는 518·519 두 단위의 합본 한 번 실행이다. 전체 6,855/6,855 PASS, 실패·취소·skip 0, strict TypeScript exit 0, 집중 39 PASS.
- 로컬 검증 커밋: 8488de6b9a9edf356b84beaa8dce438d15a219f2
- 원격 소스 보존 커밋: 30b982dc1ca641b3554a59e3a2cea794944d21ce
- 원격 root tree: fff5e1f51ef0ee82b015dfb0cbd8e09340bd1da1
- src tree: 68d28dea0ec86a2f7d4b7592866b765a21da194f
- test tree: 4ad3cabea2d261e940530cf4aaf3ae4fab20e4c1
- 06:38 UTC 독립 GitHub ref/tree GET으로 검증된 로컬 커밋의 src/test와 대조했다. 현재 검증 중인 520 작업 트리와 구분한다.
- 소스·테스트·작은 검증 요약만 원격 게시한다. 원시·압축 로그는 별도 승인 전까지 로컬에 보존하며 업로드하지 않는다. 기존 운영 서비스·DB는 변경하지 않았고 main 병합·배포하지 않았다.

## R19 이후 완료된 범위

1. 513 — Help 실행 누락을 보완했다. 고정 Rust help.txt의 UTF-8 5,759바이트, SHA256 17725b0d646c3c1e96860ccadf52e493721b4e5eac4a27aa998977dd65183b8a와 일치하는 문구를 반환한다. 같은 테스트로 이전 dispatcher의 실패와 수정 후 통과를 보존했다. 실제 slash worker → 구체 executor → 영속 결과 → HTTP 여러 chunk를 시험했다. 전체 6,841 PASS. 도움말에 나타난 모든 명령 구현 완료를 의미하지 않는다.
2. 514 — prepared context의 정확한 private queue와 resident identity를 검사해 기존 interaction worker에 실제 executor/component 서비스를 연결했다. 다른 resident는 큐 소유권을 받기 전에 거부한다. 전체 6,843 PASS.
3. 515 — 일반 메시지 처리도 같은 executor와 settings resolver, control verifier를 사용한다. 실제 prefix Help 처리와 같은 메시지 재전달의 중복 억제, 영속 전달 확인 및 기존 delivery wake를 함께 시험했다. 전체 6,844 PASS.
4. 516 — 실제 decoded slash 입력 → 권한·접수 기록 → ACK → 원래 작업 큐 → 실제 interaction worker → executor → 영속 결과 → HTTP 전달을 연결했다. 동일 입력은 ACK 1회와 필요한 응답 chunk 수만 전송한다. 전체 6,845 PASS.
5. 517 — history gap 복구와 periodic polling도 원래 실행기·게이트·resolver·control을 공유한다. 호출자 설정과 transport 메서드를 미리 포착한다. 실제 AttachmentHttpClient는 get이 prototype에 있으므로 own-field만 받던 새 연결 코드가 잘못 거부했다. 실제 클라이언트와 HTTP body를 사용한 동일 테스트로 RED를 재현했고 private brand 확인 후 정확한 prototype 메서드에 결속하도록 수정했다. 좁은 초기 full PASS와 구분하여 수정본 전체 6,846 PASS를 다시 실행했다. 원래 gap receiver는 consumer만 dispose한다.
6. 518 — 준비된 구체 서비스를 기존 7개 typed consumer(ready, message-emergency, message, history, interaction-normal, interaction-reserved, receive-error)에 연결한 후 paused Gateway를 활성화한다. 실제 loopback command 등록, prefix/slash 처리, 접수·전달 확인을 시험했다. 같은 시험에서 interaction 1개와 core 6개까지 총 14개를 함께 구동하고 실제 join 이후 native resident가 닫힘을 확인했다. Gateway shard는 제어된 메모리 이벤트 포트이며 실제 Discord WebSocket은 아니다.
7. 519 — history 대상 조회의 별도 native reader를 구현했다. 기존 초기화 API의 순서를 공용 collector로 보존하고, native profile은 기존 DB만 읽는다. Startup → 정렬된 Allowed → project recency → thread recency 순서, 50개 고유 대상의 조기 종료를 보존한다. 설정 ID와 읽는 행에 유한 예산(최대 4,096)을 두고, 중복·0 행도 행 예산에 포함한다. 초과 시 부분 목록을 반환하지 않는다. SQL CASE로 잘못된 대용량 text/blob ID가 JS 값으로 복사되는 것을 막는다. 한 native slot과 공용 Background 용량을 사용하며 timeout/abort 후에도 실제 worker exit까지 join한다. SQLite 내부 정렬 시간을 강제 중단한다는 주장은 하지 않는다. 이 시점의 519만으로는 periodic bootstrap에 native profile이 선택되지 않는다.

518·519는 별도의 전체 실행 두 번이 아니라 합본 한 번의 6,855 PASS다. 각 단위의 집중 검사와 합본 전체 검사를 구별한다.

## 현재 실제 적용 후 검증 중인 520

prepared history/typed bootstrap에 명시적인 historyTargetLimits를 요구하고 native 대상 조회를 선택하도록 연결했다. 예산 실패·오류·취소에 동기식 fallback이나 빈 목록을 사용하지 않는다. 실제 중복 행으로 예산을 초과시켰을 때 기존 cursor들이 보존되고 HTTP가 발생하지 않으며, 나중에 완전한 조회가 성공했을 때만 오래된 cursor를 제거하는 시험을 추가했다. 설정 변경 후에도 원래 제한을 유지한다. 집중 54 PASS·strict TS0 후 실제 전체 회귀를 실행 중이다. 520 전체 PASS 또는 원격 보존 완료는 아직 주장하지 않는다.

새 native fixture가 DB 초기화를 생략해 발생한 실패도 보존했다. 기존 DB만 읽는 제품 계약이 맞았으므로 테스트가 명시적으로 먼저 초기화하도록 수정했고 제품 검증을 완화하지 않았다.

## 남은 구현·검증 한계

- standalone CLI에서 모든 서비스를 시작하는 최종 entrypoint와 Windows 운영 검증은 미완료다. 14-owner 통합 시험은 실제 HTTP·native process·SQLite를 사용하지만 제어된 fixture이며 실계정 운영이 아니다.
- 412 POSIX singleton socket 작업은 실행 거절 상태로 미적용이다. 우회하지 않는다. heartbeat는 호출자가 이미 exclusive guard를 보유해야 하며 Windows adapter는 미완료다.
- remote MCP/Pro의 전체 원격 작업 경로, 일부 Windows host 명령, 전체 mirror sync와 archive 삭제 등은 여전히 미완료다. Unsupported를 성공한 no-op으로 바꾸지 않는다.
- native history 대상 조회 연결은 일부다. fresh mirror policy, 메시지/interaction custody, BridgeState 및 다른 상태 조회에 동기식 경로가 남아 있다. Promise 반환이나 일부 worker 이관을 전체 offload로 주장하지 않는다.
- native reader의 SQL 정렬·OS IO가 timeout보다 오래 걸릴 수 있다. 취소 후 소유권을 버리지 않고 실제 exit를 기다린다. 공용 hard-deadline/fail-stop의 운영 검증은 별도다.
- 실제 Discord/Codex 연결, Windows 재시작, 24시간 backlog·성능·메모리·장애 부하 시험, 최신 Rust 전체 차이 이전 완료는 미검증이다.
- 원래 작업 폴더의 633 결과는 여전히 UNKNOWN이며 재구현 PASS로 바꾸지 않는다.

## 원본 복구·지원 및 최신 Rust

- 2026-10-11 06:18:32 UTC 원래 recovery/tools 두 폴더는 현재 접근 가능한 파일 시스템에 없다. 초기화·덮어쓰기·삭제하지 않았다. 영구 소실량은 확정하지 않는다.
- 지원 사건 16911035는 유지한다. 04:20 UTC 기술 담당 배정, 저장소·스냅샷·로그 발견 여부, 실제 보존 조치, 원본 재연결/추출 가능성과 다음 업데이트를 묻는 답장을 보냈다. 06:39 UTC 확인까지 그 답장이 최신이고 새 지원팀 수신은 없다. 복구·보존 완료나 ETA는 확인되지 않았다.
- 06:19:33 UTC 독립 조회한 Rust main은 dfec7dfb55e01516ad6d48a67a4aff4072d6150e로 같았다. 선택한 소스의 이전 일치 검증과 전체 최신 Rust 검증을 혼동하지 않는다.
- R19 SHA256: 750bb5a42eb60734490221d6adb31ab487f074e3cd924b2bcdbcc3c7be853937, 191,189바이트. 아래 원문은 그대로 이어 붙였으며 R1–R19 파일은 보존한다.

---

# TS 마이그레이션 통합 인계 문서 R19 — 2026-10-11 05:52 UTC

R18 전체와 그 안의 R1–R17을 아래에 바이트 그대로 보존한다. 사용자 필수 명세와 최신 Rust 대조, 중앙 상태·에러 처리, TS 재시작 판단, 경계 타입 선행, 스레드 격리 및 재시작 시험 지시는 계속 유효하다. 문서·테스트 수는 전체 운영이나 배포 승인을 뜻하지 않는다.

## 마지막 완료된 실제 검증과 원격 보존

- checkpoint 512: 전체 6,839/6,839 PASS, 실패·취소·skip 0, strict TypeScript exit 0.
- 로컬 검증 커밋: fdd1fdf5e5f3f2ed0a8a966765aeca6ac97eee75
- 원격 소스 보존 커밋: 3cfeff611590170a21a900e2de1577c1428693f7
- 원격 root tree: 3e3ca27e7c07d058d7b2a0b36d8ebe53a546286c
- src tree: 48ef33ac804cce8d080c4d2dd136ab06953a62b1
- test tree: 36e3971bc3edc4fc2a88931d686d1951209ebf6b
- 독립 GitHub ref/tree GET을 로컬 검증 커밋의 src/test와 대조했다. 검증 중인 후속 후보와 구분한다.
- 원격에는 소스·테스트·작은 검증 요약만 게시했다. 원시·압축 로그는 별도 승인 전까지 로컬 보존하며 게시하지 않는다.

## R18 이후 실제 완료된 범위

1. 507 — 같은 prepared context의 여섯 core 작업자(app-server-supervisor, completion, new-first-reply-verification, stop-control, prompt-intake-recovery, server-request)를 원래 순서로 시작한다. queue/executor/backend/admission의 정확한 identity를 확인한다. 부분 시작 실패 시 이미 시작한 작업자를 join하고 원래 receiver를 정리한다. 전체 6,811 PASS.
2. 508 — 실제 gateway shard exit, 공용 worker exit, drain/control loop 중 종료 원인을 선택한다. 선택되지 않은 대기는 취소 후 join한다. 이미 도착한 다른 원인은 진단 근거로 보존하며, 성공한 drain이 승리한 경우만 그 key를 전달한다. 전체 6,819 PASS.
3. 509 — gateway 입력을 닫고 core 종료를 요청한 뒤, 공통 deadline 아래 gateway와 worker를 병렬 join한다. 그 이후에만 실제 native resident를 닫는다. 진단 보고 실패는 보존하고, 실제 작업이 join되지 않은 경우 resident 소유권을 버리지 않는다. 실제 native child·여섯 core worker·HTTP fixture를 함께 시험했다. 전체 6,822 PASS.
4. 510 — 위 종료 결과가 성공한 경우만 정확한 drain ACK와 재시작 marker를 확인한다. 그동안 heartbeat를 유지하고 이후 원래 reserve로 heartbeat를 join한다. 일반 종료는 중앙 오류 우선순위를 유지한다. 전체 6,829 PASS. Rust의 heartbeat 총 1초 reserve 안에 abort/join 1초가 포함되어 보장된 graceful 간격은 0이다. 이 한계를 숨기거나 production timeout을 늘리지 않았다. 완료된 clean task와 실제 join된 typed timeout을 구분하는 테스트를 둔다.
5. 511 — 실제 serial heartbeat 파일 IO를 monitored task에 연결했다. task 진입 전 강제 취소는 파일을 만들지 않고, 진입 후 취소는 이미 수락한 write와 소유한 marker 정리가 끝날 때까지 join한다. 실제 core/native 정리가 끝난 뒤 heartbeat marker가 제거되는 순서를 함께 시험했다. 전체 6,835 PASS.
6. 512 — 기존 영속 interaction receive loop를 실제 runtime exit/join에 연결했다. 정상 종료는 원래 sender만 해제하며 다른 생산자와 예약의 소유권은 유지한다. 강제 종료는 buffered permit을 해제하지만 durable 접수 기록은 남기고, 실행 중인 처리·결과 저장·알림·custody는 실제 완료까지 기다린다. 강제 중단이 임의 Node Promise의 완료를 뜻하지 않는다. 전체 6,839 PASS.

## 현재 후속 후보 513

Help가 기존 concrete dispatcher에서 Unsupported로 끝나던 연결 누락을 발견했다. 현재 Rust help.txt와 정확히 같은 5,759 UTF-8 bytes를 TS 상수로 옮기고 immediate 결과에 연결했다. SHA256은 17725b0d646c3c1e96860ccadf52e493721b4e5eac4a27aa998977dd65183b8a다. 실제 등록된 slash worker를 거쳐 결과를 영속 기록하고 여러 HTTP chunk로 보내는 시험을 추가했다. 같은 테스트에서 기존 dispatcher 12 PASS/2 FAIL, 수정본 14 PASS 및 strict TS0을 확인했으며 실제 전체 회귀는 진행 중이다. 아직 513 전체 PASS나 원격 소스 보존 완료를 주장하지 않는다.

이 도움말은 이전할 원본의 호환 텍스트다. 목록의 모든 TS 명령이 구현·운영 검증됐다는 증거가 아니다. 구현되지 않은 host·mirror sync 등은 여전히 명시적으로 실패한다.

## 최신 Rust와 복구 상태

- 05:49 UTC 원격 main은 dfec7dfb55e01516ad6d48a67a4aff4072d6150e로 이전 확인과 같았다.
- 05:44 독립 GitHub 파일 읽기에서 help.txt blob 6762631d95d0cd98ed2ab4e383cbea520d30ccb8을 확인했고 고정 Rust 파일과 같았다. R18에 기록한 new-reply 및 runtime 선택 파일 일치도 그대로다. 최신 Rust 전체 변경의 이전 완료는 아니다.
- 05:49 기존 두 작업 폴더는 현재 접근 가능한 파일 시스템에 여전히 없었다. 원본 초기화·덮어쓰기를 하지 않았으며 별도 재구현과 원본 복구 요청은 별개로 유지한다.
- 지원 사건 16911035는 열려 있다. 04:20 사용자의 요청으로 기술 담당·스냅샷·실제 보존·재연결 가능 여부를 다시 문의했다. 05:49 최신 메일 확인에 새 수신은 없었다. 복구 가능 여부나 완료 시점은 아직 확인되지 않았다.

## 여전히 남은 인수 조건

- 독립 실행 CLI와 전체 gateway/service 구성, 실제 Discord/Codex 연결, 공통 종료 전체 wiring, HTTP와 singleton 최종 소유권 정리는 완성되지 않았다.
- POSIX singleton 후보 412의 native socket listen은 환경 EPERM으로 검증되지 않았고 미적용이다. 우회나 권한 변경으로 통과 처리하지 않는다. Heartbeat adapter는 호출자가 이미 독점 소유권을 가졌다는 전제가 필요하며 이를 자체 증명하지 않는다.
- Windows marker/process/native adapter, 장시간 24시간 운영, 실측 성능·backlog·격리·장애 시험은 별도 검증이 필요하다.
- 일부 중앙 facade/receipt/ingress/bridge-state 경로는 여전히 동기 SQLite 또는 제한 없는 조회를 사용한다. 선택된 native worker 적용을 전체 main-loop offload 완료로 주장하지 않는다.
- Pro remote MCP, full mirror sync, archive deletion/host 명령 등 미완료 경로와 최신 Rust 추가 변경의 전체 대응을 끝내야 한다.
- append-only 파일·durable cursor·generation·미확정 전송·스레드 격리 및 원래 request/actor/channel 바인딩의 기존 제약을 유지한다. 구형 cursor 자동 채택/초기화, 불확실 요청 자동 재실행, 자동 Reserve 전환을 추가하지 않는다.

---

아래는 R18 전체 원문이다. 역사 기록의 “진행 중”은 위 최신 검증과 구분한다.

# TS 마이그레이션 통합 인계 문서 R18 — 2026-10-11 05:08 UTC

이 불변본은 R17 전체와 그 안의 R1–R16을 아래에 그대로 보존한다. 필수 구현 명세, 최신 Rust 대조, 오래된 Stop 예외의 정확한 조건, 중앙 상태·에러 처리 및 진행 보고 지시는 계속 유효하다. 이 문서는 운영·배포 승인이 아니다.

## 최신 실제 검증과 원격 보존

- checkpoint 506: 실제 전체 6,808/6,808 PASS, 실패·취소·skip 0, strict TypeScript exit 0.
- 로컬 검증 커밋: f9f1311b7d5c16a4c6087f6378a6a8956033680d
- 원격 보존 커밋: ce0154f72747044a0d04fe3e80ccd7c3ea859b10
- 원격 root tree: 53592755d40dced2b4d42e0abc51dfa29dccf595
- src tree: a29d84e7f409b8396297ba47e83b0d38c7baccd4
- test tree: 11f42cb19b002f619d02ed0003b4397d9c6f0cf9
- 원격 ref/tree를 독립 GET하여 로컬 검증 커밋의 src/test와 대조했다. 현재 작업 중인 파일을 위 검증본과 혼동하지 않는다.
- 원격에는 허가된 소스·테스트·작은 검증 요약만 올렸다. 원시·압축 실행 로그는 별도 승인 전까지 로컬 보존한다.

## R17 이후 확인된 구현

1. 494–496: 원래 session/project/turn/prompt SHA를 확인하는 증분 observer와 native 파싱 작업자를 실제 파일에 연결했다. 창 1 MiB, LF 포함 기록 256 KiB, 기록 수 256개와 협력적 시간 예산을 적용한다. 부분 기록은 완성될 때까지 offset을 넘기지 않는다. 파일 교체·축소·관찰된 변경은 실패이며 임의 초기화하지 않는다.
2. 497–500: 원래 identity/version에 대한 조건부 checkpoint, 매핑·접수 기록 재확인, bounded pending 조회, 중앙 상태 facade와 native DB 작업자, Codex thread의 정확한 native 조회를 연결했다. 제출된 저장 결과가 불확실하면 성공/롤백으로 단정하지 않고 다음 조회에서 원래 버전을 재조정한다.
3. 501–503: 실제 파일 검사 → Codex thread와 파일 witness 재확인 → 원래 version/매핑 조건부 저장 → 정확한 job 재조회가 이어진다. 한 번에 최대 8개다. 잘못된 JSON은 이전 cursor를 보존하고 review 상태로 남긴다. 501–503은 합본 한 번의 실제 전체 6,792 PASS이며 각 단위의 별도 전체 실행으로 부풀리지 않는다.
4. 504–505: 게이트웨이와 동일한 normal ACK receipt 키·본문·전송기를 사용한다. 경고는 별도 영속 1회 claim이다. 첫 batch 즉시, 이후 1초 delayed tick, 각 답변의 5초 취소 요청과 실제 작업 join을 연결했다. 전송 불확실성은 재전송 허가가 아니다. 실제 loopback HTTP 전송 중 종료, 5초 초과, 동시 gateway/recovery 경합을 검증했고 전체 6,803 PASS다.
5. 506: 복구 중 발생한 delivery wake를 한 비트로 합쳐 보관하고, 같은 queue/executor에서 실제 completion pipeline이 시작할 때 한 번 전달한다. 기존 호출자의 callback과 queue this를 보존한다. 중복 binding은 거부하고 pipeline join 후 callback을 떼어낸다. 실제 native 시작 context와 completion pipeline을 함께 사용한 시험을 포함한다.

## 현재 적용 후 검증 중인 507

같은 prepared context의 app-server supervisor, completion, new-first-reply-verification, stop-control, prompt-intake-recovery, server-request 6개를 source 순서로 구성한다. 정확한 private queue/executor/backend/admission identity를 검사하고, 세 번째 작업자 시작 실패 시 먼저 시작한 두 작업자를 join한 뒤 남은 receiver를 정리하는 시험을 추가했다. 집중 14개 및 strict TS0을 확인한 후 실제 전체 회귀를 실행 중이다. 아직 507 전체 PASS나 원격 보존 완료를 주장하지 않는다.

## 최신 Rust와의 대조

2026-10-11 04:52 UTC 원격 main은 dfec7dfb55e01516ad6d48a67a4aff4072d6150e다. 04:59 조회한 new_reply_worker.rs, new_reply_worker/reply.rs, discord_runtime.rs의 Git blob은 각각 638bdc4e0416fa9da6699a8eb45e3ab15fa2c762, 26a3b89b29b676c964ad8a610de85a66debe3bf3, 34b6d69b7be6dd290ceda63b8634f285bb310fcf이며 고정 Rust 원문과 같았다. 선택한 세 파일의 동일성이지 최신 Rust 전체 이전 완료가 아니다.

Rust의 길이·mtime fingerprint 변경 시 cursor를 0으로 초기화하는 동작은 사용자의 증분 처리 명세와 충돌하여 그대로 복제하지 않았다. 현재 제한된 anchor는 전체 과거 파일의 무변조 증명이 아니다. 생산자의 append-only 계약과 정확한 durable cursor 소유권이 필요하며, 구형 cursor를 자동 채택하거나 초기화하지 않는다.

## 여전히 남은 구현·운영 검증

- 독립 실행 entrypoint와 gateway, typed interaction, remote MCP, mirror, heartbeat, core workers의 전체 시작·종료 연결.
- 단일 인스턴스 선행 소유권. 기존 Unix socket EPERM 경로를 우회하지 않는다.
- 실제 Windows marker/process/권한/경합, 재시작, 손상·락·응답 유실, 큰 backlog, 24시간 운영과 성능 검증.
- 기존 synchronous SQLite, StateAccessFacade/BridgeState/custody/idle journal 및 비한정 목록 처리의 전체 offload와 예산. 특히 ACK readiness와 공통 receipt는 아직 동기 SQLite를 포함한다.
- Pro remote MCP 실제 인증·상태·bridge·dispatcher·runner, host commands, archive delete, 전체 mirror sync의 미구현 경로.
- 최신 Rust 변경분 전체와 필수 명세의 전체 대조. 시험 개수로 진행률이나 배포 가능성을 산출하지 않는다.

5초 제한은 취소 요청 시점이며 실제 작업이 종료됐다는 뜻이 아니다. 이미 접수된 native/HTTP/receipt 작업은 끝날 때까지 기다린다. 실행 중 작업의 common-deadline 처리와 최종 종료 정책은 실제 service assembly에서 연결해야 한다.

Archive 100개·11페이지는 한 번의 하위 트리 요청에서 대상 목록을 완전하게 확인하는 한계다. 전체 Archive 보관량 제한이 아니다. 누락·중복 페이지가 있으면 일부 수집을 승인하지 않는다. 오래된 Stop은 이후 별개의 원래 요청이 시작되어 실제 정상 완료된 증거가 있을 때만 차단 판단에서 제외한다.

## 원본 복구와 지원 문의

기존 두 원본 경로는 2026-10-11 04:50 UTC에도 보이지 않았다. 원본 경로를 생성하거나 초기화·덮어쓰지 않았다. 사건 16911035의 보존/추출 가능 여부와 ETA는 미확인이다. 사용자의 후속 요청에 따라 04:20 UTC 담당 배정, 장애 전 저장소·스냅샷·로그, 실제 보존 조치, 다음 업데이트 시점을 문의하는 답장을 보냈다. 05:00 UTC 확인에는 새 답장이 없다. 별도 재구현 및 원격 보존은 원본 복구와 구별한다.

## R17 전체 원문 보존

아래 177,153바이트의 SHA-256은 ffb8d57d62b84478643fdbc22388afe5be27e060c273df7985aaf5f8cbd2caba다. 앞선 불변본과 필수 구현 문서를 삭제하거나 수정하지 않는다.

# TS 마이그레이션 통합 인계 문서 R17 — 2026-10-11 04:13 UTC

이 불변본은 R16 전체를 뒤에 그대로 보존한다. 기존 필수 명세와 사용자의 최신 Rust 대조·중단 버그·상태 중앙화·5분 진행 보고 지시를 삭제하지 않는다. 아래는 새 검증 범위이며 운영 완료나 배포 승인이 아니다.

## 검증 및 원격 보존

- 실제 적용 checkpoint 493: 전체 6,733/6,733 PASS, 실패·취소·skip 0, strict TypeScript exit 0.
- 로컬 검증 커밋: 98e810da36b82c281b2c5a37a3abf3f5a98b523e
- 원격 보존 커밋: 741f2e560b54ddc2c3f80e547845d7e60828f72b
- 원격 root tree: d821eaefed1fe1107ae5ad712f3d21519b9a3f66
- src tree: de2655f377d558afee2ac5445132e77c5f732bd9
- test tree: 984dcdf3210942b15ec514f726e3d7f4a4d4b2c3
- 원격 ref와 tree를 독립 GET하고 로컬 검증 커밋의 src/test와 일치 확인했다.
- 원격에는 허가된 소스·테스트·작은 검증 요약만 보존했다. 원시·압축 로그는 별도 업로드 승인 전까지 로컬에만 남긴다.

## 새로 연결한 범위

1. 483–486: 초기 native 접근 정책, 복구 이전 completion/server-request 구독, 실제 명령 처리기와 시작 순서, 명시된 Pro 준비 포트. 같은 native 실행 파일의 조회/시작 동일성을 검사한다. 실제 remote MCP 인증·운영 연결을 대신하지 않는다.
2. 487: 복구 전에 확보한 원래 completion receiver를 pipeline에서 그대로 소비한다. 재구독 때문에 복구 중 이벤트가 사라지는 경로를 막는다.
3. 488–490: 승인 질문 표시를 원래 generation/occurrence/job/channel과 묶고, Discord 실제 HTTP 응답을 전부 확인한 뒤 영속 receipt를 기록한다. 마지막 chunk만 입력 구성 요소를 갖는다. 응답 불확실성은 재전송 허가가 아니다. 직렬 복구 작업자는 지수 대기 중에도 동일 pending receive를 유지하며 원래 native resident/공유 HTTP/receiver에 연결한다.
4. 491: 주기적인 prompt intake 복구를 같은 명령 처리기·queue·admission gate로 묶었다. 시작 시에만 허용한 이전 lease 해제를 주기 작업에서 반복하지 않는다. 미래 retry 시각, 외부 lease, 수동 hold를 유지한다.
5. 492: 중단 명령 작업자를 원래 queue lock·bridge·native backend에 연결했다. 바쁜 대상은 건너뛰고 다른 대상을 처리하며, dispatch 불확실 상태는 작업자 재생성 뒤에도 자동 재실행하지 않는다.
6. 493: 완료 처리 pipeline을 시작 단계의 정확한 backend/queue/native resident/receiver와 공유 HTTP에 묶었다. callback 진입을 확인한 뒤 작업자 handle을 반환하여 선행 취소 때 receiver가 남지 않도록 한다. 실제 Node 프로토콜 자식 → 실제 backend/queue → 완료 scheduler → loopback HTTP → durable receipt까지 검증했다.

Node 프로토콜 자식과 loopback HTTP는 통합 픽스처다. 실제 Codex 앱 서버, Discord 운영 서버 또는 Windows 24시간 운영 통과가 아니다.

## 첫 입력 확인 작업의 현재 후보

- 494: session/project, 원래 turn, 입력 본문 SHA-256을 검사하는 순수 observer. 집중 8개/TS0이며 실제 전체 회귀 진행 중이다.
- 495: 최대 1 MiB 창, LF 포함 256 KiB 기록, 256개 기록을 별도 native 작업자에서 파싱/해시한다. 집중 합본 15개/TS0. 아직 실제 적용·전체 검증 전이다.
- 496: 실제 파일 identity와 이전/다음 LF 경계, 제한된 prefix/tail anchor를 연결하는 후보를 검증 중이다. 파일 교체/축소/관찰된 변경은 실패로 유지한다.
- 최신 Rust scan.rs는 고정 원본과 같은 Git blob a864bf610d286be6d00e124d22c2ea430a5b92ef임을 확인했다. 원본의 길이·mtime fingerprint 변경 시 처음부터 재검사하는 동작은 사용자의 증분 스캔 명세와 충돌하므로 그대로 복제하지 않는다.
- append 때 이전 offset/turn 상태를 유지하되 완전한 기록 경계와 파일 연속성 검사를 통과해야 한다. 경계 anchor는 전체 과거 파일의 무변조 증명이 아니다. 생산자의 append-only 계약과 정확한 durable checkpoint 소유권이 추가로 필요하다.
- 이 후보들은 DB compare-and-swap, 최초 응답 hold 해제, 매핑 재확인, 경고/ACK 복구의 완성된 권한 경로가 아니다. 이를 성공한 것으로 미리 표시하지 않는다.

## 남은 필수 구현·검증

- 단독 운영 entrypoint, gateway/전체 작업자 시작 순서, notification wake와 종료 프로토콜 연결.
- 단일 실행 인스턴스의 선행 소유권 확인. 기존 Unix socket EPERM 제한을 우회하지 않는다.
- 첫 입력 확인의 durable cursor와 원래 ingress/job/thread/turn/prompt 매핑, 결과 불확실성 복구 연결.
- 기존 동기 SQLite/StateAccessFacade/BridgeState/custody/idle journal 및 비한정 intake 목록의 예산·offload.
- Pro remote MCP의 실제 인증·상태·bridge·dispatcher·runner, host commands, archive delete 및 전체 mirror sync의 미구현 경로.
- 최신 Rust 전체 변경분과 필수 명세의 전체 대조. 선택한 일부 파일 확인을 전체 동등성으로 확장하지 않는다.
- 실제 Windows 프로세스/경합/재시작/손상·락·응답 유실/대규모 backlog/24시간 실행·성능 검증.
- 기술 검사 수로 진행률을 산출하지 않는다. 실제 운영/배포 PASS는 여전히 없다.

Archive 100개·11페이지는 단일 하위 트리 요청의 완전한 대상 수집 한계이며 전체 보관 개수 제한이 아니다. 누락·중복 페이지를 일부 성공으로 승인하지 않는다. 오래된 Stop은 이후 별도 원래 요청이 실제로 정상 완료됐다는 증거가 있는 경우만 제외한다.

## 원본 복구와 보존

기존 두 원본 경로는 2026-10-11 03:57:45 UTC에 여전히 보이지 않았다. 원본 경로 생성·초기화·덮어쓰기를 하지 않았다. 지원 사건 16911035는 열려 있지만 원본 저장소/스냅샷 보존의 실제 완료, 추출 가능 여부 및 ETA는 확인되지 않았다. 04:11 UTC 확인에는 새 답장이 없었다. 새 검증 코드의 원격 보존은 원본 작업의 복구와 구별한다.

## R16 전체 원문 보존

아래는 R16 전체 170,631바이트이며 SHA-256 305b3d41dd81125bb235789e6be50ad04176c5921c6241918b10470f3819d81d와 일치한다. R1–R16과 원래 필수 구현 문서는 삭제하거나 고치지 않는다.

# TS 마이그레이션 통합 인계 문서 R16 — 2026-10-11

이 문서는 R15 본문 전체를 바이트 변경 없이 뒤에 보존하는 새 불변본이다. 이전 명세, 복구 기록, 원격 Rust 검토 지시를 삭제하거나 축약하지 않는다. 코드·운영 전체 PASS가 아니며, 아래 최신 상태가 역사 기록보다 우선한다.

## 최신 검증 및 보존

- 최신 실제 적용 검증: checkpoint 482, 6,677/6,677 PASS, 실패·취소·skip 0, strict TypeScript exit 0.
- 로컬 검증 커밋: e5148651f60c3ce1b7897f196c19fa0b7bcf2aec
- 검증 소스 원격 커밋: 49feac01c7c70e1572e4eee1cc3e38e326d8403f
- 원격 src tree: 5928bc54bfadbea2649cf9a6dac5cecdf34b4984
- 원격 test tree: 5f1e96fb86873f98ac0a6fe930b7f4dd07216577
- 원격 ref를 다시 읽고 로컬 검증 커밋의 src/test tree와 일치를 확인했다.
- 현재 후보 483의 초기 접근 정책은 집중 11 PASS/TS0이며 전체 회귀 진행 중이다. 이 후보의 전체 통과나 원격 보관은 위 482 보존과 구별한다.

원격 보관은 검증된 소스·테스트와 작은 검증 요약에 한정한다. 원시·압축 실행 로그는 로컬에 남았으며 업로드 승인이 없어 전송하지 않았다. 소스 보관은 원래 유실 경로의 복구나 운영 배포를 뜻하지 않는다.

## R15 이후 연결된 실제 범위

- 474: 초기 opt-in 네이티브 접근 정책 갱신. SQLite 읽기·분류·정렬을 별도 실행기로 옮겼다. 기존 실시간 message/interaction/history의 동기 갱신은 아직 자동 교체하지 않았다.
- 475: 실제 세션 미러 반복 작업을 공통 작업 수명·종료 감독에 연결했다. 종료 중 확인된 전송 결과는 보존하며 보고 실패로 지우지 않는다.
- 476: 기존 Codex DB 확인 후 bridge DB를 초기화하는 시작 순서를 고정 실행기로 옮겼다. 같은 파일을 두 DB로 사용하는 기본 경로·파일 식별 검사를 추가했다. 악의적 경로 교체나 Windows 파일 식별까지 검증한 것은 아니다.
- 477–478: 시작 시 빈 headless 증거로 수행하는 자동 Reserve 정리와 네이티브 소유자. 정책 원본은 감사 증거로 남기고 mode만 manual로 바꾼다. 접수가 불확실하거나 오류가 이미 통지된 요청에는 실행 보류를 남긴다. 기존 queue/intake 내용, 정책 관찰·리비전, 수동 보류를 삭제하지 않는다. 취소·시간 초과·commit 불확실성은 자동 재시도 권한이 아니다.
- 479–480: 이전 런타임 접수 복구에 전체 행·바이트 예산을 적용하고, DB 준비 → Reserve 정리 → 실제 native resident/custody 시작 → 이전 접수 복구를 내부 시작 함수로 연결했다. 뒤 단계가 실패하면 정확한 자식 프로세스를 종료하거나 미완료 정리 소유자를 오류에 보존한다. 테스트 자식은 로컬 Node 기반 app-server 프로토콜 픽스처다.
- 481: 이전 intake 담당자의 lease만 시작 단계에서 정리한 뒤 기존 복구 경로를 사용한다. 상태 접근은 중앙 facade를 거치며 수동 실행 보류와 미래 retry 시각은 유지한다. 주기 작업은 이 시작 전용 lease 해제를 호출하지 않는다.
- 482: 같은 resident/backend/queue/admission gate를 실제 명령 처리기에 연결했다. Pro 전처리와 mirror 연결은 명시된 포트만 받으며 미구현 기능을 성공한 것으로 위장하지 않는다. null 타임아웃 때문에 설정 오류 전에 정책 DB가 변경되는 후보 결함은 동일 테스트 RED→GREEN으로 막았다.

## 남은 필수 한계

1. 단일 실행 인스턴스의 실제 소유권과 초기 drain controller는 호출자의 선행 조건이다. 이 내부 함수들은 단독 실행 entrypoint가 아니며, 기존 Unix socket EPERM 차단을 우회하지 않는다.
2. 실제 Discord gateway, 모든 처리 작업, 종료 프로토콜까지 한 프로그램으로 시작·정지하는 완성된 운영 진입점은 아직 없다.
3. 기존 custody/idle journal, 상당수 StateAccessFacade와 BridgeState, intake 목록 처리에는 동기·비한정 작업이 남는다. 새로운 몇 경로의 offload를 전체 성능 요건 충족으로 확대하지 않는다.
4. Pro 런타임, host commands, archive delete, 전체 mirror sync 등의 명시적 미구현 경로와 최신 Rust 전체 변경분 대조가 남는다.
5. 엄격한 손상 TEXT 거부는 Rust의 일부 lossy 감사 변환과 다르다. 무해한 동일성으로 취급하지 않는다. SQLite 내부 스캔·메모리와 전체 시작 wall-clock 시간도 새 행/바이트 예산만으로 보장하지 않는다.
6. 실제 Codex/Windows 실행, 경쟁 프로세스, 24시간 운영, 재시작·성능·게시/배포 승인은 미검증이다. 테스트 수로 전체 진행률을 계산하지 않는다.
7. Archive 100개·11페이지는 한 하위 트리 작업의 완전성 검증 범위이며 전체 보관량 제한이 아니다. 오래된 Stop 예외는 이후 별도 요청의 정상 완료가 입증된 경우만 적용한다. 기존 명세와 348 구현 범위를 유지한다.

## 원본 복구

기존 두 경로는 마지막 확인에도 현재 파일 시스템에서 발견되지 않았다. 원본 초기화·덮어쓰기는 하지 않았다. 지원 사건 16911035는 열려 있으나 원본/스냅샷 실제 보존, 추출 가능 여부, 복구 ETA는 확인되지 않았다. 원격 재구현 보관과 원본 복구는 별개다.

## R15 전체 원문 보존

아래 본문은 R15의 전체 164,835바이트이며 SHA-256 f1bf0e3ec6b223045d4ceed662228444fa4c4f9278f08a5f83767025a06b38ca와 정확히 일치한다. 이 안에 R14 이하와 기존 필수 구현 문서·지시가 보존되어 있다.

# MIGRATION MASTER HANDOFF — immutable R15, 2026-10-11 UTC

This continuing implementation and recovery record preserves the complete unchanged R14 below. Earlier state statements remain historical. It is not operational, performance or deployment approval.

## Verified state

Actual applied checkpoint 473: 6,618/6,618 tests PASS, zero failed/cancelled/skipped; strict TypeScript exit 0. Local commit c1372c2652d4d4b4192e25873b2eefa3085b3b44; remote source preservation 06afaefa7a6bab4588ae91a796d1a23b1043d0ed; remote root e35cd4b5dad52fd0843be35c69a71d41b0f22579; src tree bee03b377734ed525b91ff1f0cbf5107e5dbd673; test tree dad99dd09218eef7890714bfa93663e1a3877059. Independent remote ref and source/test equality checked 2026-10-11T01:48:24.858Z. Focused combined suite: 26 PASS. Full suite: one combined run, 268869.994081 ms.

The implementation remains TypeScript on pinned official Node 24.21.0. Tests use actual isolated SQLite, fixed worker threads and temporary rollout files, with scripted Discord transport. No production Discord/Codex or Windows 24-hour qualification is implied. Local and remote histories are intentionally separate. Only source, tests and bounded summaries are remotely preserved; raw/compressed logs stay local pending separate authorization.

## Verified changes after R14

467: bounded detail-mode reads preserve absent-row Send, exact lowercase send/all, corrupt-value errors, native errors and borrowed connection lifetime. UTF-8/UTF-16 and byte-bound cases are covered. Native lookup uses the existing shared worker limit. The setter is still not migrated.

468: bound polling connects existing native cursor reads, authentic bounded file observation and the mixed receipt executor. Missing cursor bindings are explicit errors: legacy cursors are not adopted, reset or initialized automatically. Changed rollout identity holds. Invalid UTF-8/JSON or oversized first records surface a held-record error; an unfinished producer record can wait. A complete valid prefix can commit while its invalid suffix remains held. Same-test RED/GREEN established that malformed first records must not silently appear idle.

469: cancellation and timeout results retain the actually joined success/failure result. Previously a retained authentic packet could be lost when target cancellation masked its error. Four same-test counterexamples establish retained evidence, including known late HTTP acceptance. Cancellation/timeout classification remains; retained completion evidence does not authorize retry.

470: runBoundMirrorWorker concretely connects the existing shared epoch/retry loop, fresh native discovery owner, target execution and bound polling. Paths and budgets are captured before asynchronous work and cannot retarget later epochs. Reporter failure and joined shutdown are covered. This is not the complete bridge service entrypoint; explicit initial cursor binding, real authenticated transport and independent producer guarantees remain required.

471: the native decoder reads persisted detail only when decoded JSON-object events exist. Empty tails and blank/scalar-only input no longer query an unrelated missing detail table. Real events still surface missing/corrupt detail before sending. Same-test RED/GREEN preserves this source ordering without a second parse or new nested worker. Advancing a complete blank/scalar prefix remains an explicitly recorded bounded TS behavior difference.

472–473: provisional policy now uses one bounded queue snapshot and one pending gate for a batch. Fresh single-item policy is still checked before each item that may perform new HTTP. The fixed receipt planner optionally captures exact confirmed chunk identities from the same database in one read-only transaction. Complete already-confirmed items skip per-item worker calls; partial items skip only the exact confirmed chunks. The snapshot is bound to native store path/thread/channel. Final cursor commit still revalidates every original receipt and skipped-item proof. Deleting a receipt after the snapshot blocks cursor advancement and does not silently resend it.

Actual liveness evidence:
- Original 1,000-item permitted window reproduced twice at roughly 10.28 seconds with zero HTTP calls and unchanged cursor, under the existing 10-second deadline.
- Actual SQL counters in the corrected provisional batch show one queue measurement and one queue read for 1,000 items.
- The same final two-test SHA is retained against old source (two failures) and corrected source (two passes).
- Corrected 1,000-item windows reach new HTTP on each of two cooperatively interrupted attempts under the unchanged deadline.
- A 40-item window, interrupted after each ten known accepted responses, completes across five polls with exactly 40 unique HTTP bodies and one final cursor advancement.
- These are bounded regression observations, not production throughput certification. Arbitrary cancellation during native intent creation can still conservatively leave an unknown intent. It is not automatically released, and no unsafe unknown-outcome replay has been introduced.

Initial fixture mistakes (enqueue's persisted Pending state, invalid RateLimited enum) are preserved with their failed runs; only test fixtures were corrected. Real production counterexamples and test-authoring failures remain distinguished. 472–473 use one combined applied full run, not separate full-suite claims.

## Remaining release blockers and requirements

The complete R14 limitations remain binding, with its missing concrete poll-loop item now narrowed by 468/470. Full startup and real transport integration still need qualification. Bound cursors require explicit initialization/reconciliation, and the producer's independent append-only contract is unverified. Bounded anchors demonstrably cannot prove every middle rewrite followed by append; historyIntegrityVerified remains false.

Most legacy facade APIs still perform synchronous SQLite on the main thread. Newly off-thread mirror paths do not establish global offload. Native worker/target limits are initial bounded policies, not measured capacity. Fresh DB policy checks and HTTP are not one atomic transaction. Unknown native writes and unknown HTTP outcomes require reconciliation. POSIX singleton test 412 remains blocked by EPERM without a bypass. No executable Rust differential oracle, full Windows process/24-hour test, main merge or deployment is claimed.

The original Pro-reviewed specification, central state/error and TS restart rules, boundary interfaces, thread isolation, durable-before-ACK, bounded memory/work, actual-exit ownership, no cursor reset, latest Rust delta tracking and exact stale-stop exclusion requirements are all preserved in the appendix. Archive 100 descendants/11 pages bounds one subtree operation, not total archive capacity. Root performs engineering and review directly.

Frozen Rust remains 4e213aa69dc89bed1552d8b83e12471d7664b7ae. Latest main was independently checked at 2026-10-11 01:44 UTC and remains dfec7dfb55e01516ad6d48a67a4aff4072d6150e. The entire newer delta is not yet claimed migrated.

## Recovery and continuity

Original workspace/tool paths remained absent at the 2026-10-11 01:27 UTC check. Neither was recreated or overwritten. This rebuild is not recovery of those files. Historical original 631/632 had 8,183 passing tests, while original 633's full outcome remains unknown. Test counts are not migration percentages.

Support case 16911035 remains open. Latest known actual incoming reply is Eddie's 2026-10-10 22:56 UTC response, followed by the authorized reply at 23:08 UTC. Actual storage preservation, recovery and ETA remain unconfirmed. The latest 01:39 UTC mailbox check found no new incoming response. Continue authorized follow-up when new evidence arrives.

## Immutable prior document

The complete R14 below is 156,782 bytes, SHA256 88aaa7baedbd93a19ffd6ab30d64555a3a9affed37cf5b54831f2e70c1ec78f2. Its bytes are unchanged, including every predecessor and original requirements.

---

# MIGRATION MASTER HANDOFF — immutable R14, 2026-10-11 UTC

This is the user's continuing implementation/recovery record, not an operational or deployment approval. The complete unchanged R13 follows this prefix, including every preceding revision and the original requirements. Historical progress statements in that appendix remain historical.

## Verified state at this revision

Actual applied checkpoint 466: 6,579/6,579 tests PASS, zero failed/cancelled/skipped; strict TypeScript exit 0. Local commit 65cf15bd680ed6d1ee51c067472b2a8b6e65a5a2; remote source preservation 4bb139cc366978e115d70c610fd354001b760ec5; remote root 0a93fecfc8a9abeb04fc9c03bab3e5e6b5ceeeac; src tree 60f8a02320b1ddd5d3606a0e15f8f6b858d29a58; test tree 191bfef4d9a9ee6e22b87d9a4e485323233f3ea7. Independent remote ref and source/test tree equality checked 2026-10-11T01:08:13.318Z.

Official Node 24.21.0 Linux, actual SQLite, fixed worker threads, temporary rollout files and scripted validated Discord transport were used. This does not establish a live Discord/Codex integration, Windows process behavior, 24-hour operation, or numeric performance acceptance. Branch remains sss/async-admission-cloud, draft PR1. No main merge or deployment. Local and remote commits intentionally differ because remote preservation contains source, tests and bounded summaries; raw/compressed logs remain local pending separate upload approval.

## Verified additions since R13

457 (6,525): current-owner/durable marker observation now has a caller-transaction-compatible complete queue snapshot. The existing snapshot API continues to own its transaction and reject a pre-existing caller transaction. The new explicit borrowed helper requires an active caller transaction and cannot consume its lifetime. The initial executable transaction conflict and getter-annotation failure remain preserved.

458 (6,532): complete skipped-item proof checks one bounded target queue snapshot and one pending-ownership gate per batch, rather than rereading the queue for every skipped item. A 100-item actual SQLite regression verifies only one measurement and one queue decode. Every skipped item must have current owner or exact durable marker evidence. Missing proof, wrong-thread markers, budget excess, pending ownership and hooks fail closed without consuming the caller transaction. Native strip-only syntax failure and two invalid fixture assumptions were corrected and retained.

459–461 (6,551 combined): opaque prepared mapped cursor CAS and the native mixed delivered/skipped transaction. Receipt identities and their hash are captured before opening the transaction; a private factory identity prevents replacing the prepared receipt set. Borrowed application never begins, commits, rolls back or closes the caller's transaction. Same-packet idempotence preserves unrelated writes in an outer transaction. One fixed native operation combines current mapping, confirmed delivered receipts, current skipped proof and both cursor records under one IMMEDIATE transaction. Skipped proofs are checked before and after cursor DML.

- A new real counterexample found that a cursor trigger could delete a receipt after the initial receipt check. The exact same regression test failed against the retained pre-fix source (missing expected exception) and passed after adding the post-DML receipt check. Trigger deletion now rolls back the cursor and receipt together.
- Mapping and receipt postconditions are shared by the existing owned cursor API and the new prepared borrowed API, not implemented by unrelated copies of SQL.
- Native requests capture their bounded fields before submission, use the same database path, join actual native exit, and classify submitted write failure as outcome-unconfirmed. No automatic network retry.
- This is one combined full run, not three separate full runs.

462–463 (6,563 combined): authentic complete mixed packets. Exactly one own-data Deliver or Skip choice is required for every item in the private native batch. The same fixed native planner produces the exact marked send chunks and complete expected receipts for Deliver items; Skip items retain their original index and cannot be sent through that plan. The packet derives skipped identities from the original batch rather than accepting caller-invented skip objects. The final native transaction revalidates all skipped items.

- Cloned or proxy packets cannot omit proof. Mixed packets cannot use the all-delivered commit API to bypass skipped-item checks.
- All-skipped batches may advance only when every authentic item has current durable/ownership proof. A missing last receipt or one unproven skip holds the complete cursor.
- Skip-marker deletion by a cursor trigger rolls back marker and cursor together.
- The retained exact mixed packet supports read-only reconciliation after later marker or mapping changes; this is not permission to resend.
- Existing all-delivered behavior remains covered. One combined full run was used.

464–465 (6,572 combined): source-order policy uses a private, bounded native discovery snapshot for historical queue jobs. Copied/proxied arrays or jobs from a different database path cannot impersonate the snapshot. A target projection does no JSON parsing or hashing on the main loop. The source sequence remains fresh pending/current ownership first, historical poll-snapshot suppression next, then durable turn/event markers.

HistoricalOwner is explicitly distinguished from current/durable proof. It holds the cursor until a refreshed snapshot or current durable proof resolves the ambiguity; it cannot authorize sending or silently advancing. The optional volatile recent-text cache is not promoted into delivery evidence. Existing boolean/current-disposition reader APIs retain their original behavior and share the fixed native reader's ownership accounting. One combined full regression was used.

466 (6,579): one authentic observed batch now connects native source-order policy, the retained native mixed receipt plan, sequential durable receipt sending and atomic mixed cursor commit. Every deliver item receives another fresh policy observation immediately before sending. Historical-only ownership holds the cursor. Mid-batch ownership change stops subsequent sends; accepted receipts remain. Abort after known acceptance joins and confirms it before stopping, while unknown delivery is never blindly replayed. The error retains the exact authentic packet for read-only reconciliation. A same-test RED/GREEN caught physical-record counts being confused with JSON-object event counts: native decoding now carries eventCount explicitly. Blank lines and scalar/array JSON do not inflate source event progress. Scripted transport/native SQLite tests cover these behaviors; this remains one already observed batch, not full polling startup or live Discord qualification.

## What is still incomplete

- Full polling startup must connect native discovery, existing cursor initialization policy, bounded file observation and the observed-batch executor under the real shared target/channel owner. The bounded components are not a runnable bridge entrypoint.
- The independent append-only producer contract remains unverified. Bounded anchor checks cannot detect every old middle rewrite followed by append; that actual counterexample remains. Filesystem observation is not atomic with database commit. historyIntegrityVerified stays false.
- Fresh ownership observations do not form an atomic transaction with external HTTP. Live queue/target ownership integration and adversarial interleaving acceptance remain required before operational promotion.
- The TS cursor journal is an explicit opt-in extension, not silently part of the frozen Rust-parity schema assembly or installed in the user's operational database. Legacy unbound cursors require explicit reconciliation, never reset or automatic adoption.
- Most legacy StateAccessFacade APIs still execute synchronous SQLite on the main thread. Off-thread mirror discovery/receipt/planner/cursor paths do not imply all store or callback paths are off-thread.
- Fixed worker limits, per-target deadlines and 8-target scheduling remain bounded policies, not measured production capacity or performance claims. Busy/deadline work must remain owned until native/HTTP completion; no hidden unbounded queue.
- POSIX singleton checkpoint 412 remains blocked by socket-listen EPERM; no alternate transport/settings bypass or PASS claim.
- No executable Rust oracle was available in this VM. Source-backed TS tests and recorded source equality are not a Rust binary differential execution.
- No complete Windows CI/process/singleton/24-hour test, actual Discord/Codex live acceptance, latency benchmark approval, main merge or deployment.

## User requirements remain binding

Use TypeScript/Node only for the implementation. Centralize thread state and error handling, keep restart decisions in TS with thin platform scripts, define boundaries before adapters, and verify thread isolation/restart/unknown-outcome scenarios. Root directly implements/reviews; do not substitute engineering delegation without the user's request.

The original Pro-reviewed 19,379-byte specification is retained at migration/rebuild-20261010/requirements/ts-runtime-parity-pro-reviewed-20261007.md, SHA256 a0799cfa3d7419a45e7003e1f579167a05dcdca0a8709dc4f891e7b0ac04bb72. Its PASS is document/plan-only. Complete preceding directives and limits are in the unchanged appendix.

Archive maximum 100 descendants/11 pages is a bound on one subtree operation, not total archive capacity. No partial approval with duplicate/disconnected pages or original command/user/channel mismatch. Old unresolved stop records may be excluded only with evidence of a later distinct started and normally completed request, never blanket-cleared.

Frozen Rust authority remains 4e213aa69dc89bed1552d8b83e12471d7664b7ae. Latest Rust main checked 2026-10-11 00:44 UTC remained dfec7dfb55e01516ad6d48a67a4aff4072d6150e. The entire newer Rust delta has not been declared migrated. Source files are read directly; omitted authorities are not reconstructed.

## Original-workspace recovery remains open

Both original paths were checked at 2026-10-11 00:57:18 UTC and remained absent. No original path was recreated/reset/overwritten. Rebuild progress is not recovery of those files. Original checkpoints 631/632 historically had 8,183 passing tests; original 633 full outcome remains unknown. Test totals are not progress percentages, and permanent loss is not established.

Support case 16911035 remains open. Latest actual incoming reply is still Eddie's 2026-10-10 22:56 UTC response; technical review planned, actual preservation/recovery/ETA unconfirmed. Root replied at 23:08 UTC and last checked for another incoming message at 2026-10-11 00:57 UTC. Continue authorized reply follow-up when new information arrives, without duplicating prior mail.

## Exact prior revision retained

The appended R13 is exactly 145,461 bytes, SHA256 c6e95cf439230786300f0ec5392e2b872401ad7c37813eb0a3dc0cc1cae9b1b9. It contains complete unchanged R12 and all earlier records. This new prefix does not erase failed attempts, access limits, uncertainty, or earlier user instructions.

---
BEGIN COMPLETE UNCHANGED R13

# MIGRATION MASTER HANDOFF — immutable R13, 2026-10-11 UTC

This is the user's implementation and recovery handoff. It is not a runtime, performance, Windows, operational, or deployment approval. All previous immutable revisions remain. The complete byte-identical R12 is appended below, including all earlier inherited instructions and evidence. Historical statuses inside that appendix must not override this newer prefix.

## Verified checkpoint and remote preservation

Combined checkpoint 455/456: actual full 6,516 PASS, zero failures/cancellations/skips, strict TypeScript exit 0. One combined actual regression was run; there is no standalone full run for 455. Node 24.21.0 Linux, actual native SQLite/worker fixtures and scripted validated transport. No authenticated Discord send or live operational database was used.

- Local source commit: c7a17e42b37162f04a1132952497f5a4a2ae44bc.
- Remote preserved commit: c79dc1c6347f7e037b7dd3f50d6dd0b7a5ec036a.
- Remote root tree: c0f996679b9de340f6eb800e2197f7e0b74cd753.
- Independently equal committed local/remote src tree: 82eac2251c7ec29a56bee2961fecc61a06c5149d.
- Independently equal committed local/remote test tree: e7e6bd44cac22944ab404eaa9a10c083847143f3.
- Source/test and bounded verification summaries preserved on sss/async-admission-cloud, draft PR1. No main merge or deployment.
- Raw/compressed logs remain local. Their upload was denied pending separate approval; do not upload or bypass this restriction.
- Checkpoint 457 is applied but still undergoing full regression as this prefix is written. Its stage focused 34/34 and strict TS passed. Do not promote it to the verified baseline without its actual full result and preservation proof.

## New work after R12

449 (6,467): authentic all-delivered packet derives every item from the private native anchored batch and binds the actual old anchor. No caller-selected receipt subset. Stage fixture initially reused a terminal turn that the source collector correctly deduplicated; the fixture alone was corrected and the 12/13 RED retained.

450 (6,474): exact current thread/channel mapping guard in the same IMMEDIATE cursor transaction before and after DML. Stale remapping, shared/null/foreign bindings and trigger retargeting reject and roll back. The stronger advanceMapped profile is explicit; ordinary legacy APIs are not silently changed.

451 (6,481): private authentic packet commit and exact read-only reconciliation. Cloned/forged/proxy packets cannot omit receipt proof. A known late committed cursor can be reconciled by exact operation/revision/turn/time/anchor/receipt-set identity without another Discord send, including after later file or mapping changes. Only after the original native owner has settled. Exact old state is reported as unchanged, other states as conflict.

452/453 (6,493 combined): fixed native receipt planner moves format, normalized chunking, identity, and receipt-set hash off the main thread. Bounded inputs/outputs, single owned slot and shared native capacity, cancellation joins native exit. Source-preserving borrowed confirm/release/block receipt mutations are extracted for reuse; confirmation/release require an existing transaction and never manage its lifetime. New-reply and recovery side effects remain intact in their original generic paths. There was one combined full run, not separate full 452 and 453 runs.

454 (6,503): fixed native mirror-only receipt store on existing DB. Exact thread/channel/domain/key shape, stored raw-byte budgets and expected hashes are checked. Intent precedes transport. Known actual acceptance can be confirmed after a mapping change without inventing permission for a new send. Postconditions detect trigger corruption. Cancelled submitted writes remain outcome-unknown until joined and observed; no automatic retry. This unit alone did not contain transport wiring.

455/456 (6,516 combined): one shared receipt-sender state machine, used by both the existing facade wrapper and new native mirror store. No duplicated rate-limit/unknown-result policy. An authentic packet retains the exact same private off-thread chunk plan that produced its expected receipt set. plan.sendItem sends those fixed chunks sequentially. Known late acceptance is durably confirmed even if cancellation arrived, then cancellation prevents later chunks. Definitive rejection and unknown outcome remain distinct. Existing confirmed chunks are reused without another transport call. Actual temporary rollout + native workers + SQLite + scripted validated transport reaches mapped cursor commit. Missing last receipt or partial unknown chunk holds the entire cursor.

## In-progress 457, not yet a full PASS

Native current-owner plus durable turn/event marker observation is being connected. Existing boolean ownership reader remains compatible and does not newly require digest input. Current-owner pending rules precede markers; User items do not inherit assistant turn-origin markers.

An initial executable test found that the old complete queue snapshot owned a transaction and therefore could not be used inside a future final cursor transaction. A distinct boundedQueueJobsInTransaction helper now requires and borrows an active caller transaction. The old API continues to reject active caller transactions as before. Whole bounded read/decoder semantics are shared. New tests assert transaction survives both budget failure and native SQL failure, and rollback remains caller-owned. Initial failed test and strict-TS getter annotation logs are retained. The stage now passes 34 focused tests, strict TS exit 0; actual full regression is still in progress.

This observation is not permanent skip authorization or send permission. Whole source poll ordering also includes poll snapshot and recent-text policy. Mixed skipped/delivered batches still need complete immutable coverage and final transactional revalidation of skipped items. Do not advance a cursor solely because an earlier asynchronous observation returned an owner or marker.

## Remaining acceptance requirements

- Whole poll/startup wiring and mixed skipped/delivered cursor proof remain incomplete.
- The new cursor sidecar is an explicit opt-in TS extension, not part of the original frozen Rust schema assembly, and has not been installed into a live DB.
- Bounded filesystem observations cannot prove arbitrary earlier file content unchanged. The executable middle-rewrite-plus-append counterexample remains. historyIntegrityVerified=false. An append-only producer contract is still unverified. Filesystem observations and DB commit are not cross-resource atomic.
- Most legacy StateAccessFacade APIs still perform synchronous main-thread SQLite. The new mirror receipt/planner/cursor paths being off-thread does not mean all storage is off-thread.
- Global background/control worker capacities are bounded policies, not benchmarked production throughput claims.
- POSIX singleton checkpoint 412 remains blocked by socket-listen EPERM; do not bypass the restriction or call it passed.
- No complete Windows native process/singleton/24-hour test, real Discord/Codex integration acceptance, numeric latency/performance acceptance, or deployment approval.
- Preserve the user's central state access, central error classification/handling, TS-owned restart decisions with thin platform scripts, boundary interfaces, thread isolation, restart and unknown-outcome test requirements.
- Archive maximum 100 descendants and 11 pages bounds one subtree operation, not total archives. Duplicate targets, disconnected pages or mismatched original command/user/channel must not authorize a partial result. This was explained and accepted; do not remove the bound as if it were a total archive quota.
- Old stop records may be excluded only with proof of a later distinct started and normally completed request; no blanket clearing of all historical unresolved stops.

## Authorities and source discipline

Frozen migration Rust authority remains 4e213aa69dc89bed1552d8b83e12471d7664b7ae. Latest checked Rust remote main remains dfec7dfb55e01516ad6d48a67a4aff4072d6150e (GET 2026-10-11 00:14:17 UTC). Latest-vs-frozen session_mirror_worker.rs blob was verified equal earlier: dc434a81db54b5a8aaca56b5009f647cdbbabd27. This equality applies only to that source, not the full 31-commit delta. Continue actual source inspection; do not reconstruct omitted authorities.

Original Pro-reviewed specification remains migration/rebuild-20261010/requirements/ts-runtime-parity-pro-reviewed-20261007.md, 19,379 bytes, SHA256 a0799cfa3d7419a45e7003e1f579167a05dcdca0a8709dc4f891e7b0ac04bb72. Its PASS is document/plan-only. All user mandates and full previous records remain below.

## Recovery and support remain separate

The two original paths were checked again at 2026-10-11 00:27:22 UTC and remain absent in the current accessible filesystem. No originals were reset, recreated, or overwritten. Rebuild progress is not restoration of the lost workspace. Original 631/632 historically had 8,183 passing tests; original 633 full outcome remains unknown. Do not compare test counts as a percentage or claim permanent loss is established.

Support case 16911035 is open. Latest actual incoming message remains Eddie's 2026-10-10 22:56:13 UTC reply: technical investigation planned, actual preservation/recovery/ETA unconfirmed. Reply sent at 23:08 UTC. Inbox checked at 2026-10-11 00:28:09 UTC with no new incoming reply. Continue authorized follow-up when new replies arrive; do not duplicate the same reply.

## Exact prior revision preserved

The appended R12 is exactly 135,556 bytes, SHA256 b8efcba9dda2abf718a505798e472bd350fb5ef8ef340b17003665329e3005dc. It already embeds complete R11 and earlier records. This R13 prefix does not delete or reinterpret prior failures, access limitations, or source/test scope.

---
BEGIN COMPLETE UNCHANGED R12

# MIGRATION MASTER HANDOFF — immutable R12, 2026-10-10 UTC

This is the user's continuing implementation/recovery handoff, not a runtime, performance, Windows, or deployment approval. R1–R11 are retained; the exact complete R11 follows this new prefix. Do not delete or replace earlier evidence.

## Current verified state

Checkpoint 448: actual full 6,461 PASS, zero failures/cancellations/skips, strict TypeScript exit 0. Tests ran on official Node 24.21.0 Linux with native SQLite and worker threads. No live service or user's operating database was used.

- Local source commit: 051bc8d14b0aafc1628d76875bff638986a30bd9.
- Remote preserved commit: a5b83e94732aacd4bccfc7929bf661eed92071e8.
- Remote root tree: dbdb117d7ed8969e7dcd3e412f3cce69a9e4ad1f.
- Independently equal local/remote src tree: 43d90bd52b89b91f7de15db6a64cdbce1ec04864.
- Independently equal local/remote test tree: 91a8ea76cadee381ca5a7b8a99a5e452e47426a3.
- Branch remains sss/async-admission-cloud. No main merge or deployment.
- Remote preservation includes source/tests and bounded verification summaries. Raw and compressed logs are local only, pending separate upload approval.
- Checkpoint 449 is currently under full regression: authentic all-delivered batch → complete receipt packet. Its stage focused 13/13 and strict TS passed; do not treat its full regression as complete until its own checkpoint records that result.

## New verified units since R11

444 (6,421): bounded native continuity observations. Captures at most 256 prefix plus 256 bytes before the cursor. Detects observed replacement, shrink, changed boundary hashes, and same-size metadata changes. Explicit executable counterexample: an in-place rewrite outside the bounded anchors followed by an append can evade these observations. historyIntegrityVerified remains false. An independently established append-only producer contract is still required. This is not full-history hashing or proof of delivery.

445 (6,428): authentic anchored batch combines the old observed boundary, exact current native file stamp, bounded off-thread decode, and complete-record next boundary. Invalid/incomplete suffix stays excluded. Even an append after decoding refuses the next-boundary observation rather than silently advancing.

446 (6,435): one shared canonical versioned anchor codec replaces duplicated anchor validation. It preserves exact u64/i64 metadata and offset, strict well-formed text, bounded JSON bytes, canonical fixed tuple serialization and decode equality. It does not make caller-provided data authentic or establish file history.

447 (6,453): atomic mirror cursor journal. This introduces an explicit opt-in TS extension table cdr_ts_mirror_cursor_anchors_v1. It is NOT automatically included in the frozen Rust-parity schema assembly and has NOT been installed in an operational database. It binds existing codex_session_mirror_offsets to canonical generation/boundary data, turn context, positive revision, operation identity, and exact ordered receipt-set hash. Both rows update in one short IMMEDIATE transaction only after all supplied receipts are confirmed.

- Legacy offset without the sidecar is held for explicit reconciliation, never automatically adopted or reset.
- An incompatible existing sidecar schema is rejected rather than rewritten.
- Fresh initialization requires both rows absent.
- A stale revision cannot overwrite a newer one.
- Same exact desired packet/operation reconciles a lost successful commit reply without another network send.
- ABORT/IGNORE/corrupting triggers and orphan-producing insert failures are covered with actual SQLite rollback tests.
- Initial UTF16 regression exposed a raw-byte bound mismatch. Raw SQL byte caps were corrected to allow UTF16 while preserving the same logical UTF8 limits. The initial 26/27 log is retained. Do not describe this as a separately hashed old-source RED artifact.
- The low-level writer proves only the supplied receipt set. It does not itself know whether a caller omitted a batch item. Complete coverage is being connected by 449.
- Existing Rust schema parity and this opt-in runtime extension are distinct scopes. Deployment/adoption/cleanup of the sidecar requires explicit runtime integration work.

448 (6,461): NativeMirrorCursorStore runs fixed read/schema/initialize/advance requests on an owned native worker. It uses an existing-only database connection; reads cannot create or migrate a missing store. The new writer uses a bounded 100 ms SQLite busy wait, while existing callers retain their 5,000 ms default.

- One in-flight operation per owner, no waiting queue, shared global native capacity.
- Timeout/cancellation holds capacity until actual worker exit.
- Submitted write failure is conservatively unconfirmed, never falsely reported as rolled back.
- Real native tests demonstrate a cancelled or expired observer whose write nevertheless commits; a fresh read reconciles the operation after the original worker exits.
- Two native writers with one expected revision produce one successful advancement and one held/unconfirmed outcome.
- Owner close joins actual native work and rejects new work.
- These worker results do not prove Discord delivery ownership, current mapping, filesystem history or whole-runtime integration.

## Immediate integration constraints

1. Derive every required receipt from the authentic decoded batch; no caller-selected prefix or arbitrary omitted item. Detail filtering is a separate explicit decoder policy.
2. Preserve the original persisted anchor independently of a refreshed continuity observation. Otherwise the later compare-and-set packet can lose its true old-generation binding.
3. Bind delivery to the current thread/channel mapping. A stale snapshot channel is not sufficient authority. The current mapping must be checked during the final DB write; ownership before network send is a separate requirement.
4. A batch containing intentionally skipped bot-owned items needs durable skip/ownership evidence. The all-delivered profile cannot silently call those items delivered.
5. Preserve uncertain-write operation packets and reconcile after actual native exit. Never retransmit merely because the observer timed out.
6. Do not run network or filesystem work inside a DB transaction. A pre-commit file observation is not atomic with a concurrent external file writer. Keep the append-only contract limitation explicit.
7. Existing receipt-sender/facade paths still contain main-thread SQLite. Native cursor IO alone does not meet the complete offload requirement.
8. No new outbox is mandated by the accepted contract. Use confirmed receipts or a proven restartable durable handoff; do not invent a production approval from isolated passing units.

## Requirements remain binding

The supplied Pro R2 MD is still present and preserved, SHA256 a0799cfa3d7419a45e7003e1f579167a05dcdca0a8709dc4f891e7b0ac04bb72, 19,379 bytes. Its PASS is document/plan only.

Keep thread state access centralized, one typed-error handling boundary, restart policy in TS with thin platform scripts, Discord/Codex contracts before adapters, and thread-isolation/restart tests. Preserve latest-Rust deltas, including stale stop records being excluded only on evidence of a subsequently started and normally completed separate request.

The archive bound of 100 descendants and 11 pages is a bound on one discovered subtree operation and complete-page verification. It is not a cap on total archived threads. Reject partial/duplicate/broken pagination instead of approving a partial destructive target list. The user understood this distinction and asked to continue; do not silently remove source-backed bounds or change total archive behavior.

The root assistant continues coding and reviewing directly. Do not start Codex/AGY engineering delegation contrary to the user's latest instruction.

## Unfinished / blockers

- Final complete session-mirror poll coordinator, send/skip ownership, current mapping, and cursor integration.
- Whole startup/gateway/worker integration and authenticated Codex/Discord operation.
- Legacy StateAccessFacade APIs still needing actual off-thread work.
- Windows process/instance qualification and measured 24-hour/performance acceptance.
- OS singleton checkpoint 412 remains blocked by two listen EPERM observations; no alternative settings/protocol workaround authorized.
- Latest Rust main dfec7dfb55e01516ad6d48a67a4aff4072d6150e remained unchanged at 23:44:56 UTC. Frozen baseline 4e213aa69dc89bed1552d8b83e12471d7664b7ae remains immutable; later changes are not all mapped.
- Tests and module counts are not a defensible percentage of full migration completion.

## Recovery and support

At 23:55:13 UTC, both original paths remain absent:
- /workspace/scratch/bf1e81df474a/codex-discord-bridge-ts-recovery-20261008
- /workspace/scratch/bf1e81df474a/migration-recovery-tools-20261008

Do not create empty replacements at those paths, reset the environment, or call the rebuilt folder a recovered original. Original at-risk interval remains approximately 25 hours 36 minutes; permanent loss is not established.

Support case 16911035 remains open independently of rebuilding. Latest human support message at 22:56:13 promised technical-owner/storage-preservation investigation. The assistant's authorized reply at 23:08:16 asked for actual preservation and non-destructive recovery results. No actual recovered storage, snapshot retention, or ETA is confirmed. Last checked at 23:47:40 with no new incoming message.

## Exact previous master follows

R11 SHA256: 66b40a440793711f0d5d4c1f8149ed885356e416c4820e99f12a581a75f66dc0.
R11 bytes: 125823. The complete bytes below are retained unchanged.

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

