import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ActivityLog,
  AppSettings,
  CreateTimeEntryInput,
  IdleResolutionInput,
  IdleResolutionResult,
  IdleReturnPrompt,
  OAuthLoginStartResult,
  ParsedQuickEntry,
  PlatformStatus,
  PresenceOverride,
  SaveOAuthConfigInput,
  ShortcutStatus,
  StartTimerInput,
  Tag,
  TickTickAuthMethod,
  TickTickConnectionStatus,
  TickTickProject,
  TickTickPullResult,
  TickTickSyncBatchResult,
  TickTickSyncQueueSummary,
  TickTickTask,
  TimeEntry,
  UpdateTimeEntryInput,
} from "../types";
import { parseQuickEntry } from "./quickEntry";

export const EVENT_IDLE_RETURN = "tempo://idle-return";
export const EVENT_TIMER_CHANGED = "tempo://timer-changed";
export const EVENT_ENTRIES_CHANGED = "tempo://entries-changed";
export const EVENT_FOCUS_QUICK_ENTRY = "tempo://focus-quick-entry";
export const EVENT_TICKTICK_CHANGED = "tempo://ticktick-changed";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// =============================================================================
// Browser Preview Fallback (supports `npm run dev` + multi-tab `/?window=mini`)
// =============================================================================

const PREVIEW_STORAGE_KEY = "tempo_preview_state_v2";
const PREVIEW_CHANNEL_NAME = "tempo-preview-sync";

interface PreviewTickTickAuth {
  connected: boolean;
  authMethod: TickTickAuthMethod | null;
  hasClientSecret: boolean;
  authInProgress: boolean;
  pendingAuthorizeUrl: string | null;
  lastPullAt: number | null;
  lastSyncError: string | null;
}

interface PreviewState {
  projects: TickTickProject[];
  tasks: TickTickTask[];
  tags: Tag[];
  entries: TimeEntry[];
  activityLogs: ActivityLog[];
  settings: AppSettings;
  ticktickAuth: PreviewTickTickAuth;
}

function buildInitialPreviewState(): PreviewState {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const h = (base: number, hours: number, mins = 0) =>
    base + Math.round((hours * 60 + mins) * 60 * 1000);
  const syncedAt = Date.now() - 15 * 60 * 1000;

  const projects: TickTickProject[] = [
    {
      id: "inbox",
      name: "Inbox",
      color: "#64748b",
      sortOrder: 0,
      isInbox: true,
      closed: false,
      syncedAt,
    },
    {
      id: "proj-tempo",
      name: "tempo 개발",
      color: "#6366f1",
      sortOrder: 1,
      isInbox: false,
      closed: false,
      syncedAt,
    },
    {
      id: "proj-work",
      name: "Work",
      color: "#10b981",
      sortOrder: 2,
      isInbox: false,
      closed: false,
      syncedAt,
    },
    {
      id: "proj-personal",
      name: "Personal",
      color: "#f59e0b",
      sortOrder: 3,
      isInbox: false,
      closed: false,
      syncedAt,
    },
  ];

  const tasks: TickTickTask[] = [
    {
      id: "task-timeline-ux",
      projectId: "proj-tempo",
      parentId: null,
      title: "Phase 2 타임라인 드래그 선택 UX 구현",
      content: "자동 추적 블록 드래그 선택 및 Time Entry 사후 변환 팝오버",
      tags: ["deep-work", "ui"],
      status: 0,
      startDate: null,
      dueDate: null,
      syncedAt,
    },
    {
      id: "task-timer-bar",
      projectId: "proj-tempo",
      parentId: null,
      title: "상단 타이머 바 @프로젝트/#태그 자동완성",
      content: "실행 중 라이브 편집 및 TickTick 태스크 자동완성 드롭다운",
      tags: ["ui"],
      status: 0,
      startDate: null,
      dueDate: null,
      syncedAt,
    },
    {
      id: "task-mini-timer",
      projectId: "proj-tempo",
      parentId: null,
      title: "미니 타이머 멀티 윈도우 & 전역 단축키 연결",
      content: "Always on top 플로팅 창과 Ctrl+Alt+S/T 전역 단축키",
      tags: ["deep-work"],
      status: 0,
      startDate: null,
      dueDate: null,
      syncedAt,
    },
    {
      id: "task-api-docs",
      projectId: "proj-work",
      parentId: null,
      title: "API 명세서 v0.2 검토 및 문서 정리",
      content: "OAuth2 루프백 플로우 및 에러 코드 테이블 보완",
      tags: ["docs"],
      status: 0,
      startDate: null,
      dueDate: null,
      syncedAt,
    },
    {
      id: "task-weekly-sync",
      projectId: "proj-work",
      parentId: null,
      title: "주간 아키텍처 리뷰 미팅 준비",
      content: "Phase 2 데모 시나리오 체크리스트 작성",
      tags: ["meeting"],
      status: 0,
      startDate: null,
      dueDate: null,
      syncedAt,
    },
    {
      id: "task-inbox-triage",
      projectId: "inbox",
      parentId: null,
      title: "인박스 정리 및 이번 주 우선순위 분류",
      content: null,
      tags: [],
      status: 0,
      startDate: null,
      dueDate: null,
      syncedAt,
    },
    {
      id: "task-workout",
      projectId: "proj-personal",
      parentId: null,
      title: "저녁 러닝 & 스트레칭",
      content: "30분 가볍게 조깅",
      tags: [],
      status: 0,
      startDate: null,
      dueDate: null,
      syncedAt,
    },
  ];

  const tags: Tag[] = [
    { id: "tt:deep-work", name: "deep-work", source: "ticktick", color: "#6366f1", createdAt: syncedAt },
    { id: "tt:docs", name: "docs", source: "ticktick", color: "#0ea5e9", createdAt: syncedAt },
    { id: "tt:ui", name: "ui", source: "ticktick", color: "#8b5cf6", createdAt: syncedAt },
    { id: "local-meeting", name: "meeting", source: "local", color: "#f59e0b", createdAt: syncedAt },
    { id: "local-bugfix", name: "bugfix", source: "local", color: "#f43f5e", createdAt: syncedAt },
  ];

  const entries: TimeEntry[] = [
    {
      id: "preview-entry-1",
      description: "상단 타이머 바 @프로젝트/#태그 자동완성",
      startedAt: h(todayStart, 9, 10),
      endedAt: h(todayStart, 10, 25),
      ticktickProjectId: "proj-tempo",
      ticktickParentTaskId: "task-timer-bar",
      ticktickSubtaskId: "tt-sub-001",
      syncMode: "subtask",
      syncStatus: "synced",
      syncError: null,
      retryCount: 0,
      completeParentTask: false,
      tagIds: ["tt:deep-work", "tt:ui"],
      createdAt: h(todayStart, 9, 10),
      updatedAt: h(todayStart, 10, 25),
    },
    {
      id: "preview-entry-2",
      description: "주간 아키텍처 리뷰 미팅",
      startedAt: h(todayStart, 13, 5),
      endedAt: h(todayStart, 13, 50),
      ticktickProjectId: "proj-work",
      ticktickParentTaskId: "task-weekly-sync",
      ticktickSubtaskId: null,
      syncMode: "subtask",
      syncStatus: "pending",
      syncError: null,
      retryCount: 0,
      completeParentTask: true,
      tagIds: ["local-meeting"],
      createdAt: h(todayStart, 13, 5),
      updatedAt: h(todayStart, 13, 50),
    },
    {
      id: "preview-entry-3",
      description: "API 명세서 v0.2 검토 및 문서 정리",
      startedAt: h(todayStart, 14, 15),
      endedAt: h(todayStart, 15, 5),
      ticktickProjectId: "proj-work",
      ticktickParentTaskId: "task-api-docs",
      ticktickSubtaskId: null,
      syncMode: "subtask",
      syncStatus: "failed",
      syncError: "네트워크 연결 시간 초과 (Phase 3 동기화 큐 재시도 대기)",
      retryCount: 2,
      completeParentTask: false,
      tagIds: ["tt:docs"],
      createdAt: h(todayStart, 14, 15),
      updatedAt: h(todayStart, 15, 5),
    },
    {
      id: "preview-entry-4",
      description: "Phase 1 SQLite 마이그레이션 및 유휴 감지기 검증",
      startedAt: h(yesterdayStart, 10, 0),
      endedAt: h(yesterdayStart, 11, 40),
      ticktickProjectId: "proj-tempo",
      ticktickParentTaskId: null,
      ticktickSubtaskId: "tt-sub-000",
      syncMode: "subtask",
      syncStatus: "synced",
      syncError: null,
      retryCount: 0,
      completeParentTask: false,
      tagIds: ["tt:deep-work", "local-bugfix"],
      createdAt: h(yesterdayStart, 10, 0),
      updatedAt: h(yesterdayStart, 11, 40),
    },
    {
      id: "preview-entry-5",
      description: "인박스 정리 및 주간 계획 수립",
      startedAt: h(yesterdayStart, 16, 15),
      endedAt: h(yesterdayStart, 16, 50),
      ticktickProjectId: "inbox",
      ticktickParentTaskId: "task-inbox-triage",
      ticktickSubtaskId: null,
      syncMode: null,
      syncStatus: "local",
      syncError: null,
      retryCount: 0,
      completeParentTask: false,
      tagIds: [],
      createdAt: h(yesterdayStart, 16, 15),
      updatedAt: h(yesterdayStart, 16, 50),
    },
  ];

  // Includes intentional unrecorded blocks (e.g. 10:55–11:55 and 15:25–16:20)
  // so the user can test "아 맞다!" drag-select -> Time Entry conversion immediately.
  const activityLogs: ActivityLog[] = [
    {
      id: 1,
      source: "vscode_ext",
      processName: "Code.exe",
      windowTitle: "tempo (main) — TimerBar.tsx",
      metadataJson: JSON.stringify({ workspace: "tempo", branch: "main", file: "src/components/TimerBar.tsx" }),
      isIdle: false,
      startedAt: h(todayStart, 9, 8),
      endedAt: h(todayStart, 10, 12),
    },
    {
      id: 2,
      source: "win_api",
      processName: "chrome.exe",
      windowTitle: "Tauri v2 Window Capabilities & Global Shortcut Docs — Google Chrome",
      metadataJson: null,
      isIdle: false,
      startedAt: h(todayStart, 10, 12),
      endedAt: h(todayStart, 10, 32),
    },
    {
      id: 3,
      source: "win_api",
      processName: "idle",
      windowTitle: null,
      metadataJson: null,
      isIdle: true,
      startedAt: h(todayStart, 10, 32),
      endedAt: h(todayStart, 10, 50),
    },
    {
      id: 4,
      source: "vscode_ext",
      processName: "Code.exe",
      windowTitle: "tempo (main) — TimelineView.tsx",
      metadataJson: JSON.stringify({ workspace: "tempo", branch: "main", file: "src/components/TimelineView.tsx" }),
      isIdle: false,
      startedAt: h(todayStart, 10, 55),
      endedAt: h(todayStart, 11, 20),
    },
    {
      id: 41,
      source: "vscode_ext",
      processName: "Code.exe",
      windowTitle: "tempo (main) — timelineLayout.ts",
      metadataJson: JSON.stringify({ workspace: "tempo", branch: "main", file: "src/lib/timelineLayout.ts" }),
      isIdle: false,
      startedAt: h(todayStart, 11, 20) + 2_000,
      endedAt: h(todayStart, 11, 34),
    },
    {
      id: 5,
      source: "win_api",
      processName: "WindowsTerminal.exe",
      windowTitle: "cargo test -p tempo-core — Windows Terminal",
      metadataJson: null,
      isIdle: false,
      startedAt: h(todayStart, 11, 35),
      endedAt: h(todayStart, 11, 39),
    },
    {
      id: 51,
      source: "win_api",
      processName: "chrome.exe",
      windowTitle: "Timeline Layout Reference — Google Chrome",
      metadataJson: null,
      isIdle: false,
      startedAt: h(todayStart, 11, 39) + 2_000,
      endedAt: h(todayStart, 11, 44),
    },
    {
      id: 52,
      source: "win_api",
      processName: "Slack.exe",
      windowTitle: "#frontend-ux — Slack",
      metadataJson: null,
      isIdle: false,
      startedAt: h(todayStart, 11, 44) + 2_000,
      endedAt: h(todayStart, 11, 47),
    },
    {
      id: 53,
      source: "win_api",
      processName: "explorer.exe",
      windowTitle: "tempo\\src-tauri\\target\\aarch64-pc-windows-msvc",
      metadataJson: null,
      isIdle: false,
      startedAt: h(todayStart, 11, 47) + 2_000,
      endedAt: h(todayStart, 11, 50),
    },
    {
      id: 54,
      source: "vscode_ext",
      processName: "Code.exe",
      windowTitle: "tempo (main) — AppBadgeIcon.tsx",
      metadataJson: JSON.stringify({ workspace: "tempo", branch: "main", file: "src/components/AppBadgeIcon.tsx" }),
      isIdle: false,
      startedAt: h(todayStart, 11, 50) + 2_000,
      endedAt: h(todayStart, 11, 56),
    },
    {
      id: 6,
      source: "win_api",
      processName: "Slack.exe",
      windowTitle: "#architecture-review — Slack",
      metadataJson: null,
      isIdle: false,
      startedAt: h(todayStart, 13, 3),
      endedAt: h(todayStart, 13, 52),
    },
    {
      id: 7,
      source: "win_api",
      processName: "Notion.exe",
      windowTitle: "TickTick Open API v1 Spec & Sync Notes",
      metadataJson: null,
      isIdle: false,
      startedAt: h(todayStart, 14, 14),
      endedAt: h(todayStart, 15, 6),
    },
    {
      id: 8,
      source: "win_api",
      processName: "idle",
      windowTitle: null,
      metadataJson: null,
      isIdle: true,
      startedAt: h(todayStart, 15, 6),
      endedAt: h(todayStart, 15, 22),
    },
    {
      id: 9,
      source: "win_api",
      processName: "Figma.exe",
      windowTitle: "tempo Mini Timer & Timeline Wireframe — Figma",
      metadataJson: null,
      isIdle: false,
      startedAt: h(todayStart, 15, 25),
      endedAt: h(todayStart, 16, 4),
    },
    {
      id: 10,
      source: "vscode_ext",
      processName: "Code.exe",
      windowTitle: "tempo (main) — MiniTimer.tsx",
      metadataJson: JSON.stringify({ workspace: "tempo", branch: "main", file: "src/components/MiniTimer.tsx" }),
      isIdle: false,
      startedAt: h(todayStart, 16, 4),
      endedAt: h(todayStart, 16, 35),
    },
    {
      id: 11,
      source: "vscode_ext",
      processName: "Code.exe",
      windowTitle: "tempo (main) — db/mod.rs",
      metadataJson: JSON.stringify({ workspace: "tempo", branch: "main", file: "crates/tempo-core/src/db/mod.rs" }),
      isIdle: false,
      startedAt: h(yesterdayStart, 9, 55),
      endedAt: h(yesterdayStart, 11, 42),
    },
    {
      id: 12,
      source: "win_api",
      processName: "chrome.exe",
      windowTitle: "TickTick Web — Inbox",
      metadataJson: null,
      isIdle: false,
      startedAt: h(yesterdayStart, 16, 10),
      endedAt: h(yesterdayStart, 16, 52),
    },
  ];

  const settings: AppSettings = {
    pollIntervalMs: 2_000,
    idleThresholdMs: 300_000,
    sleepGapThresholdMs: 10_000,
    redactedProcesses: ["1password.exe", "bitwarden.exe", "keepass.exe", "keepassxc.exe"],
    redactedTitleKeywords: ["InPrivate", "Incognito", "Private Browsing", "시크릿"],
    excludedProcesses: [],
    syncMode: "subtask",
    fallbackProjectId: null,
    stopTimerOnQuit: false,
    timelineMinDurationMs: 0,
    shortcutToggleTimer: "Ctrl+Alt+S",
    shortcutQuickEntry: "Ctrl+Alt+T",
    miniTimerAlwaysOnTop: true,
    autoSyncOnStop: false,
    ticktickTimeZone: null,
    ticktickOauthClientId: null,
    ticktickOauthRedirectPort: 18492,
  };

  const ticktickAuth: PreviewTickTickAuth = {
    connected: false,
    authMethod: null,
    hasClientSecret: false,
    authInProgress: false,
    pendingAuthorizeUrl: null,
    lastPullAt: syncedAt,
    lastSyncError: null,
  };

  return { projects, tasks, tags, entries, activityLogs, settings, ticktickAuth };
}

let previewState: PreviewState | null = null;
const previewListeners = {
  timerChanged: new Set<(running: TimeEntry | null) => void>(),
  entriesChanged: new Set<() => void>(),
  focusQuickEntry: new Set<() => void>(),
  ticktickChanged: new Set<() => void>(),
};

let previewChannel: BroadcastChannel | null = null;
let previewMiniPopup: Window | null = null;

function ensurePreviewChannel() {
  if (typeof window === "undefined" || isTauriRuntime() || previewChannel) return;
  if ("BroadcastChannel" in window) {
    previewChannel = new BroadcastChannel(PREVIEW_CHANNEL_NAME);
    previewChannel.onmessage = (event: MessageEvent<{ type: string; running?: TimeEntry | null }>) => {
      // Reload shared state from localStorage when another preview tab mutates it.
      previewState = loadPreviewStateFromStorage();
      if (event.data?.type === "timer-changed") {
        previewListeners.timerChanged.forEach((cb) => cb(event.data.running ?? null));
      }
      if (event.data?.type === "entries-changed" || event.data?.type === "timer-changed") {
        previewListeners.entriesChanged.forEach((cb) => cb());
      }
      if (event.data?.type === "focus-quick-entry") {
        previewListeners.focusQuickEntry.forEach((cb) => cb());
      }
      if (event.data?.type === "ticktick-changed") {
        previewListeners.ticktickChanged.forEach((cb) => cb());
      }
    };
  }
}

function loadPreviewStateFromStorage(): PreviewState {
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(PREVIEW_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PreviewState>;
        if (parsed && Array.isArray(parsed.projects) && Array.isArray(parsed.entries)) {
          const defaults = buildInitialPreviewState();
          return {
            ...defaults,
            ...parsed,
            settings: { ...defaults.settings, ...(parsed.settings ?? {}) },
            ticktickAuth: { ...defaults.ticktickAuth, ...(parsed.ticktickAuth ?? {}) },
          };
        }
      }
    } catch {
      // Fall back to fresh sample data.
    }
  }
  return buildInitialPreviewState();
}

function getPreviewState(): PreviewState {
  ensurePreviewChannel();
  if (!previewState) {
    previewState = loadPreviewStateFromStorage();
    savePreviewState(previewState);
  }
  return previewState;
}

function savePreviewState(state: PreviewState) {
  previewState = state;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(PREVIEW_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Ignore storage quota errors in private browsing.
    }
  }
}

function notifyPreviewTimerChanged(running: TimeEntry | null) {
  previewListeners.timerChanged.forEach((cb) => cb(running));
  previewListeners.entriesChanged.forEach((cb) => cb());
  previewChannel?.postMessage({ type: "timer-changed", running });
}

function notifyPreviewEntriesChanged() {
  previewListeners.entriesChanged.forEach((cb) => cb());
  previewChannel?.postMessage({ type: "entries-changed" });
}

function notifyPreviewTickTickChanged() {
  previewListeners.ticktickChanged.forEach((cb) => cb());
  previewChannel?.postMessage({ type: "ticktick-changed" });
}

function buildPreviewQueueSummary(entries: TimeEntry[]): TickTickSyncQueueSummary {
  const summary: TickTickSyncQueueSummary = {
    localCount: 0,
    pendingCount: 0,
    syncedCount: 0,
    failedCount: 0,
  };
  for (const entry of entries) {
    if (entry.endedAt === null) continue;
    if (entry.syncStatus === "pending") summary.pendingCount += 1;
    else if (entry.syncStatus === "synced") summary.syncedCount += 1;
    else if (entry.syncStatus === "failed") summary.failedCount += 1;
    else summary.localCount += 1;
  }
  return summary;
}

function buildPreviewTickTickStatus(state: PreviewState): TickTickConnectionStatus {
  const port = state.settings.ticktickOauthRedirectPort ?? 18492;
  const detectedTimeZone =
    typeof Intl !== "undefined"
      ? Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      : "UTC";
  return {
    connected: state.ticktickAuth.connected,
    authMethod: state.ticktickAuth.authMethod,
    oauthConfigured:
      Boolean(state.settings.ticktickOauthClientId) && state.ticktickAuth.hasClientSecret,
    hasClientSecret: state.ticktickAuth.hasClientSecret,
    oauthClientId: state.settings.ticktickOauthClientId,
    oauthRedirectPort: port,
    oauthRedirectUri:
      port === 0
        ? "http://127.0.0.1:<ephemeral>/callback"
        : `http://127.0.0.1:${port}/callback`,
    authInProgress: state.ticktickAuth.authInProgress,
    pendingAuthorizeUrl: state.ticktickAuth.pendingAuthorizeUrl,
    tokenExpiresAt: state.ticktickAuth.connected ? Date.now() + 3_600_000 : null,
    lastPullAt: state.ticktickAuth.lastPullAt,
    lastSyncError: state.ticktickAuth.lastSyncError,
    detectedTimeZone,
    queue: buildPreviewQueueSummary(state.entries),
  };
}

// =============================================================================
// Platform & Activity Collector IPC
// =============================================================================

export async function getPlatformStatus(): Promise<PlatformStatus> {
  if (isTauriRuntime()) {
    return invoke<PlatformStatus>("get_platform_status");
  }
  return {
    os: "web-preview",
    arch: "browser",
    activeWindow: {
      source: "vscode_ext",
      processName: "Code.exe",
      windowTitle: "tempo (main) — TimelineView.tsx",
      metadataJson: JSON.stringify({ workspace: "tempo", branch: "main" }),
    },
    idleMs: 0,
    schemaVersion: 1,
  };
}

export async function listActivityLogs(
  fromMs: number,
  toMs: number,
  minDurationMs?: number | null,
): Promise<ActivityLog[]> {
  if (isTauriRuntime()) {
    return invoke<ActivityLog[]>("list_activity_logs", {
      fromMs,
      toMs,
      minDurationMs: minDurationMs ?? null,
    });
  }
  const state = getPreviewState();
  const minDur = Math.max(0, minDurationMs ?? 0);
  return state.activityLogs
    .filter(
      (log) => log.endedAt >= fromMs && log.startedAt <= toMs && log.endedAt - log.startedAt >= minDur,
    )
    .sort((a, b) => a.startedAt - b.startedAt);
}

export async function submitPresenceHeartbeat(payload: PresenceOverride): Promise<void> {
  if (isTauriRuntime()) {
    await invoke<void>("submit_presence_heartbeat", { payload });
  }
}

// =============================================================================
// Timer & Time Entry CRUD IPC
// =============================================================================

export async function getRunningTimer(): Promise<TimeEntry | null> {
  if (isTauriRuntime()) {
    return invoke<TimeEntry | null>("get_running_timer");
  }
  return getPreviewState().entries.find((entry) => entry.endedAt === null) ?? null;
}

export async function startTimer(input: StartTimerInput): Promise<TimeEntry> {
  if (isTauriRuntime()) {
    return invoke<TimeEntry>("start_timer", { input });
  }
  const state = getPreviewState();
  const now = input.startedAt ?? Date.now();
  const stoppedPrev = state.entries.map((entry) =>
    entry.endedAt === null
      ? { ...entry, endedAt: Math.max(entry.startedAt, now), updatedAt: now }
      : entry,
  );
  const created: TimeEntry = {
    id: crypto.randomUUID(),
    description: input.description,
    startedAt: now,
    endedAt: null,
    ticktickProjectId: input.ticktickProjectId,
    ticktickParentTaskId: input.ticktickParentTaskId,
    ticktickSubtaskId: null,
    syncMode: null,
    syncStatus: "local",
    syncError: null,
    retryCount: 0,
    completeParentTask: false,
    tagIds: input.tagIds,
    createdAt: now,
    updatedAt: now,
  };
  savePreviewState({ ...state, entries: [created, ...stoppedPrev] });
  notifyPreviewTimerChanged(created);
  return created;
}

export async function stopTimer(): Promise<TimeEntry | null> {
  if (isTauriRuntime()) {
    return invoke<TimeEntry | null>("stop_timer");
  }
  const state = getPreviewState();
  const now = Date.now();
  let stopped: TimeEntry | null = null;
  const nextEntries = state.entries.map((entry) => {
    if (entry.endedAt === null) {
      stopped = { ...entry, endedAt: Math.max(entry.startedAt, now), updatedAt: now };
      return stopped;
    }
    return entry;
  });
  savePreviewState({ ...state, entries: nextEntries });
  notifyPreviewTimerChanged(null);
  if (
    stopped &&
    state.settings.autoSyncOnStop &&
    state.ticktickAuth.connected &&
    (stopped as TimeEntry).ticktickParentTaskId
  ) {
    return enqueueTickTickSync((stopped as TimeEntry).id);
  }
  return stopped;
}

export async function listTimeEntries(limit = 100): Promise<TimeEntry[]> {
  if (isTauriRuntime()) {
    return invoke<TimeEntry[]>("list_time_entries", { limit });
  }
  return [...getPreviewState().entries]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

export async function listTimeEntriesInRange(fromMs: number, toMs: number): Promise<TimeEntry[]> {
  if (isTauriRuntime()) {
    return invoke<TimeEntry[]>("list_time_entries_in_range", { fromMs, toMs });
  }
  return getPreviewState()
    .entries.filter((e) => e.startedAt <= toMs && (e.endedAt === null || e.endedAt >= fromMs))
    .sort((a, b) => a.startedAt - b.startedAt);
}

export async function createTimeEntry(input: CreateTimeEntryInput): Promise<TimeEntry> {
  if (isTauriRuntime()) {
    return invoke<TimeEntry>("create_time_entry", { input });
  }
  if (input.endedAt < input.startedAt) {
    throw new Error("endedAt must be greater than or equal to startedAt");
  }
  const state = getPreviewState();
  const now = Date.now();
  const created: TimeEntry = {
    id: crypto.randomUUID(),
    description: input.description,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    ticktickProjectId: input.ticktickProjectId ?? null,
    ticktickParentTaskId: input.ticktickParentTaskId ?? null,
    ticktickSubtaskId: null,
    syncMode: null,
    syncStatus: "local",
    syncError: null,
    retryCount: 0,
    completeParentTask: input.completeParentTask ?? false,
    tagIds: input.tagIds ?? [],
    createdAt: now,
    updatedAt: now,
  };
  savePreviewState({ ...state, entries: [created, ...state.entries] });
  notifyPreviewEntriesChanged();
  return created;
}

export async function updateTimeEntry(
  id: string,
  input: UpdateTimeEntryInput,
): Promise<TimeEntry | null> {
  if (isTauriRuntime()) {
    return invoke<TimeEntry | null>("update_time_entry", { id, input });
  }
  const state = getPreviewState();
  let updated: TimeEntry | null = null;
  let wasRunning = false;
  const now = Date.now();
  const nextEntries = state.entries.map((entry) => {
    if (entry.id !== id) return entry;
    wasRunning = entry.endedAt === null;
    const nextStartedAt = input.startedAt ?? entry.startedAt;
    const nextEndedAt = input.endedAt !== undefined ? input.endedAt : entry.endedAt;
    if (nextEndedAt !== null && nextEndedAt < nextStartedAt) {
      throw new Error("endedAt must be greater than or equal to startedAt");
    }
    updated = {
      ...entry,
      description: input.description ?? entry.description,
      startedAt: nextStartedAt,
      endedAt: nextEndedAt,
      ticktickProjectId:
        input.ticktickProjectId !== undefined ? input.ticktickProjectId : entry.ticktickProjectId,
      ticktickParentTaskId:
        input.ticktickParentTaskId !== undefined
          ? input.ticktickParentTaskId
          : entry.ticktickParentTaskId,
      tagIds: input.tagIds ?? entry.tagIds,
      completeParentTask: input.completeParentTask ?? entry.completeParentTask,
      updatedAt: now,
    };
    return updated;
  });
  savePreviewState({ ...state, entries: nextEntries });
  const running = nextEntries.find((e) => e.endedAt === null) ?? null;
  if (wasRunning || running?.id === id) {
    notifyPreviewTimerChanged(running);
  } else {
    notifyPreviewEntriesChanged();
  }
  return updated;
}

export async function deleteTimeEntry(id: string): Promise<boolean> {
  if (isTauriRuntime()) {
    return invoke<boolean>("delete_time_entry", { id });
  }
  const state = getPreviewState();
  const target = state.entries.find((e) => e.id === id);
  if (!target) return false;
  const nextEntries = state.entries.filter((entry) => entry.id !== id);
  savePreviewState({ ...state, entries: nextEntries });
  if (target.endedAt === null) {
    notifyPreviewTimerChanged(null);
  } else {
    notifyPreviewEntriesChanged();
  }
  return true;
}

// =============================================================================
// Tags & TickTick Cache IPC
// =============================================================================

export async function listTags(): Promise<Tag[]> {
  if (isTauriRuntime()) {
    return invoke<Tag[]>("list_tags");
  }
  return [...getPreviewState().tags].sort((a, b) => a.name.localeCompare(b.name));
}

export async function upsertTag(
  name: string,
  source = "local",
  color: string | null = null,
): Promise<Tag> {
  if (isTauriRuntime()) {
    return invoke<Tag>("upsert_tag", { name, source, color });
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Tag name cannot be empty");
  }
  const state = getPreviewState();
  const existing = state.tags.find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing;
  const tag: Tag = {
    id: source === "ticktick" ? `tt:${trimmed}` : crypto.randomUUID(),
    name: trimmed,
    source,
    color,
    createdAt: Date.now(),
  };
  savePreviewState({ ...state, tags: [...state.tags, tag] });
  notifyPreviewEntriesChanged();
  return tag;
}

export async function deleteTag(id: string): Promise<boolean> {
  if (isTauriRuntime()) {
    return invoke<boolean>("delete_tag", { id });
  }
  const state = getPreviewState();
  const nextTags = state.tags.filter((t) => t.id !== id);
  if (nextTags.length === state.tags.length) return false;
  const nextEntries = state.entries.map((entry) => ({
    ...entry,
    tagIds: entry.tagIds.filter((tid) => tid !== id),
  }));
  savePreviewState({ ...state, tags: nextTags, entries: nextEntries });
  notifyPreviewEntriesChanged();
  return true;
}

export async function listTickTickProjects(includeClosed = false): Promise<TickTickProject[]> {
  if (isTauriRuntime()) {
    return invoke<TickTickProject[]>("list_ticktick_projects", { includeClosed });
  }
  return getPreviewState()
    .projects.filter((p) => includeClosed || !p.closed)
    .sort((a, b) => {
      if (a.isInbox !== b.isInbox) return a.isInbox ? -1 : 1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.localeCompare(b.name);
    });
}

export async function listTickTickTasks(params?: {
  projectId?: string | null;
  status?: number | null;
  query?: string | null;
  limit?: number;
}): Promise<TickTickTask[]> {
  if (isTauriRuntime()) {
    return invoke<TickTickTask[]>("list_ticktick_tasks", {
      projectId: params?.projectId ?? null,
      status: params?.status ?? null,
      query: params?.query ?? null,
      limit: params?.limit ?? 100,
    });
  }
  const q = params?.query?.trim().toLowerCase() ?? "";
  return getPreviewState()
    .tasks.filter((task) => {
      if (params?.projectId && task.projectId !== params.projectId) return false;
      if (params?.status !== undefined && params?.status !== null && task.status !== params.status) {
        return false;
      }
      if (q) {
        const hay = `${task.title} ${task.content ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .slice(0, params?.limit ?? 100);
}

export async function parseQuickEntryInput(input: string): Promise<ParsedQuickEntry> {
  if (isTauriRuntime()) {
    return invoke<ParsedQuickEntry>("parse_quick_entry_input", { input });
  }
  return parseQuickEntry(input);
}

// =============================================================================
// Settings, Shortcuts & Idle Resolution IPC
// =============================================================================

export async function getSettings(): Promise<AppSettings> {
  if (isTauriRuntime()) {
    return invoke<AppSettings>("get_settings");
  }
  return { ...getPreviewState().settings };
}

export async function updateSettings(settings: AppSettings): Promise<AppSettings> {
  if (isTauriRuntime()) {
    return invoke<AppSettings>("update_settings", { settings });
  }
  const state = getPreviewState();
  const clean: AppSettings = {
    ...settings,
    shortcutToggleTimer: settings.shortcutToggleTimer?.trim() || null,
    shortcutQuickEntry: settings.shortcutQuickEntry?.trim() || null,
  };
  savePreviewState({ ...state, settings: clean });
  return { ...clean };
}

export async function getShortcutStatus(): Promise<ShortcutStatus> {
  if (isTauriRuntime()) {
    return invoke<ShortcutStatus>("get_shortcut_status");
  }
  const settings = getPreviewState().settings;
  const warnings: string[] = [];
  if (
    settings.shortcutToggleTimer &&
    settings.shortcutQuickEntry &&
    settings.shortcutToggleTimer.toLowerCase() === settings.shortcutQuickEntry.toLowerCase()
  ) {
    warnings.push("빠른 입력 단축키가 타이머 토글 단축키와 중복됩니다.");
  }
  return {
    toggleTimerRegistered: Boolean(settings.shortcutToggleTimer),
    quickEntryRegistered: Boolean(settings.shortcutQuickEntry) && warnings.length === 0,
    warnings,
  };
}

export async function getPendingIdlePrompt(): Promise<IdleReturnPrompt | null> {
  if (isTauriRuntime()) {
    return invoke<IdleReturnPrompt | null>("get_pending_idle_prompt");
  }
  return null;
}

export async function resolveIdle(input: IdleResolutionInput): Promise<IdleResolutionResult> {
  if (isTauriRuntime()) {
    return invoke<IdleResolutionResult>("resolve_idle", { input });
  }
  const state = getPreviewState();
  const target = state.entries.find((e) => e.id === input.entryId && e.endedAt === null);
  if (!target) {
    throw new Error("Running entry not found");
  }
  const now = Date.now();
  const effectiveIdleStart = Math.max(target.startedAt, input.idleStartedAt);
  const effectiveReturn = Math.max(effectiveIdleStart, input.returnedAt);

  if (input.action === "keep") {
    return { action: "keep", updatedEntry: target, idleEntry: null, resumedEntry: null };
  }

  const stopped: TimeEntry = { ...target, endedAt: effectiveIdleStart, updatedAt: now };
  let nextEntries = state.entries.map((e) => (e.id === target.id ? stopped : e));

  let idleEntry: TimeEntry | null = null;
  let resumedEntry: TimeEntry | null = null;

  if (input.action === "split") {
    idleEntry = {
      id: crypto.randomUUID(),
      description: input.idleDescription ?? "",
      startedAt: effectiveIdleStart,
      endedAt: effectiveReturn,
      ticktickProjectId: null,
      ticktickParentTaskId: null,
      ticktickSubtaskId: null,
      syncMode: null,
      syncStatus: "local",
      syncError: null,
      retryCount: 0,
      completeParentTask: false,
      tagIds: [],
      createdAt: now,
      updatedAt: now,
    };
    nextEntries = [idleEntry, ...nextEntries];
  }

  if (
    input.action === "discard_and_continue" ||
    (input.action === "split" && (input.resumeOriginal ?? true))
  ) {
    resumedEntry = {
      ...target,
      id: crypto.randomUUID(),
      startedAt: effectiveReturn,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    nextEntries = [resumedEntry, ...nextEntries];
  }

  savePreviewState({ ...state, entries: nextEntries });
  notifyPreviewTimerChanged(resumedEntry);

  return {
    action: input.action,
    updatedEntry: stopped,
    idleEntry,
    resumedEntry,
  };
}

// =============================================================================
// Mini Timer Multi-Window Controls
// =============================================================================

export async function openMiniTimer(): Promise<void> {
  if (isTauriRuntime()) {
    await invoke<void>("open_mini_timer");
    return;
  }
  if (typeof window !== "undefined") {
    previewMiniPopup = window.open(
      `${window.location.pathname}?window=mini`,
      "tempo-mini-preview",
      "width=372,height=112,menubar=no,toolbar=no,location=no,status=no",
    );
  }
}

export async function closeMiniTimer(): Promise<void> {
  if (isTauriRuntime()) {
    await invoke<void>("close_mini_timer");
    return;
  }
  if (typeof window !== "undefined") {
    const isMini = new URLSearchParams(window.location.search).get("window") === "mini";
    if (isMini) {
      window.close();
    } else if (previewMiniPopup && !previewMiniPopup.closed) {
      previewMiniPopup.close();
      previewMiniPopup = null;
    }
  }
}

export async function toggleMiniTimer(): Promise<boolean> {
  if (isTauriRuntime()) {
    return invoke<boolean>("toggle_mini_timer");
  }
  if (previewMiniPopup && !previewMiniPopup.closed) {
    previewMiniPopup.close();
    previewMiniPopup = null;
    return false;
  }
  await openMiniTimer();
  return true;
}

export async function isMiniTimerOpen(): Promise<boolean> {
  if (isTauriRuntime()) {
    return invoke<boolean>("is_mini_timer_open");
  }
  return Boolean(previewMiniPopup && !previewMiniPopup.closed);
}

export async function setMiniTimerAlwaysOnTop(alwaysOnTop: boolean): Promise<boolean> {
  if (isTauriRuntime()) {
    return invoke<boolean>("set_mini_timer_always_on_top", { alwaysOnTop });
  }
  const state = getPreviewState();
  savePreviewState({
    ...state,
    settings: { ...state.settings, miniTimerAlwaysOnTop: alwaysOnTop },
  });
  return alwaysOnTop;
}

export async function focusMainWindow(): Promise<void> {
  if (isTauriRuntime()) {
    await invoke<void>("focus_main_window_cmd");
    return;
  }
  if (typeof window !== "undefined") {
    if (window.opener && !window.opener.closed) {
      window.opener.focus();
    } else {
      window.location.href = window.location.pathname;
    }
  }
}

// =============================================================================
// Phase 3: TickTick OAuth2, Pull Caching & Offline Sync Queue IPC
// =============================================================================

export async function getTickTickStatus(): Promise<TickTickConnectionStatus> {
  if (isTauriRuntime()) {
    return invoke<TickTickConnectionStatus>("get_ticktick_status");
  }
  return buildPreviewTickTickStatus(getPreviewState());
}

export async function saveTickTickOAuthConfig(
  input: SaveOAuthConfigInput,
): Promise<TickTickConnectionStatus> {
  if (isTauriRuntime()) {
    return invoke<TickTickConnectionStatus>("save_ticktick_oauth_config", { input });
  }
  const state = getPreviewState();
  const nextClientId = input.clientId.trim() || null;
  const nextPort =
    input.redirectPort !== undefined && input.redirectPort !== null
      ? input.redirectPort
      : state.settings.ticktickOauthRedirectPort;
  const nextHasSecret =
    input.clientSecret === undefined || input.clientSecret === null
      ? state.ticktickAuth.hasClientSecret
      : input.clientSecret.trim().length > 0;

  const nextState: PreviewState = {
    ...state,
    settings: {
      ...state.settings,
      ticktickOauthClientId: nextClientId,
      ticktickOauthRedirectPort: nextPort,
    },
    ticktickAuth: {
      ...state.ticktickAuth,
      hasClientSecret: nextHasSecret,
    },
  };
  savePreviewState(nextState);
  notifyPreviewTickTickChanged();
  return buildPreviewTickTickStatus(nextState);
}

export async function connectTickTickPersonalToken(
  token: string,
): Promise<TickTickConnectionStatus> {
  if (isTauriRuntime()) {
    return invoke<TickTickConnectionStatus>("connect_ticktick_personal_token", { token });
  }
  if (!token.trim()) {
    throw new Error("API 토큰을 입력해주세요.");
  }
  const state = getPreviewState();
  const nextState: PreviewState = {
    ...state,
    ticktickAuth: {
      ...state.ticktickAuth,
      connected: true,
      authMethod: "personal_token",
      authInProgress: false,
      pendingAuthorizeUrl: null,
      lastSyncError: null,
    },
  };
  savePreviewState(nextState);
  notifyPreviewTickTickChanged();
  return buildPreviewTickTickStatus(nextState);
}

export async function startTickTickOAuthLogin(): Promise<OAuthLoginStartResult> {
  if (isTauriRuntime()) {
    return invoke<OAuthLoginStartResult>("start_ticktick_oauth_login");
  }
  const state = getPreviewState();
  if (!state.settings.ticktickOauthClientId || !state.ticktickAuth.hasClientSecret) {
    throw new Error("TickTick OAuth2 Client ID와 Client Secret을 먼저 설정해주세요.");
  }
  const port = state.settings.ticktickOauthRedirectPort || 18492;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authorizeUrl = `https://ticktick.com/oauth/authorize?client_id=${encodeURIComponent(
    state.settings.ticktickOauthClientId,
  )}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=tasks%3Aread+tasks%3Awrite`;

  savePreviewState({
    ...state,
    ticktickAuth: {
      ...state.ticktickAuth,
      authInProgress: true,
      pendingAuthorizeUrl: authorizeUrl,
      lastSyncError: null,
    },
  });
  notifyPreviewTickTickChanged();

  // Simulate loopback callback completion in browser preview mode.
  window.setTimeout(() => {
    const latest = getPreviewState();
    if (!latest.ticktickAuth.authInProgress) return;
    savePreviewState({
      ...latest,
      ticktickAuth: {
        ...latest.ticktickAuth,
        connected: true,
        authMethod: "oauth2",
        authInProgress: false,
        pendingAuthorizeUrl: null,
        lastPullAt: Date.now(),
        lastSyncError: null,
      },
    });
    notifyPreviewTickTickChanged();
    notifyPreviewEntriesChanged();
  }, 900);

  return { authorizeUrl, redirectUri };
}

export async function cancelTickTickOAuthLogin(): Promise<TickTickConnectionStatus> {
  if (isTauriRuntime()) {
    return invoke<TickTickConnectionStatus>("cancel_ticktick_oauth_login");
  }
  const state = getPreviewState();
  const nextState: PreviewState = {
    ...state,
    ticktickAuth: {
      ...state.ticktickAuth,
      authInProgress: false,
      pendingAuthorizeUrl: null,
    },
  };
  savePreviewState(nextState);
  notifyPreviewTickTickChanged();
  return buildPreviewTickTickStatus(nextState);
}

export async function disconnectTickTick(): Promise<TickTickConnectionStatus> {
  if (isTauriRuntime()) {
    return invoke<TickTickConnectionStatus>("disconnect_ticktick");
  }
  const state = getPreviewState();
  const nextState: PreviewState = {
    ...state,
    ticktickAuth: {
      ...state.ticktickAuth,
      connected: false,
      authMethod: null,
      authInProgress: false,
      pendingAuthorizeUrl: null,
      lastSyncError: null,
    },
  };
  savePreviewState(nextState);
  notifyPreviewTickTickChanged();
  return buildPreviewTickTickStatus(nextState);
}

export async function pullTickTickCache(): Promise<TickTickPullResult> {
  if (isTauriRuntime()) {
    return invoke<TickTickPullResult>("pull_ticktick_cache");
  }
  const state = getPreviewState();
  if (!state.ticktickAuth.connected) {
    throw new Error("TickTick 계정이 연결되어 있지 않습니다. 먼저 로그인해주세요.");
  }
  const syncedAt = Date.now();
  const nextState: PreviewState = {
    ...state,
    projects: state.projects.map((p) => ({ ...p, syncedAt })),
    tasks: state.tasks.map((t) => ({ ...t, syncedAt })),
    ticktickAuth: { ...state.ticktickAuth, lastPullAt: syncedAt, lastSyncError: null },
  };
  savePreviewState(nextState);
  notifyPreviewTickTickChanged();
  notifyPreviewEntriesChanged();
  return {
    projectsSynced: nextState.projects.length,
    tasksSynced: nextState.tasks.filter((t) => t.status === 0).length,
    tagsSynced: nextState.tags.filter((t) => t.source === "ticktick").length,
    syncedAt,
    warnings: [],
  };
}

function flushPreviewEntries(entryIds?: Set<string>): TickTickSyncBatchResult {
  const state = getPreviewState();
  const targets = state.entries.filter(
    (e) =>
      e.endedAt !== null &&
      e.syncStatus === "pending" &&
      (!entryIds || entryIds.has(e.id)),
  );
  if (!state.ticktickAuth.connected) {
    return { processed: 0, synced: 0, failed: 0, skipped: targets.length };
  }
  const now = Date.now();
  const completedParentIds = new Set<string>();
  const targetIds = new Set(targets.map((t) => t.id));
  const nextEntries = state.entries.map((entry) => {
    if (!targetIds.has(entry.id)) return entry;
    if (entry.completeParentTask && entry.ticktickParentTaskId) {
      completedParentIds.add(entry.ticktickParentTaskId);
    }
    return {
      ...entry,
      syncStatus: "synced" as const,
      syncError: null,
      ticktickSubtaskId: entry.ticktickSubtaskId ?? `tt-preview-${entry.id.slice(0, 8)}`,
      updatedAt: now,
    };
  });
  const nextTasks =
    completedParentIds.size > 0
      ? state.tasks.map((t) => (completedParentIds.has(t.id) ? { ...t, status: 2 } : t))
      : state.tasks;

  savePreviewState({
    ...state,
    entries: nextEntries,
    tasks: nextTasks,
    ticktickAuth: { ...state.ticktickAuth, lastSyncError: null },
  });
  notifyPreviewEntriesChanged();
  notifyPreviewTickTickChanged();
  return {
    processed: targets.length,
    synced: targets.length,
    failed: 0,
    skipped: 0,
  };
}

export async function enqueueTickTickSync(entryId: string): Promise<TimeEntry> {
  if (isTauriRuntime()) {
    return invoke<TimeEntry>("enqueue_ticktick_sync", { entryId });
  }
  const state = getPreviewState();
  const target = state.entries.find((e) => e.id === entryId);
  if (!target) throw new Error("시간 기록을 찾을 수 없습니다.");
  if (target.endedAt === null) {
    throw new Error("실행 중인 타이머는 정지한 뒤에 TickTick으로 동기화할 수 있습니다.");
  }
  if (target.syncStatus === "synced") return target;

  const effectiveMode =
    state.settings.syncMode === "subtask" && target.ticktickParentTaskId
      ? "subtask"
      : "fallback_list";
  const queued: TimeEntry = {
    ...target,
    syncMode: target.ticktickSubtaskId ? target.syncMode ?? effectiveMode : effectiveMode,
    syncStatus: "pending",
    syncError: null,
    updatedAt: Date.now(),
  };
  savePreviewState({
    ...state,
    entries: state.entries.map((e) => (e.id === entryId ? queued : e)),
  });
  notifyPreviewEntriesChanged();
  notifyPreviewTickTickChanged();

  if (state.ticktickAuth.connected) {
    window.setTimeout(() => {
      flushPreviewEntries(new Set([entryId]));
    }, 350);
  }
  return queued;
}

export async function processTickTickSyncQueue(): Promise<TickTickSyncBatchResult> {
  if (isTauriRuntime()) {
    return invoke<TickTickSyncBatchResult>("process_ticktick_sync_queue");
  }
  return flushPreviewEntries();
}

export async function retryFailedTickTickSyncs(): Promise<TickTickSyncBatchResult> {
  if (isTauriRuntime()) {
    return invoke<TickTickSyncBatchResult>("retry_failed_ticktick_syncs");
  }
  const state = getPreviewState();
  const now = Date.now();
  const requeued = state.entries.map((entry) =>
    entry.endedAt !== null && entry.syncStatus === "failed"
      ? { ...entry, syncStatus: "pending" as const, syncError: null, updatedAt: now }
      : entry,
  );
  savePreviewState({ ...state, entries: requeued });
  return flushPreviewEntries();
}

// =============================================================================
// Event Subscriptions
// =============================================================================

export async function onIdleReturn(
  handler: (prompt: IdleReturnPrompt) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    return () => {};
  }
  return listen<IdleReturnPrompt>(EVENT_IDLE_RETURN, (event) => {
    handler(event.payload);
  });
}

export async function onTimerChanged(
  handler: (running: TimeEntry | null) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) {
    ensurePreviewChannel();
    previewListeners.timerChanged.add(handler);
    return () => {
      previewListeners.timerChanged.delete(handler);
    };
  }
  return listen<TimeEntry | null>(EVENT_TIMER_CHANGED, (event) => {
    handler(event.payload);
  });
}

export async function onEntriesChanged(handler: () => void): Promise<() => void> {
  if (!isTauriRuntime()) {
    ensurePreviewChannel();
    previewListeners.entriesChanged.add(handler);
    return () => {
      previewListeners.entriesChanged.delete(handler);
    };
  }
  return listen<void>(EVENT_ENTRIES_CHANGED, () => {
    handler();
  });
}

export async function onFocusQuickEntry(handler: () => void): Promise<() => void> {
  if (!isTauriRuntime()) {
    ensurePreviewChannel();
    previewListeners.focusQuickEntry.add(handler);
    return () => {
      previewListeners.focusQuickEntry.delete(handler);
    };
  }
  return listen<void>(EVENT_FOCUS_QUICK_ENTRY, () => {
    handler();
  });
}

export async function onTickTickChanged(handler: () => void): Promise<() => void> {
  if (!isTauriRuntime()) {
    ensurePreviewChannel();
    previewListeners.ticktickChanged.add(handler);
    return () => {
      previewListeners.ticktickChanged.delete(handler);
    };
  }
  return listen<void>(EVENT_TICKTICK_CHANGED, () => {
    handler();
  });
}
