import {
  AlertCircle,
  Check,
  CheckCircle2,
  CheckSquare,
  Clock,
  CloudUpload,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  applyTimeInputToDate,
  formatDateKey,
  formatDayGroupLabel,
  formatDurationHms,
  formatTimeHm,
} from "../lib/time";
import type {
  CreateTimeEntryInput,
  SyncStatus,
  Tag,
  TickTickProject,
  TickTickTask,
  TimeEntry,
  UpdateTimeEntryInput,
} from "../types";
import { ProjectPicker } from "./ProjectPicker";
import { TagPicker } from "./TagPicker";

interface TimerListViewProps {
  entries: TimeEntry[];
  projects: TickTickProject[];
  tasks: TickTickTask[];
  tags: Tag[];
  ticktickConnected?: boolean;
  onStartSimilar: (entry: TimeEntry) => Promise<void>;
  onCreateManual: (input: CreateTimeEntryInput) => Promise<void>;
  onUpdateEntry: (id: string, input: UpdateTimeEntryInput) => Promise<void>;
  onDeleteEntry: (id: string) => Promise<void>;
  onCreateTag: (name: string, color?: string | null) => Promise<Tag>;
  onDeleteTag: (id: string) => Promise<void>;
  onRequestTickTickSync: (entry: TimeEntry) => Promise<void> | void;
  onRetryFailedSyncs?: () => Promise<void>;
  onProcessSyncQueue?: () => Promise<void>;
}

interface EditDraft {
  description: string;
  startHm: string;
  endHm: string;
  projectId: string | null;
  taskId: string | null;
  tagIds: string[];
  completeParentTask: boolean;
}

function SyncStatusBadge({ entry }: { entry: TimeEntry }) {
  const styles: Record<SyncStatus, { label: string; cls: string }> = {
    local: {
      label: "local",
      cls: "border-zinc-700/80 bg-zinc-800/70 text-zinc-400",
    },
    pending: {
      label: "pending",
      cls: "border-amber-500/40 bg-amber-500/15 text-amber-300",
    },
    synced: {
      label: "synced",
      cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
    },
    failed: {
      label: "failed",
      cls: "border-rose-500/40 bg-rose-500/15 text-rose-300",
    },
  };

  const info = styles[entry.syncStatus];
  return (
    <div className="flex items-center gap-1">
      <span
        title={entry.syncError ?? `TickTick 동기화 상태: ${entry.syncStatus}`}
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${info.cls}`}
      >
        {entry.syncStatus === "synced" && <CheckCircle2 className="h-3 w-3" />}
        {entry.syncStatus === "failed" && <AlertCircle className="h-3 w-3" />}
        {entry.syncStatus === "pending" && <Clock className="h-3 w-3" />}
        {info.label}
      </span>
      {entry.completeParentTask && (
        <span
          title="TickTick 동기화 시 원래 태스크도 완료 처리"
          className="inline-flex items-center gap-0.5 rounded-full border border-indigo-500/40 bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-medium text-indigo-300"
        >
          <Check className="h-2.5 w-2.5" />원 완료
        </span>
      )}
    </div>
  );
}

export function TimerListView({
  entries,
  projects,
  tasks,
  tags,
  ticktickConnected = false,
  onStartSimilar,
  onCreateManual,
  onUpdateEntry,
  onDeleteEntry,
  onCreateTag,
  onDeleteTag,
  onRequestTickTickSync,
  onRetryFailedSyncs,
  onProcessSyncQueue,
}: TimerListViewProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [syncFilter, setSyncFilter] = useState<SyncStatus | "all">("all");
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Manual past entry form
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualDesc, setManualDesc] = useState("");
  const [manualDate, setManualDate] = useState(() => formatDateKey(Date.now()));
  const [manualStartHm, setManualStartHm] = useState(() => formatTimeHm(Date.now() - 30 * 60_000));
  const [manualEndHm, setManualEndHm] = useState(() => formatTimeHm(Date.now()));
  const [manualProjectId, setManualProjectId] = useState<string | null>(null);
  const [manualTaskId, setManualTaskId] = useState<string | null>(null);
  const [manualTagIds, setManualTagIds] = useState<string[]>([]);
  const [manualCompleteParent, setManualCompleteParent] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);

  // Inline editing state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const hasRunning = useMemo(() => entries.some((e) => e.endedAt === null), [entries]);

  useEffect(() => {
    if (!hasRunning) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [hasRunning]);

  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const taskMap = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const tagMap = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return entries.filter((entry) => {
      if (syncFilter !== "all" && entry.syncStatus !== syncFilter) return false;
      if (!q) return true;
      const projName = entry.ticktickProjectId
        ? (projectMap.get(entry.ticktickProjectId)?.name ?? "")
        : "";
      const taskTitle = entry.ticktickParentTaskId
        ? (taskMap.get(entry.ticktickParentTaskId)?.title ?? "")
        : "";
      const tagText = entry.tagIds.map((id) => tagMap.get(id)?.name ?? "").join(" ");
      const hay = `${entry.description} ${projName} ${taskTitle} ${tagText}`.toLowerCase();
      return hay.includes(q);
    });
  }, [entries, searchQuery, syncFilter, projectMap, taskMap, tagMap]);

  const groupedByDay = useMemo(() => {
    const map = new Map<string, TimeEntry[]>();
    for (const entry of filteredEntries) {
      const key = formatDateKey(entry.startedAt);
      const list = map.get(key);
      if (list) list.push(entry);
      else map.set(key, [entry]);
    }
    return [...map.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([dateKey, items]) => {
        const sorted = [...items].sort((a, b) => b.startedAt - a.startedAt);
        const totalMs = sorted.reduce(
          (acc, item) => acc + Math.max(0, (item.endedAt ?? nowMs) - item.startedAt),
          0,
        );
        return { dateKey, items: sorted, totalMs };
      });
  }, [filteredEntries, nowMs]);

  const todayKey = formatDateKey(nowMs);
  const todayTotalMs = useMemo(
    () =>
      entries
        .filter((e) => formatDateKey(e.startedAt) === todayKey)
        .reduce((acc, item) => acc + Math.max(0, (item.endedAt ?? nowMs) - item.startedAt), 0),
    [entries, todayKey, nowMs],
  );

  function openManualForm() {
    const now = Date.now();
    setManualDate(formatDateKey(now));
    setManualStartHm(formatTimeHm(now - 30 * 60_000));
    setManualEndHm(formatTimeHm(now));
    setManualError(null);
    setShowManualForm((v) => !v);
  }

  async function handleCreateManualSubmit(event: FormEvent) {
    event.preventDefault();
    const [y, m, d] = manualDate.split("-").map(Number);
    if (!y || !m || !d) {
      setManualError("올바른 날짜를 입력하세요.");
      return;
    }
    const baseTs = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    const startedAt = applyTimeInputToDate(baseTs, manualStartHm);
    const endedAt = applyTimeInputToDate(baseTs, manualEndHm);
    if (startedAt === null || endedAt === null) {
      setManualError("시작/종료 시각 형식이 올바르지 않습니다 (HH:MM).");
      return;
    }
    if (endedAt < startedAt) {
      setManualError("종료 시각은 시작 시각보다 같거나 늦어야 합니다.");
      return;
    }

    await onCreateManual({
      description: manualDesc.trim() || "(Manual Entry)",
      startedAt,
      endedAt,
      ticktickProjectId: manualProjectId,
      ticktickParentTaskId: manualTaskId,
      tagIds: manualTagIds,
      completeParentTask: manualTaskId ? manualCompleteParent : false,
    });
    setManualDesc("");
    setManualProjectId(null);
    setManualTaskId(null);
    setManualTagIds([]);
    setManualCompleteParent(false);
    setManualError(null);
    setShowManualForm(false);
  }

  function startEditing(entry: TimeEntry) {
    setEditingId(entry.id);
    setEditError(null);
    setEditDraft({
      description: entry.description,
      startHm: formatTimeHm(entry.startedAt),
      endHm: entry.endedAt !== null ? formatTimeHm(entry.endedAt) : "",
      projectId: entry.ticktickProjectId,
      taskId: entry.ticktickParentTaskId,
      tagIds: [...entry.tagIds],
      completeParentTask: entry.completeParentTask,
    });
  }

  async function saveEditing(entry: TimeEntry) {
    if (!editDraft) return;
    const nextStart = applyTimeInputToDate(entry.startedAt, editDraft.startHm);
    if (nextStart === null) {
      setEditError("시작 시각 형식이 올바르지 않습니다.");
      return;
    }

    let nextEnd: number | undefined;
    if (entry.endedAt !== null) {
      const parsedEnd = applyTimeInputToDate(entry.endedAt, editDraft.endHm);
      if (parsedEnd === null) {
        setEditError("종료 시각 형식이 올바르지 않습니다.");
        return;
      }
      if (parsedEnd < nextStart) {
        setEditError("종료 시각이 시작 시각보다 빠릅니다.");
        return;
      }
      nextEnd = parsedEnd;
    }

    await onUpdateEntry(entry.id, {
      description: editDraft.description.trim() || "(Untitled)",
      startedAt: nextStart,
      endedAt: nextEnd,
      ticktickProjectId: editDraft.projectId,
      ticktickParentTaskId: editDraft.taskId,
      tagIds: editDraft.tagIds,
      completeParentTask: editDraft.taskId ? editDraft.completeParentTask : false,
    });
    setEditingId(null);
    setEditDraft(null);
    setEditError(null);
  }

  const openTasks = useMemo(() => tasks.filter((t) => t.status === 0), [tasks]);
  const pendingSyncCount = useMemo(
    () => entries.filter((e) => e.endedAt !== null && e.syncStatus === "pending").length,
    [entries],
  );
  const failedSyncCount = useMemo(
    () => entries.filter((e) => e.endedAt !== null && e.syncStatus === "failed").length,
    [entries],
  );

  return (
    <section className="mx-auto max-w-5xl space-y-5">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">Time Entries</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-zinc-400">
            <span>
              오늘 합계{" "}
              <strong className="font-mono font-semibold text-indigo-300">
                {formatDurationHms(todayTotalMs)}
              </strong>
            </span>
            <span className="text-zinc-700">·</span>
            <span>총 {filteredEntries.length}건 표시</span>
            {pendingSyncCount > 0 && ticktickConnected && onProcessSyncQueue && (
              <button
                type="button"
                onClick={() => void onProcessSyncQueue()}
                className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/20"
              >
                <CloudUpload className="h-3 w-3" />
                대기 {pendingSyncCount}건 전송
              </button>
            )}
            {failedSyncCount > 0 && onRetryFailedSyncs && (
              <button
                type="button"
                onClick={() => void onRetryFailedSyncs()}
                className="inline-flex items-center gap-1 rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-300 hover:bg-rose-500/20"
              >
                <RotateCw className="h-3 w-3" />
                실패 {failedSyncCount}건 일괄 재시도
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="작업·프로젝트·태그 검색..."
              className="h-9 w-52 rounded-lg border border-zinc-800 bg-zinc-900/90 pl-8 pr-3 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <select
            value={syncFilter}
            onChange={(e) => setSyncFilter(e.target.value as SyncStatus | "all")}
            aria-label="동기화 상태 필터"
            className="h-9 rounded-lg border border-zinc-800 bg-zinc-900/90 px-2.5 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
          >
            <option value="all">동기화: 전체</option>
            <option value="local">local</option>
            <option value="pending">pending</option>
            <option value="synced">synced</option>
            <option value="failed">failed</option>
          </select>

          <button
            type="button"
            onClick={openManualForm}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 text-xs font-medium text-zinc-200 transition hover:border-indigo-500/60 hover:bg-zinc-800"
          >
            <Plus className="h-3.5 w-3.5" />
            수동 기록 추가
          </button>
        </div>
      </div>

      {/* Collapsible Manual Past Entry Form */}
      {showManualForm && (
        <form
          onSubmit={(e) => void handleCreateManualSubmit(e)}
          className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={manualDesc}
              onChange={(e) => setManualDesc(e.target.value)}
              placeholder="완료한 작업 설명"
              className="h-9 min-w-[220px] flex-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none"
            />
            <input
              type="date"
              value={manualDate}
              onChange={(e) => setManualDate(e.target.value)}
              className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
            />
            <div className="flex items-center gap-1.5">
              <input
                type="time"
                value={manualStartHm}
                onChange={(e) => setManualStartHm(e.target.value)}
                className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-2 font-mono text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
              />
              <span className="text-zinc-500">–</span>
              <input
                type="time"
                value={manualEndHm}
                onChange={(e) => setManualEndHm(e.target.value)}
                className="h-9 rounded-lg border border-zinc-800 bg-zinc-950 px-2 font-mono text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <ProjectPicker
                projects={projects}
                selectedProjectId={manualProjectId}
                onChange={setManualProjectId}
                compact
                align="left"
              />
              <select
                value={manualTaskId ?? ""}
                onChange={(e) => {
                  const id = e.target.value || null;
                  setManualTaskId(id);
                  if (id) {
                    const task = taskMap.get(id);
                    if (task) {
                      setManualProjectId(task.projectId);
                      if (!manualDesc.trim()) setManualDesc(task.title);
                    }
                  }
                }}
                className="h-8 max-w-[230px] rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
              >
                <option value="">TickTick 태스크 연결 안 함</option>
                {openTasks
                  .filter((t) => !manualProjectId || t.projectId === manualProjectId)
                  .map((task) => (
                    <option key={task.id} value={task.id}>
                      {task.title}
                    </option>
                  ))}
              </select>
              <TagPicker
                tags={tags}
                selectedTagIds={manualTagIds}
                onChange={setManualTagIds}
                onCreateTag={onCreateTag}
                onDeleteTag={onDeleteTag}
                compact
                align="left"
              />
              {manualTaskId && (
                <label className="flex items-center gap-1.5 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={manualCompleteParent}
                    onChange={(e) => setManualCompleteParent(e.target.checked)}
                    className="rounded border-zinc-600 bg-zinc-900"
                  />
                  원 작업도 완료 표시
                </label>
              )}
            </div>

            <div className="flex items-center gap-2">
              {manualError && <span className="text-xs text-rose-400">{manualError}</span>}
              <button
                type="button"
                onClick={() => setShowManualForm(false)}
                className="h-8 rounded-lg px-3 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
              >
                취소
              </button>
              <button
                type="submit"
                className="h-8 rounded-lg bg-indigo-500 px-3.5 text-xs font-medium text-white hover:bg-indigo-400"
              >
                기록 저장
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Date-Grouped Entry Lists */}
      {groupedByDay.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 p-12 text-center">
          <p className="text-sm font-medium text-zinc-300">
            {entries.length === 0
              ? "아직 기록된 시간이 없습니다."
              : "필터 조건에 일치하는 시간 기록이 없습니다."}
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            상단 타이머 바에서 작업을 시작하거나 Timeline 탭에서 자동 수집 블록을 변환해보세요.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {groupedByDay.map((group) => (
            <div
              key={group.dateKey}
              className="overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/50"
            >
              {/* Date Group Header */}
              <div className="flex items-center justify-between border-b border-zinc-800/80 bg-zinc-900/90 px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-zinc-200">
                    {formatDayGroupLabel(group.dateKey)}
                  </span>
                  <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
                    {group.items.length}
                  </span>
                </div>
                <span className="font-mono text-xs font-semibold tabular-nums text-zinc-200">
                  {formatDurationHms(group.totalMs)}
                </span>
              </div>

              {/* Entries */}
              <ul className="divide-y divide-zinc-800/60">
                {group.items.map((entry) => {
                  const isRunning = entry.endedAt === null;
                  const isEditing = editingId === entry.id && editDraft !== null;
                  const project = entry.ticktickProjectId
                    ? (projectMap.get(entry.ticktickProjectId) ?? null)
                    : null;
                  const linkedTask = entry.ticktickParentTaskId
                    ? (taskMap.get(entry.ticktickParentTaskId) ?? null)
                    : null;
                  const durationMs = Math.max(0, (entry.endedAt ?? nowMs) - entry.startedAt);

                  if (isEditing && editDraft) {
                    return (
                      <li key={entry.id} className="space-y-3 bg-zinc-900/95 px-4 py-3.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="text"
                            value={editDraft.description}
                            onChange={(e) =>
                              setEditDraft({ ...editDraft, description: e.target.value })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void saveEditing(entry);
                              } else if (e.key === "Escape") {
                                setEditingId(null);
                                setEditDraft(null);
                              }
                            }}
                            autoFocus
                            className="h-8 min-w-[220px] flex-1 rounded-lg border border-indigo-500/70 bg-zinc-950 px-2.5 text-sm text-zinc-100 focus:outline-none"
                          />

                          <div className="flex items-center gap-1.5">
                            <input
                              type="time"
                              value={editDraft.startHm}
                              onChange={(e) =>
                                setEditDraft({ ...editDraft, startHm: e.target.value })
                              }
                              className="h-8 rounded-lg border border-zinc-700 bg-zinc-950 px-2 font-mono text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
                            />
                            <span className="text-zinc-500">–</span>
                            {isRunning ? (
                              <span className="rounded-md bg-rose-500/15 px-2 py-1 text-xs font-medium text-rose-300">
                                실행 중
                              </span>
                            ) : (
                              <input
                                type="time"
                                value={editDraft.endHm}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, endHm: e.target.value })
                                }
                                className="h-8 rounded-lg border border-zinc-700 bg-zinc-950 px-2 font-mono text-xs text-zinc-200 focus:border-indigo-500 focus:outline-none"
                              />
                            )}
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <ProjectPicker
                              projects={projects}
                              selectedProjectId={editDraft.projectId}
                              onChange={(projectId) =>
                                setEditDraft((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        projectId,
                                        taskId:
                                          prev.taskId &&
                                          projectId &&
                                          taskMap.get(prev.taskId)?.projectId !== projectId
                                            ? null
                                            : prev.taskId,
                                      }
                                    : prev,
                                )
                              }
                              compact
                              align="left"
                            />

                            <select
                              value={editDraft.taskId ?? ""}
                              onChange={(e) => {
                                const taskId = e.target.value || null;
                                const task = taskId ? taskMap.get(taskId) : null;
                                setEditDraft((prev) =>
                                  prev
                                    ? {
                                        ...prev,
                                        taskId,
                                        projectId: task ? task.projectId : prev.projectId,
                                      }
                                    : prev,
                                );
                              }}
                              className="h-8 max-w-[230px] rounded-lg border border-zinc-800 bg-zinc-950 px-2 text-xs text-zinc-300 focus:border-indigo-500 focus:outline-none"
                            >
                              <option value="">TickTick 태스크 없음</option>
                              {openTasks
                                .filter(
                                  (t) =>
                                    !editDraft.projectId || t.projectId === editDraft.projectId,
                                )
                                .map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.title}
                                  </option>
                                ))}
                            </select>

                            <TagPicker
                              tags={tags}
                              selectedTagIds={editDraft.tagIds}
                              onChange={(tagIds) =>
                                setEditDraft((prev) => (prev ? { ...prev, tagIds } : prev))
                              }
                              onCreateTag={onCreateTag}
                              onDeleteTag={onDeleteTag}
                              compact
                              align="left"
                            />

                            {editDraft.taskId && (
                              <label className="flex items-center gap-1.5 text-xs text-zinc-300">
                                <input
                                  type="checkbox"
                                  checked={editDraft.completeParentTask}
                                  onChange={(e) =>
                                    setEditDraft({
                                      ...editDraft,
                                      completeParentTask: e.target.checked,
                                    })
                                  }
                                  className="rounded border-zinc-600 bg-zinc-900"
                                />
                                원 작업 완료 표시
                              </label>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5">
                            {editError && (
                              <span className="mr-1 text-xs text-rose-400">{editError}</span>
                            )}
                            <button
                              type="button"
                              onClick={() => void saveEditing(entry)}
                              className="inline-flex h-8 items-center gap-1 rounded-lg bg-indigo-500 px-3 text-xs font-medium text-white hover:bg-indigo-400"
                            >
                              <Check className="h-3.5 w-3.5" />
                              저장
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(null);
                                setEditDraft(null);
                              }}
                              className="inline-flex h-8 items-center gap-1 rounded-lg bg-zinc-800 px-2.5 text-xs text-zinc-300 hover:bg-zinc-700"
                            >
                              <X className="h-3.5 w-3.5" />
                              취소
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  }

                  return (
                    <li
                      key={entry.id}
                      className={`group flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition hover:bg-zinc-800/35 ${
                        isRunning ? "bg-rose-500/[0.04]" : ""
                      }`}
                    >
                      {/* Left: Description, Project, Task, Tags */}
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {isRunning && (
                            <span
                              className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-rose-500"
                              title="실행 중"
                            />
                          )}
                          <button
                            type="button"
                            onClick={() => startEditing(entry)}
                            className="max-w-full truncate text-left text-sm font-medium text-zinc-100 hover:text-indigo-300"
                            title="클릭하여 편집"
                          >
                            {entry.description || "(Untitled)"}
                          </button>

                          {project && (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-950/70 px-2 py-0.5 text-[11px] font-medium text-zinc-300">
                              <span
                                className="h-2 w-2 rounded-full"
                                style={{ backgroundColor: project.color ?? "#6366f1" }}
                              />
                              {project.name}
                            </span>
                          )}
                        </div>

                        {(linkedTask || entry.tagIds.length > 0) && (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {linkedTask && (
                              <span className="inline-flex items-center gap-1 text-[11px] text-zinc-400">
                                <CheckSquare className="h-3 w-3 text-indigo-400" />
                                <span className="max-w-[260px] truncate">{linkedTask.title}</span>
                              </span>
                            )}
                            {entry.tagIds.map((tid) => {
                              const tag = tagMap.get(tid);
                              if (!tag) return null;
                              return (
                                <span
                                  key={tag.id}
                                  className="inline-flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900/90 px-1.5 py-0.5 text-[10px] text-zinc-300"
                                >
                                  <span
                                    className="h-1.5 w-1.5 rounded-full"
                                    style={{ backgroundColor: tag.color ?? "#6366f1" }}
                                  />
                                  #{tag.name}
                                </span>
                              );
                            })}
                          </div>
                        )}

                        {entry.syncStatus === "failed" && entry.syncError && (
                          <div className="flex items-center gap-1.5 text-[11px] text-rose-400/90">
                            <AlertCircle className="h-3 w-3 shrink-0" />
                            <span className="truncate">
                              {entry.syncError}
                              {entry.retryCount > 0 ? ` (재시도 ${entry.retryCount}회)` : ""}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Right: Sync Badge, Time Range, Duration, Actions */}
                      <div className="flex shrink-0 items-center gap-3">
                        <SyncStatusBadge entry={entry} />

                        <span className="hidden font-mono text-xs tabular-nums text-zinc-500 md:inline">
                          {formatTimeHm(entry.startedAt)} –{" "}
                          {entry.endedAt !== null ? formatTimeHm(entry.endedAt) : "실행 중"}
                        </span>

                        <span
                          className={`w-20 text-right font-mono text-sm font-medium tabular-nums ${
                            isRunning ? "text-rose-300" : "text-zinc-200"
                          }`}
                        >
                          {formatDurationHms(durationMs)}
                        </span>

                        <div className="flex items-center gap-0.5">
                          <button
                            type="button"
                            onClick={() => void onStartSimilar(entry)}
                            title="이 작업으로 이어서 시작"
                            className="rounded-md p-1.5 text-zinc-400 transition hover:bg-indigo-500/15 hover:text-indigo-300"
                          >
                            <Play className="h-3.5 w-3.5 fill-current" />
                          </button>

                          {!isRunning && entry.syncStatus !== "synced" && (
                            <button
                              type="button"
                              onClick={() => void onRequestTickTickSync(entry)}
                              title={
                                entry.syncStatus === "failed"
                                  ? "TickTick 동기화 재시도"
                                  : entry.syncStatus === "pending"
                                    ? "동기화 대기 중 (지금 다시 큐 깨우기)"
                                    : "TickTick에 밀어넣기"
                              }
                              className={`rounded-md p-1.5 transition ${
                                entry.syncStatus === "failed"
                                  ? "text-rose-400 hover:bg-rose-500/15"
                                  : entry.syncStatus === "pending"
                                    ? "text-amber-300 hover:bg-amber-500/15"
                                    : "text-zinc-400 hover:bg-emerald-500/15 hover:text-emerald-300"
                              }`}
                            >
                              {entry.syncStatus === "failed" ? (
                                <RotateCw className="h-3.5 w-3.5" />
                              ) : (
                                <CloudUpload className="h-3.5 w-3.5" />
                              )}
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => startEditing(entry)}
                            title="편집"
                            className="rounded-md p-1.5 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>

                          <button
                            type="button"
                            onClick={() => void onDeleteEntry(entry.id)}
                            title="삭제"
                            className="rounded-md p-1.5 text-zinc-400 transition hover:bg-rose-500/15 hover:text-rose-400"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
