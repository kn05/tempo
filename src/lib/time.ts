import type { ActivityLog } from "../types";

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];

export function formatDurationHms(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function formatDurationShort(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function formatTimeHm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatTimeHms(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export function formatDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function getDayRangeMs(date: Date): { startMs: number; endMs: number } {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

export function addDays(date: Date, delta: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + delta);
  return next;
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function formatDayGroupLabel(dateKey: string): string {
  const [yStr, mStr, dStr] = dateKey.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const target = new Date(y, m - 1, d);
  const today = new Date();
  const yesterday = addDays(today, -1);
  const weekday = WEEKDAY_KO[target.getDay()];

  if (isSameLocalDay(target, today)) {
    return `오늘 · ${m}월 ${d}일 (${weekday})`;
  }
  if (isSameLocalDay(target, yesterday)) {
    return `어제 · ${m}월 ${d}일 (${weekday})`;
  }
  return `${dateKey} (${weekday})`;
}

export function formatFullDateKorean(date: Date): string {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const weekday = WEEKDAY_KO[date.getDay()];
  const today = new Date();
  const yesterday = addDays(today, -1);
  if (isSameLocalDay(date, today)) {
    return `오늘 · ${y}년 ${m}월 ${d}일 (${weekday})`;
  }
  if (isSameLocalDay(date, yesterday)) {
    return `어제 · ${y}년 ${m}월 ${d}일 (${weekday})`;
  }
  return `${y}년 ${m}월 ${d}일 (${weekday})`;
}

/**
 * Applies an `HH:MM` string onto the local calendar day of `baseTs`.
 */
export function applyTimeInputToDate(baseTs: number, hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  const d = new Date(baseTs);
  d.setHours(hours, minutes, 0, 0);
  return d.getTime();
}

export interface ProcessColorStyle {
  hex: string;
  bg: string;
  border: string;
  text: string;
}

const KNOWN_APP_COLORS: Record<string, ProcessColorStyle> = {
  "code.exe": {
    hex: "#3b82f6",
    bg: "rgba(59, 130, 246, 0.18)",
    border: "rgba(59, 130, 246, 0.55)",
    text: "#93c5fd",
  },
  "cursor.exe": {
    hex: "#6366f1",
    bg: "rgba(99, 102, 241, 0.2)",
    border: "rgba(99, 102, 241, 0.55)",
    text: "#c7d2fe",
  },
  "chrome.exe": {
    hex: "#10b981",
    bg: "rgba(16, 185, 129, 0.18)",
    border: "rgba(16, 185, 129, 0.52)",
    text: "#6ee7b7",
  },
  "msedge.exe": {
    hex: "#06b6d4",
    bg: "rgba(6, 182, 212, 0.18)",
    border: "rgba(6, 182, 212, 0.52)",
    text: "#67e8f9",
  },
  "firefox.exe": {
    hex: "#f97316",
    bg: "rgba(249, 115, 22, 0.18)",
    border: "rgba(249, 115, 22, 0.52)",
    text: "#fdba74",
  },
  "windowsterminal.exe": {
    hex: "#14b8a6",
    bg: "rgba(20, 184, 166, 0.18)",
    border: "rgba(20, 184, 166, 0.52)",
    text: "#5eead4",
  },
  "slack.exe": {
    hex: "#a855f7",
    bg: "rgba(168, 85, 247, 0.18)",
    border: "rgba(168, 85, 247, 0.52)",
    text: "#d8b4fe",
  },
  "discord.exe": {
    hex: "#818cf8",
    bg: "rgba(129, 140, 248, 0.18)",
    border: "rgba(129, 140, 248, 0.52)",
    text: "#c7d2fe",
  },
  "figma.exe": {
    hex: "#ec4899",
    bg: "rgba(236, 72, 153, 0.18)",
    border: "rgba(236, 72, 153, 0.52)",
    text: "#f9a8d4",
  },
  "notion.exe": {
    hex: "#94a3b8",
    bg: "rgba(148, 163, 184, 0.18)",
    border: "rgba(148, 163, 184, 0.5)",
    text: "#cbd5e1",
  },
};

const PALETTE: ProcessColorStyle[] = [
  {
    hex: "#6366f1",
    bg: "rgba(99, 102, 241, 0.18)",
    border: "rgba(99, 102, 241, 0.5)",
    text: "#c7d2fe",
  },
  {
    hex: "#0ea5e9",
    bg: "rgba(14, 165, 233, 0.18)",
    border: "rgba(14, 165, 233, 0.5)",
    text: "#7dd3fc",
  },
  {
    hex: "#10b981",
    bg: "rgba(16, 185, 129, 0.18)",
    border: "rgba(16, 185, 129, 0.5)",
    text: "#6ee7b7",
  },
  {
    hex: "#f59e0b",
    bg: "rgba(245, 158, 11, 0.18)",
    border: "rgba(245, 158, 11, 0.5)",
    text: "#fcd34d",
  },
  {
    hex: "#ec4899",
    bg: "rgba(236, 72, 153, 0.18)",
    border: "rgba(236, 72, 153, 0.5)",
    text: "#f9a8d4",
  },
  {
    hex: "#8b5cf6",
    bg: "rgba(139, 92, 246, 0.18)",
    border: "rgba(139, 92, 246, 0.5)",
    text: "#ddd6fe",
  },
  {
    hex: "#f43f5e",
    bg: "rgba(244, 63, 94, 0.18)",
    border: "rgba(244, 63, 94, 0.5)",
    text: "#fda4af",
  },
];

export function getProcessColor(processName: string): ProcessColorStyle {
  const key = processName.trim().toLowerCase();
  if (KNOWN_APP_COLORS[key]) {
    return KNOWN_APP_COLORS[key];
  }
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function cleanProcessLabel(processName: string): string {
  return processName.replace(/\.exe$/i, "");
}

/**
 * Normalizes a process name for matching (trimmed, lowercased, optional trailing `.exe` removed).
 * Mirrors `tempo_core::normalize_process_match_key`.
 */
export function normalizeProcessMatchKey(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  const lowered = trimmed.toLowerCase();
  const stripped = lowered.endsWith(".exe") ? lowered.slice(0, -4) : lowered;
  return stripped || lowered;
}

/**
 * Returns true when `rule` matches `processName`, ignoring case and an optional `.exe` suffix.
 */
export function processNameMatches(rule: string, processName: string): boolean {
  const ruleKey = normalizeProcessMatchKey(rule);
  if (!ruleKey) return false;
  const actualKey = normalizeProcessMatchKey(processName);
  return actualKey.length > 0 && ruleKey === actualKey;
}

export function matchesAnyProcess(rules: string[], processName: string): boolean {
  return rules.some((rule) => processNameMatches(rule, processName));
}

export function titleMatchesAnyKeyword(keywords: string[], windowTitle: string | null): boolean {
  if (!windowTitle) return false;
  const titleLower = windowTitle.toLowerCase();
  return keywords.some((kw) => {
    const trimmed = kw.trim();
    return trimmed.length > 0 && titleLower.includes(trimmed.toLowerCase());
  });
}

export function shouldRedactActivity(
  redactedProcesses: string[],
  redactedTitleKeywords: string[],
  processName: string,
  windowTitle: string | null,
): boolean {
  return (
    matchesAnyProcess(redactedProcesses, processName) ||
    titleMatchesAnyKeyword(redactedTitleKeywords, windowTitle)
  );
}

export function dedupeProcessList(items: string[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalizeProcessMatchKey(trimmed);
    const existingIdx = out.findIndex((item) => normalizeProcessMatchKey(item) === key);
    if (existingIdx !== -1) {
      if (!out[existingIdx].toLowerCase().endsWith(".exe") && trimmed.toLowerCase().endsWith(".exe")) {
        out[existingIdx] = trimmed;
      }
    } else {
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Generates a helpful default Time Entry description from a set of selected activity logs
 * by picking the dominant non-idle span (preferring rich window title or workspace metadata).
 */
export function suggestDescriptionFromLogs(logs: ActivityLog[]): string {
  const activeLogs = logs.filter((l) => !l.isIdle);
  if (activeLogs.length === 0) return "작업 기록";

  const byKey = new Map<
    string,
    { duration: number; processName: string; windowTitle: string | null; metadataJson: string | null }
  >();

  for (const log of activeLogs) {
    const dur = Math.max(0, log.endedAt - log.startedAt);
    const key = `${log.processName}::${log.windowTitle ?? ""}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.duration += dur;
    } else {
      byKey.set(key, {
        duration: dur,
        processName: log.processName,
        windowTitle: log.windowTitle,
        metadataJson: log.metadataJson,
      });
    }
  }

  const dominant = [...byKey.values()].sort((a, b) => b.duration - a.duration)[0];
  if (!dominant) return "작업 기록";

  if (dominant.metadataJson) {
    try {
      const meta = JSON.parse(dominant.metadataJson) as {
        workspace?: string;
        branch?: string;
        file?: string;
      };
      if (meta.workspace) {
        return meta.branch ? `${meta.workspace} (${meta.branch}) 개발` : `${meta.workspace} 개발`;
      }
    } catch {
      // Ignore malformed JSON metadata.
    }
  }

  if (dominant.windowTitle && dominant.windowTitle !== "[Redacted]") {
    const cleaned = dominant.windowTitle
      .replace(/\s*[-—–]\s*(Visual Studio Code|Google Chrome|Microsoft Edge|Mozilla Firefox)$/i, "")
      .trim();
    if (cleaned.length > 0) {
      return cleaned.length > 64 ? `${cleaned.slice(0, 61)}...` : cleaned;
    }
  }

  return `${cleanProcessLabel(dominant.processName)} 작업`;
}
