import {
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  CloudUpload,
  EyeOff,
  RefreshCw,
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
  type WheelEvent as ReactWheelEvent,
} from "react";
import {
  addDays,
  applyTimeInputToDate,
  cleanProcessLabel,
  formatDurationHms,
  formatDurationShort,
  formatFullDateKorean,
  formatTimeHm,
  getDayRangeMs,
  getProcessColor,
  isSameLocalDay,
  matchesAnyProcess,
  processNameMatches,
  suggestDescriptionFromLogs,
} from "../lib/time";
import {
  buildTimelineBlocks,
  layoutTimeEntries,
  parseActivityMetadata,
  type ClampedActivity,
  type ClampedEntry,
  type TimelineBlock,
} from "../lib/timelineLayout";
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
import { ActivityHoverPopover } from "./ActivityHoverPopover";
import { AppBadgeIcon, AppIconStack } from "./AppBadgeIcon";
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
  excludedProcesses: string[];
  onRefresh: () => Promise<void>;
  onExcludeProcess: (processName: string) => Promise<void>;
  onCreateEntry: (input: CreateTimeEntryInput) => Promise<TimeEntry>;
  onUpdateEntry: (id: string, input: UpdateTimeEntryInput) => Promise<void>;
  onDeleteEntry: (id: string) => Promise<void>;
  onCreateTag: (name: string, color?: string | null) => Promise<Tag>;
  onDeleteTag: (id: string) => Promise<void>;
  onRequestTickTickSync: (entry: TimeEntry) => Promise<void> | void;
}

interface DragBand {
  anchorY: number;
  currentY: number;
  moved: boolean;
}

interface HoveredBlockState {
  block: TimelineBlock;
  anchorTopPx: number;
  viewportHeightPx: number;
}

const ZOOM_OPTIONS: { label: string; pxPerHour: number }[] = [
  { label: "1x", pxPerHour: 60 },
  { label: "2x", pxPerHour: 120 },
  { label: "4x", pxPerHour: 240 },
  { label: "8x", pxPerHour: 480 },
];

const HOURS = Array.from({ length: 24 }, (_, i) => i);

function formatClusterHeading(block: TimelineBlock): string {
  if (block.apps.length === 0) return "활동";
  if (block.apps.length === 1) return block.apps[0].label;
  if (block.apps.length === 2) return `${block.apps[0].label} · ${block.apps[1].label}`;
  return `${block.apps[0].label} +${block.apps.length - 1}`;
}

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
  excludedProcesses,
  onRefresh,
  onExcludeProcess,
  onCreateEntry,
  onUpdateEntry,
  onDeleteEntry,
  onCreateTag,
  onDeleteTag,
  onRequestTickTickSync,
}: TimelineViewProps) {
  const [pxPerHour, setPxPerHour] = useState(120);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Selection state on Auto-Tracked column (always tracked by underlying raw log IDs)
  const [selectedLogIds, setSelectedLogIds] = useState<number[]>([]);
  const [anchorBlockId, setAnchorBlockId] = useState<string | null>(null);
  const [customRange, setCustomRange] = useState<{ startMs: number; endMs: number } | null>(null);
  const [dragBand, setDragBand] = useState<DragBand | null>(null);
  const [hoveredState, setHoveredState] = useState<HoveredBlockState | null>(null);

  // Selected existing Time Entry on Column 2
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

  const timelineBlocks = useMemo(
    () => buildTimelineBlocks(clampedActivities, dayStartMs, pxPerHour),
    [clampedActivities, dayStartMs, pxPerHour],
  );

  const layoutEntries = useMemo(
    () => layoutTimeEntries(clampedEntries, dayStartMs, pxPerHour),
    [clampedEntries, dayStartMs, pxPerHour],
  );

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
      .slice(0, 7)
      .map(([processName, durationMs]) => ({ processName, durationMs }));

    const trackedRatio =
      activeMs > 0 ? Math.min(100, Math.round((trackedMs / activeMs) * 100)) : trackedMs > 0 ? 100 : 0;

    return { activeMs, idleMs, trackedMs, topApps, trackedRatio };
  }, [clampedActivities, clampedEntries]);

  // Reset selections when switching days.
  useEffect(() => {
    setSelectedLogIds([]);
    setAnchorBlockId(null);
    setCustomRange(null);
    setInspectedEntryId(null);
    setHoveredState(null);
  }, [dayStartMs]);

  useEffect(() => {
    setHoveredState(null);
  }, [pxPerHour, timelineBlocks]);

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

  const selectedLogIdSet = useMemo(() => new Set(selectedLogIds), [selectedLogIds]);

  const selectedLogs = useMemo(
    () => clampedActivities.filter((item) => selectedLogIdSet.has(item.log.id)),
    [clampedActivities, selectedLogIdSet],
  );

  const activeSelectionRange = useMemo<{ startMs: number; endMs: number } | null>(() => {
    if (selectedLogs.length > 0) {
      const startMs = Math.min(...selectedLogs.map((l) => l.startMs));
      const endMs = Math.max(...selectedLogs.map((l) => l.endMs));
      return { startMs, endMs };
    }
    return customRange;
  }, [selectedLogs, customRange]);

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
    const snapped = Math.round(rawMs / 60_000) * 60_000;
    return Math.max(dayStartMs, Math.min(dayEndMs, snapped));
  }

  function handleZoomChange(nextPxPerHour: number) {
    if (nextPxPerHour === pxPerHour) return;
    const el = scrollContainerRef.current;
    if (el) {
      const centerHours = (el.scrollTop + el.clientHeight / 2) / pxPerHour;
      setPxPerHour(nextPxPerHour);
      window.requestAnimationFrame(() => {
        const currentEl = scrollContainerRef.current;
        if (!currentEl) return;
        const target = centerHours * nextPxPerHour - currentEl.clientHeight / 2;
        currentEl.scrollTop = Math.max(0, target);
      });
    } else {
      setPxPerHour(nextPxPerHour);
    }
  }

  function handleTimelineWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const curIdx = ZOOM_OPTIONS.findIndex((opt) => opt.pxPerHour === pxPerHour);
    if (curIdx === -1) return;
    const nextIdx =
      event.deltaY < 0
        ? Math.min(ZOOM_OPTIONS.length - 1, curIdx + 1)
        : Math.max(0, curIdx - 1);
    if (nextIdx !== curIdx) {
      handleZoomChange(ZOOM_OPTIONS[nextIdx].pxPerHour);
    }
  }

  function clearSelection() {
    setSelectedLogIds([]);
    setAnchorBlockId(null);
    setCustomRange(null);
    setDraftProjectId(null);
    setDraftTaskId(null);
    setDraftTagIds([]);
    setDraftCompleteParent(false);
    setDraftError(null);
  }

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
    if (moved) {
      setHoveredState(null);
    }
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
        const firstId = overlapping[0].log.id;
        const firstBlock = timelineBlocks.find((b) => b.logIds.includes(firstId));
        setAnchorBlockId(firstBlock?.id ?? null);
        setCustomRange(null);
      } else {
        setSelectedLogIds([]);
        setAnchorBlockId(null);
        setCustomRange({ startMs: bandStart, endMs: bandEnd });
      }
      setInspectedEntryId(null);
    }

    setDragBand(null);
  }

  function handleBlockClick(block: TimelineBlock, event: ReactMouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      return;
    }

    setCustomRange(null);
    setInspectedEntryId(null);

    if (event.shiftKey && anchorBlockId !== null) {
      const anchorIdx = timelineBlocks.findIndex((b) => b.id === anchorBlockId);
      const clickedIdx = timelineBlocks.findIndex((b) => b.id === block.id);
      if (anchorIdx !== -1 && clickedIdx !== -1) {
        const [from, to] =
          anchorIdx <= clickedIdx ? [anchorIdx, clickedIdx] : [clickedIdx, anchorIdx];
        const ids = timelineBlocks.slice(from, to + 1).flatMap((b) => b.logIds);
        setSelectedLogIds(Array.from(new Set(ids)));
        return;
      }
    }

    setAnchorBlockId(block.id);
    setSelectedLogIds((prev) => {
      const prevSet = new Set(prev);
      const allSelected = block.logIds.every((id) => prevSet.has(id));
      if (allSelected) {
        const removeSet = new Set(block.logIds);
        return prev.filter((id) => !removeSet.has(id));
      }
      for (const id of block.logIds) {
        prevSet.add(id);
      }
      return Array.from(prevSet);
    });
  }

  function handleBlockHoverEnter(block: TimelineBlock) {
    if (dragBand?.moved) return;
    const el = scrollContainerRef.current;
    const scrollTop = el?.scrollTop ?? 0;
    const viewportHeightPx = el?.clientHeight ?? 480;
    const anchorTopPx = block.topPx - scrollTop + Math.min(block.heightPx / 2, 24);
    setHoveredState({ block, anchorTopPx, viewportHeightPx });
  }

  async function handleConvertSelection(pushToTickTick: boolean) {
    if (!activeSelectionRange || saving) return;
    const startTs = applyTimeInputToDate(dayStartMs, draftStartHm);
    const endTs = applyTimeInputToDate(dayStartMs, draftEndHm);
    if (startTs === null || endTs === null) {
      setDraftError("시각 형식 오류");
      return;
    }
    if (endTs <= startTs) {
      setDraftError("종료 ≤ 시작");
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
    const map = new Map<string, { processName: string; isIdle: boolean; durationMs: number }>();
    for (const item of selectedLogs) {
      const key = item.log.isIdle ? "__idle__" : item.log.processName.trim().toLowerCase();
      const prev = map.get(key);
      const dur = item.endMs - item.startMs;
      if (prev) {
        prev.durationMs += dur;
      } else {
        map.set(key, {
          processName: item.log.processName,
          isIdle: item.log.isIdle,
          durationMs: dur,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.durationMs - a.durationMs);
  }, [selectedLogs]);

  const selectedWindowBreakdown = useMemo(() => {
    const map = new Map<
      string,
      { processName: string; title: string; durationMs: number; workspace?: string; branch?: string }
    >();
    for (const item of selectedLogs) {
      if (item.log.isIdle) continue;
      const meta = parseActivityMetadata(item.log.metadataJson);
      const rawTitle = item.log.windowTitle?.trim();
      const title =
        rawTitle ||
        (meta?.workspace
          ? meta.branch
            ? `${meta.workspace} (${meta.branch})`
            : meta.workspace
          : `${cleanProcessLabel(item.log.processName)}`);
      const key = `${item.log.processName.toLowerCase()}::${title}`;
      const dur = item.endMs - item.startMs;
      const prev = map.get(key);
      if (prev) {
        prev.durationMs += dur;
      } else {
        map.set(key, {
          processName: item.log.processName,
          title,
          durationMs: dur,
          workspace: meta?.workspace,
          branch: meta?.branch,
        });
      }
    }
    return [...map.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, 6);
  }, [selectedLogs]);

  const currentTimeY = isToday ? tsToY(Math.min(nowMs, dayEndMs)) : null;
  const maxTopAppMs = summary.topApps[0]?.durationMs ?? 1;
  const inspectedProject = inspectedEntry?.ticktickProjectId
    ? (projectMap.get(inspectedEntry.ticktickProjectId) ?? null)
    : null;

  return (
    <section className="mx-auto flex h-full max-w-6xl flex-col gap-4">
      {/* Compact Navigation & Zoom Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="inline-flex h-8 items-center rounded-lg border border-white/[0.08] bg-white/[0.03]">
            <button
              type="button"
              onClick={() => onChangeDate(addDays(selectedDate, -1))}
              className="flex h-full items-center px-2 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
              title="이전 날"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="px-3 text-xs font-semibold tracking-tight text-zinc-100">
              {formatFullDateKorean(selectedDate)}
            </div>
            <button
              type="button"
              onClick={() => onChangeDate(addDays(selectedDate, 1))}
              disabled={isToday}
              className="flex h-full items-center px-2 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-30"
              title="다음 날"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {!isToday && (
            <button
              type="button"
              onClick={() => onChangeDate(new Date())}
              className="h-8 rounded-lg bg-indigo-500/12 px-2.5 text-xs font-medium text-indigo-300 ring-1 ring-inset ring-indigo-500/25 transition-colors hover:bg-indigo-500/20"
            >
              오늘
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div
            className="inline-flex h-8 items-center rounded-lg border border-white/[0.08] bg-white/[0.03] p-0.5 text-xs"
            title="Ctrl + 휠"
          >
            {ZOOM_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => handleZoomChange(opt.pxPerHour)}
                className={`h-7 rounded-md px-2.5 font-mono text-[11px] font-medium transition-colors ${
                  pxPerHour === opt.pxPerHour
                    ? "bg-white/[0.12] text-zinc-100"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void onRefresh()}
            title="새로고침"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.03] text-zinc-400 transition-colors hover:bg-white/[0.07] hover:text-zinc-100"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Main Workspace: Full-Height 2-Track Canvas + Contextual Visual Rail */}
      <div className="flex min-h-0 flex-1 flex-col gap-5 lg:flex-row">
        {/* Left: 2-Track Vertical Timeline */}
        <div className="flex min-h-[480px] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/[0.07] bg-[#0d0d11]">
          {/* Whisper-Quiet Column Headers */}
          <div className="grid h-9 shrink-0 grid-cols-[56px_1fr_1fr] border-b border-white/[0.06] bg-white/[0.02] text-xs">
            <div className="border-r border-white/[0.06]" />
            <div className="flex items-center justify-between border-r border-white/[0.06] px-3">
              <span className="flex items-center gap-2 font-medium text-zinc-300">
                <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                <span>활동</span>
              </span>
              <span className="font-mono text-[11px] tabular-nums text-zinc-500">
                {summary.activeMs > 0 ? formatDurationShort(summary.activeMs) : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between px-3">
              <span className="flex items-center gap-2 font-medium text-zinc-300">
                <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
                <span>기록</span>
              </span>
              <span className="font-mono text-[11px] tabular-nums text-indigo-300/80">
                {summary.trackedMs > 0 ? formatDurationShort(summary.trackedMs) : "—"}
              </span>
            </div>
          </div>

          {/* Relative Viewport Wrapper */}
          <div className="relative min-h-0 flex-1">
            <div
              ref={scrollContainerRef}
              onScroll={() => {
                if (hoveredState) setHoveredState(null);
              }}
              onWheel={handleTimelineWheel}
              className="relative h-full overflow-y-auto"
            >
              <div
                className="relative grid grid-cols-[56px_1fr_1fr]"
                style={{ height: `${totalHeightPx}px` }}
              >
                {/* Hour Gutter */}
                <div className="relative select-none border-r border-white/[0.06] bg-black/20">
                  {HOURS.map((hour) => (
                    <div key={hour}>
                      <div
                        className="absolute left-0 right-0 pr-2.5 text-right font-mono text-[10px] tabular-nums text-zinc-500"
                        style={{ top: `${hour * pxPerHour - 6}px` }}
                      >
                        {hour > 0 ? `${String(hour).padStart(2, "0")}:00` : ""}
                      </div>
                      {pxPerHour >= 240 && (
                        <div
                          className="absolute left-0 right-0 pr-2.5 text-right font-mono text-[9px] tabular-nums text-zinc-600"
                          style={{ top: `${hour * pxPerHour + pxPerHour / 2 - 5}px` }}
                        >
                          {`${String(hour).padStart(2, "0")}:30`}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Track 1: Auto-Tracked Activity Blocks */}
                <div
                  ref={autoTrackRef}
                  onPointerDown={handleTrackPointerDown}
                  onPointerMove={handleTrackPointerMove}
                  onPointerUp={handleTrackPointerUp}
                  onPointerCancel={() => setDragBand(null)}
                  onMouseLeave={() => setHoveredState(null)}
                  className="relative cursor-crosshair select-none border-r border-white/[0.06]"
                >
                  {HOURS.map((hour) => (
                    <div key={hour}>
                      <div
                        className="pointer-events-none absolute left-0 right-0 border-t border-white/[0.05]"
                        style={{ top: `${hour * pxPerHour}px` }}
                      />
                      {pxPerHour >= 120 && (
                        <div
                          className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-white/[0.025]"
                          style={{ top: `${hour * pxPerHour + pxPerHour / 2}px` }}
                        />
                      )}
                      {pxPerHour >= 240 && (
                        <>
                          <div
                            className="pointer-events-none absolute left-0 right-0 border-t border-dotted border-white/[0.02]"
                            style={{ top: `${hour * pxPerHour + pxPerHour / 4}px` }}
                          />
                          <div
                            className="pointer-events-none absolute left-0 right-0 border-t border-dotted border-white/[0.02]"
                            style={{ top: `${hour * pxPerHour + (pxPerHour * 3) / 4}px` }}
                          />
                        </>
                      )}
                    </div>
                  ))}

                  {/* Drag Range Selection Lens */}
                  {dragBand && dragBand.moved && (
                    <div
                      className="pointer-events-none absolute left-1.5 right-1.5 z-30 rounded-lg border border-indigo-400 bg-indigo-500/20 shadow-lg shadow-indigo-500/10"
                      style={{
                        top: `${Math.min(dragBand.anchorY, dragBand.currentY)}px`,
                        height: `${Math.max(8, Math.abs(dragBand.currentY - dragBand.anchorY))}px`,
                      }}
                    >
                      <div className="inline-block rounded-br-md rounded-tl-[6px] bg-indigo-500 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-white">
                        {formatTimeHm(yToTs(Math.min(dragBand.anchorY, dragBand.currentY)))}–
                        {formatTimeHm(yToTs(Math.max(dragBand.anchorY, dragBand.currentY)))}
                      </div>
                    </div>
                  )}

                  {/* Custom Empty-Gap Drag Selection */}
                  {customRange && selectedLogIds.length === 0 && (
                    <div
                      className="pointer-events-none absolute left-1.5 right-1.5 z-20 rounded-lg border border-dashed border-indigo-400 bg-indigo-500/15"
                      style={{
                        top: `${tsToY(customRange.startMs)}px`,
                        height: `${Math.max(16, tsToY(customRange.endMs) - tsToY(customRange.startMs))}px`,
                      }}
                    >
                      <div className="px-2 py-0.5 font-mono text-[10px] tabular-nums text-indigo-200">
                        {formatTimeHm(customRange.startMs)}–{formatTimeHm(customRange.endMs)}
                      </div>
                    </div>
                  )}

                  {/* Zero-Overlap Activity Blocks */}
                  {timelineBlocks.map((block) => {
                    const selectedCount = block.logIds.reduce(
                      (acc, id) => acc + (selectedLogIdSet.has(id) ? 1 : 0),
                      0,
                    );
                    const isFullySelected =
                      selectedCount === block.logIds.length && selectedCount > 0;
                    const isPartiallySelected = selectedCount > 0 && !isFullySelected;

                    const dominantStyle = block.dominantApp
                      ? getProcessColor(block.dominantApp.processName)
                      : null;

                    const isSliver = block.heightPx < 13;
                    const isTinyRow = block.heightPx >= 13 && block.heightPx < 20;
                    const isTall = block.heightPx >= 36;

                    const bgColor =
                      block.kind === "idle"
                        ? undefined
                        : block.kind === "cluster"
                          ? "rgba(22, 22, 29, 0.94)"
                          : "#12151f";

                    const accentOverlay =
                      block.kind === "single" && dominantStyle
                        ? `linear-gradient(90deg, ${dominantStyle.bg}, rgba(20, 20, 26, 0.88) 80%)`
                        : block.kind === "idle"
                          ? "repeating-linear-gradient(-45deg, rgba(245, 158, 11, 0.14), rgba(245, 158, 11, 0.14) 6px, rgba(20, 20, 26, 0.9) 6px, rgba(20, 20, 26, 0.9) 12px)"
                          : undefined;

                    const borderColor = isFullySelected
                      ? "#818cf8"
                      : isPartiallySelected
                        ? "rgba(129, 140, 248, 0.65)"
                        : block.kind === "idle"
                          ? "rgba(245, 158, 11, 0.3)"
                          : block.kind === "cluster"
                            ? "rgba(255, 255, 255, 0.09)"
                            : dominantStyle?.border ?? "rgba(255, 255, 255, 0.09)";

                    return (
                      <button
                        key={block.id}
                        type="button"
                        onClick={(e) => handleBlockClick(block, e)}
                        onMouseEnter={() => handleBlockHoverEnter(block)}
                        onMouseLeave={() =>
                          setHoveredState((prev) => (prev?.block.id === block.id ? null : prev))
                        }
                        style={{
                          top: `${block.topPx}px`,
                          height: `${block.heightPx}px`,
                          backgroundColor: bgColor,
                          backgroundImage: accentOverlay,
                          borderColor,
                          borderLeftColor:
                            block.kind === "single" && dominantStyle && !isFullySelected
                              ? dominantStyle.hex
                              : undefined,
                        }}
                        className={`group absolute left-1.5 right-1.5 z-10 cursor-pointer overflow-hidden border text-left transition-all ${
                          isSliver ? "rounded-[3px] px-0" : "rounded-md px-2"
                        } ${block.kind === "single" ? "border-l-[3px]" : ""} ${
                          isFullySelected
                            ? "z-20 ring-2 ring-indigo-400/90"
                            : isPartiallySelected
                              ? "z-20 ring-1 ring-indigo-400/70"
                              : "hover:z-20 hover:brightness-115"
                        }`}
                      >
                        {isSliver ? (
                          block.kind === "cluster" ? (
                            <div className="flex h-full w-full">
                              {block.apps.map((app) => (
                                <span
                                  key={app.processKey}
                                  style={{
                                    width: `${Math.max(6, app.share * 100)}%`,
                                    backgroundColor: getProcessColor(app.processName).hex,
                                  }}
                                  className="h-full opacity-85"
                                />
                              ))}
                            </div>
                          ) : block.kind === "single" && dominantStyle ? (
                            <div
                              className="h-full w-full opacity-85"
                              style={{ backgroundColor: dominantStyle.hex }}
                            />
                          ) : null
                        ) : (
                          <div className="flex h-full flex-col justify-center">
                            <div className="flex items-center justify-between gap-1.5">
                              <div className="flex min-w-0 items-center gap-1.5">
                                {block.kind === "cluster" ? (
                                  <AppIconStack
                                    apps={block.apps}
                                    maxIcons={isTinyRow ? 3 : 4}
                                    size={isTinyRow ? "xs" : "sm"}
                                  />
                                ) : block.kind === "idle" ? (
                                  <AppBadgeIcon
                                    processName="idle"
                                    isIdle
                                    size={isTinyRow ? "xs" : "sm"}
                                  />
                                ) : block.dominantApp ? (
                                  <AppBadgeIcon
                                    processName={block.dominantApp.processName}
                                    size={isTinyRow ? "xs" : "sm"}
                                  />
                                ) : null}

                                <span
                                  className={`truncate font-semibold leading-none ${
                                    isTinyRow ? "text-[10px]" : "text-[11px]"
                                  }`}
                                  style={{
                                    color:
                                      block.kind === "idle"
                                        ? "#fcd34d"
                                        : block.kind === "cluster"
                                          ? "#e4e4e7"
                                          : dominantStyle?.text ?? "#e4e4e7",
                                  }}
                                >
                                  {block.kind === "idle"
                                    ? "유휴"
                                    : block.kind === "cluster"
                                      ? formatClusterHeading(block)
                                      : block.dominantApp?.label ?? "활동"}
                                </span>
                              </div>

                              <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] leading-none tabular-nums text-zinc-400">
                                {formatDurationShort(block.endMs - block.startMs)}
                                {isFullySelected && (
                                  <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-indigo-500 text-white">
                                    <Check className="h-2.5 w-2.5" />
                                  </span>
                                )}
                              </span>
                            </div>

                            {isTall && block.kind === "single" && block.dominantWindowTitle && (
                              <div className="mt-0.5 truncate pl-[22px] text-[10px] text-zinc-400">
                                {block.dominantWindowTitle}
                              </div>
                            )}

                            {isTall && block.kind === "cluster" && (
                              <div className="mt-0.5 flex items-center gap-2 truncate text-[10px] text-zinc-400">
                                {block.apps.slice(0, 3).map((app) => (
                                  <span key={app.processKey} className="truncate">
                                    {app.label}{" "}
                                    <span className="font-mono text-[9px] text-zinc-500">
                                      {formatDurationShort(app.durationMs)}
                                    </span>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {block.kind === "cluster" && !isSliver && (
                          <div className="pointer-events-none absolute bottom-0 left-0 right-0 flex h-[2.5px] w-full overflow-hidden">
                            {block.apps.map((app) => (
                              <span
                                key={app.processKey}
                                style={{
                                  width: `${Math.max(4, app.share * 100)}%`,
                                  backgroundColor: getProcessColor(app.processName).hex,
                                }}
                                className="h-full"
                              />
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}

                  {/* Current Time Hairline + Anchor Dot */}
                  {currentTimeY !== null && (
                    <div
                      className="pointer-events-none absolute left-0 right-0 z-30 border-t border-rose-500/80"
                      style={{ top: `${currentTimeY}px` }}
                    >
                      <span className="absolute -left-[3.5px] -top-[3.5px] h-1.5 w-1.5 rounded-full bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.9)]" />
                    </div>
                  )}
                </div>

                {/* Track 2: Confirmed Time Entries */}
                <div className="relative bg-white/[0.01]">
                  {HOURS.map((hour) => (
                    <div key={hour}>
                      <div
                        className="pointer-events-none absolute left-0 right-0 border-t border-white/[0.05]"
                        style={{ top: `${hour * pxPerHour}px` }}
                      />
                      {pxPerHour >= 120 && (
                        <div
                          className="pointer-events-none absolute left-0 right-0 border-t border-dashed border-white/[0.025]"
                          style={{ top: `${hour * pxPerHour + pxPerHour / 2}px` }}
                        />
                      )}
                      {pxPerHour >= 240 && (
                        <>
                          <div
                            className="pointer-events-none absolute left-0 right-0 border-t border-dotted border-white/[0.02]"
                            style={{ top: `${hour * pxPerHour + pxPerHour / 4}px` }}
                          />
                          <div
                            className="pointer-events-none absolute left-0 right-0 border-t border-dotted border-white/[0.02]"
                            style={{ top: `${hour * pxPerHour + (pxPerHour * 3) / 4}px` }}
                          />
                        </>
                      )}
                    </div>
                  ))}

                  {layoutEntries.map((item) => {
                    const project = item.entry.ticktickProjectId
                      ? (projectMap.get(item.entry.ticktickProjectId) ?? null)
                      : null;
                    const accent = project?.color ?? "#6366f1";
                    const selected = inspectedEntryId === item.entry.id;
                    const isRunning = item.entry.endedAt === null;

                    const gutterPx = 6;
                    const colGapPx = 4;
                    const widthPct = 100 / item.totalCols;
                    const leftCalc =
                      item.totalCols === 1
                        ? `${gutterPx}px`
                        : `calc(${item.colIndex * widthPct}% + ${
                            item.colIndex === 0 ? gutterPx : colGapPx / 2
                          }px)`;
                    const widthCalc =
                      item.totalCols === 1
                        ? `calc(100% - ${gutterPx * 2}px)`
                        : `calc(${widthPct}% - ${
                            (gutterPx * 2 + colGapPx * (item.totalCols - 1)) / item.totalCols
                          }px)`;

                    return (
                      <button
                        key={item.entry.id}
                        type="button"
                        onClick={() => {
                          clearSelection();
                          setInspectedEntryId(selected ? null : item.entry.id);
                        }}
                        style={{
                          top: `${item.topPx}px`,
                          height: `${item.heightPx}px`,
                          left: leftCalc,
                          width: widthCalc,
                          borderLeftColor: isRunning ? "#f43f5e" : accent,
                        }}
                        className={`absolute z-10 flex cursor-pointer flex-col justify-center overflow-hidden rounded-md border border-l-[3.5px] px-2.5 text-left transition-all ${
                          item.heightPx < 30 ? "py-0.5" : "py-1"
                        } ${
                          selected
                            ? "z-20 border-indigo-400/80 bg-indigo-500/20 ring-2 ring-indigo-400/50"
                            : isRunning
                              ? "border-rose-500/35 bg-rose-500/12 hover:bg-rose-500/18"
                              : "border-white/[0.09] bg-[#16161f] hover:border-white/[0.16] hover:bg-[#1c1c28]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="truncate text-[11.5px] font-semibold text-zinc-100">
                            {item.entry.description || "(Untitled)"}
                          </span>
                          <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-400">
                            {formatDurationShort(item.endMs - item.startMs)}
                          </span>
                        </div>
                        {item.heightPx >= 36 && (
                          <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-400">
                            {project && (
                              <span className="inline-flex items-center gap-1 truncate">
                                <span
                                  className="h-1.5 w-1.5 rounded-full"
                                  style={{ backgroundColor: accent }}
                                />
                                <span>{project.name}</span>
                              </span>
                            )}
                            {item.entry.syncStatus !== "local" && (
                              <span
                                title={item.entry.syncStatus}
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                  item.entry.syncStatus === "synced"
                                    ? "bg-emerald-400"
                                    : item.entry.syncStatus === "pending"
                                      ? "bg-amber-400"
                                      : "bg-rose-400"
                                }`}
                              />
                            )}
                          </div>
                        )}
                      </button>
                    );
                  })}

                  {currentTimeY !== null && (
                    <div
                      className="pointer-events-none absolute left-0 right-0 z-30 border-t border-rose-500/80"
                      style={{ top: `${currentTimeY}px` }}
                    />
                  )}
                </div>
              </div>
            </div>

            {hoveredState && !dragBand?.moved && (
              <ActivityHoverPopover
                block={hoveredState.block}
                anchorTopPx={hoveredState.anchorTopPx}
                viewportHeightPx={hoveredState.viewportHeightPx}
              />
            )}
          </div>
        </div>

        {/* Right Contextual Rail: Selection Converter | Entry Editor | Visual Day Overview */}
        <aside className="w-full shrink-0 lg:min-h-0 lg:w-72 lg:overflow-y-auto xl:w-80">
          {activeSelectionRange ? (
            <div className="sticky top-0 overflow-hidden rounded-xl border border-indigo-500/35 bg-[#121218] shadow-2xl">
              <div className="h-[2px] w-full bg-gradient-to-r from-indigo-500 via-indigo-400 to-sky-400" />
              <div className="space-y-4 p-4">
                {/* Selection Range Hero */}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-xs tabular-nums text-indigo-300">
                      {formatTimeHm(activeSelectionRange.startMs)} –{" "}
                      {formatTimeHm(activeSelectionRange.endMs)}
                    </div>
                    <div className="mt-0.5 font-mono text-xl font-semibold tracking-tight tabular-nums text-zinc-100">
                      {formatDurationHms(
                        activeSelectionRange.endMs - activeSelectionRange.startMs,
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={clearSelection}
                    className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                    title="닫기"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* App Breakdown Chips */}
                {selectedAppBreakdown.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {selectedAppBreakdown.map((app) => (
                      <span
                        key={app.isIdle ? "idle" : app.processName}
                        className="group inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] py-0.5 pl-1 pr-2 text-[10.5px] text-zinc-300"
                      >
                        <AppBadgeIcon processName={app.processName} isIdle={app.isIdle} size="xs" />
                        <span>{app.isIdle ? "유휴" : cleanProcessLabel(app.processName)}</span>
                        <span className="font-mono text-[10px] tabular-nums text-zinc-500">
                          {formatDurationShort(app.durationMs)}
                        </span>
                        {!app.isIdle && (
                          <button
                            type="button"
                            title={`${cleanProcessLabel(app.processName)} 수집 제외 (타임라인에서 숨김)`}
                            onClick={() => {
                              setSelectedLogIds((prev) =>
                                prev.filter((id) => {
                                  const match = clampedActivities.find((item) => item.log.id === id);
                                  return (
                                    !match ||
                                    match.log.isIdle ||
                                    !processNameMatches(app.processName, match.log.processName)
                                  );
                                }),
                              );
                              void onExcludeProcess(app.processName);
                            }}
                            className="-mr-0.5 rounded-full p-0.5 text-zinc-500 transition-colors hover:bg-rose-500/20 hover:text-rose-300"
                          >
                            <EyeOff className="h-2.5 w-2.5" />
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                )}

                {/* Quick-Pick Window Suggestions */}
                {selectedWindowBreakdown.length > 0 && (
                  <div className="max-h-28 space-y-0.5 overflow-y-auto rounded-lg bg-black/25 p-1.5">
                    {selectedWindowBreakdown.map((win) => (
                      <button
                        key={`${win.processName}-${win.title}`}
                        type="button"
                        onClick={() => setDraftDesc(win.title)}
                        className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left text-[11px] text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                      >
                        <span className="flex min-w-0 items-center gap-1.5">
                          <AppBadgeIcon processName={win.processName} size="xs" />
                          <span className="truncate">{win.title}</span>
                        </span>
                        <span className="shrink-0 font-mono text-[9.5px] tabular-nums text-zinc-500">
                          {formatDurationShort(win.durationMs)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {/* Form Fields */}
                <div className="space-y-2.5">
                  <input
                    type="text"
                    value={draftDesc}
                    onChange={(e) => setDraftDesc(e.target.value)}
                    placeholder="작업 제목"
                    className="h-9 w-full rounded-lg border border-white/[0.09] bg-zinc-950/90 px-3 text-xs font-medium text-zinc-100 placeholder:font-normal placeholder:text-zinc-500 focus:border-indigo-500/70 focus:outline-none"
                  />

                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="time"
                      value={draftStartHm}
                      onChange={(e) => setDraftStartHm(e.target.value)}
                      className="h-8 w-full rounded-lg border border-white/[0.08] bg-zinc-950/90 px-2.5 font-mono text-xs text-zinc-100 focus:border-indigo-500/70 focus:outline-none"
                    />
                    <input
                      type="time"
                      value={draftEndHm}
                      onChange={(e) => setDraftEndHm(e.target.value)}
                      className="h-8 w-full rounded-lg border border-white/[0.08] bg-zinc-950/90 px-2.5 font-mono text-xs text-zinc-100 focus:border-indigo-500/70 focus:outline-none"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
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
                    <div className="flex flex-wrap gap-1">
                      {draftTagIds.map((tid) => {
                        const tag = tagMap.get(tid);
                        if (!tag) return null;
                        return (
                          <span
                            key={tag.id}
                            className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-zinc-300"
                          >
                            #{tag.name}
                          </span>
                        );
                      })}
                    </div>
                  )}

                  <div className="relative flex items-center">
                    <CheckSquare className="pointer-events-none absolute left-2.5 h-3.5 w-3.5 text-indigo-400/80" />
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
                      className="h-8 w-full rounded-lg border border-white/[0.08] bg-zinc-950/90 pl-8 pr-2.5 text-xs text-zinc-200 focus:border-indigo-500/70 focus:outline-none"
                    >
                      <option value="">TickTick 태스크 없음</option>
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
                  </div>

                  {draftTaskId && (
                    <label className="flex cursor-pointer items-center gap-2 pt-0.5 text-xs text-zinc-300">
                      <input
                        type="checkbox"
                        checked={draftCompleteParent}
                        onChange={(e) => setDraftCompleteParent(e.target.checked)}
                        className="rounded border-zinc-600 bg-zinc-900 accent-indigo-500"
                      />
                      <span>원 태스크 완료</span>
                    </label>
                  )}

                  {draftError && <p className="text-xs text-rose-400">{draftError}</p>}

                  <div className="grid grid-cols-2 gap-2 pt-1">
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void handleConvertSelection(false)}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-indigo-500 px-3 text-xs font-semibold text-white transition-colors hover:bg-indigo-400 disabled:opacity-50"
                    >
                      <Check className="h-3.5 w-3.5" />
                      저장
                    </button>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void handleConvertSelection(true)}
                      className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-emerald-500/15 px-3 text-xs font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/30 transition-colors hover:bg-emerald-500/25 disabled:opacity-50"
                    >
                      <CloudUpload className="h-3.5 w-3.5" />
                      TickTick
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : inspectedEntry ? (
            <div className="sticky top-0 overflow-hidden rounded-xl border border-white/[0.1] bg-[#121218] shadow-2xl">
              <div
                className="h-[2px] w-full"
                style={{
                  backgroundColor:
                    inspectedEntry.endedAt === null
                      ? "#f43f5e"
                      : inspectedProject?.color ?? "#6366f1",
                }}
              />
              <div className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-xs tabular-nums text-zinc-400">
                      {formatTimeHm(inspectedEntry.startedAt)} –{" "}
                      {inspectedEntry.endedAt !== null ? formatTimeHm(inspectedEntry.endedAt) : "지금"}
                    </div>
                    <div className="mt-0.5 font-mono text-lg font-semibold tabular-nums text-zinc-100">
                      {formatDurationHms(
                        Math.max(0, (inspectedEntry.endedAt ?? nowMs) - inspectedEntry.startedAt),
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setInspectedEntryId(null)}
                    className="rounded-lg p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <input
                  type="text"
                  value={entryEditDesc}
                  onChange={(e) => setEntryEditDesc(e.target.value)}
                  className="h-9 w-full rounded-lg border border-white/[0.09] bg-zinc-950/90 px-3 text-xs font-medium text-zinc-100 focus:border-indigo-500/70 focus:outline-none"
                />

                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="time"
                    value={entryEditStartHm}
                    onChange={(e) => setEntryEditStartHm(e.target.value)}
                    className="h-8 rounded-lg border border-white/[0.08] bg-zinc-950/90 px-2.5 font-mono text-xs text-zinc-100 focus:border-indigo-500/70 focus:outline-none"
                  />
                  {inspectedEntry.endedAt !== null ? (
                    <input
                      type="time"
                      value={entryEditEndHm}
                      onChange={(e) => setEntryEditEndHm(e.target.value)}
                      className="h-8 rounded-lg border border-white/[0.08] bg-zinc-950/90 px-2.5 font-mono text-xs text-zinc-100 focus:border-indigo-500/70 focus:outline-none"
                    />
                  ) : (
                    <span className="flex h-8 items-center justify-center gap-1.5 rounded-lg bg-rose-500/15 text-xs font-medium text-rose-300">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" />
                      진행 중
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
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

                <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] pt-3">
                  <button
                    type="button"
                    onClick={async () => {
                      await onDeleteEntry(inspectedEntry.id);
                      setInspectedEntryId(null);
                    }}
                    title="삭제"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-rose-500/15 hover:text-rose-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                  <div className="flex items-center gap-1.5">
                    {inspectedEntry.endedAt !== null && inspectedEntry.syncStatus !== "synced" && (
                      <button
                        type="button"
                        onClick={() => void onRequestTickTickSync(inspectedEntry)}
                        className="inline-flex h-8 items-center gap-1 rounded-lg bg-emerald-500/15 px-2.5 text-xs font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/25 transition-colors hover:bg-emerald-500/25"
                      >
                        <CloudUpload className="h-3.5 w-3.5" />
                        TickTick
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleSaveInspectedEntry()}
                      className="inline-flex h-8 items-center gap-1 rounded-lg bg-indigo-500 px-3 text-xs font-medium text-white transition-colors hover:bg-indigo-400"
                    >
                      <Check className="h-3.5 w-3.5" />
                      저장
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            /* Default Visual Day Overview (data & proportions instead of tutorial prose) */
            <div className="space-y-4">
              {/* Active vs Tracked Ratio Card */}
              <div className="space-y-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
                      <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                      <span>활동</span>
                    </div>
                    <div className="mt-1 font-mono text-lg font-semibold tracking-tight tabular-nums text-zinc-100">
                      {formatDurationHms(summary.activeMs)}
                    </div>
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
                      <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" />
                      <span>기록</span>
                    </div>
                    <div className="mt-1 font-mono text-lg font-semibold tracking-tight tabular-nums text-indigo-300">
                      {formatDurationHms(summary.trackedMs)}
                    </div>
                  </div>
                </div>

                {/* Visual Coverage Meter */}
                <div className="space-y-1.5">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-sky-400 transition-all duration-300"
                      style={{ width: `${summary.trackedRatio}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between font-mono text-[10px] tabular-nums text-zinc-500">
                    <span>
                      {summary.idleMs > 0 ? `유휴 ${formatDurationShort(summary.idleMs)}` : ""}
                      {minDurationMs > 0
                        ? `${summary.idleMs > 0 ? " · " : ""}≥${Math.round(minDurationMs / 1000)}s`
                        : ""}
                    </span>
                    <span className="text-zinc-400">{summary.trackedRatio}%</span>
                  </div>
                </div>

                {/* Live Active Window Indicator */}
                {isToday &&
                  status?.activeWindow &&
                  !matchesAnyProcess(excludedProcesses, status.activeWindow.processName) && (
                    <div className="flex items-center gap-2 border-t border-white/[0.06] pt-3">
                      <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />
                      <AppBadgeIcon processName={status.activeWindow.processName} size="xs" />
                      <span className="truncate font-mono text-[11px] text-zinc-300">
                        {cleanProcessLabel(status.activeWindow.processName)}
                      </span>
                    </div>
                  )}
              </div>

              {/* Top Apps Proportional Visual Bars */}
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
                <div className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
                  앱 분포
                </div>

                {summary.topApps.length === 0 ? (
                  <div className="py-8 text-center text-xs text-zinc-600">활동 없음</div>
                ) : (
                  <div className="mt-3 space-y-3">
                    {summary.topApps.map((app) => {
                      const style = getProcessColor(app.processName);
                      const pct = Math.max(5, Math.round((app.durationMs / maxTopAppMs) * 100));
                      const label = cleanProcessLabel(app.processName);
                      return (
                        <div key={app.processName} className="group space-y-1">
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="flex min-w-0 items-center gap-2 text-zinc-200">
                              <AppBadgeIcon processName={app.processName} size="xs" />
                              <span className="truncate font-medium" title={app.processName}>
                                {label}
                              </span>
                            </span>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => void onExcludeProcess(app.processName)}
                                title={`${label} 수집 제외 (타임라인에서 숨김)`}
                                aria-label={`${label} 수집 제외`}
                                className="rounded p-0.5 text-zinc-500 opacity-0 transition-all hover:bg-rose-500/15 hover:text-rose-300 focus-visible:opacity-100 group-hover:opacity-100"
                              >
                                <EyeOff className="h-3 w-3" />
                              </button>
                              <span className="font-mono text-[11px] tabular-nums text-zinc-400">
                                {formatDurationShort(app.durationMs)}
                              </span>
                            </div>
                          </div>
                          <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.05]">
                            <div
                              className="h-full rounded-full opacity-85 transition-all duration-300"
                              style={{ width: `${pct}%`, backgroundColor: style.hex }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
