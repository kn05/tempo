import { GripHorizontal, Maximize2, Pin, PinOff, Play, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { matchProjectByHint, matchTagByName, parseQuickEntry } from "../lib/quickEntry";
import {
  closeMiniTimer,
  focusMainWindow,
  getRunningTimer,
  getSettings,
  listTags,
  listTickTickProjects,
  onEntriesChanged,
  onTimerChanged,
  setMiniTimerAlwaysOnTop,
  startTimer,
  stopTimer,
  updateTimeEntry,
  upsertTag,
} from "../lib/tauri";
import { formatDurationHms } from "../lib/time";
import type { Tag, TickTickProject, TimeEntry } from "../types";

export function MiniTimer() {
  const [runningEntry, setRunningEntry] = useState<TimeEntry | null>(null);
  const [projects, setProjects] = useState<TickTickProject[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [description, setDescription] = useState("");
  const [alwaysOnTop, setAlwaysOnTop] = useState(true);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const lastRunningIdRef = useRef<string | null>(null);

  const loadState = useCallback(async () => {
    const [running, loadedProjects, loadedTags, loadedSettings] = await Promise.all([
      getRunningTimer(),
      listTickTickProjects(false),
      listTags(),
      getSettings(),
    ]);
    setRunningEntry(running);
    setProjects(loadedProjects);
    setTags(loadedTags);
    setAlwaysOnTop(loadedSettings.miniTimerAlwaysOnTop);
  }, []);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (runningEntry) {
      const switched = lastRunningIdRef.current !== runningEntry.id;
      lastRunningIdRef.current = runningEntry.id;
      if (switched || document.activeElement !== inputRef.current) {
        setDescription(runningEntry.description);
      }
    } else if (lastRunningIdRef.current !== null) {
      lastRunningIdRef.current = null;
      setDescription("");
    }
  }, [runningEntry]);

  useEffect(() => {
    if (!runningEntry) return;
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [runningEntry]);

  useEffect(() => {
    let disposed = false;
    let unlistenTimer: (() => void) | undefined;
    let unlistenEntries: (() => void) | undefined;

    void onTimerChanged((nextRunning) => {
      if (!disposed) {
        setRunningEntry(nextRunning);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlistenTimer = fn;
    });

    void onEntriesChanged(() => {
      if (!disposed) {
        void loadState();
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlistenEntries = fn;
    });

    return () => {
      disposed = true;
      unlistenTimer?.();
      unlistenEntries?.();
    };
  }, [loadState]);

  const currentProject = useMemo(() => {
    if (!runningEntry?.ticktickProjectId) return null;
    return projects.find((p) => p.id === runningEntry.ticktickProjectId) ?? null;
  }, [projects, runningEntry]);

  const elapsedMs = runningEntry ? nowMs - runningEntry.startedAt : 0;

  async function commitRunningDescription() {
    if (!runningEntry) return;
    const trimmed = description.trim();
    if (trimmed !== runningEntry.description) {
      await updateTimeEntry(runningEntry.id, { description: trimmed || "(Untitled)" });
    }
  }

  async function handleStartOrStop() {
    if (busy) return;
    setBusy(true);
    try {
      if (runningEntry) {
        await commitRunningDescription();
        await stopTimer();
      } else {
        const parsed = parseQuickEntry(description);
        const matchedProject = matchProjectByHint(parsed.projectHint, projects);
        const tagIds: string[] = [];
        for (const name of parsed.tagNames) {
          const existing = matchTagByName(name, tags);
          if (existing) {
            tagIds.push(existing.id);
          } else {
            const created = await upsertTag(name, "local", null);
            tagIds.push(created.id);
          }
        }
        await startTimer({
          description: parsed.description.trim() || "(Quick Timer)",
          ticktickProjectId: matchedProject?.id ?? null,
          ticktickParentTaskId: null,
          tagIds,
        });
      }
      await loadState();
    } finally {
      setBusy(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (runningEntry) {
      await commitRunningDescription();
      inputRef.current?.blur();
    } else {
      await handleStartOrStop();
    }
  }

  async function handleTogglePin() {
    const next = await setMiniTimerAlwaysOnTop(!alwaysOnTop);
    setAlwaysOnTop(next);
  }

  return (
    <div
      className={`relative flex h-screen w-screen flex-col justify-between overflow-hidden rounded-xl border bg-[#0d0d11]/98 text-zinc-100 shadow-2xl select-none ${
        runningEntry ? "border-rose-500/30" : "border-white/[0.1]"
      }`}
    >
      {runningEntry && (
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-rose-500 via-rose-400/60 to-transparent" />
      )}

      {/* Compact Frameless Drag Bar */}
      <div
        data-tauri-drag-region
        className="flex h-7 items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-2.5"
      >
        <div
          data-tauri-drag-region
          className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-zinc-400"
        >
          <GripHorizontal className="pointer-events-none h-3 w-3 text-zinc-600" />
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              runningEntry
                ? "animate-pulse bg-rose-500 shadow-[0_0_6px_rgba(244,63,94,0.9)]"
                : "bg-zinc-600"
            }`}
          />
          <span data-tauri-drag-region className="font-semibold tracking-tight text-zinc-200">
            tempo
          </span>
          {currentProject && (
            <span className="inline-flex items-center gap-1 truncate rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-zinc-300">
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: currentProject.color ?? "#6366f1" }}
              />
              <span className="max-w-[90px] truncate">{currentProject.name}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => void handleTogglePin()}
            title={alwaysOnTop ? "항상 위 해제" : "항상 위 고정"}
            className={`rounded p-1 transition-colors ${
              alwaysOnTop
                ? "text-indigo-400 hover:bg-indigo-500/15"
                : "text-zinc-500 hover:bg-white/[0.06] hover:text-zinc-200"
            }`}
          >
            {alwaysOnTop ? <Pin className="h-3 w-3" /> : <PinOff className="h-3 w-3" />}
          </button>
          <button
            type="button"
            onClick={() => void focusMainWindow()}
            title="메인 창"
            className="rounded p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
          >
            <Maximize2 className="h-3 w-3" />
          </button>
          <button
            type="button"
            onClick={() => void closeMiniTimer()}
            title="닫기"
            className="rounded p-1 text-zinc-500 transition-colors hover:bg-rose-500/20 hover:text-rose-300"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Main Compact Controls */}
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="flex flex-1 items-center gap-2.5 px-3 py-2"
      >
        <input
          ref={inputRef}
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => {
            if (runningEntry) void commitRunningDescription();
          }}
          placeholder="작업 입력..."
          className="h-8 min-w-0 flex-1 bg-transparent text-[13px] font-medium text-zinc-100 placeholder:font-normal placeholder:text-zinc-500 focus:outline-none"
        />

        <span
          className={`w-[70px] shrink-0 text-right font-mono text-[15px] font-semibold tabular-nums ${
            runningEntry ? "text-rose-300" : "text-zinc-400"
          }`}
        >
          {formatDurationHms(elapsedMs)}
        </span>

        <button
          type="button"
          disabled={busy}
          onClick={() => void handleStartOrStop()}
          aria-label={runningEntry ? "Stop timer" : "Start timer"}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white shadow transition disabled:opacity-50 ${
            runningEntry
              ? "bg-rose-500 shadow-rose-500/25 hover:bg-rose-400"
              : "bg-indigo-500 shadow-indigo-500/20 hover:bg-indigo-400"
          }`}
        >
          {runningEntry ? (
            <Square className="h-3 w-3 fill-current" />
          ) : (
            <Play className="ml-0.5 h-3 w-3 fill-current" />
          )}
        </button>
      </form>
    </div>
  );
}
