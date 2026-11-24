import { ClockAlert } from "lucide-react";
import { useState } from "react";
import type { IdleResolutionAction, IdleReturnPrompt } from "../types";

interface IdleReturnModalProps {
  prompt: IdleReturnPrompt;
  onResolve: (
    action: IdleResolutionAction,
    options?: { idleDescription?: string; resumeOriginal?: boolean },
  ) => Promise<void>;
}

function formatMinutesSeconds(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}시간 ${m}분 ${s}초`;
  if (m > 0) return `${m}분 ${s}초`;
  return `${s}초`;
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-zinc-700/80 bg-zinc-900 p-6 shadow-2xl">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
            <ClockAlert className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-zinc-100">
              유휴 시간이 감지되었습니다
            </h2>
            <p className="mt-1 text-xs text-zinc-400">
              <span className="font-medium text-zinc-200">
                {prompt.entryDescription || "(Untitled)"}
              </span>{" "}
              타이머 실행 중{" "}
              <span className="font-semibold text-amber-300">
                {formatMinutesSeconds(prompt.idleDurationMs)}
              </span>
              동안 입력이 없었습니다.
            </p>
            <p className="mt-1 font-mono text-[11px] text-zinc-500">
              {new Date(prompt.idleStartedAt).toLocaleTimeString()} –{" "}
              {new Date(prompt.returnedAt).toLocaleTimeString()}
            </p>
          </div>
        </div>

        <div className="mt-5 space-y-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void choose("keep")}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800/80 px-4 py-2.5 text-left text-sm transition hover:border-indigo-500/60 hover:bg-zinc-800 disabled:opacity-50"
          >
            <div className="font-medium text-zinc-100">유지 (Keep)</div>
            <div className="text-xs text-zinc-400">유휴 시간을 포함하여 계속 기록합니다.</div>
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => void choose("discard")}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800/80 px-4 py-2.5 text-left text-sm transition hover:border-rose-500/60 hover:bg-zinc-800 disabled:opacity-50"
          >
            <div className="font-medium text-zinc-100">버리기 (Discard)</div>
            <div className="text-xs text-zinc-400">유휴 시작 시점으로 타이머를 종료합니다.</div>
          </button>

          <button
            type="button"
            disabled={busy}
            onClick={() => void choose("discard_and_continue")}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800/80 px-4 py-2.5 text-left text-sm transition hover:border-indigo-500/60 hover:bg-zinc-800 disabled:opacity-50"
          >
            <div className="font-medium text-zinc-100">버리고 계속 (Discard &amp; Continue)</div>
            <div className="text-xs text-zinc-400">
              유휴 구간만 제외하고 복귀 시점부터 같은 작업으로 새 타이머를 시작합니다.
            </div>
          </button>

          <div className="rounded-lg border border-zinc-700 bg-zinc-800/60 p-3">
            <input
              type="text"
              value={idleDescription}
              onChange={(e) => setIdleDescription(e.target.value)}
              placeholder="분리할 유휴 기록 설명 (비워두면 빈 기록)"
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none"
            />
            <label className="mt-2 flex items-center gap-2 text-xs text-zinc-300">
              <input
                type="checkbox"
                checked={resumeOriginal}
                onChange={(e) => setResumeOriginal(e.target.checked)}
                className="rounded border-zinc-600 bg-zinc-900"
              />
              복귀 시점부터 원래 작업 타이머 자동 재개
            </label>
            <button
              type="button"
              disabled={busy}
              onClick={() => void choose("split")}
              className="mt-2.5 w-full rounded-md bg-indigo-500 px-3 py-2 text-xs font-medium text-white transition hover:bg-indigo-400 disabled:opacity-50"
            >
              새 기록으로 분리 (Split)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
