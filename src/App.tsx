import { AlertTriangle, CheckCircle2, Cloud, Keyboard, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { IdleReturnModal } from "./components/IdleReturnModal";
import { Sidebar } from "./components/Sidebar";
import { TickTickView } from "./components/TickTickView";
import { TimelineView } from "./components/TimelineView";
import { TimerBar } from "./components/TimerBar";
import { TimerListView } from "./components/TimerListView";
import { matchTagByName } from "./lib/quickEntry";
import {
  cancelTickTickOAuthLogin,
  connectTickTickPersonalToken,
  createTimeEntry,
  deleteTag,
  deleteTimeEntry,
  disconnectTickTick,
  enqueueTickTickSync,
  getPendingIdlePrompt,
  getPlatformStatus,
  getRunningTimer,
  getSettings,
  getShortcutStatus,
  getTickTickStatus,
  listActivityLogs,
  listTags,
  listTickTickProjects,
  listTickTickTasks,
  listTimeEntries,
  listTimeEntriesInRange,
  onEntriesChanged,
  onFocusQuickEntry,
  onIdleReturn,
  onTickTickChanged,
  onTimerChanged,
  processTickTickSyncQueue,
  pullTickTickCache,
  resolveIdle,
  retryFailedTickTickSyncs,
  saveTickTickOAuthConfig,
  startTickTickOAuthLogin,
  startTimer,
  stopTimer,
  toggleMiniTimer,
  updateSettings,
  updateTimeEntry,
  upsertTag,
} from "./lib/tauri";
import { getDayRangeMs } from "./lib/time";
import type {
  ActivityLog,
  AppSettings,
  CreateTimeEntryInput,
  IdleResolutionAction,
  IdleReturnPrompt,
  NavTab,
  OAuthLoginStartResult,
  PlatformStatus,
  SaveOAuthConfigInput,
  ShortcutStatus,
  StartTimerInput,
  SyncMode,
  Tag,
  TickTickConnectionStatus,
  TickTickProject,
  TickTickPullResult,
  TickTickSyncBatchResult,
  TickTickTask,
  TimeEntry,
  UpdateTimeEntryInput,
} from "./types";

function parseCsvList(raw: string): string[] {
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function formatKeyEventToShortcut(event: ReactKeyboardEvent<HTMLInputElement>): string | null {
  const key = event.key;
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) {
    return null;
  }
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  if (parts.length === 0) return null;

  const normalizedKey =
    key.length === 1 ? key.toUpperCase() : key === " " ? "Space" : key;
  parts.push(normalizedKey);
  return parts.join("+");
}

interface SettingsDraft {
  pollIntervalMs: string;
  idleThresholdMin: string;
  sleepGapSec: string;
  redactedProcesses: string;
  redactedTitleKeywords: string;
  excludedProcesses: string;
  syncMode: SyncMode;
  fallbackProjectId: string;
  stopTimerOnQuit: boolean;
  timelineMinDurationSec: string;
  shortcutToggleTimer: string;
  shortcutQuickEntry: string;
  miniTimerAlwaysOnTop: boolean;
  autoSyncOnStop: boolean;
  ticktickTimeZone: string;
  ticktickOauthClientId: string;
  ticktickOauthRedirectPort: number;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<NavTab>("timer");
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [ticktickStatus, setTickTickStatus] = useState<TickTickConnectionStatus | null>(null);
  const [runningEntry, setRunningEntry] = useState<TimeEntry | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [projects, setProjects] = useState<TickTickProject[]>([]);
  const [tasks, setTasks] = useState<TickTickTask[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);

  // Timeline state (for selected local date)
  const [timelineDate, setTimelineDate] = useState<Date>(() => new Date());
  const [timelineLogs, setTimelineLogs] = useState<ActivityLog[]>([]);
  const [timelineEntries, setTimelineEntries] = useState<TimeEntry[]>([]);

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft | null>(null);
  const [shortcutStatus, setShortcutStatus] = useState<ShortcutStatus | null>(null);
  const [settingsSavedMsg, setSettingsSavedMsg] = useState<string | null>(null);
  const [recordingShortcutField, setRecordingShortcutField] = useState<
    "shortcutToggleTimer" | "shortcutQuickEntry" | null
  >(null);

  const [idlePrompt, setIdlePrompt] = useState<IdleReturnPrompt | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const timerInputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToastMsg(message);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMsg(null);
      toastTimerRef.current = null;
    }, 4_000);
  }, []);

  const hydrateSettingsDraft = useCallback((loaded: AppSettings) => {
    setSettings(loaded);
    setSettingsDraft({
      pollIntervalMs: String(loaded.pollIntervalMs),
      idleThresholdMin: String(Math.round(loaded.idleThresholdMs / 60_000)),
      sleepGapSec: String(Math.round(loaded.sleepGapThresholdMs / 1_000)),
      redactedProcesses: loaded.redactedProcesses.join(", "),
      redactedTitleKeywords: loaded.redactedTitleKeywords.join(", "),
      excludedProcesses: loaded.excludedProcesses.join(", "),
      syncMode: loaded.syncMode,
      fallbackProjectId: loaded.fallbackProjectId ?? "",
      stopTimerOnQuit: loaded.stopTimerOnQuit,
      timelineMinDurationSec: String(Math.round(loaded.timelineMinDurationMs / 1_000)),
      shortcutToggleTimer: loaded.shortcutToggleTimer ?? "",
      shortcutQuickEntry: loaded.shortcutQuickEntry ?? "",
      miniTimerAlwaysOnTop: loaded.miniTimerAlwaysOnTop,
      autoSyncOnStop: loaded.autoSyncOnStop,
      ticktickTimeZone: loaded.ticktickTimeZone ?? "",
      ticktickOauthClientId: loaded.ticktickOauthClientId ?? "",
      ticktickOauthRedirectPort: loaded.ticktickOauthRedirectPort ?? 18492,
    });
  }, []);

  const refreshTimelineForDate = useCallback(
    async (date: Date, minDurationMs: number) => {
      const { startMs, endMs } = getDayRangeMs(date);
      const [logs, dayEntries] = await Promise.all([
        listActivityLogs(startMs, endMs, minDurationMs),
        listTimeEntriesInRange(startMs, endMs),
      ]);
      setTimelineLogs(logs);
      setTimelineEntries(dayEntries);
    },
    [],
  );

  const refresh = useCallback(async () => {
    const [
      platformStatus,
      loadedTickTickStatus,
      running,
      list,
      loadedProjects,
      loadedTasks,
      loadedTags,
      pendingPrompt,
      loadedSettings,
      loadedShortcutStatus,
    ] = await Promise.all([
      getPlatformStatus(),
      getTickTickStatus(),
      getRunningTimer(),
      listTimeEntries(200),
      listTickTickProjects(false),
      listTickTickTasks({ limit: 300 }),
      listTags(),
      getPendingIdlePrompt(),
      getSettings(),
      getShortcutStatus(),
    ]);

    setStatus(platformStatus);
    setTickTickStatus(loadedTickTickStatus);
    setRunningEntry(running);
    setEntries(list);
    setProjects(loadedProjects);
    setTasks(loadedTasks);
    setTags(loadedTags);
    setIdlePrompt(pendingPrompt);
    setShortcutStatus(loadedShortcutStatus);
    hydrateSettingsDraft(loadedSettings);

    await refreshTimelineForDate(timelineDate, loadedSettings.timelineMinDurationMs);
  }, [hydrateSettingsDraft, refreshTimelineForDate, timelineDate]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Reload timeline immediately when user navigates dates.
  useEffect(() => {
    if (!settings) return;
    void refreshTimelineForDate(timelineDate, settings.timelineMinDurationMs);
  }, [timelineDate, settings, refreshTimelineForDate]);

  useEffect(() => {
    let disposed = false;
    let unlistenIdle: (() => void) | undefined;
    let unlistenTimer: (() => void) | undefined;
    let unlistenEntries: (() => void) | undefined;
    let unlistenFocus: (() => void) | undefined;
    let unlistenTickTick: (() => void) | undefined;

    void onIdleReturn((prompt) => {
      if (!disposed) setIdlePrompt(prompt);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenIdle = fn;
    });

    void onTimerChanged(() => {
      if (!disposed) void refresh();
    }).then((fn) => {
      if (disposed) fn();
      else unlistenTimer = fn;
    });

    void onEntriesChanged(() => {
      if (!disposed) void refresh();
    }).then((fn) => {
      if (disposed) fn();
      else unlistenEntries = fn;
    });

    void onFocusQuickEntry(() => {
      if (!disposed) {
        timerInputRef.current?.focus();
        timerInputRef.current?.select();
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlistenFocus = fn;
    });

    void onTickTickChanged(() => {
      if (!disposed) void refresh();
    }).then((fn) => {
      if (disposed) fn();
      else unlistenTickTick = fn;
    });

    return () => {
      disposed = true;
      unlistenIdle?.();
      unlistenTimer?.();
      unlistenEntries?.();
      unlistenFocus?.();
      unlistenTickTick?.();
    };
  }, [refresh]);

  async function handleStart(input: StartTimerInput) {
    await startTimer(input);
    await refresh();
  }

  async function handleStop() {
    await stopTimer();
    await refresh();
  }

  async function handleUpdateEntry(id: string, input: UpdateTimeEntryInput) {
    await updateTimeEntry(id, input);
    await refresh();
  }

  async function handleCreateEntry(input: CreateTimeEntryInput): Promise<TimeEntry> {
    const created = await createTimeEntry(input);
    await refresh();
    return created;
  }

  async function handleDeleteEntry(id: string) {
    await deleteTimeEntry(id);
    await refresh();
  }

  async function handleStartSimilar(entry: TimeEntry) {
    await startTimer({
      description: entry.description,
      ticktickProjectId: entry.ticktickProjectId,
      ticktickParentTaskId: entry.ticktickParentTaskId,
      tagIds: [...entry.tagIds],
    });
    await refresh();
  }

  async function handleStartTaskTimer(task: TickTickTask) {
    const mappedTagIds: string[] = [];
    for (const tagName of task.tags) {
      const existing = matchTagByName(tagName, tags);
      if (existing) {
        mappedTagIds.push(existing.id);
      } else {
        const created = await upsertTag(tagName, "ticktick", null);
        mappedTagIds.push(created.id);
      }
    }
    await startTimer({
      description: task.title,
      ticktickProjectId: task.projectId,
      ticktickParentTaskId: task.id,
      tagIds: mappedTagIds,
    });
    setActiveTab("timer");
    await refresh();
  }

  async function handleCreateTag(name: string, color?: string | null): Promise<Tag> {
    const created = await upsertTag(name, "local", color ?? null);
    setTags((prev) =>
      prev.some((t) => t.id === created.id)
        ? prev
        : [...prev, created].sort((a, b) => a.name.localeCompare(b.name)),
    );
    return created;
  }

  async function handleDeleteTag(id: string) {
    await deleteTag(id);
    await refresh();
  }

  async function handleToggleMiniTimer() {
    await toggleMiniTimer();
  }

  async function handleRequestTickTickSync(entry: TimeEntry) {
    try {
      await enqueueTickTickSync(entry.id);
      await refresh();
      if (ticktickStatus?.connected) {
        showToast(
          `"${entry.description || "(Untitled)"}" 기록을 TickTick 동기화 큐에 등록했습니다.`,
        );
      } else {
        showToast(
          `"${entry.description || "(Untitled)"}" 기록이 오프라인 대기 큐(pending)에 저장되었습니다. TickTick 로그인 시 자동 전송됩니다.`,
        );
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveOAuthConfig(input: SaveOAuthConfigInput) {
    const next = await saveTickTickOAuthConfig(input);
    setTickTickStatus(next);
    await refresh();
    showToast("TickTick OAuth2 앱 설정이 저장되었습니다 (Secret은 OS Keyring 보관).");
  }

  async function handleStartOAuthLogin(): Promise<OAuthLoginStartResult> {
    const result = await startTickTickOAuthLogin();
    await refresh();
    showToast("브라우저에서 TickTick 인증을 완료해주세요.");
    return result;
  }

  async function handleCancelOAuthLogin() {
    const next = await cancelTickTickOAuthLogin();
    setTickTickStatus(next);
    showToast("TickTick OAuth2 로그인을 취소했습니다.");
  }

  async function handleConnectPersonalToken(token: string) {
    const next = await connectTickTickPersonalToken(token);
    setTickTickStatus(next);
    try {
      const pull = await pullTickTickCache();
      await refresh();
      showToast(
        `TickTick 연결 완료! 프로젝트 ${pull.projectsSynced}개 · 태스크 ${pull.tasksSynced}개 · 태그 ${pull.tagsSynced}개를 동기화했습니다.`,
      );
    } catch {
      await refresh();
      showToast("TickTick 토큰이 연결되었습니다.");
    }
  }

  async function handleDisconnectTickTick() {
    const next = await disconnectTickTick();
    setTickTickStatus(next);
    showToast("TickTick 연결이 해제되었습니다. 로컬 시간 기록과 캐시는 그대로 유지됩니다.");
  }

  async function handlePullTickTickCache(): Promise<TickTickPullResult> {
    const res = await pullTickTickCache();
    await refresh();
    const warnSuffix = res.warnings.length > 0 ? ` (경고 ${res.warnings.length}건)` : "";
    showToast(
      `TickTick Pull 완료: 프로젝트 ${res.projectsSynced}개 · 태스크 ${res.tasksSynced}개 · 태그 ${res.tagsSynced}개${warnSuffix}`,
    );
    return res;
  }

  async function handleProcessTickTickQueue(): Promise<TickTickSyncBatchResult> {
    const batch = await processTickTickSyncQueue();
    await refresh();
    if (batch.processed === 0 && batch.skipped > 0) {
      showToast("TickTick이 연결되어 있지 않아 대기 큐를 유지했습니다.");
    } else {
      showToast(`동기화 큐 처리 완료: 성공 ${batch.synced}건 · 실패 ${batch.failed}건`);
    }
    return batch;
  }

  async function handleRetryFailedTickTickSyncs(): Promise<TickTickSyncBatchResult> {
    const batch = await retryFailedTickTickSyncs();
    await refresh();
    showToast(`실패 항목 재시도 완료: 성공 ${batch.synced}건 · 실패 ${batch.failed}건`);
    return batch;
  }

  async function handleResolveIdle(
    action: IdleResolutionAction,
    options?: { idleDescription?: string; resumeOriginal?: boolean },
  ) {
    if (!idlePrompt) return;
    await resolveIdle({
      entryId: idlePrompt.entryId,
      action,
      idleStartedAt: idlePrompt.idleStartedAt,
      returnedAt: idlePrompt.returnedAt,
      idleDescription: options?.idleDescription ?? null,
      resumeOriginal: options?.resumeOriginal ?? true,
    });
    setIdlePrompt(null);
    await refresh();
  }

  async function handleSaveSettings(event: FormEvent) {
    event.preventDefault();
    if (!settingsDraft) return;
    const saved = await updateSettings({
      pollIntervalMs: Number.parseInt(settingsDraft.pollIntervalMs, 10) || 2_000,
      idleThresholdMs: Math.max(1, Number.parseFloat(settingsDraft.idleThresholdMin) || 5) * 60_000,
      sleepGapThresholdMs: Math.max(1, Number.parseInt(settingsDraft.sleepGapSec, 10) || 10) * 1_000,
      redactedProcesses: parseCsvList(settingsDraft.redactedProcesses),
      redactedTitleKeywords: parseCsvList(settingsDraft.redactedTitleKeywords),
      excludedProcesses: parseCsvList(settingsDraft.excludedProcesses),
      syncMode: settingsDraft.syncMode,
      fallbackProjectId: settingsDraft.fallbackProjectId.trim() || null,
      stopTimerOnQuit: settingsDraft.stopTimerOnQuit,
      timelineMinDurationMs:
        Math.max(0, Number.parseInt(settingsDraft.timelineMinDurationSec, 10) || 0) * 1_000,
      shortcutToggleTimer: settingsDraft.shortcutToggleTimer.trim() || null,
      shortcutQuickEntry: settingsDraft.shortcutQuickEntry.trim() || null,
      miniTimerAlwaysOnTop: settingsDraft.miniTimerAlwaysOnTop,
      autoSyncOnStop: settingsDraft.autoSyncOnStop,
      ticktickTimeZone: settingsDraft.ticktickTimeZone.trim() || null,
      ticktickOauthClientId: settingsDraft.ticktickOauthClientId.trim() || null,
      ticktickOauthRedirectPort: settingsDraft.ticktickOauthRedirectPort,
    });
    const nextShortcuts = await getShortcutStatus();
    setShortcutStatus(nextShortcuts);
    hydrateSettingsDraft(saved);
    setSettingsSavedMsg("설정이 저장되었고 수집기 및 전역 단축키에 즉시 반영되었습니다.");
    window.setTimeout(() => setSettingsSavedMsg(null), 3_500);
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <Sidebar
        activeTab={activeTab}
        onSelect={setActiveTab}
        onToggleMiniTimer={() => void handleToggleMiniTimer()}
        ticktickStatus={ticktickStatus}
        runtimeLabel={
          status
            ? `${status.os}/${status.arch}${status.schemaVersion ? ` · db v${status.schemaVersion}` : ""}`
            : "loading..."
        }
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TimerBar
          runningEntry={runningEntry}
          projects={projects}
          tasks={tasks}
          tags={tags}
          recentEntries={entries}
          inputRef={timerInputRef}
          onStart={handleStart}
          onStop={handleStop}
          onUpdateRunning={handleUpdateEntry}
          onCreateTag={handleCreateTag}
          onDeleteTag={handleDeleteTag}
          onToggleMiniTimer={handleToggleMiniTimer}
        />

        <main className="min-h-0 flex-1 overflow-y-auto p-6">
          {activeTab === "timer" && (
            <TimerListView
              entries={entries}
              projects={projects}
              tasks={tasks}
              tags={tags}
              ticktickConnected={ticktickStatus?.connected ?? false}
              onStartSimilar={handleStartSimilar}
              onCreateManual={async (input) => {
                await handleCreateEntry(input);
              }}
              onUpdateEntry={handleUpdateEntry}
              onDeleteEntry={handleDeleteEntry}
              onCreateTag={handleCreateTag}
              onDeleteTag={handleDeleteTag}
              onRequestTickTickSync={handleRequestTickTickSync}
              onProcessSyncQueue={async () => {
                await handleProcessTickTickQueue();
              }}
              onRetryFailedSyncs={async () => {
                await handleRetryFailedTickTickSyncs();
              }}
            />
          )}

          {activeTab === "timeline" && (
            <TimelineView
              selectedDate={timelineDate}
              onChangeDate={setTimelineDate}
              activityLogs={timelineLogs}
              timeEntries={timelineEntries}
              projects={projects}
              tasks={tasks}
              tags={tags}
              status={status}
              minDurationMs={settings?.timelineMinDurationMs ?? 0}
              onRefresh={refresh}
              onCreateEntry={handleCreateEntry}
              onUpdateEntry={handleUpdateEntry}
              onDeleteEntry={handleDeleteEntry}
              onCreateTag={handleCreateTag}
              onDeleteTag={handleDeleteTag}
              onRequestTickTickSync={handleRequestTickTickSync}
            />
          )}

          {activeTab === "ticktick" && (
            <TickTickView
              status={ticktickStatus}
              projects={projects}
              tasks={tasks}
              onStartTaskTimer={handleStartTaskTimer}
              onSaveOAuthConfig={handleSaveOAuthConfig}
              onStartOAuthLogin={handleStartOAuthLogin}
              onCancelOAuthLogin={handleCancelOAuthLogin}
              onConnectPersonalToken={handleConnectPersonalToken}
              onDisconnect={handleDisconnectTickTick}
              onPullCache={handlePullTickTickCache}
              onProcessQueue={handleProcessTickTickQueue}
              onRetryFailed={handleRetryFailedTickTickSyncs}
            />
          )}

          {activeTab === "settings" && settingsDraft && settings && (
            <section className="mx-auto max-w-2xl space-y-4">
              <div>
                <h1 className="text-lg font-semibold">Settings</h1>
                <p className="text-xs text-zinc-500">
                  변경된 수집기·유휴·개인정보 필터·전역 단축키 설정은 저장 즉시 반영됩니다.
                </p>
              </div>

              <form
                onSubmit={(e) => void handleSaveSettings(e)}
                className="space-y-5 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-5"
              >
                {/* Global Shortcuts & Mini Timer */}
                <div className="space-y-3 border-b border-zinc-800/80 pb-5">
                  <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                    <Keyboard className="h-4 w-4 text-indigo-400" />
                    전역 단축키 &amp; 미니 타이머
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div className="space-y-1 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">타이머 시작/정지</span>
                        {shortcutStatus && settingsDraft.shortcutToggleTimer.trim() && (
                          <span
                            className={`inline-flex items-center gap-1 text-[10px] ${
                              shortcutStatus.toggleTimerRegistered
                                ? "text-emerald-400"
                                : "text-amber-400"
                            }`}
                          >
                            {shortcutStatus.toggleTimerRegistered ? (
                              <CheckCircle2 className="h-3 w-3" />
                            ) : (
                              <AlertTriangle className="h-3 w-3" />
                            )}
                            {shortcutStatus.toggleTimerRegistered ? "등록됨" : "미등록"}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          value={settingsDraft.shortcutToggleTimer}
                          onFocus={() => setRecordingShortcutField("shortcutToggleTimer")}
                          onBlur={() => setRecordingShortcutField(null)}
                          onChange={(e) =>
                            setSettingsDraft({
                              ...settingsDraft,
                              shortcutToggleTimer: e.target.value,
                            })
                          }
                          onKeyDown={(e) => {
                            const combo = formatKeyEventToShortcut(e);
                            if (combo) {
                              e.preventDefault();
                              setSettingsDraft({
                                ...settingsDraft,
                                shortcutToggleTimer: combo,
                              });
                            }
                          }}
                          placeholder="예: Ctrl+Alt+S (비우면 비활성)"
                          className={`w-full rounded-lg border bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none ${
                            recordingShortcutField === "shortcutToggleTimer"
                              ? "border-indigo-400 ring-1 ring-indigo-500/40"
                              : "border-zinc-800 focus:border-indigo-500"
                          }`}
                        />
                        {settingsDraft.shortcutToggleTimer && (
                          <button
                            type="button"
                            onClick={() =>
                              setSettingsDraft({ ...settingsDraft, shortcutToggleTimer: "" })
                            }
                            title="단축키 비활성화"
                            className="rounded-lg border border-zinc-800 px-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="space-y-1 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400">빠른 입력 창 포커스</span>
                        {shortcutStatus && settingsDraft.shortcutQuickEntry.trim() && (
                          <span
                            className={`inline-flex items-center gap-1 text-[10px] ${
                              shortcutStatus.quickEntryRegistered
                                ? "text-emerald-400"
                                : "text-amber-400"
                            }`}
                          >
                            {shortcutStatus.quickEntryRegistered ? (
                              <CheckCircle2 className="h-3 w-3" />
                            ) : (
                              <AlertTriangle className="h-3 w-3" />
                            )}
                            {shortcutStatus.quickEntryRegistered ? "등록됨" : "미등록"}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          value={settingsDraft.shortcutQuickEntry}
                          onFocus={() => setRecordingShortcutField("shortcutQuickEntry")}
                          onBlur={() => setRecordingShortcutField(null)}
                          onChange={(e) =>
                            setSettingsDraft({
                              ...settingsDraft,
                              shortcutQuickEntry: e.target.value,
                            })
                          }
                          onKeyDown={(e) => {
                            const combo = formatKeyEventToShortcut(e);
                            if (combo) {
                              e.preventDefault();
                              setSettingsDraft({
                                ...settingsDraft,
                                shortcutQuickEntry: combo,
                              });
                            }
                          }}
                          placeholder="예: Ctrl+Alt+T (비우면 비활성)"
                          className={`w-full rounded-lg border bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none ${
                            recordingShortcutField === "shortcutQuickEntry"
                              ? "border-indigo-400 ring-1 ring-indigo-500/40"
                              : "border-zinc-800 focus:border-indigo-500"
                          }`}
                        />
                        {settingsDraft.shortcutQuickEntry && (
                          <button
                            type="button"
                            onClick={() =>
                              setSettingsDraft({ ...settingsDraft, shortcutQuickEntry: "" })
                            }
                            title="단축키 비활성화"
                            className="rounded-lg border border-zinc-800 px-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  <p className="text-[11px] text-zinc-500">
                    입력칸을 클릭한 뒤 원하는 조합 키(예: <code className="text-zinc-300">Ctrl+Alt+S</code>)를 누르면 자동으로 입력됩니다.
                  </p>

                  {shortcutStatus && shortcutStatus.warnings.length > 0 && (
                    <div className="space-y-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                      {shortcutStatus.warnings.map((w, idx) => (
                        <div key={idx} className="flex items-start gap-1.5">
                          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                          <span>{w}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <label className="flex items-center gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={settingsDraft.miniTimerAlwaysOnTop}
                      onChange={(e) =>
                        setSettingsDraft({
                          ...settingsDraft,
                          miniTimerAlwaysOnTop: e.target.checked,
                        })
                      }
                      className="rounded border-zinc-600 bg-zinc-900"
                    />
                    미니 타이머 창 항상 위(Always on top) 유지
                  </label>
                </div>

                {/* Collector & Idle Settings */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <label className="block space-y-1 text-xs">
                    <span className="text-zinc-400">폴링 주기 (ms)</span>
                    <input
                      type="number"
                      min={250}
                      max={60000}
                      value={settingsDraft.pollIntervalMs}
                      onChange={(e) =>
                        setSettingsDraft({ ...settingsDraft, pollIntervalMs: e.target.value })
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                    />
                  </label>

                  <label className="block space-y-1 text-xs">
                    <span className="text-zinc-400">유휴 임계치 (분)</span>
                    <input
                      type="number"
                      min={1}
                      max={1440}
                      value={settingsDraft.idleThresholdMin}
                      onChange={(e) =>
                        setSettingsDraft({ ...settingsDraft, idleThresholdMin: e.target.value })
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                    />
                  </label>

                  <label className="block space-y-1 text-xs">
                    <span className="text-zinc-400">절전 갭 분리 (초)</span>
                    <input
                      type="number"
                      min={1}
                      max={3600}
                      value={settingsDraft.sleepGapSec}
                      onChange={(e) =>
                        setSettingsDraft({ ...settingsDraft, sleepGapSec: e.target.value })
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                    />
                  </label>
                </div>

                <label className="block space-y-1 text-xs">
                  <span className="text-zinc-400">창 제목 마스킹 프로세스 (쉼표 구분)</span>
                  <input
                    type="text"
                    value={settingsDraft.redactedProcesses}
                    onChange={(e) =>
                      setSettingsDraft({ ...settingsDraft, redactedProcesses: e.target.value })
                    }
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                  />
                </label>

                <label className="block space-y-1 text-xs">
                  <span className="text-zinc-400">창 제목 마스킹 키워드 (쉼표 구분)</span>
                  <input
                    type="text"
                    value={settingsDraft.redactedTitleKeywords}
                    onChange={(e) =>
                      setSettingsDraft({
                        ...settingsDraft,
                        redactedTitleKeywords: e.target.value,
                      })
                    }
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                  />
                </label>

                <label className="block space-y-1 text-xs">
                  <span className="text-zinc-400">수집 제외 프로세스 Denylist (쉼표 구분)</span>
                  <input
                    type="text"
                    value={settingsDraft.excludedProcesses}
                    onChange={(e) =>
                      setSettingsDraft({ ...settingsDraft, excludedProcesses: e.target.value })
                    }
                    placeholder="예: KeePass.exe, Signal.exe"
                    className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                  />
                </label>

                {/* TickTick Sync Settings */}
                <div className="space-y-3 border-y border-zinc-800/80 py-5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs font-semibold text-zinc-200">
                      <Cloud className="h-4 w-4 text-emerald-400" />
                      TickTick 동기화 설정
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveTab("ticktick")}
                      className="text-[11px] font-medium text-indigo-300 hover:text-indigo-200"
                    >
                      {ticktickStatus?.connected ? "연결됨 · 계정 관리 →" : "계정 연결하기 →"}
                    </button>
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <label className="block space-y-1 text-xs">
                      <span className="text-zinc-400">TickTick 동기화 모드</span>
                      <select
                        value={settingsDraft.syncMode}
                        onChange={(e) =>
                          setSettingsDraft({
                            ...settingsDraft,
                            syncMode: e.target.value as SyncMode,
                          })
                        }
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                      >
                        <option value="subtask">하위 작업 (parentId 기본)</option>
                        <option value="fallback_list">전용 리스트 (TimeLog Fallback)</option>
                      </select>
                    </label>

                    <label className="block space-y-1 text-xs">
                      <span className="text-zinc-400">Fallback 리스트 선택 (선택)</span>
                      <select
                        value={settingsDraft.fallbackProjectId}
                        onChange={(e) =>
                          setSettingsDraft({
                            ...settingsDraft,
                            fallbackProjectId: e.target.value,
                          })
                        }
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                      >
                        <option value="">자동 (연결 프로젝트 또는 Inbox)</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                        {settingsDraft.fallbackProjectId &&
                          !projects.some((p) => p.id === settingsDraft.fallbackProjectId) && (
                            <option value={settingsDraft.fallbackProjectId}>
                              사용자 지정 ({settingsDraft.fallbackProjectId})
                            </option>
                          )}
                      </select>
                    </label>
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <label className="block space-y-1 text-xs">
                      <span className="text-zinc-400">TickTick 타임존 (비우면 OS 자동 감지)</span>
                      <input
                        type="text"
                        value={settingsDraft.ticktickTimeZone}
                        onChange={(e) =>
                          setSettingsDraft({
                            ...settingsDraft,
                            ticktickTimeZone: e.target.value,
                          })
                        }
                        placeholder={`자동 감지: ${ticktickStatus?.detectedTimeZone ?? "UTC"}`}
                        className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                      />
                    </label>

                    <label className="flex items-center gap-2 self-end pb-2 text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        checked={settingsDraft.autoSyncOnStop}
                        onChange={(e) =>
                          setSettingsDraft({
                            ...settingsDraft,
                            autoSyncOnStop: e.target.checked,
                          })
                        }
                        className="rounded border-zinc-600 bg-zinc-900"
                      />
                      타이머 종료 시 연결된 태스크 자동 동기화
                    </label>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className="block space-y-1 text-xs">
                    <span className="text-zinc-400">타임라인 최소 표시 길이 (초)</span>
                    <input
                      type="number"
                      min={0}
                      max={3600}
                      value={settingsDraft.timelineMinDurationSec}
                      onChange={(e) =>
                        setSettingsDraft({
                          ...settingsDraft,
                          timelineMinDurationSec: e.target.value,
                        })
                      }
                      className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 focus:border-indigo-500 focus:outline-none"
                    />
                  </label>

                  <label className="flex items-center gap-2 self-end pb-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={settingsDraft.stopTimerOnQuit}
                      onChange={(e) =>
                        setSettingsDraft({ ...settingsDraft, stopTimerOnQuit: e.target.checked })
                      }
                      className="rounded border-zinc-600 bg-zinc-900"
                    />
                    앱 종료(Quit) 시 실행 중인 수동 타이머 자동 정지
                  </label>
                </div>

                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs text-emerald-400">{settingsSavedMsg ?? ""}</span>
                  <button
                    type="submit"
                    className="rounded-lg bg-indigo-500 px-4 py-2 text-xs font-medium text-white transition hover:bg-indigo-400"
                  >
                    설정 저장
                  </button>
                </div>
              </form>
            </section>
          )}
        </main>
      </div>

      {idlePrompt && <IdleReturnModal prompt={idlePrompt} onResolve={handleResolveIdle} />}

      {toastMsg && (
        <div className="fixed bottom-5 right-5 z-50 flex max-w-md items-start gap-2.5 rounded-xl border border-zinc-700 bg-zinc-900/95 px-4 py-3 text-xs text-zinc-200 shadow-2xl backdrop-blur">
          <span className="leading-relaxed">{toastMsg}</span>
          <button
            type="button"
            onClick={() => setToastMsg(null)}
            className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
