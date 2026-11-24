import { Coffee, Layers, ZoomIn } from "lucide-react";
import { formatDurationShort, formatTimeHm, formatTimeHms, getProcessColor } from "../lib/time";
import type { TimelineBlock } from "../lib/timelineLayout";
import { AppBadgeIcon, AppIconStack } from "./AppBadgeIcon";

interface ActivityHoverPopoverProps {
  block: TimelineBlock;
  /** Vertical center of the hovered block relative to the visible timeline panel (px). */
  anchorTopPx: number;
  /** Viewport height of the scrollable timeline body (px), used to avoid clipping. */
  viewportHeightPx: number;
  nextZoomLabel: string | null;
}

export function ActivityHoverPopover({
  block,
  anchorTopPx,
  viewportHeightPx,
  nextZoomLabel,
}: ActivityHoverPopoverProps) {
  const visibleApps = block.apps.slice(0, 6);
  const hiddenAppCount = Math.max(0, block.apps.length - visibleApps.length);
  const maxWindowsPerApp = block.kind === "single" ? 5 : 2;

  const totalWindowRows = visibleApps.reduce(
    (acc, app) =>
      acc +
      Math.min(app.windows.length, maxWindowsPerApp) +
      (app.windows.length > maxWindowsPerApp ? 1 : 0),
    0,
  );
  // Position popover cleanly near the hovered block without overflowing top or bottom of the grid.
  const estimatedHeight =
    block.kind === "idle"
      ? 110
      : Math.min(400, 108 + visibleApps.length * 28 + totalWindowRows * 16);
  const clampedTop = Math.max(
    8,
    Math.min(anchorTopPx - 16, Math.max(8, viewportHeightPx - estimatedHeight - 12)),
  );

  return (
    <div
      style={{ top: `${clampedTop}px` }}
      className="pointer-events-none absolute left-[calc(50%+28px)] z-40 ml-2 max-h-[calc(100%-16px)] w-[310px] max-w-[calc(50%-40px)] overflow-hidden rounded-xl border border-zinc-700/90 bg-zinc-950/95 p-3 shadow-2xl shadow-black/70 backdrop-blur-md"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-zinc-800/80 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          {block.kind === "idle" ? (
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-amber-500/20 text-amber-300">
              <Coffee className="h-3 w-3" />
            </span>
          ) : block.kind === "cluster" ? (
            <AppIconStack apps={block.apps} maxIcons={3} size="sm" />
          ) : block.dominantApp ? (
            <AppBadgeIcon processName={block.dominantApp.processName} size="md" />
          ) : null}

          <div className="min-w-0">
            <div className="truncate text-xs font-semibold text-zinc-100">
              {block.kind === "idle"
                ? "유휴 구간 (Idle)"
                : block.kind === "cluster"
                  ? `멀티 앱 활동 · ${block.apps.length}개 앱`
                  : block.dominantApp?.label ?? "활동"}
            </div>
            <div className="font-mono text-[10px] text-zinc-400">
              {formatTimeHms(block.startMs)} – {formatTimeHms(block.endMs)}
            </div>
          </div>
        </div>

        <span className="shrink-0 rounded-md bg-zinc-800/90 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-zinc-100">
          {formatDurationShort(block.endMs - block.startMs)}
        </span>
      </div>

      {/* Body: App & Window Title Breakdown */}
      {block.kind === "idle" ? (
        <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
          {formatTimeHm(block.startMs)}부터 {formatTimeHm(block.endMs)}까지 키보드·마우스 입력이
          감지되지 않았습니다.
        </p>
      ) : (
        <div className="mt-2.5 space-y-2.5">
          {visibleApps.map((app) => {
            const style = getProcessColor(app.processName);
            const pct = Math.max(4, Math.round(app.share * 100));
            const topWindows = app.windows.slice(0, maxWindowsPerApp);
            const hiddenWindows = Math.max(0, app.windows.length - topWindows.length);

            return (
              <div key={app.processKey} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="flex min-w-0 items-center gap-1.5 font-medium text-zinc-200">
                    <AppBadgeIcon processName={app.processName} size="xs" />
                    <span className="truncate">{app.label}</span>
                    {app.windows.length > 1 && (
                      <span className="shrink-0 rounded bg-zinc-800/90 px-1 text-[9px] text-zinc-400">
                        {app.windows.length}창
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-zinc-300">
                    {formatDurationShort(app.durationMs)}
                    {block.apps.length > 1 && (
                      <span className="ml-1 text-zinc-500">{Math.round(app.share * 100)}%</span>
                    )}
                  </span>
                </div>

                {/* Proportional bar */}
                {block.apps.length > 1 && (
                  <div className="h-1 w-full overflow-hidden rounded-full bg-zinc-800/90">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, backgroundColor: style.hex }}
                    />
                  </div>
                )}

                {/* Per-window title breakdown */}
                <div className="space-y-0.5 pl-5">
                  {topWindows.map((win) => (
                    <div
                      key={win.title}
                      className="flex items-center justify-between gap-2 text-[10px] text-zinc-400"
                    >
                      <span className="flex min-w-0 items-center gap-1">
                        {win.workspace && (
                          <span className="shrink-0 rounded bg-indigo-500/15 px-1 font-mono text-[9px] text-indigo-300">
                            {win.workspace}
                            {win.branch ? `:${win.branch}` : ""}
                          </span>
                        )}
                        <span className="truncate">{win.title}</span>
                      </span>
                      <span className="shrink-0 font-mono text-[9px] text-zinc-500">
                        {formatDurationShort(win.durationMs)}
                      </span>
                    </div>
                  ))}
                  {hiddenWindows > 0 && (
                    <div className="text-[9px] text-zinc-500">외 {hiddenWindows}개 창 제목 더 있음</div>
                  )}
                </div>
              </div>
            );
          })}

          {hiddenAppCount > 0 && (
            <div className="text-[10px] text-zinc-500">외 {hiddenAppCount}개 앱 더 있음</div>
          )}
        </div>
      )}

      {/* Footer Hint */}
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-zinc-800/80 pt-2 text-[10px] text-zinc-500">
        {block.kind === "cluster" && nextZoomLabel ? (
          <span className="inline-flex items-center gap-1 text-sky-400/90">
            <ZoomIn className="h-3 w-3" />
            {nextZoomLabel}로 줌인하면 개별 블록 확장
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <Layers className="h-3 w-3" />
            원본 로그 {block.logs.length}건 병합됨
          </span>
        )}
        <span className="shrink-0 text-zinc-400">클릭해 선택</span>
      </div>
    </div>
  );
}
