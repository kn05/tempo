# tempo

Windows용 로컬 우선 타임 트래커. 수동 타이머와 활성 창 기록을 로컬 SQLite에 쌓고, 필요한 기록만 TickTick 캘린더 타임라인으로 보낸다.

## 기능

### 타이머
상단 바에서 작업명을 입력해 바로 타이머를 켠다. `@프로젝트`, `#태그` 문법과 TickTick 태스크 자동완성을 지원하고, 메인 창을 닫아도 시스템 트레이에 남아 백그라운드 추적을 이어간다. 항상 위 미니 타이머와 전역 단축키로도 제어할 수 있고, 타이머가 켜진 채 자리를 비우면 복귀 시 유휴 구간을 유지, 제외, 분리할지 고를 수 있다.

### 자동 타임라인과 개인정보 필터
Windows 활성 창을 백그라운드에서 수집해 하루 단위 타임라인으로 보여준다. 짧은 앱 전환은 하나의 블록으로 묶이고, 타이머를 켜지 않고 일한 구간은 드래그해서 시간 기록으로 바꿀 수 있다.

설정에서 특정 앱을 수집 대상에서 빼거나, 프로세스나 키워드 기준으로 창 제목을 가릴 수 있다. 제목 가리기 규칙은 저장 시 과거 타임라인 로그에도 소급 적용된다.

### TickTick 연동
프로젝트, 태스크, 태그를 로컬 SQLite에 캐싱해 오프라인에서도 동작한다. 시간 기록을 보낼 때는 원래 태스크의 예정 일정을 건드리지 않고 완료된 하위 작업(`parentId`)으로 캘린더 타임라인에 남긴다. 원하면 지정한 별도 리스트로 보내는 fallback 모드를 쓸 수 있다.

인증은 OAuth2 루프백과 Personal API Token 둘 다 지원하며, 토큰은 Windows Credential Manager 같은 OS 자격 증명 저장소에 보관한다.

## 실행 및 빌드

Rust(stable)와 Node.js 22+가 필요하다. Windows 네이티브 빌드에는 MSVC 툴체인과 WebView2 환경이 필요하다.

### 코어 테스트와 프론트엔드 프리뷰

```bash
cargo test
npm install
npm run dev
```

루트 `Cargo.toml`의 `default-members`가 `crates/tempo-core`로 지정되어 있어 Linux에서도 GTK/WebKit 없이 코어 테스트를 돌릴 수 있다. `npm run dev`는 Tauri 없이 브라우저 프리뷰 모드로 뜬다.

### Windows 실행 및 인스톨러 빌드

```powershell
npm run tauri dev

# NSIS 인스톨러
npm run tauri build -- --target x86_64-pc-windows-msvc
npm run tauri build -- --target aarch64-pc-windows-msvc
```

`main` 브랜치에 푸시하면 [build-windows.yml](.github/workflows/build-windows.yml) 워크플로우가 x64, ARM64 인스톨러를 빌드한다.

## TickTick 연결 설정

앱 안의 `TickTick` 탭에서 두 방식 중 하나로 연결한다.

1. OAuth2: TickTick Developer Center에 앱을 등록하고 Redirect URI를 `http://127.0.0.1:18492/callback`으로 맞춘 뒤 로그인한다. 포트는 설정에서 바꿀 수 있다.
2. Personal API Token: TickTick 웹의 `Settings > Account > API Token`에서 발급받은 토큰을 입력한다.

API 동작만 따로 확인하려면 `scripts/ticktick_poc.py`를 실행하면 된다.

```bash
TICKTICK_TOKEN="<TOKEN>" python3 scripts/ticktick_poc.py
TICKTICK_TOKEN="<TOKEN>" python3 scripts/ticktick_poc.py --run-write-test --cleanup
```

## 구조

```text
crates/tempo-core/   SQLite, 활성 창 수집기, 유휴 상태머신, TickTick 클라이언트, 동기화 큐
src-tauri/           Tauri v2 셸 (시스템 트레이, 미니 타이머, 전역 단축키, IPC)
src/                 React, TypeScript, Vite, Tailwind CSS v4 프론트엔드
scripts/             TickTick Open API v1 확인용 CLI 및 유틸리티
```

자세한 설계와 작업 기록은 아래 문서에 있다.

- [SPEC.md](SPEC.md): 기능 명세 및 SQLite 스키마
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): 구현 현황과 개발 규칙
- [docs/poc-results.md](docs/poc-results.md): TickTick Open API v1 검증 결과
- [docs/research.md](docs/research.md): TickTick API 조사 메모

로컬 IPC 기반 VS Code 익스텐션 연동은 아직 미구현 상태다.
