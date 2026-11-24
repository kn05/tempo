# tempo

Lightweight, Local-First Windows time tracker (Rust + Tauri v2 + SQLite + React/TypeScript/Tailwind) with TickTick calendar timeline synchronization.

자세한 기능 및 아키텍처 설계는 [SPEC.md](./SPEC.md), 현재 개발 현황 및 다음 단계 가이드는 [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md), API 리서치·PoC 결과는 [docs/research.md](./docs/research.md)와 [docs/poc-results.md](./docs/poc-results.md)를 참고하세요.

---

## 프로젝트 구조 (Phase 0)

```text
tempo/
├── SPEC.md                          # v0.1 기능/아키텍처/SQLite 스키마 명세
├── crates/tempo-core/               # OS 독립 코어 크레이트 (SQLite, 추적기 Trait/Win32, TickTick 클라이언트)
├── src-tauri/                       # Tauri v2 데스크톱 셸 (시스템 트레이, 창 닫기->트레이 최소화, IPC 커맨드)
├── src/                             # React + TypeScript + Vite + Tailwind CSS v4 UI
├── scripts/ticktick_poc.py          # Phase 0 TickTick Open API v1 PoC 검증 CLI (외부 패키지 불필요)
└── .github/workflows/build-windows.yml  # Windows x64 / ARM64 네이티브 빌드 CI
```

---

## Phase 0 검증 가이드

### 1. TickTick Open API v1 PoC 실행 (`parentId` / 2-Step 완료 / Inbox 검증)

**방법 A — Personal API Token (가장 빠름)**
TickTick 웹 앱 → `Settings → Account → API Token`에서 토큰 발급 후 실행:

```bash
# 1) 읽기 전용 프로브 (프로젝트 목록, 태그 엔드포인트, Inbox 조회 확인)
TICKTICK_TOKEN="<YOUR_TOKEN>" python3 scripts/ticktick_poc.py

# 2) 실제 쓰기 검증 (임시 부모 태스크 + parentId 완료 하위 작업 생성 -> 캘린더 타임라인 확인)
TICKTICK_TOKEN="<YOUR_TOKEN>" python3 scripts/ticktick_poc.py --run-write-test

# (확인 후 즉시 자동 삭제까지 하려면 --cleanup 추가)
TICKTICK_TOKEN="<YOUR_TOKEN>" python3 scripts/ticktick_poc.py --run-write-test --cleanup
```

**방법 B — OAuth2 루프백 플로우**
TickTick Developer Center에서 앱을 등록하고 Redirect URI로 `http://127.0.0.1:18492/callback`을 지정한 뒤 실행:

```bash
TICKTICK_CLIENT_ID="<ID>" TICKTICK_CLIENT_SECRET="<SECRET>" \
  python3 scripts/ticktick_poc.py --oauth --run-write-test
```

### 2. 코어 테스트 & 프론트엔드 빌드 (Linux / Windows 공통)

```bash
# Rust 코어 단위 테스트 (SQLite 스키마, 활동 병합/절전 분리/유휴 분리, TickTick DTO)
cargo test

# PoC 스크립트 오프라인 자가 테스트
python3 scripts/ticktick_poc.py --self-test

# 프론트엔드 설치 및 빌드 / 브라우저 프리뷰
npm install
npm run build
npm run dev
```

### 3. Windows 네이티브 실행 / 빌드 (x64 & ARM64)

```powershell
# 개발 모드
npm run tauri dev

# 릴리즈 번들 (NSIS)
npm run tauri build -- --target x86_64-pc-windows-msvc
npm run tauri build -- --target aarch64-pc-windows-msvc
```
