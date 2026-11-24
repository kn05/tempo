import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { IdleReturnModal } from "./components/IdleReturnModal";
import { SettingsView, type SettingsDraft } from "./components/SettingsView";
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

function buildSettingsDraft(loaded: AppSettings): SettingsDraft {
  return {
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
  };
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
  const [settingsSavedIndicator, setSettingsSavedIndicator] = useState(false);

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
    }, 3_500);
  }, []);

  const hydrateSettingsDraft = useCallback((loaded: AppSettings) => {
    setSettings(loaded);
    setSettingsDraft(buildSettingsDraft(loaded));
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
      showToast(ticktickStatus?.connected ? "TickTick 동기화 등록됨" : "대기 큐 저장됨");
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSaveOAuthConfig(input: SaveOAuthConfigInput) {
    const next = await saveTickTickOAuthConfig(input);
    setTickTickStatus(next);
    await refresh();
    showToast("OAuth2 설정 저장됨");
  }

  async function handleStartOAuthLogin(): Promise<OAuthLoginStartResult> {
    const result = await startTickTickOAuthLogin();
    await refresh();
    showToast("브라우저 인증 대기 중");
    return result;
  }

  async function handleCancelOAuthLogin() {
    const next = await cancelTickTickOAuthLogin();
    setTickTickStatus(next);
    showToast("OAuth2 인증 취소됨");
  }

  async function handleConnectPersonalToken(token: string) {
    const next = await connectTickTickPersonalToken(token);
    setTickTickStatus(next);
    try {
      const pull = await pullTickTickCache();
      await refresh();
      showToast(`TickTick 연결 · ${pull.projectsSynced} 프로젝트 · ${pull.tasksSynced} 태스크`);
    } catch {
      await refresh();
      showToast("TickTick 연결됨");
    }
  }

  async function handleDisconnectTickTick() {
    const next = await disconnectTickTick();
    setTickTickStatus(next);
    showToast("TickTick 연결 해제됨");
  }

  async function handlePullTickTickCache(): Promise<TickTickPullResult> {
    const res = await pullTickTickCache();
    await refresh();
    showToast(`Pull · ${res.projectsSynced} 프로젝트 · ${res.tasksSynced} 태스크`);
    return res;
  }

  async function handleProcessTickTickQueue(): Promise<TickTickSyncBatchResult> {
    const batch = await processTickTickSyncQueue();
    await refresh();
    if (batch.processed === 0 && batch.skipped > 0) {
      showToast("오프라인 · 대기 유지");
    } else {
      showToast(`전송 · 성공 ${batch.synced} · 실패 ${batch.failed}`);
    }
    return batch;
  }

  async function handleRetryFailedTickTickSyncs(): Promise<TickTickSyncBatchResult> {
    const batch = await retryFailedTickTickSyncs();
    await refresh();
    showToast(`재시도 · 성공 ${batch.synced} · 실패 ${batch.failed}`);
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
    setSettingsSavedIndicator(true);
    window.setTimeout(() => setSettingsSavedIndicator(false), 2_500);
  }

  const runtimeLabel = status
    ? `${status.os}/${status.arch}${status.schemaVersion ? ` · db v${status.schemaVersion}` : ""}`
    : "";

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#09090b] text-zinc-100">
      <Sidebar
        activeTab={activeTab}
        onSelect={setActiveTab}
        onToggleMiniTimer={() => void handleToggleMiniTimer()}
        ticktickStatus={ticktickStatus}
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

        <main
          className={`min-h-0 flex-1 ${
            activeTab === "timeline"
              ? "overflow-y-auto px-6 py-4 lg:overflow-hidden"
              : "overflow-y-auto px-6 py-6"
          }`}
        >
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
            <SettingsView
              draft={settingsDraft}
              savedSettings={settings}
              projects={projects}
              shortcutStatus={shortcutStatus}
              ticktickStatus={ticktickStatus}
              runtimeLabel={runtimeLabel}
              savedIndicator={settingsSavedIndicator}
              onChangeDraft={setSettingsDraft}
              onSubmit={handleSaveSettings}
              onResetDraft={() => setSettingsDraft(buildSettingsDraft(settings))}
              onOpenTickTick={() => setActiveTab("ticktick")}
            />
          )}
        </main>
      </div>

      {idlePrompt && <IdleReturnModal prompt={idlePrompt} onResolve={handleResolveIdle} />}

      {toastMsg && (
        <div className="fixed bottom-5 right-5 z-50 flex max-w-sm items-center gap-2.5 rounded-full border border-white/[0.12] bg-[#16161f]/95 py-2 pl-4 pr-2.5 text-xs font-medium text-zinc-200 shadow-2xl shadow-black/70 backdrop-blur-xl">
          <span>{toastMsg}</span>
          <button
            type="button"
            onClick={() => setToastMsg(null)}
            className="rounded-full p-1 text-zinc-500 transition-colors hover:bg-white/[0.08] hover:text-zinc-100"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
