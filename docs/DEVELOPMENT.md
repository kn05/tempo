# `tempo` 개발 현황 및 아키텍처 가이드 (Session Handoff)

> 새 세션에서 **Phase 4 (로컬 IPC & VS Code 익스텐션)** 이후 작업을 시작할 때 [SPEC.md](../SPEC.md), [docs/poc-results.md](./poc-results.md)와 함께 가장 먼저 읽는 개발 가이드입니다.

---

## 1. 현재 진행 상태 (2026-11-24 기준)

* **Phase 0 (PoC & 스캐폴딩): 완료**
  * Rust Cargo Workspace + Tauri v2 (`2.12.7`) + React 19 + TypeScript + Vite 6 + Tailwind CSS v4 스캐폴딩 완료.
  * TickTick Open API v1 실측 PoC 완료 ([docs/poc-results.md](./poc-results.md)): `parentId` 하위 작업 생성, 2-Step 완료, 부모 태스크 일정 보존, `GET /open/v1/tag`, `GET /open/v1/project/inbox/data` 모두 **PASS**.
* **Phase 1 (핵심 엔진): 구현 및 Linux 검증 완료**
  * SQLite `PRAGMA user_version` 마이그레이션 러너(v1), `AppSettings` 타입 저장/조회/검증, `time_entries` 수동 생성·부분 편집·삭제·기간 조회, 유휴 복귀 4종 트랜잭션(`keep` / `discard` / `discard_and_continue` / `split`) 구현.
  * 순수 Rust `IdleStateMachine` 및 백그라운드 `CollectorEngine` / `CollectorHandle`(폴링 영속화, Phase 4용 `PresenceSlot` TTL 오버라이드, `Quit` 시 마지막 `ended_at` 플러시) 구현.
  * 개인정보 필터 확장(프로세스 마스킹 + 창 제목 키워드 마스킹 + Denylist 프로세스 수집 제외) 및 Windows UWP 수집기 보강.
  * 시스템 트레이 동적 동기화(`tray-idle.png` / `tray-active.png`) 및 `tempo://idle-return`, `tempo://timer-changed` 이벤트 연동.
* **Phase 2 (타이머 UI & 타임라인): 구현 및 Linux 검증 완료**
  * `@프로젝트`/`#태그` 빠른 입력 파서(`crates/tempo-core/src/parser.rs`), `tauri-plugin-global-shortcut` 기반 전역 단축키(`src-tauri/src/shortcuts.rs`), 프레임리스 미니 타이머 멀티 윈도우(`"mini"`, `index.html?window=mini`), `TimerBar` / `TimerListView` / `TimelineView` / `MiniTimer` / `Settings` UI 완성.
* **Phase 3 (TickTick 연동): 구현 및 Linux 검증 완료**
  * **OS Keyring & 시크릿 저장소 (`crates/tempo-core/src/ticktick/secrets.rs`):**
    * `SecretStore` 트레이트 + `KeyringSecretStore`(Windows Credential Manager `windows-native`, Linux `linux-native`, macOS `apple-native`; 멀티스레드 키스토어 레이스 방지를 위한 내부 직렬화 `Mutex`) + 테스트용 `MemorySecretStore`.
    * `TickTickCredentials`의 커스텀 `Debug` 구현으로 Access/Refresh 토큰 및 OAuth Client Secret이 로그·SQLite에 절대 평문 노출되지 않도록 보호.
  * **OAuth2 루프백 로그인 (`crates/tempo-core/src/ticktick/oauth.rs`):**
    * `127.0.0.1:<port>/callback` 비동기 루프백 콜백 서버(`port=18492` 기본 / `0` 설정 시 임시 포트 자동 할당, 브라우저 `/favicon.ico` 요청 무시, 타임아웃·취소 지원).
    * RFC 7636 PKCE (`S256`) + 고엔트로피 CSRF `state` 검증 + `Basic` 인증 토큰 교환(`authorization_code`) 및 `refresh_token` 자동 갱신.
    * Personal API Token 직접 연결도 함께 지원(연결 전 `GET /open/v1/project` 실측 검증 후 OS Keyring 저장).
  * **TickTick API 클라이언트 & SQLite Pull 캐싱 (`client.rs`, `db/mod.rs`, `sync.rs`):**
    * `TickTickClient` 타임아웃(연결 10s / 요청 20s), `POST /open/v1/task/filter`, `GET /open/v1/project/{pid}/task/{tid}`, 재시도 가능/401 에러 분류 및 마스킹 메시지 추가.
    * `Database::sync_ticktick_cache` 단일 트랜잭션 Pull 캐싱: `GET /open/v1/project` + `GET /open/v1/project/inbox/data` + 열린 프로젝트별 `/data` + `POST /open/v1/task/filter` + `GET /open/v1/tag`.
    * 실제 Inbox ID(`inbox12345...`) 자동 감지 및 FK 안전 보장, 로컬 커스텀 태그(`source = 'local'`) 및 과거 기록 메타데이터 보존, 원격 완료된 태스크 상태(`status = 2`) 정리.
  * **오프라인 비동기 동기화 큐 & 2-Step 멱등 완료 (`sync.rs`, `db/mod.rs`):**
    * `AppSettings` 확장(`auto_sync_on_stop`, `ticktick_time_zone`, `ticktick_oauth_client_id`, `ticktick_oauth_redirect_port`) — 스키마 v1 유지.
    * `TickTickService` & `SyncWorkerHandle`(백그라운드 30초 주기 + `enqueue`/로그인 시 즉시 기동 + 실패 항목 지수 백오프 자동 재시도 최대 5회 + 401 시 `refresh_token` 자동 갱신).
    * **2-Step 멱등성:** 1단계 `POST /open/v1/task`(`parentId` 하위 작업 또는 `fallback_list`) 성공 즉시 `ticktick_subtask_id`와 반환된 실제 `project_id`를 단일 SQLite 트랜잭션에 커밋한 뒤 2단계 `complete` 호출 → 2단계 실패 후 재시도 시 1단계를 건너뛰어 중복 생성 원천 차단.
    * `complete_parent_task == true` 시 부모 태스크의 예정 일정(`startDate`/`dueDate`)을 전혀 수정하지 않고 부모 `complete` 엔드포인트만 호출 후 로컬 캐시 상태도 `2`로 갱신.
    * OS IANA 타임존 자동 감지(`iana-time-zone`, 예: `Asia/Seoul`) + 사용자 수동 오버라이드 지원.
  * **Tauri 셸 & 프론트엔드 (`src-tauri/src/lib.rs`, `tray.rs`, `src/`):**
    * `SyncWorkerHandle::prepare` + `tauri::async_runtime::spawn`으로 동기 `.setup()` 스레드 패닉 없이 백그라운드 워커 기동, 종료 시 OAuth 대기 세션·워커 정상 종료.
    * `stop_timer` 및 트레이 토글 정지 시 `auto_sync_on_stop` 조건부 자동 큐 등록 지원.
    * Phase 3 IPC 커맨드 10종 추가(총 38개) 및 `tempo://ticktick-changed` 이벤트(총 5종) 연결.
    * `TickTickView` 전면 개편(연결 상태 배지, OAuth2 루프백 로그인 + 앱 자격 증명 설정 + URL 복사/취소, Personal API Token 연결, 수동 Pull, 대기 큐 전송, 실패 일괄 재시도, 완료 태스크 표시 토글, 마감일 표시).
    * `TimerListView` / `TimelineView`의 `onRequestTickTickSync`를 실제 `enqueueTickTickSync` 비동기 큐에 연결, 실패 사유 인라인 표시 및 일괄 전송/재시도 버튼 추가.
    * `Sidebar`에 TickTick 연결 상태 점과 미동기화 큐 카운트 배지 추가, `Settings`에 Fallback 리스트 선택 드롭다운·타임존·종료 시 자동 동기화 옵션 추가.
    * `src/lib/tauri.ts` 브라우저 프리뷰 모드에서도 로그인·Pull·오프라인 큐·2-Step 동기화 시뮬레이션 유지.
* **로컬 검증 상태:**
  * `cargo test` → **40/40 PASS** (경고 0건 — OAuth2 루프백/PKCE/State, Keyring/SecretStore 마스킹, Pull 캐싱, 2-Step 멱등 재시도, 부모 일정 무변경 완료, Fallback 리스트, 401 자동 리프레시, 백그라운드 워커 즉시 기동 포함)
  * `npm run build` (`tsc --noEmit && vite build`) → **PASS**
  * `python3 scripts/ticktick_poc.py --self-test` → **PASS**
* **주의 (미검증 항목):**
  * Linux 헤드리스 환경에는 GTK/WebKit2GTK가 없어 `src-tauri/` 및 `crates/tempo-core/src/tracker/windows.rs`의 네이티브 컴파일·실동작은 아직 Windows 머신 또는 [.github/workflows/build-windows.yml](../.github/workflows/build-windows.yml) CI에서 검증되지 않았습니다. (`tauri 2.12.7`, `tauri-plugin-global-shortcut 2.4.1`, `tauri-plugin-opener 2.7.3`, `keyring 3.6.3`, `windows 0.61.3` 실측 소스 시그니처 기준으로 검증 작성됨.)
* **다음 단계:** **Phase 4 (로컬 IPC & VS Code 익스텐션)** 착수 (및 Windows CI 워크플로우 빌드 확인).

---

## 2. 반드시 유지해야 할 아키텍처·환경 규칙

1. **Linux 헤드리스 개발 환경 & `tempo-core` 분리 원칙**
   * 개발 머신은 Linux(NixOS)이며 `gtk3` / `webkit2gtk-4.1` 개발 라이브러리가 없습니다.
   * 루트 [Cargo.toml](../Cargo.toml)의 `default-members = ["crates/tempo-core"]`를 반드시 유지합니다.
   * **비즈니스 로직·DB·추적기·유휴 상태머신·수집기·파서·동기화 큐·OAuth2 클라이언트·IPC 서버·테스트는 모두 `crates/tempo-core`에 작성**하여 Linux에서도 `cargo test`로 100% 검증 가능하게 유지합니다.
   * `src-tauri/`는 트레이·창 제어·전역 단축키·백그라운드 태스크 기동·IPC 커맨드 바인딩만 담당하는 얇은 셸로 유지합니다.
2. **외부 시스템 라이브러리 비의존 정책**
   * SQLite는 `rusqlite` `bundled` 피처, HTTP/TLS는 `reqwest` `rustls-tls` 피처, Keyring은 타겟별 네이티브 피처(`windows-native` / `linux-native` / `apple-native`)를 유지하여 `libdbus`/`openssl` 등 C 시스템 라이브러리 의존성을 배제합니다.
3. **프론트엔드 스택 & 브라우저 프리뷰 폴백 규칙**
   * Tailwind CSS v4 (`@tailwindcss/vite`, [src/index.css](../src/index.css)의 `@import "tailwindcss";`) 사용 — `tailwind.config.js` / `postcss.config.js`를 만들지 않습니다.
   * [src/lib/tauri.ts](../src/lib/tauri.ts)는 Tauri 런타임 외부(`npm run dev` 브라우저 단독 실행)에서도 동작하도록 인메모리/`localStorage` 프리뷰 폴백을 유지합니다.
4. **Windows Tauri v2 데드락 & 런타임 주의**
   * `WebviewWindowBuilder::build()`와 `GlobalShortcutExt::on_shortcut` / `unregister_all`은 내부적으로 `run_on_main_thread` + 블로킹 `recv()`를 사용합니다. `src-tauri`에서 이들을 호출하는 커맨드는 반드시 `async fn`으로 선언하거나 `tauri::async_runtime::spawn`에서 호출합니다.
   * `.setup()`은 동기 메인 스레드에서 실행되므로 `tokio::spawn` 대신 `tauri::async_runtime::spawn`을 사용합니다(예: `SyncWorkerHandle::prepare`).
5. **시크릿 & 로컬 파일**
   * `.env`에 `TICKTICK_TOKEN`이 저장되어 있으며 `.gitignore`에 등록되어 있습니다. **토큰·시크릿 값은 로그·SQLite·문서·응답에 절대 출력/저장하지 않습니다.**

---

## 3. 코드베이스 맵 (Phase 3 완료 기준)

| 경로 | 역할 | 상태 |
| --- | --- | --- |
| `crates/tempo-core/src/db/schema.sql` | SQLite v0.1 7개 테이블 + 인덱스 (`WAL`, `FK`, `busy_timeout`) | 완료 |
| `crates/tempo-core/src/db/migrations.rs` | `PRAGMA user_version` 기반 트랜잭션 마이그레이션 러너 (`CURRENT_SCHEMA_VERSION = 1`) | 완료 |
| `crates/tempo-core/src/db/mod.rs` | `Database` CRUD + `sync_ticktick_cache` Pull 트랜잭션 + `time_entries` 동기화 상태 전이(`enqueue`/`record_subtask`/`synced`/`failed`/`requeue`/`queue_summary`) | Phase 3 완료 |
| `crates/tempo-core/src/models.rs` | 도메인 모델 (`TimeEntry`, `AppSettings` + TickTick 옵션, `TickTickConnectionStatus`, `TickTickPullResult`, `TickTickSyncBatchResult`, `OAuthLoginStartResult`, `SaveOAuthConfigInput`, `PresenceOverride` 등) | Phase 3 완료 |
| `crates/tempo-core/src/parser.rs` | `@프로젝트` / `#태그` 빠른 입력 파서 (`parse_quick_entry`) | 완료 |
| `crates/tempo-core/src/idle.rs` | 수동 타이머 유휴 감지 순수 Rust 상태머신 (`IdleStateMachine`) | 완료 |
| `crates/tempo-core/src/collector.rs` | `PresenceSlot`(Phase 4 IPC 연결 대상), `CollectorEngine`, `CollectorHandle`, `format_tray_tooltip` | 완료 |
| `crates/tempo-core/src/tracker/` | `ActivityTracker`/`IdleDetector` Trait, `ActivityAggregator`, Windows Win32 구현체, Linux 스텁 | 완료 |
| `crates/tempo-core/src/ticktick/secrets.rs` | `SecretStore` 트레이트, `KeyringSecretStore`(OS 자격 증명 저장소), `MemorySecretStore`, 토큰 마스킹 `TickTickCredentials` | Phase 3 완료 |
| `crates/tempo-core/src/ticktick/oauth.rs` | 루프백 OAuth2 서버(`127.0.0.1:<port>/callback`), PKCE(S256), CSRF State 검증, 토큰 교환/리프레시 | Phase 3 완료 |
| `crates/tempo-core/src/ticktick/client.rs` | TickTick Open API v1 클라이언트(`project`, `inbox/data`, `project/{id}/data`, `task/filter`, `tag`, `task` 생성/조회/완료/삭제) | Phase 3 완료 |
| `crates/tempo-core/src/ticktick/sync.rs` | `TickTickService`(인증·Pull 캐싱·2-Step 멱등 Push·자동 토큰 갱신) 및 `SyncWorkerHandle` 백그라운드 비동기 큐 워커 | Phase 3 완료 |
| `src-tauri/src/shortcuts.rs` | `tauri-plugin-global-shortcut` v2 전역 단축키 관리자 (`ShortcutManager`) | 완료 |
| `src-tauri/src/tray.rs` | 동적 트레이 아이콘/툴팁, `Start/Stop Timer`(종료 시 자동 동기화 훅 포함), `Open tempo`, `Mini Timer`, `Quit` | Phase 3 완료 |
| `src-tauri/src/lib.rs` | Tauri v2 앱 셸, 수집기 + TickTick 동기화 워커, 멀티 윈도우(`main` + `mini`), 38개 IPC 커맨드, 5종 이벤트 발행 | Phase 3 완료 |
| `src/types.ts`, `src/lib/quickEntry.ts`, `src/lib/time.ts`, `src/lib/tauri.ts` | TS 도메인 타입, 빠른 입력 파서, 날짜/시간 유틸리티, 38개 IPC 래퍼 + 멀티탭 브라우저 프리뷰 폴백 | Phase 3 완료 |
| `src/components/ProjectPicker.tsx`, `TagPicker.tsx`, `TimerBar.tsx`, `MiniTimer.tsx` | 프로젝트/태그 피커, 상단 타이머 바, 프레임리스 미니 타이머 | 완료 |
| `src/components/TimerListView.tsx`, `TimelineView.tsx` | 날짜별 시간 기록 리스트(실패 사유 표시·일괄 전송/재시도) & 2트랙 사후 밀어넣기 타임라인 (`enqueueTickTickSync` 연결 완료) | Phase 3 완료 |
| `src/components/TickTickView.tsx` | TickTick OAuth2/API Token 연결, Pull 캐시 새로고침, 대기/실패 큐 제어, 프로젝트/태스크 탐색 및 원클릭 타이머 시작 | Phase 3 완료 |
| `src/components/Sidebar.tsx`, `IdleReturnModal.tsx`, `App.tsx` | 사이드바(TickTick 연결/큐 배지), 유휴 복귀 4지선다 모달, TickTick 설정(Fallback 리스트·타임존·종료 시 자동 동기화) | Phase 3 완료 |

---

## 4. Phase 3 완료 기준 IPC 계약 & 이벤트

### 4.1 Tauri IPC 커맨드 (38개)
* **플랫폼/수집기:** `get_platform_status`, `list_activity_logs(fromMs, toMs, minDurationMs?)`, `submit_presence_heartbeat(payload)`
* **타이머/기록 CRUD:** `get_running_timer`, `start_timer(input)`, `stop_timer`, `list_time_entries(limit?)`, `list_time_entries_in_range(fromMs, toMs)`, `create_time_entry(input)`, `update_time_entry(id, input)`, `delete_time_entry(id)`
* **태그 & TickTick 캐시 & 파서:** `list_tags`, `upsert_tag(name, source?, color?)`, `delete_tag(id)`, `list_ticktick_projects(includeClosed?)`, `list_ticktick_tasks(projectId?, status?, query?, limit?)`, `parse_quick_entry_input(input)`
* **TickTick 인증 & 동기화 큐 (Phase 3 신규 10종):** `get_ticktick_status`, `save_ticktick_oauth_config(input)`, `connect_ticktick_personal_token(token)`, `start_ticktick_oauth_login`, `cancel_ticktick_oauth_login`, `disconnect_ticktick`, `pull_ticktick_cache`, `enqueue_ticktick_sync(entryId)`, `process_ticktick_sync_queue`, `retry_failed_ticktick_syncs`
* **설정/단축키/유휴:** `get_settings`, `update_settings(settings)`, `get_shortcut_status`, `get_pending_idle_prompt`, `resolve_idle(input)`
* **미니 타이머/창 제어:** `open_mini_timer`, `close_mini_timer`, `toggle_mini_timer`, `is_mini_timer_open`, `set_mini_timer_always_on_top(alwaysOnTop)`, `focus_main_window_cmd`

### 4.2 Tauri 이벤트 (5종)
* `tempo://idle-return` (`IdleReturnPrompt`): 수동 타이머 실행 중 유휴 복귀 시 발행 + 메인 창 포커스.
* `tempo://timer-changed` (`TimeEntry | null`): 타이머 시작/정지/트레이·단축키 토글/유휴 해결/실행 중 항목 수정·삭제 시 브로드캐스트.
* `tempo://entries-changed` (`()`): 시간 기록 생성/수정/삭제/태그 변경/동기화 완료 시 메인 창과 미니 타이머 창 간 동기화 트리거.
* `tempo://focus-quick-entry` (`()`): 빠른 입력 전역 단축키 입력 시 메인 창 포커스 후 상단 타이머 바 입력창 포커스.
* `tempo://ticktick-changed` (`()`): TickTick 로그인/로그아웃/OAuth 진행 상태/Pull 완료/동기화 큐 상태 변경 시 UI 갱신 트리거.

---

## 5. Phase 4 (로컬 IPC & VS Code 익스텐션) 구현 체크리스트

1. **로컬 IPC 서버 (`crates/tempo-core`):**
   * `POST /v1/presence` 엔드포인트 구현 (Windows Named Pipe 우선 고려 + `127.0.0.1` 전용 바인딩 HTTP 서버 + 로컬 생성 Bearer 토큰 파일/키링 인증).
   * 수신된 heartbeat를 `CollectorHandle::presence()` (`PresenceSlot`)에 주입하여 `Code.exe` 포커스 시 워크스페이스·브랜치·파일명 메타데이터 덮어쓰기.
2. **VS Code 익스텐션 (`extensions/tempo-vscode/`):**
   * 활성 에디터, 워크스페이스 폴더, Git 브랜치, 파일 경로 변화를 감지해 주기적으로 `POST /v1/presence` heartbeat 전송.
   * 설정 화면에서 IPC 상태 및 연결된 익스텐션 메타데이터 확인 UI 제공.
