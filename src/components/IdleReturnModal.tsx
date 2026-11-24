import { Check, Play, Scissors, Trash2 } from "lucide-react";
import { useState } from "react";
import { formatDurationShort, formatTimeHm } from "../lib/time";
import type { IdleResolutionAction, IdleReturnPrompt } from "../types";

interface IdleReturnModalProps {
  prompt: IdleReturnPrompt;
  onResolve: (
    action: IdleResolutionAction,
    options?: { idleDescription?: string; resumeOriginal?: boolean },
  ) => Promise<void>;
}

export function IdleReturnModal({ prompt, onResolve }: IdleReturnModalProps) {
  const [idleDescription, setIdleDescription] = useState("");
  const [resumeOriginal, setResumeOriginal] = useState(true);
  const [busy, setBusy] = useState(false);

  async function choose(action: IdleResolutionAction) {
    if (busy) return;
    setBusy(true);
    try {
      await onResolve(action, {
        idleDescription: idleDescription.trim() || undefined,
        resumeOriginal,
      });
    } finally {
      setBusy(false);
    }
  }

  const idleStartHm = formatTimeHm(prompt.idleStartedAt);
  const returnedHm = formatTimeHm(prompt.returnedAt);
  const idleDurLabel = formatDurationShort(prompt.idleDurationMs);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-md">
      <div className="w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.1] bg-[#121218] shadow-2xl shadow-black/80">
        {/* Amber Top Hairline */}
        <div className="h-[2px] w-full bg-gradient-to-r from-indigo-500 via-amber-400 to-amber-500/40" />

        <div className="space-y-5 p-6">
          {/* Hero Metric & Visual Timeline Strip */}
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-amber-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  <span>유휴 감지</span>
                </div>
                <h2 className="mt-1 truncate text-base font-semibold text-zinc-100">
                  {prompt.entryDescription || "(Untitled)"}
                </h2>
              </div>

              <div className="shrink-0 font-mono text-2xl font-semibold tracking-tight tabular-nums text-amber-300">
                {idleDurLabel}
              </div>
            </div>

            {/* Visual Work -> Idle Timeline Bar */}
            <div className="space-y-1.5">
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
                <div className="h-full w-[42%] bg-indigo-500/80" />
                <div
                  className="h-full flex-1 border-l border-amber-300/60"
                  style={{
                    backgroundImage:
                      "repeating-linear-gradient(-45deg, rgba(245, 158, 11, 0.45), rgba(245, 158, 11, 0.45) 5px, rgba(245, 158, 11, 0.16) 5px, rgba(245, 158, 11, 0.16) 10px)",
                  }}
                />
              </div>
              <div className="flex items-center font-mono text-[10.5px] tabular-nums text-zinc-500">
                <span className="w-[42%] text-right pr-1 text-zinc-400">{idleStartHm}</span>
                <span className="flex-1 text-right text-amber-300/90">{returnedHm}</span>
              </div>
            </div>
          </div>

          {/* Scannable Action Options */}
          <div className="space-y-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void choose("keep")}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-left transition-colors hover:border-indigo-500/40 hover:bg-white/[0.06] disabled:opacity-50"
            >
              <span className="flex items-center gap-2.5 text-sm font-medium text-zinc-100">
                <Check className="h-4 w-4 text-indigo-400" />
                <span>유지</span>
              </span>
              <span className="font-mono text-xs tabular-nums text-indigo-300">
                +{idleDurLabel}
              </span>
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => void choose("discard")}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-left transition-colors hover:border-rose-500/40 hover:bg-white/[0.06] disabled:opacity-50"
            >
              <span className="flex items-center gap-2.5 text-sm font-medium text-zinc-100">
                <Trash2 className="h-4 w-4 text-rose-400" />
                <span>버리기</span>
              </span>
              <span className="font-mono text-xs tabular-nums text-zinc-400">
                {idleStartHm} 종료
              </span>
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => void choose("discard_and_continue")}
              className="flex w-full items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-white/[0.03] px-4 py-3 text-left transition-colors hover:border-emerald-500/40 hover:bg-white/[0.06] disabled:opacity-50"
            >
              <span className="flex items-center gap-2.5 text-sm font-medium text-zinc-100">
                <Play className="h-4 w-4 text-emerald-400" />
                <span>버리고 계속</span>
              </span>
              <span className="font-mono text-xs tabular-nums text-zinc-400">
                {returnedHm} 재개
              </span>
            </button>

            {/* Split Card */}
            <div className="space-y-2.5 rounded-xl border border-white/[0.08] bg-black/25 p-3.5">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={idleDescription}
                  onChange={(e) => setIdleDescription(e.target.value)}
                  placeholder="유휴 구간 제목..."
                  className="h-8 flex-1 rounded-lg border border-white/[0.08] bg-zinc-950/90 px-2.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500/70 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void choose("split")}
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-indigo-500 px-3 text-xs font-medium text-white transition-colors hover:bg-indigo-400 disabled:opacity-50"
                >
                  <Scissors className="h-3.5 w-3.5" />
                  <span>분리</span>
                </button>
              </div>

              <button
                type="button"
                role="switch"
                aria-checked={resumeOriginal}
                onClick={() => setResumeOriginal((v) => !v)}
                className="flex w-full items-center justify-between text-xs text-zinc-400"
              >
                <span>원래 작업 재개</span>
                <span
                  className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
                    resumeOriginal ? "bg-indigo-500" : "bg-white/[0.12]"
                  }`}
                >
                  <span
                    className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
                      resumeOriginal ? "translate-x-[14px]" : "translate-x-[2px]"
                    }`}
                  />
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
