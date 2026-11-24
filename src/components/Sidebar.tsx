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
  runtimeLabel: string;
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
  runtimeLabel,
  ticktickStatus,
}: SidebarProps) {
  const pendingCount = ticktickStatus?.queue.pendingCount ?? 0;
  const failedCount = ticktickStatus?.queue.failedCount ?? 0;
  const unsyncedCount = pendingCount + failedCount;

  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950/90">
      <div className="flex h-16 items-center gap-2.5 border-b border-zinc-800/80 px-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500 text-sm font-bold text-white shadow-sm">
          T
        </div>
        <div>
          <div className="text-sm font-semibold tracking-tight text-zinc-100">tempo</div>
          <div className="text-[11px] text-zinc-500">v0.1 Phase 3</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 p-2.5">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => onSelect(id)}
              className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition ${
                active
                  ? "bg-indigo-500/15 text-indigo-300"
                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Icon className="h-4 w-4 shrink-0" />
                <span>{label}</span>
              </span>

              {id === "ticktick" && ticktickStatus && (
                <span className="flex items-center gap-1.5">
                  {unsyncedCount > 0 && (
                    <span
                      title={`동기화 대기 ${pendingCount}건 · 실패 ${failedCount}건`}
                      className={`rounded-full px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none ${
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
                    className={`h-2 w-2 rounded-full ${
                      ticktickStatus.authInProgress
                        ? "animate-pulse bg-sky-400"
                        : ticktickStatus.connected
                          ? "bg-emerald-400"
                          : "bg-zinc-600"
                    }`}
                  />
                </span>
              )}
            </button>
          );
        })}
      </nav>

      <div className="space-y-2 border-t border-zinc-800/80 p-3">
        <button
          type="button"
          onClick={onToggleMiniTimer}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/80 px-3 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-indigo-500/50 hover:bg-zinc-800 hover:text-zinc-100"
        >
          <PictureInPicture2 className="h-3.5 w-3.5 text-indigo-400" />
          Mini Timer
        </button>

        <div className="px-1 text-[11px] text-zinc-500">
          Runtime: <span className="font-mono text-zinc-300">{runtimeLabel}</span>
        </div>
      </div>
    </aside>
  );
}
