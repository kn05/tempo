import {
  Activity,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Clock,
  CloudUpload,
  Monitor,
  MousePointerClick,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  addDays,
  applyTimeInputToDate,
  cleanProcessLabel,
  formatDurationHms,
  formatDurationShort,
  formatFullDateKorean,
  formatTimeHm,
  formatTimeHms,
  getDayRangeMs,
  getProcessColor,
  isSameLocalDay,
  suggestDescriptionFromLogs,
} from "../lib/time";
import type {
  ActivityLog,
  CreateTimeEntryInput,
  PlatformStatus,
  Tag,
  TickTickProject,
  TickTickTask,
  TimeEntry,
  UpdateTimeEntryInput,
} from "../types";
import { ProjectPicker } from "./ProjectPicker";
import { TagPicker } from "./TagPicker";

interface TimelineViewProps {
  selectedDate: Date;
  onChangeDate: (next: Date) => void;
  activityLogs: ActivityLog[];
  timeEntries: TimeEntry[];
  projects: TickTickProject[];
  tasks: TickTickTask[];
  tags: Tag[];
  status: PlatformStatus | null;
  minDurationMs: number;
  onRefresh: () => Promise<void>;
  onCreateEntry: (input: CreateTimeEntryInput) => Promise<TimeEntry>;
  onUpdateEntry: (id: string, input: UpdateTimeEntryInput) => Promise<void>;
  onDeleteEntry: (id: string) => Promise<void>;
  onCreateTag: (name: string, color?: string | null) => Promise<Tag>;
  onDeleteTag: (id: string) => Promise<void>;
  onRequestTickTickSync: (entry: TimeEntry) => Promise<void> | void;
}

interface ClampedActivity {
  log: ActivityLog;
  startMs: number;
  endMs: number;
}

interface ClampedEntry {
  entry: TimeEntry;
  startMs: number;
  endMs: number;
}

interface DragBand {
  anchorY: number;
  currentY: number;
  moved: boolean;
}

const ZOOM_OPTIONS: { label: string; pxPerHour: number }[] = [
  { label: "1x", pxPerHour: 60 },
  { label: "2x", pxPerHour: 120 },
  { label: "4x", pxPerHour: 240 },
];

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function TimelineView({
  selectedDate,
  onChangeDate,
  activityLogs,
  timeEntries,
  projects,
  tasks,
  tags,
  status,
  minDurationMs,
  onRefresh,
  onCreateEntry,
  onUpdateEntry,
  onDeleteEntry,
  onCreateTag,
  onDeleteTag,
  onRequestTickTickSync,
}: TimelineViewProps) {
  const [pxPerHour, setPxPerHour] = useState(120);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Selection state on Auto-Tracked column
  const [selectedLogIds, setSelectedLogIds] = useState<number[]>([]);
  const [anchorLogId, setAnchorLogId] = useState<number | null>(null);
  const [customRange, setCustomRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const [dragBand, setDragBand] = useState<DragBand | null>(null);
  const [hoveredLog, setHoveredLog] = useState<ActivityLog | null>(null);

  // Selected existing Time Entry on Column 2 for quick inspection/edit
  const [inspectedEntryId, setInspectedEntryId] = useState<string | null>(null);

  // Retroactive conversion draft state
  const [draftDesc, setDraftDesc] = useState("");
  const [draftStartHm, setDraftStartHm] = useState("");
  const [draftEndHm, setDraftEndHm] = useState("");
  const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
  const [draftTaskId, setDraftTaskId] = useState<string | null>(null);
  const [draftTagIds, setDraftTagIds] = useState<string[]>([]);
  const [draftCompleteParent, setDraftCompleteParent] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Quick edit draft for inspected Time Entry
  const [entryEditDesc, setEntryEditDesc] = useState("");
  const [entryEditStartHm, setEntryEditStartHm] = useState("");
  const [entryEditEndHm, setEntryEditEndHm] = useState("");
  const [entryEditProjectId, setEntryEditProjectId] = useState<string | null>(null);
  const [entryEditTagIds, setEntryEditTagIds] = useState<string[]>([]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const autoTrackRef = useRef<HTMLDivElement>(null);
  const suppressNextClickRef = useRef(false);

  const isToday = isSameLocalDay(selectedDate, new Date());
  const { startMs: dayStartMs, endMs: dayEndMs } = useMemo(
    () => getDayRangeMs(selectedDate),
    [selectedDate],
  );
  const totalHeightPx = 24 * pxPerHour;

  useEffect(() => {
    if (!isToday) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, [isToday]);

  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const taskMap = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const tagMap = useMemo(() => new Map(tags.map((t) => [t.id, t])), [tags]);
  const openTasks = useMemo(() => tasks.filter((t) => t.status === 0), [tasks]);

  // Clamp spans to the selected local day [00:00:00.000, 23:59:59.999].
  const clampedActivities = useMemo<ClampedActivity[]>(() => {
    const out: ClampedActivity[] = [];
    for (const log of activityLogs) {
      const startMs = Math.max(log.startedAt, dayStartMs);
      const endMs = Math.min(log.endedAt, dayEndMs);
      if (endMs > startMs) {
        out.push({ log, startMs, endMs });
      }
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  }, [activityLogs, dayStartMs, dayEndMs]);

  const clampedEntries = useMemo<ClampedEntry[]>(() => {
    const out: ClampedEntry[] = [];
    for (const entry of timeEntries) {
      const rawEnd = entry.endedAt ?? nowMs;
      const startMs = Math.max(entry.startedAt, dayStartMs);
      const endMs = Math.min(rawEnd, dayEndMs);
      if (endMs > startMs) {
        out.push({ entry, startMs, endMs });
      }
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  }, [timeEntries, dayStartMs, dayEndMs, nowMs]);

  // Daily summary metrics & top apps
  const summary = useMemo(() => {
    let activeMs = 0;
    let idleMs = 0;
    const byApp = new Map<string, number>();

    for (const item of clampedActivities) {
      const dur = item.endMs - item.startMs;
      if (item.log.isIdle) {
        idleMs += dur;
      } else {
        activeMs += dur;
        byApp.set(item.log.processName, (byApp.get(item.log.processName) ?? 0) + dur);
      }
    }

    const trackedMs = clampedEntries.reduce((acc, item) => acc + (item.endMs - item.startMs), 0);
    const topApps = [...byApp.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([processName, durationMs]) => ({ processName, durationMs }));

    return { activeMs, idleMs, trackedMs, topApps };
  }, [clampedActivities, clampedEntries]);

  // Reset selections when switching days.
  useEffect(() => {
    setSelectedLogIds([]);
    setAnchorLogId(null);
    setCustomRange(null);
    setInspectedEntryId(null);
  }, [dayStartMs]);

  // Auto-scroll to first activity of the day (or 08:30) when date changes.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const earliest =
      clampedActivities[0]?.startMs ?? clampedEntries[0]?.startMs ?? dayStartMs + 8.5 * 3_600_000;
    const targetHours = Math.max(0, (earliest - dayStartMs) / 3_600_000 - 0.5);
    el.scrollTop = Math.max(0, targetHours * pxPerHour);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayStartMs]);

  const selectedLogs = useMemo(() => {
    const set = new Set(selectedLogIds);
    return clampedActivities.filter((item) => set.has(item.log.id));
  }, [clampedActivities, selectedLogIds]);

  const activeSelectionRange = useMemo<{ startMs: number; endMs: number } | null>(() => {
    if (selectedLogs.length > 0) {
      const startMs = Math.min(...selectedLogs.map((l) => l.startMs));
      const endMs = Math.max(...selectedLogs.map((l) => l.endMs));
      return { startMs, endMs };
    }
    return customRange;
  }, [selectedLogs, customRange]);

  // Hydrate conversion draft whenever selection changes.
  useEffect(() => {
    if (!activeSelectionRange) return;
    setDraftStartHm(formatTimeHm(activeSelectionRange.startMs));
    setDraftEndHm(formatTimeHm(activeSelectionRange.endMs));
    setDraftDesc(
      selectedLogs.length > 0
        ? suggestDescriptionFromLogs(selectedLogs.map((s) => s.log))
        : "작업 기록",
    );
    setDraftError(null);
    setInspectedEntryId(null);
  }, [activeSelectionRange, selectedLogs]);

  const inspectedEntry = useMemo(
    () => timeEntries.find((e) => e.id === inspectedEntryId) ?? null,
    [timeEntries, inspectedEntryId],
  );

  useEffect(() => {
    if (!inspectedEntry) return;
    setEntryEditDesc(inspectedEntry.description);
    setEntryEditStartHm(formatTimeHm(inspectedEntry.startedAt));
    setEntryEditEndHm(inspectedEntry.endedAt !== null ? formatTimeHm(inspectedEntry.endedAt) : "");
    setEntryEditProjectId(inspectedEntry.ticktickProjectId);
    setEntryEditTagIds([...inspectedEntry.tagIds]);
  }, [inspectedEntry]);

  function tsToY(ts: number): number {
    return ((ts - dayStartMs) / 3_600_000) * pxPerHour;
  }

  function yToTs(y: number): number {
    const clampedY = Math.max(0, Math.min(totalHeightPx, y));
    const rawMs = dayStartMs + (clampedY / pxPerHour) * 3_600_000;
    // Snap to 1-minute increments for tidy retroactive entries.
    const snapped = Math.round(rawMs / 60_000) * 60_000;
    return Math.max(dayStartMs, Math.min(dayEndMs, snapped));
  }

  function clearSelection() {
    setSelectedLogIds([]);
    setAnchorLogId(null);
    setCustomRange(null);
    setDraftProjectId(null);
    setDraftTaskId(null);
    setDraftTagIds([]);
    setDraftCompleteParent(false);
    setDraftError(null);
  }

  // Pointer drag range selection on the Auto-Tracked column
  function handleTrackPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const rect = autoTrackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const y = event.clientY - rect.top;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragBand({ anchorY: y, currentY: y, moved: false });
  }

  function handleTrackPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragBand) return;
    const rect = autoTrackRef.current?.getBoundingClientRect();
    if (!rect) return;
    const y = Math.max(0, Math.min(totalHeightPx, event.clientY - rect.top));
    const moved = dragBand.moved || Math.abs(y - dragBand.anchorY) >= 6;
    setDragBand({ ...dragBand, currentY: y, moved });
  }

  function handleTrackPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragBand) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    if (dragBand.moved) {
      suppressNextClickRef.current = true;
      const topY = Math.min(dragBand.anchorY, dragBand.currentY);
      const botY = Math.max(dragBand.anchorY, dragBand.currentY);
      const bandStart = yToTs(topY);
      const bandEnd = Math.max(bandStart + 60_000, yToTs(botY));

      const overlapping = clampedActivities.filter(
        (item) => item.endMs > bandStart && item.startMs < bandEnd,
      );
      if (overlapping.length > 0) {
        setSelectedLogIds(overlapping.map((item) => item.log.id));
        setAnchorLogId(overlapping[0].log.id);
        setCustomRange(null);
      } else {
        setSelectedLogIds([]);
        setAnchorLogId(null);
        setCustomRange({ startMs: bandStart, endMs: bandEnd });
      }
      setInspectedEntryId(null);
    }

    setDragBand(null);
  }

  function handleBlockClick(item: ClampedActivity, event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }

    setCustomRange(null);
    setInspectedEntryId(null);

    if (event.shiftKey && anchorLogId !== null) {
      const anchorIdx = clampedActivities.findIndex((a) => a.log.id === anchorLogId);
      const clickedIdx = clampedActivities.findIndex((a) => a.log.id === item.log.id);
      if (anchorIdx !== -1 && clickedIdx !== -1) {
        const [from, to] = anchorIdx <= clickedIdx ? [anchorIdx, clickedIdx] : [clickedIdx, anchorIdx];
        setSelectedLogIds(clampedActivities.slice(from, to + 1).map((a) => a.log.id));
        return;
      }
    }

    setAnchorLogId(item.log.id);
    setSelectedLogIds((prev) =>
      prev.includes(item.log.id) ? prev.filter((id) => id !== item.log.id) : [...prev, item.log.id],
    );
  }

  async function handleConvertSelection(pushToTickTick: boolean) {
    if (!activeSelectionRange || saving) return;
    const startTs = applyTimeInputToDate(dayStartMs, draftStartHm);
    const endTs = applyTimeInputToDate(dayStartMs, draftEndHm);
    if (startTs === null || endTs === null) {
      setDraftError("시작/종료 시각 형식이 올바르지 않습니다 (HH:MM).");
      return;
    }
    if (endTs <= startTs) {
      setDraftError("종료 시각은 시작 시각보다 늦어야 합니다.");
      return;
    }

    setSaving(true);
    setDraftError(null);
    try {
      const created = await onCreateEntry({
        description: draftDesc.trim() || "작업 기록",
        startedAt: startTs,
        endedAt: endTs,
        ticktickProjectId: draftProjectId,
        ticktickParentTaskId: draftTaskId,
        tagIds: draftTagIds,
        completeParentTask: draftTaskId ? draftCompleteParent : false,
      });
      if (pushToTickTick) {
        await onRequestTickTickSync(created);
      }
      clearSelection();
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveInspectedEntry() {
    if (!inspectedEntry) return;
    const nextStart = applyTimeInputToDate(inspectedEntry.startedAt, entryEditStartHm);
    if (nextStart === null) return;
    let nextEnd: number | undefined;
    if (inspectedEntry.endedAt !== null) {
      const parsed = applyTimeInputToDate(inspectedEntry.endedAt, entryEditEndHm);
      if (parsed === null || parsed < nextStart) return;
      nextEnd = parsed;
    }
    await onUpdateEntry(inspectedEntry.id, {
      description: entryEditDesc.trim() || "(Untitled)",
      startedAt: nextStart,
      endedAt: nextEnd,
      ticktickProjectId: entryEditProjectId,
      tagIds: entryEditTagIds,
    });
    setInspectedEntryId(null);
  }

  const selectedAppBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of selectedLogs) {
      const label = item.log.isIdle ? "유휴" : cleanProcessLabel(item.log.processName);
      map.set(label, (map.get(label) ?? 0) + (item.endMs - item.startMs));
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [selectedLogs]);

  const currentTimeY = isToday ? tsToY(Math.min(nowMs, dayEndMs)) : null;

  const parsedHoveredMeta = useMemo(() => {
    if (!hoveredLog?.metadataJson) return null;
    try {
      return JSON.parse(hoveredLog.metadataJson) as {
        workspace?: string;
        branch?: string;
        file?: string;
      };
    } catch {
      return null;
    }
  }, [hoveredLog]);

  return (
    <section className="mx-auto flex h-full max-w-6xl flex-col gap-4">
      {/* Top Navigation & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
            <button
              type="button"
              onClick={() => onChangeDate(addDays(selectedDate, -1))}
              className="p-2 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
              title="이전 날"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="px-3 text-xs font-semibold text-zinc-100">
              {formatFullDateKorean(selectedDate)}
            </div>
            <button
              type="button"
              onClick={() => onChangeDate(addDays(selectedDate, 1))}
              disabled={isToday}
              className="p-2 text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-35"
              title="다음 날"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {!isToday && (
            <button
              type="button"
              onClick={() => onChangeDate(new Date())}
              className="rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs font-medium text-indigo-300 hover:border-indigo-500/50 hover:bg-zinc-800"
            >
              오늘로 이동
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-xs">
            {ZOOM_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => setPxPerHour(opt.pxPerHour)}
                className={`rounded-md px-2 py-1 font-mono text-[11px] transition ${
                  pxPerHour === opt.pxPerHour
                    ? "bg-indigo-500 text-white"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void onRefresh()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-200 transition hover:border-zinc-700 hover:bg-zinc-800"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            새로고침
          </button>
        </div>
      </div>

      {/* Daily Summary Strip */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/50 px-3.5 py-2.5">
          <div className="text-[11px] text-zinc-500">자동 수집 활동</div>
          <div className="mt-0.5 font-mono text-base font-semibold text-zinc-100">
            {formatDurationHms(summary.activeMs)}
          </div>
          <div className="text-[10px] text-zinc-500">
            유휴 {formatDurationShort(summary.idleMs)}
            {minDurationMs > 0 ? ` · ${Math.round(minDurationMs / 1000)}초 이상` : ""}
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/50 px-3.5 py-2.5">
          <div className="text-[11px] text-zinc-500">확정 시간 기록</div>
          <div className="mt-0.5 font-mono text-base font-semibold text-indigo-300">
            {formatDurationHms(summary.trackedMs)}
          </div>
          <div className="text-[10px] text-zinc-500">{clampedEntries.length}개 Time Entry</div>
        </div>

        <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/50 px-3.5 py-2.5 lg:col-span-2">
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span>상위 사용 앱</span>
            {isToday && status?.activeWindow && (
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-emerald-400">
                <Monitor className="h-3 w-3" />
                {status.activeWindow.processName}
              </span>
            )}
          </div>
          {summary.topApps.length === 0 ? (
            <div className="mt-2 text-xs text-zinc-500">수집된 활동 데이터가 없습니다.</div>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {summary.topApps.map((app) => {
                const style = getProcessColor(app.processName);
                return (
                  <span
                    key={app.processName}
                    className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-950/70 px-2 py-0.5 text-[11px] text-zinc-200"
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: style.hex }}
                    />
                    <span>{cleanProcessLabel(app.processName)}</span>
                    <span className="font-mono text-[10px] text-zinc-400">
                      {formatDurationShort(app.durationMs)}
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Main Split: 2-Track Vertical Timeline + Sticky Right Inspector/Conversion Drawer */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left: 2-Track Time Axis */}
        <div className="flex min-h-[480px] flex-col overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/40 lg:col-span-8">
          {/* Track Column Headers */}
          <div className="grid grid-cols-[56px_1fr_1fr] border-b border-zinc-800/80 bg-zinc-900/90 text-[11px] font-semibold text-zinc-300">
            <div className="border-r border-zinc-800/80 px-2 py-2 text-center text-zinc-500">
              시간
            </div>
            <div className="flex items-center justify-between border-r border-zinc-800/80 px-3 py-2">
              <span className="flex items-center gap-1.5">
                <Activity className="h-3.5 w-3.5 text-sky-400" />
                자동 추적 활동 ({clampedActivities.length})
              </span>
              <span className="text-[10px] font-normal text-zinc-500">드래그 · Shift+클릭 선택</span>
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <span className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-indigo-400" />
                확정 시간 기록 ({clampedEntries.length})
              </span>
              <span className="text-[10px] font-normal text-zinc-500">클릭해 편집</span>
            </div>
          </div>

          {/* Scrollable 24-Hour Grid */}
          <div ref={scrollContainerRef} className="relative flex-1 overflow-y-auto">
            <div
              className="relative grid grid-cols-[56px_1fr_1fr]"
              style={{ height: `${totalHeightPx}px` }}
            >
              {/* Hour Gutter */}
              <div className="relative select-none border-r border-zinc-800/80 bg-zinc-950/40">
                {HOURS.map((hour) => (
                  <div
                    key={hour}
                    className="absolute left-0 right-0 pr-2 text-right font-mono text-[10px] text-zinc-500"
                    style={{ top: `${hour * pxPerHour - 6}px` }}
                  >
                    {hour > 0 ? `${String(hour).padStart(2, "0")}:00` : ""}
                  </div>
                ))}
              </div>

              {/* Track 1: Auto-Tracked Activity Logs (Draggable + Click Multi-Select) */}
              <div
                ref={autoTrackRef}
                onPointerDown={handleTrackPointerDown}
                onPointerMove={handleTrackPointerMove}
                onPointerUp={handleTrackPointerUp}
                onPointerCancel={() => setDragBand(null)}
                className="relative select-none border-r border-zinc-800/80"
              >
                {/* Hour & Half-Hour Gridlines */}
                {HOURS.map((hour) => (
                  <div key={hour}>
                    <div
                      className="pointer-events-none absolute left-0 right-0 border-t border-zinc-800/60"
                      style={{ top: `${hour * pxPerHour}px` }}
                    />
                    {pxPerHour >= 120 && (
                      <div
                        className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-zinc-800/30"
                        style={{ top: `${hour * pxPerHour + pxPerHour / 2}px` }}
                      />
                    )}
                  </div>
                ))}

                {/* Drag Range Selection Overlay */}
                {dragBand && dragBand.moved && (
                  <div
                    className="pointer-events-none absolute left-1 right-1 z-30 rounded-lg border-2 border-indigo-400 bg-indigo-500/20"
                    style={{
                      top: `${Math.min(dragBand.anchorY, dragBand.currentY)}px`,
                      height: `${Math.max(8, Math.abs(dragBand.currentY - dragBand.anchorY))}px`,
                    }}
                  >
                    <div className="inline-block rounded-br-md bg-indigo-500 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white">
                      {formatTimeHm(yToTs(Math.min(dragBand.anchorY, dragBand.currentY)))} –{" "}
                      {formatTimeHm(yToTs(Math.max(dragBand.anchorY, dragBand.currentY)))}
                    </div>
                  </div>
                )}

                {/* Custom Empty-Gap Drag Selection Highlight */}
                {customRange && selectedLogIds.length === 0 && (
                  <div
                    className="pointer-events-none absolute left-1.5 right-1.5 z-20 rounded-lg border-2 border-dashed border-indigo-400 bg-indigo-500/15"
                    style={{
                      top: `${tsToY(customRange.startMs)}px`,
                      height: `${Math.max(16, tsToY(customRange.endMs) - tsToY(customRange.startMs))}px`,
                    }}
                  >
                    <div className="px-2 py-0.5 font-mono text-[10px] text-indigo-200">
                      선택 구간 {formatTimeHm(customRange.startMs)}–{formatTimeHm(customRange.endMs)}
                    </div>
                  </div>
                )}

                {/* Activity Log Blocks */}
                {clampedActivities.map((item) => {
                  const top = tsToY(item.startMs);
                  const rawHeight = tsToY(item.endMs) - top;
                  const height = Math.max(14, rawHeight);
                  const isSelected = selectedLogIds.includes(item.log.id);
                  const style = getProcessColor(item.log.processName);
                  const isCompact = height < 30;

                  return (
                    <button
                      key={item.log.id}
                      type="button"
                      onClick={(e) => handleBlockClick(item, e)}
                      onMouseEnter={() => setHoveredLog(item.log)}
                      onMouseLeave={() =>
                        setHoveredLog((prev) => (prev?.id === item.log.id ? null : prev))
                      }
                      style={{
                        top: `${top}px`,
                        height: `${height}px`,
                        backgroundColor: item.log.isIdle ? undefined : style.bg,
                        borderColor: isSelected
                          ? "#818cf8"
                          : item.log.isIdle
                            ? "rgba(245, 158, 11, 0.35)"
                            : style.border,
                        backgroundImage: item.log.isIdle
                          ? "repeating-linear-gradient(-45deg, rgba(245, 158, 11, 0.14), rgba(245, 158, 11, 0.14) 6px, rgba(24, 24, 27, 0.55) 6px, rgba(24, 24, 27, 0.55) 12px)"
                          : undefined,
                      }}
                      className={`absolute left-1.5 right-1.5 z-10 overflow-hidden rounded-md border px-2 text-left transition ${
                        isSelected
                          ? "z-20 ring-2 ring-indigo-400/90"
                          : "hover:z-20 hover:brightness-115"
                      }`}
                    >
                      <div className="flex h-full flex-col justify-center">
                        <div className="flex items-center justify-between gap-1">
                          <span
                            className="truncate text-[11px] font-semibold"
                            style={{ color: item.log.isIdle ? "#fcd34d" : style.text }}
                          >
                            {item.log.isIdle ? "유휴 (Idle)" : cleanProcessLabel(item.log.processName)}
                          </span>
                          <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-zinc-300/80">
                            {formatDurationShort(item.endMs - item.startMs)}
                            {isSelected && (
                              <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-indigo-500 text-white">
                                <Check className="h-2.5 w-2.5" />
                              </span>
                            )}
                          </span>
                        </div>
                        {!isCompact && item.log.windowTitle && (
                          <div className="truncate text-[10px] text-zinc-300/80">
                            {item.log.windowTitle}
                          </div>
                        )}
                      </div>
                    </button>
                  );
                })}

                {/* Current Time Hairline */}
                {currentTimeY !== null && (
                  <div
                    className="pointer-events-none absolute left-0 right-0 z-30 border-t-2 border-rose-500/80"
                    style={{ top: `${currentTimeY}px` }}
                  />
                )}
              </div>

              {/* Track 2: Confirmed / Manual Time Entries */}
              <div className="relative bg-zinc-950/20">
                {HOURS.map((hour) => (
                  <div key={hour}>
                    <div
                      className="pointer-events-none absolute left-0 right-0 border-t border-zinc-800/60"
                      style={{ top: `${hour * pxPerHour}px` }}
                    />
                    {pxPerHour >= 120 && (
                      <div
                        className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-zinc-800/30"
                        style={{ top: `${hour * pxPerHour + pxPerHour / 2}px` }}
                      />
                    )}
                  </div>
                ))}

                {clampedEntries.map((item) => {
                  const top = tsToY(item.startMs);
                  const height = Math.max(24, tsToY(item.endMs) - top);
                  const project = item.entry.ticktickProjectId
                    ? (projectMap.get(item.entry.ticktickProjectId) ?? null)
                    : null;
                  const accent = project?.color ?? "#6366f1";
                  const selected = inspectedEntryId === item.entry.id;
                  const isRunning = item.entry.endedAt === null;

                  return (
                    <button
                      key={item.entry.id}
                      type="button"
                      onClick={() => {
                        clearSelection();
                        setInspectedEntryId(selected ? null : item.entry.id);
                      }}
                      style={{
                        top: `${top}px`,
                        height: `${height}px`,
                        borderLeftColor: accent,
                      }}
                      className={`absolute left-1.5 right-1.5 z-10 overflow-hidden rounded-md border border-l-4 px-2.5 py-1 text-left transition ${
                        selected
                          ? "z-20 border-indigo-400 bg-indigo-500/20 ring-2 ring-indigo-400/60"
                          : isRunning
                            ? "border-rose-500/50 bg-rose-500/15 hover:bg-rose-500/20"
                            : "border-zinc-700/80 bg-zinc-900/90 hover:border-zinc-600 hover:bg-zinc-800/90"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="truncate text-xs font-semibold text-zinc-100">
                          {item.entry.description || "(Untitled)"}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] text-zinc-300">
                          {formatDurationShort(item.endMs - item.startMs)}
                        </span>
                      </div>
                      {height >= 36 && (
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-zinc-400">
                          {project && (
                            <span className="inline-flex items-center gap-1 truncate">
                              <span
                                className="h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: accent }}
                              />
                              {project.name}
                            </span>
                          )}
                          <span className="rounded bg-zinc-800 px-1 text-[9px] text-zinc-400">
                            {item.entry.syncStatus}
                          </span>
                        </div>
                      )}
                    </button>
                  );
                })}

                {currentTimeY !== null && (
                  <div
                    className="pointer-events-none absolute left-0 right-0 z-30 border-t-2 border-rose-500/80"
                    style={{ top: `${currentTimeY}px` }}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Hover Detail Footer Strip */}
          <div className="flex min-h-[38px] items-center justify-between gap-3 border-t border-zinc-800/80 bg-zinc-950/90 px-3.5 py-2 text-xs">
            {hoveredLog ? (
              <>
                <div className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 font-semibold text-zinc-100">
                    {hoveredLog.isIdle ? "유휴 구간" : hoveredLog.processName}
                  </span>
                  <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400">
                    {hoveredLog.source}
                  </span>
                  {parsedHoveredMeta?.workspace && (
                    <span className="shrink-0 rounded bg-indigo-500/15 px-1.5 py-0.5 font-mono text-[10px] text-indigo-300">
                      {parsedHoveredMeta.workspace}
                      {parsedHoveredMeta.branch ? `:${parsedHoveredMeta.branch}` : ""}
                    </span>
                  )}
                  <span className="truncate text-zinc-400">
                    {hoveredLog.windowTitle ?? "(창 제목 없음)"}
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-zinc-300">
                  {formatTimeHms(hoveredLog.startedAt)} – {formatTimeHms(hoveredLog.endedAt)} (
                  {formatDurationShort(hoveredLog.endedAt - hoveredLog.startedAt)})
                </span>
              </>
            ) : (
              <span className="text-[11px] text-zinc-500">
                활동 블록에 마우스를 올리면 상세 창 제목·소스 메타데이터를 확인할 수 있습니다.
              </span>
            )}
          </div>
        </div>

        {/* Right: Retroactive Conversion Panel OR Entry Inspector OR Guide */}
        <div className="lg:col-span-4">
          {activeSelectionRange ? (
            <div className="sticky top-0 space-y-4 rounded-xl border border-indigo-500/40 bg-zinc-900/85 p-4 shadow-xl">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-300">
                    <Sparkles className="h-3.5 w-3.5" />
                    시간 기록으로 변환 (&ldquo;아 맞다!&rdquo;)
                  </div>
                  <p className="mt-0.5 text-[11px] text-zinc-400">
                    {selectedLogs.length > 0
                      ? `활동 블록 ${selectedLogs.length}개 선택됨 · 총 ${formatDurationHms(
                          activeSelectionRange.endMs - activeSelectionRange.startMs,
                        )}`
                      : `구간 선택됨 · ${formatDurationHms(
                          activeSelectionRange.endMs - activeSelectionRange.startMs,
                        )}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={clearSelection}
                  className="rounded-md p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  title="선택 해제"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {selectedAppBreakdown.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {selectedAppBreakdown.map(([app, dur]) => (
                    <span
                      key={app}
                      className="rounded-md border border-zinc-800 bg-zinc-950/80 px-2 py-0.5 text-[10px] text-zinc-300"
                    >
                      {app} <span className="font-mono text-zinc-500">{formatDurationShort(dur)}</span>
                    </span>
                  ))}
                </div>
              )}

              <div className="space-y-3">
                <label className="block space-y-1 text-xs">
                  <span className="text-zinc-400">작업 설명</span>
                  <input
                    type="text"
                    value={draftDesc}
                    onChange={(e) => setDraftDesc(e.target.value)}
                    placeholder="무슨 작업을 했나요?"
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
                  />
                </label>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block space-y-1 text-xs">
                    <span className="text-zinc-400">시작 시각</span>
                    <input
                      type="time"
                      value={draftStartHm}
                      onChange={(e) => setDraftStartHm(e.target.value)}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
                    />
                  </label>
                  <label className="block space-y-1 text-xs">
                    <span className="text-zinc-400">종료 시각</span>
                    <input
                      type="time"
                      value={draftEndHm}
                      onChange={(e) => setDraftEndHm(e.target.value)}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
                    />
                  </label>
                </div>

                <div className="space-y-1 text-xs">
                  <span className="text-zinc-400">프로젝트 &amp; 태그</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <ProjectPicker
                      projects={projects}
                      selectedProjectId={draftProjectId}
                      onChange={(pid) => {
                        setDraftProjectId(pid);
                        if (draftTaskId && pid && taskMap.get(draftTaskId)?.projectId !== pid) {
                          setDraftTaskId(null);
                        }
                      }}
                      compact
                      align="left"
                    />
                    <TagPicker
                      tags={tags}
                      selectedTagIds={draftTagIds}
                      onChange={setDraftTagIds}
                      onCreateTag={onCreateTag}
                      onDeleteTag={onDeleteTag}
                      compact
                      align="left"
                    />
                  </div>
                  {draftTagIds.length > 0 && (
                    <div className="flex flex-wrap gap-1 pt-1">
                      {draftTagIds.map((tid) => {
                        const tag = tagMap.get(tid);
                        if (!tag) return null;
                        return (
                          <span
                            key={tag.id}
                            className="rounded-full border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-200"
                          >
                            #{tag.name}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>

                <label className="block space-y-1 text-xs">
                  <span className="flex items-center gap-1 text-zinc-400">
                    <CheckSquare className="h-3 w-3 text-indigo-400" />
                    TickTick 원 태스크 연결 (선택)
                  </span>
                  <select
                    value={draftTaskId ?? ""}
                    onChange={(e) => {
                      const taskId = e.target.value || null;
                      setDraftTaskId(taskId);
                      if (taskId) {
                        const task = taskMap.get(taskId);
                        if (task) {
                          setDraftProjectId(task.projectId);
                          if (!draftDesc.trim()) setDraftDesc(task.title);
                        }
                      }
                    }}
                    className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-2 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
                  >
                    <option value="">연결 안 함 (로컬 기록)</option>
                    {openTasks
                      .filter((t) => !draftProjectId || t.projectId === draftProjectId)
                      .map((task) => {
                        const p = projectMap.get(task.projectId);
                        return (
                          <option key={task.id} value={task.id}>
                            {p ? `[${p.name}] ` : ""}
                            {task.title}
                          </option>
                        );
                      })}
                  </select>
                </label>

                {draftTaskId && (
                  <label className="flex items-center gap-2 text-xs text-zinc-300">
                    <input
                      type="checkbox"
                      checked={draftCompleteParent}
                      onChange={(e) => setDraftCompleteParent(e.target.checked)}
                      className="rounded border-zinc-600 bg-zinc-900"
                    />
                    원래 태스크도 완료로 표시
                  </label>
                )}

                {draftError && <p className="text-xs text-rose-400">{draftError}</p>}

                <div className="space-y-2 pt-1">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleConvertSelection(false)}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
                  >
                    <Check className="h-3.5 w-3.5" />
                    시간 기록으로 저장
                  </button>

                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void handleConvertSelection(true)}
                    className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/25 disabled:opacity-50"
                  >
                    <CloudUpload className="h-3.5 w-3.5" />
                    저장 후 TickTick에 밀어넣기
                  </button>
                </div>
              </div>
            </div>
          ) : inspectedEntry ? (
            <div className="sticky top-0 space-y-3 rounded-xl border border-zinc-700/80 bg-zinc-900/85 p-4 shadow-xl">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold text-zinc-200">선택된 시간 기록 편집</h2>
                <button
                  type="button"
                  onClick={() => setInspectedEntryId(null)}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <input
                type="text"
                value={entryEditDesc}
                onChange={(e) => setEntryEditDesc(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
              />

              <div className="grid grid-cols-2 gap-2">
                <input
                  type="time"
                  value={entryEditStartHm}
                  onChange={(e) => setEntryEditStartHm(e.target.value)}
                  className="rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
                />
                {inspectedEntry.endedAt !== null ? (
                  <input
                    type="time"
                    value={entryEditEndHm}
                    onChange={(e) => setEntryEditEndHm(e.target.value)}
                    className="rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 font-mono text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
                  />
                ) : (
                  <span className="flex items-center justify-center rounded-lg bg-rose-500/15 text-xs font-medium text-rose-300">
                    실행 중
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <ProjectPicker
                  projects={projects}
                  selectedProjectId={entryEditProjectId}
                  onChange={setEntryEditProjectId}
                  compact
                  align="left"
                />
                <TagPicker
                  tags={tags}
                  selectedTagIds={entryEditTagIds}
                  onChange={setEntryEditTagIds}
                  onCreateTag={onCreateTag}
                  onDeleteTag={onDeleteTag}
                  compact
                  align="left"
                />
              </div>

              <div className="flex items-center justify-between gap-2 pt-2">
                <button
                  type="button"
                  onClick={async () => {
                    await onDeleteEntry(inspectedEntry.id);
                    setInspectedEntryId(null);
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-300 hover:bg-rose-500/20"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  삭제
                </button>
                <div className="flex items-center gap-1.5">
                  {inspectedEntry.endedAt !== null && inspectedEntry.syncStatus !== "synced" && (
                    <button
                      type="button"
                      onClick={() => void onRequestTickTickSync(inspectedEntry)}
                      className="inline-flex items-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/25"
                    >
                      <CloudUpload className="h-3.5 w-3.5" />
                      밀어넣기
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleSaveInspectedEntry()}
                    className="inline-flex items-center gap-1 rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-400"
                  >
                    <Check className="h-3.5 w-3.5" />
                    저장
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-5 text-xs text-zinc-400">
              <div className="flex items-center gap-2 font-semibold text-zinc-200">
                <MousePointerClick className="h-4 w-4 text-indigo-400" />
                사후 밀어넣기 사용법
              </div>
              <ul className="mt-3 space-y-2 leading-relaxed">
                <li>
                  • 좌측 <strong className="text-zinc-200">자동 추적 활동</strong> 트랙에서
                  타이머를 깜빡한 구간을 <strong className="text-indigo-300">세로 드래그</strong>
                  하세요.
                </li>
                <li>
                  • 개별 블록을 <strong className="text-zinc-200">클릭</strong>하거나{" "}
                  <strong className="text-zinc-200">Shift + 클릭</strong>으로 연속 구간을 다중
                  선택할 수 있습니다.
                </li>
                <li>
                  • 선택하면 이곳에 변환 패널이 열려 프로젝트·TickTick 태스크·태그를 연결하고 즉시
                  Time Entry로 확정할 수 있습니다.
                </li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
