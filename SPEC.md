# `tempo` v0.1 기능 및 아키텍처 명세서 (SPEC)

## 1. 프로젝트 개요 및 핵심 원칙

* **프로젝트 / 폴더명:** `tempo`
* **타겟 플랫폼:** Windows 10/11 (x64, ARM64 네이티브 빌드)
* **기술 스택:**
  * **백엔드 데몬 & 시스템 트레이:** Rust + Tauri v2
  * **로컬 DB:** SQLite (`WAL` 모드, `busy_timeout` 설정)
  * **프론트엔드:** React + TypeScript + Vite + Tailwind CSS
  * **시크릿 보관:** OS 자격 증명 저장소 (`keyring` → Windows Credential Manager)
* **핵심 원칙:**
  * **Lightweight:** 시스템 트레이 상주 시 최소한의 메모리·CPU 점유율 유지. 메인 창을 닫아도 백그라운드 수집기 유지.
  * **Local-First:** 모든 활동 로그와 시간 기록은 로컬 SQLite에 우선 저장. 오프라인 환경에서도 100% 동작하며, TickTick 동기화는 비동기 큐로 처리.
  * **직관적인 데스크톱 UX:** 상단 타이머 바와 타임라인 뷰를 중심으로 최소한의 조작으로 기록·검토할 수 있는 레이아웃과 인터랙션 지향.
  * **OS 추상화:** 플랫폼 의존 추적 로직(`ActivityTracker`, `IdleDetector`)을 Rust Trait으로 분리하여 Windows 네이티브 구현체(`#[cfg(target_os = "windows")]`)와 개발/테스트용 Linux·Mock 구현체를 병행 지원.

---

## 2. 핵심 기능 명세

### 2.1 수동 타이머 (Manual Timer)

* **상단 타이머 바:** 작업 설명 입력(또는 TickTick 태스크 검색/선택, `@프로젝트` / `#태그` 빠른 지정 지원), 프로젝트(TickTick 리스트) 및 태그(TickTick 태그 + 로컬 커스텀 태그) 지정, 시작/정지 버튼.
* **미니 타이머 (Mini Timer):** 항상 위(Always on top) 옵션이 있는 소형 플로팅 창. 현재 작업명과 경과 시간 표시 및 원클릭 제어.
* **전역 단축키:** 앱이 백그라운드에 있어도 타이머 시작/정지 및 빠른 입력 창 호출.

### 2.2 백그라운드 자동 추적 (Timeline & Rich Presence 대비)

* **1단계 — 기본 수집기 (MVP 구현):**
  * Windows API(`GetForegroundWindow`, `GetWindowThreadProcessId`, `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` 등)를 폴링(기본 1~2초 주기)하여 활성 창의 `process_name`과 `window_title`을 기록.
  * UWP 앱(`ApplicationFrameHost.exe`) 및 관리자 권한 창 접근 실패 시 안전하게 폴백 처리.
  * 연속된 동일 활동은 로컬 DB에 단일 구간(`started_at ~ ended_at`)으로 병합 저장하여 DB 용량 최소화.
  * **절전/슬립 갭 분리:** 폴링 간격이 임계치(기본 10초)를 초과하면(절전·최대절전 복귀 등) 이전 구간과 병합하지 않고 강제로 새 구간을 시작.
  * **개인정보 필터(Settings):** 비밀번호 관리자, 시크릿 브라우저 창 등 지정된 프로세스/키워드의 창 제목 마스킹 또는 제외(Denylist) 지원.

* **2단계 — 외부 익스텐션 확장 구조 (인터페이스 예약):**
  * 추후 VS Code 익스텐션 등 외부 클라이언트가 접속할 수 있도록 로컬 IPC 규격(`POST /v1/presence`)을 미리 설계.
  * **보안:** Windows Named Pipe를 우선 고려하며, `localhost` HTTP 사용 시 `127.0.0.1` 전용 바인딩 + 로컬 생성 Bearer 토큰 인증 필수.
  * `Code.exe` 등 특정 프로세스가 포커스된 상태에서 익스텐션 heartbeat가 수신되면, 기본 창 제목 대신 익스텐션 메타데이터(워크스페이스, 브랜치, 파일명 등)를 우선 덮어씌워 저장.

### 2.3 유휴 감지 (Idle Detection)

* Windows API(`GetLastInputInfo`)로 마우스·키보드 마지막 입력 시점 추적. (임계치 기본 5분, 사용자 설정 가능)
* **자동 추적 중 유휴 발생 시:** 팝업 없이 해당 구간을 `is_idle = 1`로 조용히 분리 기록.
* **수동 타이머 실행 중 복귀 시:** 복귀 팝업을 띄워 4가지 선택지 제공.
  1. **유지 (Keep):** 유휴 시간 포함하여 계속 기록.
  2. **버리기 (Discard):** 유휴 시작 시점으로 타이머 종료.
  3. **버리고 계속 (Discard & Continue):** 유휴 구간만 제외하고 복귀 시점부터 새 타이머 시작.
  4. **새 기록으로 분리 (Split):** 유휴 구간을 별도 빈 기록으로 분리.

### 2.4 TickTick 연동 (핵심 차별화)

* **인증 및 Pull:**
  * TickTick OAuth2 연동(루프백 리다이렉트 `http://127.0.0.1:<port>/callback`, 토큰은 OS keyring 저장).
  * 프로젝트(리스트), 미완료 태스크, 태그 목록을 로컬 DB에 캐싱하여 오프라인에서도 선택 가능.
  * 프로젝트/태그 모델: TickTick 프로젝트 및 태그를 기본 모델로 캐싱하며, 로컬 전용 커스텀 태그 추가도 허용.
* **하위 작업(Subtask) 기반 타임라인 기록:**
  * 타이머 종료 또는 사후 밀어넣기 시, 연결된 TickTick 태스크의 하위 작업(`parentId`)으로 `[원래 태스크명] 수행` 태스크를 생성.
  * 실제 수행한 `startDate` / `dueDate`를 지정하고 완료 처리하여, 원 태스크의 계획 일정을 건드리지 않고 TickTick 캘린더 타임라인에만 기록을 남김.
  * **2-Step 완료 및 멱등성:** Open API v1은 생성(`POST /open/v1/task`)과 완료(`POST /open/v1/project/{projectId}/task/{taskId}/complete`)가 분리되어 있으므로, 1단계 생성 직후 반환된 `ticktick_subtask_id`를 로컬 DB에 저장한 뒤 2단계 완료를 호출(실패 시 중복 생성 없이 완료만 재시도).
  * **기술 검증(PoC) 결과 (Phase 0 검증 완료 — [docs/poc-results.md](./docs/poc-results.md)):**
    1. `POST /open/v1/task`에서 `parentId` 지정 하위 작업 생성 및 영속화 **검증 완료 (PASS)** → **하위 작업(`parentId`) 모드를 기본 전략으로 확정**.
    2. 2-Step `POST /open/v1/project/{projectId}/task/{taskId}/complete` 완료 처리 및 부모 태스크 상태·일정 무변경 **검증 완료 (PASS)**.
    3. `GET /open/v1/project/inbox/data` Inbox 조회 및 `GET /open/v1/tag` 태그 목록 조회 **검증 완료 (PASS)**.
    4. 전용 리스트(`TimeLog`) **Fallback 모드**는 선택적 사용자 설정 및 장애 대비용으로 유지.
* **원 작업 완료 동기화:**
  * 기록 전송 시 `[원래 태스크도 완료로 표시]` 옵션 제공. 체크 시 부모 태스크를 완료 처리(`complete` 엔드포인트)하되, **부모 태스크의 원래 예정 시간은 수정하지 않음**.
* **"아 맞다!" 사후 밀어넣기 (Retroactive Sync):**
  * 타이머를 켜지 않고 작업한 경우, 타임라인 뷰에서 자동 기록된 활동 블록들을 드래그/다중 선택해 하나의 시간 기록(`time_entries`)으로 변환.
  * 변환된 기록에 TickTick 태스크를 매핑하고 `[TickTick에 밀어넣기]`를 눌러 사후 동기화.

---

## 3. UI / UX 구성

| 영역 | 구성 요소 및 동작 |
| --- | --- |
| **상단 타이머 바** | 고정 헤더. 작업명 입력창(입력 시 TickTick 태스크 자동완성 드롭다운), 프로젝트(TickTick 리스트)/태그 선택기, 경과 시간, 시작/정지 버튼. |
| **좌측 사이드바** | `Timer (리스트 뷰)` / `Timeline (자동 추적 뷰)` / `TickTick (할 일 목록)` / `Settings` 탭 전환. |
| **Timer 뷰 (기본)** | 날짜별로 그룹화된 수동/확정 시간 기록 리스트. 각 항목에 프로젝트 색상, 태그, TickTick 동기화 상태 뱃지(`local` / `pending` / `synced` / `failed` + 원 작업 완료 표시) 및 재시도 버튼 제공. |
| **Timeline 뷰** | 시간축 위에 **자동 추적된 앱 활동 블록**과 **수동 타이머 블록**을 나란히 배치. 자동 블록을 드래그 선택해 즉시 Time Entry 생성 및 TickTick 밀어넣기 지원. |
| **시스템 트레이** | 트레이 아이콘 색상으로 타이머 실행 여부 구분. 우클릭 메뉴(시작/정지, 미니 타이머 열기, 앱 열기, 종료). |

---

## 4. 로컬 데이터베이스 스키마 (SQLite v0.1)

초기화 시 반드시 `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`를 적용한다.

```sql
-- 1. 자동 수집 활동 로그 (Timeline 원천 데이터)
CREATE TABLE activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'win_api', -- 'win_api', 'vscode_ext', 'mock' 등
    process_name TEXT NOT NULL,
    window_title TEXT,
    metadata_json TEXT,                     -- 익스텐션 확장 데이터 (워크스페이스, 브랜치 등)
    is_idle INTEGER NOT NULL DEFAULT 0,     -- 0: 활동, 1: 유휴
    started_at INTEGER NOT NULL,            -- Unix Timestamp (ms)
    ended_at INTEGER NOT NULL
);

CREATE INDEX idx_activity_logs_time ON activity_logs(started_at, ended_at);

-- 2. TickTick 프로젝트(리스트) 로컬 캐시
CREATE TABLE ticktick_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT,
    sort_order INTEGER DEFAULT 0,
    is_inbox INTEGER NOT NULL DEFAULT 0,
    closed INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER NOT NULL
);

-- 3. TickTick 태스크 로컬 캐시
CREATE TABLE ticktick_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_id TEXT,                         -- 상위 태스크 ID (하위 작업인 경우)
    title TEXT NOT NULL,
    content TEXT,
    tags_json TEXT,                         -- TickTick 원본 태그 JSON 배열
    status INTEGER NOT NULL DEFAULT 0,      -- 0: 미완료, 2: 완료
    start_date TEXT,
    due_date TEXT,
    synced_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES ticktick_projects(id) ON DELETE CASCADE
);

CREATE INDEX idx_ticktick_tasks_project_status ON ticktick_tasks(project_id, status);

-- 4. 태그 (TickTick 캐시 태그 + 로컬 커스텀 태그 통합)
CREATE TABLE tags (
    id TEXT PRIMARY KEY,                    -- UUID 또는 'tt:<name>'
    name TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT 'local',   -- 'ticktick' | 'local'
    color TEXT,
    created_at INTEGER NOT NULL
);

-- 5. 확정된 시간 기록 (수동 타이머 및 타임라인에서 변환된 기록)
CREATE TABLE time_entries (
    id TEXT PRIMARY KEY,                    -- UUID
    description TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,            -- Unix Timestamp (ms)
    ended_at INTEGER,                       -- NULL이면 현재 실행 중
    ticktick_project_id TEXT,               -- 연결된 TickTick 프로젝트(리스트) ID
    ticktick_parent_task_id TEXT,           -- 연결된 TickTick 원 태스크 ID
    ticktick_subtask_id TEXT,               -- TickTick에 생성된 완료 하위 작업(또는 Fallback) ID
    sync_mode TEXT,                         -- 'subtask' | 'fallback_list'
    sync_status TEXT NOT NULL DEFAULT 'local', -- 'local', 'pending', 'synced', 'failed'
    sync_error TEXT,                        -- 마지막 동기화 실패 사유
    retry_count INTEGER NOT NULL DEFAULT 0,
    complete_parent_task INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_time_entries_time ON time_entries(started_at, ended_at);
CREATE INDEX idx_time_entries_sync ON time_entries(sync_status);

-- 6. 시간 기록 <-> 태그 N:M 매핑
CREATE TABLE time_entry_tags (
    time_entry_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (time_entry_id, tag_id),
    FOREIGN KEY (time_entry_id) REFERENCES time_entries(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

-- 7. 앱 설정 (Key-Value)
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
```

---

## 5. 개발 마일스톤 (구현 순서)

1. **Phase 0 (PoC & 스캐폴딩):**
   * `tempo` Tauri v2 + React + TypeScript + Tailwind 프로젝트 스캐폴딩 및 OS 추상화 트레이트(`ActivityTracker`, `IdleDetector`) 골격 구성.
   * TickTick Open API v1 PoC 도구 작성 및 검증(`parentId` 하위 작업 생성, 2-step `complete`, 캘린더 노출, Inbox 조회).
   * GitHub Actions Windows(x64, ARM64) 빌드 워크플로우 초안 구성.
2. **Phase 1 (핵심 엔진):** SQLite 마이그레이션 + Windows 활성 창 수집기(절전 갭 분리 포함) + 유휴 감지기 + 시스템 트레이 상주 + 수동 타이머 CRUD.
3. **Phase 2 (타이머 UI & 타임라인):** 상단 타이머 바(자동완성·프로젝트/태그), 미니 타이머, 전역 단축키, Timer 리스트 뷰, Timeline 뷰(드래그 선택 → Time Entry 변환).
4. **Phase 3 (TickTick 연동):** OAuth2 루프백 로그인 + OS keyring 토큰 저장, 프로젝트/태스크/태그 Pull 캐싱, 오프라인 비동기 큐(하위 작업/Fallback 밀어넣기 + 원 작업 완료 처리).
5. **Phase 4 (확장):** 로컬 IPC 엔드포인트(Named Pipe / 인증된 `127.0.0.1` HTTP) 오픈 및 VS Code 익스텐션 제작.
