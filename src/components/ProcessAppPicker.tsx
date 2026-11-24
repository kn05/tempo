import { Check, History, Plus, RefreshCw, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  cleanProcessLabel,
  dedupeProcessList,
  formatDurationShort,
  matchesAnyProcess,
  processNameMatches,
} from "../lib/time";
import type { DiscoverableApp } from "../types";
import { AppBadgeIcon } from "./AppBadgeIcon";

interface ProcessAppPickerProps {
  label: string;
  description?: string;
  values: string[];
  discoverableApps: DiscoverableApp[];
  loadingApps?: boolean;
  accentTone?: "rose" | "amber";
  emptyHint?: string;
  onChange: (next: string[]) => void;
  onRefreshApps?: () => void;
}

export function ProcessAppPicker({
  label,
  description,
  values,
  discoverableApps,
  loadingApps = false,
  accentTone = "rose",
  emptyHint = "선택된 앱 없음",
  onChange,
  onRefreshApps,
}: ProcessAppPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const onRefreshAppsRef = useRef(onRefreshApps);
  onRefreshAppsRef.current = onRefreshApps;

  useEffect(() => {
    if (!open) return;
    onRefreshAppsRef.current?.();
    inputRef.current?.focus();

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const trimmedQuery = query.trim();

  const { runningMatches, recentMatches } = useMemo(() => {
    const q = trimmedQuery.toLowerCase();
    const matchesQuery = (app: DiscoverableApp) => {
      if (!q) return true;
      const procLower = app.processName.toLowerCase();
      const labelLower = cleanProcessLabel(app.processName).toLowerCase();
      const titleLower = (app.windowTitle ?? "").toLowerCase();
      return procLower.includes(q) || labelLower.includes(q) || titleLower.includes(q);
    };

    const running: DiscoverableApp[] = [];
    const recent: DiscoverableApp[] = [];
    for (const app of discoverableApps) {
      if (!matchesQuery(app)) continue;
      if (app.isRunning) running.push(app);
      else recent.push(app);
    }
    return { runningMatches: running, recentMatches: recent };
  }, [discoverableApps, trimmedQuery]);

  const exactCandidate = useMemo(() => {
    if (!trimmedQuery) return null;
    return discoverableApps.find((app) => processNameMatches(trimmedQuery, app.processName)) ?? null;
  }, [discoverableApps, trimmedQuery]);

  const canAddManual =
    trimmedQuery.length > 0 &&
    !exactCandidate &&
    !matchesAnyProcess(values, trimmedQuery);

  function toggleProcess(processName: string) {
    if (matchesAnyProcess(values, processName)) {
      onChange(values.filter((v) => !processNameMatches(v, processName)));
    } else {
      onChange(dedupeProcessList([...values, processName]));
    }
  }

  function removeProcess(processName: string) {
    onChange(values.filter((v) => !processNameMatches(v, processName)));
  }

  function addManual(raw: string) {
    const clean = raw.trim();
    if (!clean) return;
    if (matchesAnyProcess(values, clean)) {
      setQuery("");
      return;
    }
    onChange(dedupeProcessList([...values, clean]));
    setQuery("");
  }

  const chipToneClass =
    accentTone === "rose"
      ? "border-rose-500/25 bg-rose-500/10 text-rose-100"
      : "border-amber-500/25 bg-amber-500/10 text-amber-100";

  const selectedRowClass =
    accentTone === "rose"
      ? "bg-rose-500/12 text-rose-100"
      : "bg-amber-500/12 text-amber-100";

  const checkToneClass =
    accentTone === "rose"
      ? "border-rose-400 bg-rose-500 text-white"
      : "border-amber-400 bg-amber-500 text-zinc-950";

  function renderAppRow(app: DiscoverableApp) {
    const selected = matchesAnyProcess(values, app.processName);
    const displayLabel = cleanProcessLabel(app.processName);
    const hasExeSuffix = app.processName.toLowerCase().endsWith(".exe");

    return (
      <button
        key={app.processName}
        type="button"
        onClick={() => toggleProcess(app.processName)}
        className={`flex w-full items-center justify-between gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${
          selected ? selectedRowClass : "text-zinc-200 hover:bg-white/[0.05]"
        }`}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <AppBadgeIcon processName={app.processName} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-xs font-medium text-zinc-100">{displayLabel}</span>
              {hasExeSuffix && (
                <span className="shrink-0 rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[9.5px] leading-none text-zinc-400">
                  {app.processName}
                </span>
              )}
            </div>
            {app.windowTitle && (
              <div className="mt-0.5 truncate text-[10.5px] text-zinc-500">{app.windowTitle}</div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!app.isRunning && app.totalDurationMs > 0 && (
            <span className="font-mono text-[10px] tabular-nums text-zinc-500">
              {formatDurationShort(app.totalDurationMs)}
            </span>
          )}
          <span
            className={`flex h-4 w-4 items-center justify-center rounded border transition-colors ${
              selected ? checkToneClass : "border-zinc-700 bg-zinc-950"
            }`}
          >
            {selected && <Check className="h-2.5 w-2.5" strokeWidth={3} />}
          </span>
        </div>
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-medium text-zinc-400">{label}</span>
        {values.length > 0 && (
          <span className="font-mono text-[10px] tabular-nums text-zinc-500">
            {values.length}개
          </span>
        )}
      </div>

      {description && <p className="text-[11px] leading-relaxed text-zinc-500">{description}</p>}

      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-white/[0.08] bg-black/30 p-2">
        {values.map((proc) => {
          const baseName = cleanProcessLabel(proc);
          const hasExe = proc.toLowerCase().endsWith(".exe");
          return (
            <span
              key={proc}
              title={proc}
              className={`inline-flex items-center gap-1.5 rounded-md border py-0.5 pl-1.5 pr-1 text-xs ${chipToneClass}`}
            >
              <AppBadgeIcon processName={proc} size="xs" />
              <span className="font-medium leading-none">{baseName}</span>
              {hasExe && (
                <span className="font-mono text-[10px] leading-none text-zinc-400/80">.exe</span>
              )}
              <button
                type="button"
                onClick={() => removeProcess(proc)}
                title={`${proc} 제거`}
                className="ml-0.5 rounded p-0.5 text-zinc-400 transition-colors hover:bg-white/[0.1] hover:text-zinc-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors ${
            open
              ? "bg-indigo-500/20 text-indigo-200 ring-1 ring-inset ring-indigo-500/40"
              : "bg-white/[0.06] text-zinc-300 hover:bg-white/[0.11] hover:text-zinc-100"
          }`}
        >
          <Plus className="h-3 w-3" />
          <span>앱 찾기</span>
        </button>

        {values.length === 0 && !open && (
          <span className="px-1 text-[11px] text-zinc-600">{emptyHint}</span>
        )}
      </div>

      {open && (
        <div className="absolute left-0 right-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl border border-white/[0.1] bg-[#14141a]/98 shadow-2xl shadow-black/80 backdrop-blur-xl">
          {/* Search & Rescan Header */}
          <div className="flex items-center gap-2 border-b border-white/[0.07] px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (exactCandidate) {
                    toggleProcess(exactCandidate.processName);
                    setQuery("");
                  } else if (canAddManual) {
                    addManual(trimmedQuery);
                  } else if (runningMatches.length + recentMatches.length === 1) {
                    const only = runningMatches[0] ?? recentMatches[0];
                    if (only) {
                      toggleProcess(only.processName);
                      setQuery("");
                    }
                  }
                }
              }}
              placeholder="실행 중인 앱 검색 또는 직접 입력 (예: Discord)..."
              className="w-full bg-transparent text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="rounded p-0.5 text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-3 w-3" />
              </button>
            )}
            {onRefreshApps && (
              <button
                type="button"
                onClick={() => onRefreshApps()}
                disabled={loadingApps}
                title="실행 중인 앱 다시 스캔"
                className="rounded p-1 text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loadingApps ? "animate-spin" : ""}`} />
              </button>
            )}
          </div>

          <div className="max-h-72 overflow-y-auto p-1.5">
            {canAddManual && (
              <button
                type="button"
                onClick={() => addManual(trimmedQuery)}
                className="mb-1.5 flex w-full items-center justify-between gap-2 rounded-lg bg-indigo-500/15 px-2.5 py-2 text-left text-xs font-medium text-indigo-200 transition-colors hover:bg-indigo-500/25"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Plus className="h-3.5 w-3.5 shrink-0 text-indigo-300" />
                  <span className="truncate font-mono">{trimmedQuery}</span>
                  <span className="text-[11px] font-normal text-indigo-300/80">직접 추가</span>
                </span>
                <span className="shrink-0 font-mono text-[10px] text-indigo-300/70">Enter</span>
              </button>
            )}

            {runningMatches.length > 0 && (
              <div className="space-y-0.5">
                <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span>현재 실행 중 ({runningMatches.length})</span>
                </div>
                {runningMatches.map(renderAppRow)}
              </div>
            )}

            {recentMatches.length > 0 && (
              <div className={`space-y-0.5 ${runningMatches.length > 0 ? "mt-2 border-t border-white/[0.06] pt-2" : ""}`}>
                <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  <History className="h-3 w-3 text-zinc-500" />
                  <span>최근 타임라인 기록 ({recentMatches.length})</span>
                </div>
                {recentMatches.map(renderAppRow)}
              </div>
            )}

            {runningMatches.length === 0 && recentMatches.length === 0 && !canAddManual && (
              <div className="px-3 py-6 text-center text-xs text-zinc-500">
                {loadingApps ? "실행 중인 앱을 스캔하는 중..." : "검색된 앱이 없습니다. 이름을 직접 입력해 Enter로 추가할 수 있습니다."}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
