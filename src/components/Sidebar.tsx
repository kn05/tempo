import {
  CalendarRange,
  CheckSquare,
  Clock,
  PictureInPicture2,
  Settings,
} from "lucide-react";
import type { NavTab, TickTickConnectionStatus } from "../types";

interface SidebarProps {
  activeTab: NavTab;
  onSelect: (tab: NavTab) => void;
  onToggleMiniTimer: () => void;
  ticktickStatus?: TickTickConnectionStatus | null;
}

const NAV_ITEMS: { id: NavTab; label: string; icon: typeof Clock }[] = [
  { id: "timer", label: "Timer", icon: Clock },
  { id: "timeline", label: "Timeline", icon: CalendarRange },
  { id: "ticktick", label: "TickTick", icon: CheckSquare },
  { id: "settings", label: "Settings", icon: Settings },
];

export function Sidebar({
  activeTab,
  onSelect,
  onToggleMiniTimer,
  ticktickStatus,
}: SidebarProps) {
  const pendingCount = ticktickStatus?.queue.pendingCount ?? 0;
  const failedCount = ticktickStatus?.queue.failedCount ?? 0;
  const unsyncedCount = pendingCount + failedCount;

  return (
    <aside className="flex w-48 shrink-0 flex-col border-r border-white/[0.06] bg-[#0c0c0f]">
      {/* Brand header aligned with TimerBar height */}
      <div className="flex h-14 items-center gap-2.5 border-b border-white/[0.06] px-4">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-indigo-400 to-indigo-600 text-xs font-bold text-white shadow-sm shadow-indigo-500/25">
          t
        </div>
        <span className="text-[15px] font-semibold tracking-tight text-zinc-100">tempo</span>
      </div>

      {/* Primary Navigation */}
      <nav className="flex-1 space-y-0.5 px-2.5 py-3">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className={`group relative flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[13px] font-medium transition-colors ${
                active
                  ? "bg-white/[0.07] text-zinc-100"
                  : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
              }`}
            >
              {active && (
                <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-indigo-400" />
              )}

              <span className="flex items-center gap-2.5">
                <Icon
                  className={`h-4 w-4 shrink-0 transition-colors ${
                    active ? "text-indigo-400" : "text-zinc-500 group-hover:text-zinc-300"
                  }`}
                />
                <span>{label}</span>
              </span>

              {id === "ticktick" && ticktickStatus && (
                <span className="flex items-center gap-1.5">
                  {unsyncedCount > 0 && (
                    <span
                      title={`대기 ${pendingCount} · 실패 ${failedCount}`}
                      className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none tabular-nums ${
                        failedCount > 0
                          ? "bg-rose-500/20 text-rose-300"
                          : "bg-amber-500/20 text-amber-300"
                      }`}
                    >
                      {unsyncedCount}
                    </span>
                  )}
                  <span
                    title={ticktickStatus.connected ? "TickTick 연결됨" : "TickTick 미연결"}
                    className={`h-1.5 w-1.5 rounded-full ${
                      ticktickStatus.authInProgress
                        ? "animate-pulse bg-sky-400"
                        : ticktickStatus.connected
                          ? "bg-emerald-400"
                          : "bg-zinc-700"
                    }`}
                  />
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Quiet Utility Footer */}
      <div className="border-t border-white/[0.06] p-2.5">
        <button
          type="button"
          onClick={onToggleMiniTimer}
          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-zinc-400 transition-colors hover:bg-white/[0.05] hover:text-zinc-200"
        >
          <PictureInPicture2 className="h-3.5 w-3.5 text-zinc-500" />
          <span>Mini Timer</span>
        </button>
      </div>
    </aside>
  );
}
