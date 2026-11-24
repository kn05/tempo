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

const SYNC_FILTER_OPTIONS: { id: SyncStatus | "all"; label: string; dotClass?: string }[] = [
  { id: "all", label: "전체" },
  { id: "local", label: "로컬", dotClass: "bg-zinc-500" },
  { id: "pending", label: "대기", dotClass: "bg-amber-400" },
  { id: "synced", label: "완료", dotClass: "bg-emerald-400" },
  { id: "failed", label: "실패", dotClass: "bg-rose-400" },
];

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
      setManualError("날짜 오류");
      return;
    }
    const baseTs = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    const startedAt = applyTimeInputToDate(baseTs, manualStartHm);
    const endedAt = applyTimeInputToDate(baseTs, manualEndHm);
    if (startedAt === null || endedAt === null) {
      setManualError("시각 형식 오류");
      return;
    }
    if (endedAt < startedAt) {
      setManualError("종료 < 시작");
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
      setEditError("시작 시각 오류");
      return;
    }

    let nextEnd: number | undefined;
    if (entry.endedAt !== null) {
      const parsedEnd = applyTimeInputToDate(entry.endedAt, editDraft.endHm);
      if (parsedEnd === null) {
        setEditError("종료 시각 오류");
        return;
      }
      if (parsedEnd < nextStart) {
        setEditError("종료 < 시작");
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
    <section className="mx-auto max-w-5xl space-y-6">
      {/* Hero Summary & Controls */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap items-baseline gap-4">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
              오늘
            </div>
            <div className="mt-0.5 font-mono text-2xl font-semibold tracking-tight tabular-nums text-zinc-100">
              {formatDurationHms(todayTotalMs)}
            </div>
          </div>

          <div className="flex items-center gap-1.5 pb-0.5">
            {pendingSyncCount > 0 && ticktickConnected && onProcessSyncQueue && (
              <button
                type="button"
                onClick={() => void onProcessSyncQueue()}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-amber-500/12 px-2.5 text-[11px] font-medium text-amber-300 ring-1 ring-inset ring-amber-500/25 transition-colors hover:bg-amber-500/20"
              >
                <CloudUpload className="h-3 w-3" />
                <span>전송 {pendingSyncCount}</span>
              </button>
            )}
            {failedSyncCount > 0 && onRetryFailedSyncs && (
              <button
                type="button"
                onClick={() => void onRetryFailedSyncs()}
                className="inline-flex h-7 items-center gap-1.5 rounded-full bg-rose-500/12 px-2.5 text-[11px] font-medium text-rose-300 ring-1 ring-inset ring-rose-500/25 transition-colors hover:bg-rose-500/20"
              >
                <RotateCw className="h-3 w-3" />
                <span>재시도 {failedSyncCount}</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Compact Segmented Sync Filter */}
          <div className="inline-flex h-8 items-center rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5 text-[11px]">
            {SYNC_FILTER_OPTIONS.map((opt) => {
              const active = syncFilter === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setSyncFilter(opt.id)}
                  className={`inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 font-medium transition-colors ${
                    active
                      ? "bg-white/[0.1] text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  {opt.dotClass && <span className={`h-1.5 w-1.5 rounded-full ${opt.dotClass}`} />}
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="검색..."
              className="h-8 w-44 rounded-lg border border-white/[0.07] bg-white/[0.03] pl-8 pr-7 text-xs text-zinc-100 placeholder:text-zinc-500 transition-all focus:w-56 focus:border-indigo-500/60 focus:bg-white/[0.05] focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={openManualForm}
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-colors ${
              showManualForm
                ? "bg-indigo-500/20 text-indigo-200 ring-1 ring-inset ring-indigo-500/40"
                : "border border-white/[0.08] bg-white/[0.04] text-zinc-200 hover:bg-white/[0.08]"
            }`}
          >
            <Plus className="h-3.5 w-3.5" />
            <span>기록 추가</span>
          </button>
        </div>
      </div>

      {/* Collapsible Manual Past Entry Form */}
      {showManualForm && (
        <form
          onSubmit={(e) => void handleCreateManualSubmit(e)}
          className="space-y-3 rounded-xl border border-indigo-500/30 bg-[#121218] p-4 shadow-xl"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={manualDesc}
              onChange={(e) => setManualDesc(e.target.value)}
              placeholder="작업 제목"
              autoFocus
              className="h-9 min-w-[220px] flex-1 rounded-lg border border-white/[0.08] bg-zinc-950/80 px-3 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500/70 focus:outline-none"
            />
            <input
              type="date"
              value={manualDate}
              onChange={(e) => setManualDate(e.target.value)}
              className="h-9 rounded-lg border border-white/[0.08] bg-zinc-950/80 px-2.5 text-xs text-zinc-200 focus:border-indigo-500/70 focus:outline-none"
            />
            <div className="flex items-center gap-1.5">
              <input
                type="time"
                value={manualStartHm}
                onChange={(e) => setManualStartHm(e.target.value)}
                className="h-9 rounded-lg border border-white/[0.08] bg-zinc-950/80 px-2 font-mono text-xs text-zinc-200 focus:border-indigo-500/70 focus:outline-none"
              />
              <span className="text-zinc-600">–</span>
              <input
                type="time"
                value={manualEndHm}
                onChange={(e) => setManualEndHm(e.target.value)}
                className="h-9 rounded-lg border border-white/[0.08] bg-zinc-950/80 px-2 font-mono text-xs text-zinc-200 focus:border-indigo-500/70 focus:outline-none"
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
                className="h-8 max-w-[230px] rounded-lg border border-white/[0.08] bg-zinc-950/80 px-2 text-xs text-zinc-300 focus:border-indigo-500/70 focus:outline-none"
              >
                <option value="">태스크 없음</option>
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
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-300">
                  <input
                    type="checkbox"
                    checked={manualCompleteParent}
                    onChange={(e) => setManualCompleteParent(e.target.checked)}
                    className="rounded border-zinc-600 bg-zinc-900 accent-indigo-500"
                  />
                  <span>원 태스크 완료</span>
                </label>
              )}
            </div>

            <div className="flex items-center gap-2">
              {manualError && <span className="text-xs text-rose-400">{manualError}</span>}
              <button
                type="button"
                onClick={() => setShowManualForm(false)}
                className="h-8 rounded-lg px-3 text-xs text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
              >
                취소
              </button>
              <button
                type="submit"
                className="h-8 rounded-lg bg-indigo-500 px-3.5 text-xs font-medium text-white transition-colors hover:bg-indigo-400"
              >
                저장
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Date-Grouped Entry Lists */}
      {groupedByDay.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/[0.08] bg-white/[0.01] py-16 text-center">
          <Clock className="h-6 w-6 text-zinc-600" />
          <p className="mt-3 text-sm font-medium text-zinc-400">
            {entries.length === 0 ? "기록 없음" : "일치하는 기록 없음"}
          </p>
          {entries.length === 0 ? (
            <button
              type="button"
              onClick={openManualForm}
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/[0.1]"
            >
              <Plus className="h-3.5 w-3.5" />
              기록 추가
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setSearchQuery("");
                setSyncFilter("all");
              }}
              className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/[0.1]"
            >
              필터 초기화
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-7">
          {groupedByDay.map((group) => (
            <div key={group.dateKey} className="space-y-2">
              {/* Airy Date Group Header */}
              <div className="flex items-baseline justify-between px-4">
                <h2 className="text-xs font-semibold tracking-tight text-zinc-400">
                  {formatDayGroupLabel(group.dateKey)}
                </h2>
                <span className="font-mono text-xs font-semibold tabular-nums text-zinc-400">
                  {formatDurationHms(group.totalMs)}
                </span>
              </div>

              {/* Entry Surface */}
              <ul className="divide-y divide-white/[0.05] overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02]">
                {group.items.map((entry) => {
                  const isRunning = entry.endedAt === null;
                  const isEditing = editingId === entry.id && editDraft !== null;
                  const project = entry.ticktickProjectId
                    ? (projectMap.get(entry.ticktickProjectId) ?? null)
                    : null;
                  const linkedTask = entry.ticktickParentTaskId
                    ? (taskMap.get(entry.ticktickParentTaskId) ?? null)
                    : null;
                  const showDistinctTaskTitle =
                    Boolean(linkedTask) &&
                    linkedTask!.title.trim().toLowerCase() !==
                      entry.description.trim().toLowerCase();
                  const durationMs = Math.max(0, (entry.endedAt ?? nowMs) - entry.startedAt);

                  if (isEditing && editDraft) {
                    return (
                      <li key={entry.id} className="space-y-3 bg-[#14141b] px-4 py-3.5">
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
                            className="h-8 min-w-[220px] flex-1 rounded-lg border border-indigo-500/60 bg-zinc-950/90 px-2.5 text-sm text-zinc-100 focus:outline-none"
                          />

                          <div className="flex items-center gap-1.5">
                            <input
                              type="time"
                              value={editDraft.startHm}
                              onChange={(e) =>
                                setEditDraft({ ...editDraft, startHm: e.target.value })
                              }
                              className="h-8 rounded-lg border border-white/[0.1] bg-zinc-950/90 px-2 font-mono text-xs text-zinc-200 focus:border-indigo-500/70 focus:outline-none"
                            />
                            <span className="text-zinc-600">–</span>
                            {isRunning ? (
                              <span className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-rose-500/15 px-2.5 text-xs font-medium text-rose-300">
                                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" />
                                진행 중
                              </span>
                            ) : (
                              <input
                                type="time"
                                value={editDraft.endHm}
                                onChange={(e) =>
                                  setEditDraft({ ...editDraft, endHm: e.target.value })
                                }
                                className="h-8 rounded-lg border border-white/[0.1] bg-zinc-950/90 px-2 font-mono text-xs text-zinc-200 focus:border-indigo-500/70 focus:outline-none"
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
                              className="h-8 max-w-[230px] rounded-lg border border-white/[0.08] bg-zinc-950/90 px-2 text-xs text-zinc-300 focus:border-indigo-500/70 focus:outline-none"
                            >
                              <option value="">태스크 없음</option>
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
                              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-300">
                                <input
                                  type="checkbox"
                                  checked={editDraft.completeParentTask}
                                  onChange={(e) =>
                                    setEditDraft({
                                      ...editDraft,
                                      completeParentTask: e.target.checked,
                                    })
                                  }
                                  className="rounded border-zinc-600 bg-zinc-900 accent-indigo-500"
                                />
                                <span>원 태스크 완료</span>
                              </label>
                            )}
                          </div>

                          <div className="flex items-center gap-1.5">
                            {editError && (
                              <span className="mr-1 text-xs text-rose-400">{editError}</span>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setEditingId(null);
                                setEditDraft(null);
                              }}
                              className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-xs text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                            >
                              취소
                            </button>
                            <button
                              type="button"
                              onClick={() => void saveEditing(entry)}
                              className="inline-flex h-8 items-center gap-1 rounded-lg bg-indigo-500 px-3 text-xs font-medium text-white transition-colors hover:bg-indigo-400"
                            >
                              <Check className="h-3.5 w-3.5" />
                              저장
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  }

                  return (
                    <li
                      key={entry.id}
                      className={`group relative flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-white/[0.03] ${
                        isRunning ? "bg-rose-500/[0.04]" : ""
                      }`}
                    >
                      {/* Subtle left project / running color bar */}
                      <span
                        className={`absolute bottom-2 left-0 top-2 w-[2.5px] rounded-r-full ${
                          isRunning ? "bg-rose-500" : ""
                        }`}
                        style={
                          !isRunning && project
                            ? { backgroundColor: project.color ?? "#6366f1", opacity: 0.75 }
                            : undefined
                        }
                      />

                      {/* Left: Primary Description + Quiet Secondary Context */}
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                          {isRunning && (
                            <span
                              className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-rose-500"
                              aria-hidden="true"
                            />
                          )}

                          <button
                            type="button"
                            onClick={() => startEditing(entry)}
                            className="max-w-full truncate text-left text-[13.5px] font-medium text-zinc-100 transition-colors hover:text-indigo-300"
                          >
                            {entry.description || "(Untitled)"}
                          </button>

                          {linkedTask && !showDistinctTaskTitle && (
                            <span
                              title={
                                entry.completeParentTask
                                  ? `${linkedTask.title} · 완료 동기화`
                                  : linkedTask.title
                              }
                              className="inline-flex shrink-0 items-center text-indigo-400/80"
                            >
                              <CheckSquare className="h-3.5 w-3.5" />
                            </span>
                          )}

                          {project && (
                            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-zinc-400">
                              <span
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: project.color ?? "#6366f1" }}
                              />
                              <span>{project.name}</span>
                            </span>
                          )}

                          {entry.tagIds.length > 0 && (
                            <div className="flex flex-wrap items-center gap-1">
                              {entry.tagIds.map((tid) => {
                                const tag = tagMap.get(tid);
                                if (!tag) return null;
                                return (
                                  <span
                                    key={tag.id}
                                    className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[10.5px] text-zinc-400"
                                  >
                                    #{tag.name}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {showDistinctTaskTitle && linkedTask && (
                          <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                            <CheckSquare className="h-3 w-3 shrink-0 text-indigo-400/75" />
                            <span className="truncate">{linkedTask.title}</span>
                          </div>
                        )}

                        {entry.syncStatus === "failed" && entry.syncError && (
                          <div className="flex items-center gap-2 text-[11px] text-rose-400/90">
                            <AlertCircle className="h-3 w-3 shrink-0" />
                            <span className="truncate">{entry.syncError}</span>
                            <button
                              type="button"
                              onClick={() => void onRequestTickTickSync(entry)}
                              className="shrink-0 font-medium text-rose-300 underline decoration-rose-400/50 underline-offset-2 hover:text-rose-200"
                            >
                              재시도
                            </button>
                          </div>
                        )}
                      </div>

                      {/* Right: Sync Status, Time Range <-> Hover Actions, Anchored Duration */}
                      <div className="flex shrink-0 items-center gap-3">
                        <div className="relative flex h-7 min-w-[116px] items-center justify-end">
                          {/* At rest: sync indicator + time range */}
                          <div className="flex items-center gap-2.5 transition-opacity group-focus-within:opacity-0 group-hover:opacity-0">
                            {entry.syncStatus === "synced" && (
                              <span title="TickTick 동기화 완료">
                                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400/80" />
                              </span>
                            )}
                            {entry.syncStatus === "pending" && (
                              <span title="동기화 대기 중">
                                <Clock className="h-3.5 w-3.5 text-amber-400/90" />
                              </span>
                            )}
                            {entry.syncStatus === "failed" && (
                              <span title={entry.syncError ?? "동기화 실패"}>
                                <AlertCircle className="h-3.5 w-3.5 text-rose-400" />
                              </span>
                            )}
                            <span className="hidden font-mono text-xs tabular-nums text-zinc-500 sm:inline">
                              {formatTimeHm(entry.startedAt)}–
                              {entry.endedAt !== null ? formatTimeHm(entry.endedAt) : "지금"}
                            </span>
                          </div>

                          {/* On hover / focus: clean inline action bar */}
                          <div className="pointer-events-none absolute inset-0 flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
                            <button
                              type="button"
                              onClick={() => void onStartSimilar(entry)}
                              title="이어서 시작"
                              className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-indigo-500/15 hover:text-indigo-300"
                            >
                              <Play className="h-3.5 w-3.5 fill-current" />
                            </button>

                            {!isRunning && entry.syncStatus !== "synced" && (
                              <button
                                type="button"
                                onClick={() => void onRequestTickTickSync(entry)}
                                title={
                                  entry.syncStatus === "failed"
                                    ? "동기화 재시도"
                                    : "TickTick 동기화"
                                }
                                className={`rounded-md p-1.5 transition-colors ${
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
                              className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-white/[0.08] hover:text-zinc-200"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>

                            <button
                              type="button"
                              onClick={() => void onDeleteEntry(entry.id)}
                              title="삭제"
                              className="rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-rose-500/15 hover:text-rose-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>

                        <span
                          className={`w-[72px] text-right font-mono text-[13.5px] font-semibold tabular-nums ${
                            isRunning ? "text-rose-300" : "text-zinc-100"
                          }`}
                        >
                          {formatDurationHms(durationMs)}
                        </span>
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
