import { Coffee } from "lucide-react";
import { formatDurationShort, formatTimeHms, getProcessColor } from "../lib/time";
import type { TimelineBlock } from "../lib/timelineLayout";
import { AppBadgeIcon, AppIconStack } from "./AppBadgeIcon";

interface ActivityHoverPopoverProps {
  block: TimelineBlock;
  /** Vertical center of the hovered block relative to the visible timeline panel (px). */
  anchorTopPx: number;
  /** Viewport height of the scrollable timeline body (px), used to avoid clipping. */
  viewportHeightPx: number;
}

export function ActivityHoverPopover({
  block,
  anchorTopPx,
  viewportHeightPx,
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

  const estimatedHeight =
    block.kind === "idle"
      ? 68
      : Math.min(360, 72 + visibleApps.length * 26 + totalWindowRows * 16);

  const clampedTop = Math.max(
    8,
    Math.min(anchorTopPx - 16, Math.max(8, viewportHeightPx - estimatedHeight - 12)),
  );

  return (
    <div
      style={{ top: `${clampedTop}px` }}
      className="pointer-events-none absolute left-[calc(50%+28px)] z-40 ml-2 max-h-[calc(100%-16px)] w-[300px] max-w-[calc(50%-40px)] overflow-hidden rounded-xl border border-white/[0.1] bg-[#121218]/98 p-3 shadow-2xl shadow-black/80 backdrop-blur-xl"
    >
      {/* Header */}
      <div
        className={`flex items-start justify-between gap-2 ${
          block.kind !== "idle" ? "border-b border-white/[0.06] pb-2" : ""
        }`}
      >
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
                ? "유휴"
                : block.kind === "cluster"
                  ? `${block.apps.length}개 앱`
                  : block.dominantApp?.label ?? "활동"}
            </div>
            <div className="font-mono text-[10px] tabular-nums text-zinc-500">
              {formatTimeHms(block.startMs)} – {formatTimeHms(block.endMs)}
            </div>
          </div>
        </div>

        <span className="shrink-0 rounded-md bg-white/[0.07] px-1.5 py-0.5 font-mono text-[11px] font-semibold tabular-nums text-zinc-100">
          {formatDurationShort(block.endMs - block.startMs)}
        </span>
      </div>

      {/* App & Window Breakdown */}
      {block.kind !== "idle" && (
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
                  </span>
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-300">
                    {formatDurationShort(app.durationMs)}
                    {block.apps.length > 1 && (
                      <span className="ml-1 text-zinc-500">{Math.round(app.share * 100)}%</span>
                    )}
                  </span>
                </div>

                {block.apps.length > 1 && (
                  <div className="h-1 w-full overflow-hidden rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${pct}%`, backgroundColor: style.hex }}
                    />
                  </div>
                )}

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
                      <span className="shrink-0 font-mono text-[9px] tabular-nums text-zinc-500">
                        {formatDurationShort(win.durationMs)}
                      </span>
                    </div>
                  ))}
                  {hiddenWindows > 0 && (
                    <div className="font-mono text-[9px] text-zinc-500">+{hiddenWindows}</div>
                  )}
                </div>
              </div>
            );
          })}

          {hiddenAppCount > 0 && (
            <div className="font-mono text-[10px] text-zinc-500">+{hiddenAppCount}</div>
          )}
        </div>
      )}
    </div>
  );
}
