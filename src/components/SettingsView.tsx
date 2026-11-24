import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Check,
  Cloud,
  Keyboard,
  Shield,
  X,
} from "lucide-react";
import { useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  AppSettings,
  DiscoverableApp,
  ShortcutStatus,
  SyncMode,
  TickTickConnectionStatus,
  TickTickProject,
} from "../types";
import { ProcessAppPicker } from "./ProcessAppPicker";

export interface SettingsDraft {
  pollIntervalMs: string;
  idleThresholdMin: string;
  sleepGapSec: string;
  redactedProcesses: string[];
  redactedTitleKeywords: string;
  excludedProcesses: string[];
  syncMode: SyncMode;
  fallbackProjectId: string;
  stopTimerOnQuit: boolean;
  timelineMinDurationSec: string;
  shortcutToggleTimer: string;
  shortcutQuickEntry: string;
  miniTimerAlwaysOnTop: boolean;
  autoSyncOnStop: boolean;
  ticktickTimeZone: string;
  ticktickOauthClientId: string;
  ticktickOauthRedirectPort: number;
}

interface SettingsViewProps {
  draft: SettingsDraft;
  savedSettings: AppSettings;
  projects: TickTickProject[];
  shortcutStatus: ShortcutStatus | null;
  ticktickStatus: TickTickConnectionStatus | null;
  discoverableApps: DiscoverableApp[];
  loadingDiscoverableApps: boolean;
  runtimeLabel: string;
  savedIndicator: boolean;
  onChangeDraft: (next: SettingsDraft) => void;
  onSubmit: (event: FormEvent) => Promise<void>;
  onResetDraft: () => void;
  onOpenTickTick: () => void;
  onRefreshDiscoverableApps: () => void;
}

function sameStringList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, idx) => item === b[idx]);
}

function formatKeyEventToShortcut(event: ReactKeyboardEvent<HTMLInputElement>): string | null {
  const key = event.key;
  if (["Control", "Alt", "Shift", "Meta"].includes(key)) {
    return null;
  }
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  if (parts.length === 0) return null;

  const normalizedKey =
    key.length === 1 ? key.toUpperCase() : key === " " ? "Space" : key;
  parts.push(normalizedKey);
  return parts.join("+");
}

function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-4 py-1 text-left"
    >
      <span className="text-[13px] text-zinc-200">{label}</span>
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          checked ? "bg-indigo-500" : "bg-white/[0.12]"
        }`}
      >
        <span
          className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
            checked ? "translate-x-[18px]" : "translate-x-[3px]"
          }`}
        />
      </span>
    </button>
  );
}

function ShortcutRecorder({
  label,
  value,
  registered,
  recording,
  onFocus,
  onBlur,
  onChange,
}: {
  label: string;
  value: string;
  registered: boolean | null;
  recording: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onChange: (next: string) => void;
}) {
  const keys = value
    .split("+")
    .map((k) => k.trim())
    .filter(Boolean);

  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-zinc-200">{label}</span>
        {registered !== null && value.trim() && (
          <span
            title={registered ? "등록됨" : "미등록"}
            className={`h-1.5 w-1.5 rounded-full ${
              registered ? "bg-emerald-400" : "bg-amber-400"
            }`}
          />
        )}
      </div>

      <div className="flex items-center gap-1.5">
        <div
          className={`relative flex h-8 min-w-[164px] items-center justify-end rounded-lg border px-2.5 transition-all ${
            recording
              ? "border-indigo-400 bg-indigo-500/10 ring-2 ring-indigo-500/30"
              : "border-white/[0.08] bg-black/30 hover:border-white/[0.16]"
          }`}
        >
          <input
            type="text"
            value={recording ? "" : value}
            onFocus={onFocus}
            onBlur={onBlur}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.currentTarget.blur();
                return;
              }
              if (e.key === "Backspace" || e.key === "Delete") {
                e.preventDefault();
                onChange("");
                e.currentTarget.blur();
                return;
              }
              const combo = formatKeyEventToShortcut(e);
              if (combo) {
                e.preventDefault();
                onChange(combo);
                e.currentTarget.blur();
              }
            }}
            aria-label={label}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
          />

          {recording ? (
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-indigo-300">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-400" />
              <span>키 입력...</span>
            </span>
          ) : keys.length > 0 ? (
            <span className="pointer-events-none flex items-center gap-1">
              {keys.map((k, i) => (
                <kbd
                  key={`${k}-${i}`}
                  className="rounded border border-white/[0.12] bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10.5px] font-medium leading-none text-zinc-200 shadow-xs"
                >
                  {k}
                </kbd>
              ))}
            </span>
          ) : (
            <span className="pointer-events-none text-[11px] text-zinc-600">없음</span>
          )}
        </div>

        {value && (
          <button
            type="button"
            onClick={() => onChange("")}
            title="비활성화"
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

function UnitNumberField({
  label,
  unit,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  unit: string;
  value: string;
  min: number;
  max: number;
  onChange: (next: string) => void;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[11px] font-medium text-zinc-400">{label}</span>
      <div className="relative flex items-center">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-full rounded-lg border border-white/[0.08] bg-black/30 pl-3 pr-10 font-mono text-xs tabular-nums text-zinc-100 focus:border-indigo-500/70 focus:outline-none"
        />
        <span className="pointer-events-none absolute right-3 font-mono text-[10.5px] text-zinc-500">
          {unit}
        </span>
      </div>
    </label>
  );
}

export function SettingsView({
  draft,
  savedSettings,
  projects,
  shortcutStatus,
  ticktickStatus,
  discoverableApps,
  loadingDiscoverableApps,
  runtimeLabel,
  savedIndicator,
  onChangeDraft,
  onSubmit,
  onResetDraft,
  onOpenTickTick,
  onRefreshDiscoverableApps,
}: SettingsViewProps) {
  const [recordingField, setRecordingField] = useState<
    "shortcutToggleTimer" | "shortcutQuickEntry" | null
  >(null);

  const isDirty =
    draft.pollIntervalMs !== String(savedSettings.pollIntervalMs) ||
    draft.idleThresholdMin !== String(Math.round(savedSettings.idleThresholdMs / 60_000)) ||
    draft.sleepGapSec !== String(Math.round(savedSettings.sleepGapThresholdMs / 1_000)) ||
    !sameStringList(draft.redactedProcesses, savedSettings.redactedProcesses) ||
    draft.redactedTitleKeywords !== savedSettings.redactedTitleKeywords.join(", ") ||
    !sameStringList(draft.excludedProcesses, savedSettings.excludedProcesses) ||
    draft.syncMode !== savedSettings.syncMode ||
    draft.fallbackProjectId !== (savedSettings.fallbackProjectId ?? "") ||
    draft.stopTimerOnQuit !== savedSettings.stopTimerOnQuit ||
    draft.timelineMinDurationSec !== String(Math.round(savedSettings.timelineMinDurationMs / 1_000)) ||
    draft.shortcutToggleTimer !== (savedSettings.shortcutToggleTimer ?? "") ||
    draft.shortcutQuickEntry !== (savedSettings.shortcutQuickEntry ?? "") ||
    draft.miniTimerAlwaysOnTop !== savedSettings.miniTimerAlwaysOnTop ||
    draft.autoSyncOnStop !== savedSettings.autoSyncOnStop ||
    draft.ticktickTimeZone !== (savedSettings.ticktickTimeZone ?? "");

  return (
    <section className="mx-auto max-w-2xl pb-10">
      <form onSubmit={(e) => void onSubmit(e)} className="space-y-6">
        {/* Section 1: Shortcuts & Mini Timer */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            <Keyboard className="h-3.5 w-3.5 text-indigo-400" />
            <span>단축키 &amp; 미니 타이머</span>
          </div>

          <div className="divide-y divide-white/[0.05] rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-1.5">
            <ShortcutRecorder
              label="타이머 시작 / 정지"
              value={draft.shortcutToggleTimer}
              registered={shortcutStatus ? shortcutStatus.toggleTimerRegistered : null}
              recording={recordingField === "shortcutToggleTimer"}
              onFocus={() => setRecordingField("shortcutToggleTimer")}
              onBlur={() => setRecordingField(null)}
              onChange={(next) => onChangeDraft({ ...draft, shortcutToggleTimer: next })}
            />

            <ShortcutRecorder
              label="빠른 입력 포커스"
              value={draft.shortcutQuickEntry}
              registered={shortcutStatus ? shortcutStatus.quickEntryRegistered : null}
              recording={recordingField === "shortcutQuickEntry"}
              onFocus={() => setRecordingField("shortcutQuickEntry")}
              onBlur={() => setRecordingField(null)}
              onChange={(next) => onChangeDraft({ ...draft, shortcutQuickEntry: next })}
            />

            <div className="py-2">
              <ToggleSwitch
                label="미니 타이머 항상 위"
                checked={draft.miniTimerAlwaysOnTop}
                onChange={(next) => onChangeDraft({ ...draft, miniTimerAlwaysOnTop: next })}
              />
            </div>
          </div>

          {shortcutStatus && shortcutStatus.warnings.length > 0 && (
            <div className="space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200">
              {shortcutStatus.warnings.map((w, idx) => (
                <div key={idx} className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Section 2: Activity Tracking */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            <Activity className="h-3.5 w-3.5 text-sky-400" />
            <span>활동 추적</span>
          </div>

          <div className="space-y-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <UnitNumberField
                label="폴링 주기"
                unit="ms"
                min={250}
                max={60000}
                value={draft.pollIntervalMs}
                onChange={(v) => onChangeDraft({ ...draft, pollIntervalMs: v })}
              />
              <UnitNumberField
                label="유휴 임계치"
                unit="분"
                min={1}
                max={1440}
                value={draft.idleThresholdMin}
                onChange={(v) => onChangeDraft({ ...draft, idleThresholdMin: v })}
              />
              <UnitNumberField
                label="절전 분리"
                unit="초"
                min={1}
                max={3600}
                value={draft.sleepGapSec}
                onChange={(v) => onChangeDraft({ ...draft, sleepGapSec: v })}
              />
              <UnitNumberField
                label="최소 표시"
                unit="초"
                min={0}
                max={3600}
                value={draft.timelineMinDurationSec}
                onChange={(v) => onChangeDraft({ ...draft, timelineMinDurationSec: v })}
              />
            </div>

            <div className="border-t border-white/[0.05] pt-3">
              <ToggleSwitch
                label="앱 종료 시 실행 중인 타이머 정지"
                checked={draft.stopTimerOnQuit}
                onChange={(next) => onChangeDraft({ ...draft, stopTimerOnQuit: next })}
              />
            </div>
          </div>
        </div>

        {/* Section 3: Privacy Filters */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            <Shield className="h-3.5 w-3.5 text-amber-400" />
            <span>개인정보</span>
          </div>

          <div className="space-y-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
            <ProcessAppPicker
              label="제목 마스킹 앱"
              description="창 제목을 [Redacted]로 가려 기록합니다. (.exe 생략 가능)"
              values={draft.redactedProcesses}
              discoverableApps={discoverableApps}
              loadingApps={loadingDiscoverableApps}
              accentTone="amber"
              emptyHint="마스킹할 앱 없음"
              onChange={(next) => onChangeDraft({ ...draft, redactedProcesses: next })}
              onRefreshApps={onRefreshDiscoverableApps}
            />

            <label className="block space-y-1.5">
              <span className="text-[11px] font-medium text-zinc-400">제목 마스킹 키워드</span>
              <input
                type="text"
                value={draft.redactedTitleKeywords}
                onChange={(e) => onChangeDraft({ ...draft, redactedTitleKeywords: e.target.value })}
                placeholder="Incognito, InPrivate, 시크릿"
                className="h-9 w-full rounded-lg border border-white/[0.08] bg-black/30 px-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500/70 focus:outline-none"
              />
            </label>

            <ProcessAppPicker
              label="수집 제외 앱"
              description="선택한 앱은 새로 수집되지 않으며, 기존 타임라인에서도 자동으로 숨겨집니다."
              values={draft.excludedProcesses}
              discoverableApps={discoverableApps}
              loadingApps={loadingDiscoverableApps}
              accentTone="rose"
              emptyHint="제외할 앱 없음"
              onChange={(next) => onChangeDraft({ ...draft, excludedProcesses: next })}
              onRefreshApps={onRefreshDiscoverableApps}
            />
          </div>
        </div>

        {/* Section 4: TickTick Sync */}
        <div className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              <Cloud className="h-3.5 w-3.5 text-emerald-400" />
              <span>TickTick</span>
            </div>
            <button
              type="button"
              onClick={onOpenTickTick}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-400 transition-colors hover:text-indigo-300"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  ticktickStatus?.connected ? "bg-emerald-400" : "bg-zinc-600"
                }`}
              />
              <span>{ticktickStatus?.connected ? "계정 관리" : "연결"}</span>
              <ArrowUpRight className="h-3 w-3" />
            </button>
          </div>

          <div className="space-y-4 rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
            {/* Segmented Sync Mode Selector */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-[13px] text-zinc-200">동기화 방식</span>
              <div className="inline-flex h-8 items-center rounded-lg border border-white/[0.08] bg-black/30 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => onChangeDraft({ ...draft, syncMode: "subtask" })}
                  className={`h-7 rounded-md px-3 font-medium transition-colors ${
                    draft.syncMode === "subtask"
                      ? "bg-white/[0.1] text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  하위 작업
                </button>
                <button
                  type="button"
                  onClick={() => onChangeDraft({ ...draft, syncMode: "fallback_list" })}
                  className={`h-7 rounded-md px-3 font-medium transition-colors ${
                    draft.syncMode === "fallback_list"
                      ? "bg-white/[0.1] text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  전용 리스트
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-[11px] font-medium text-zinc-400">Fallback 리스트</span>
                <select
                  value={draft.fallbackProjectId}
                  onChange={(e) => onChangeDraft({ ...draft, fallbackProjectId: e.target.value })}
                  className="h-9 w-full rounded-lg border border-white/[0.08] bg-black/30 px-3 text-xs text-zinc-100 focus:border-indigo-500/70 focus:outline-none"
                >
                  <option value="">자동</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  {draft.fallbackProjectId &&
                    !projects.some((p) => p.id === draft.fallbackProjectId) && (
                      <option value={draft.fallbackProjectId}>{draft.fallbackProjectId}</option>
                    )}
                </select>
              </label>

              <label className="block space-y-1.5">
                <span className="text-[11px] font-medium text-zinc-400">타임존</span>
                <input
                  type="text"
                  value={draft.ticktickTimeZone}
                  onChange={(e) => onChangeDraft({ ...draft, ticktickTimeZone: e.target.value })}
                  placeholder={ticktickStatus?.detectedTimeZone ?? "UTC"}
                  className="h-9 w-full rounded-lg border border-white/[0.08] bg-black/30 px-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500/70 focus:outline-none"
                />
              </label>
            </div>

            <div className="border-t border-white/[0.05] pt-3">
              <ToggleSwitch
                label="타이머 종료 시 자동 동기화"
                checked={draft.autoSyncOnStop}
                onChange={(next) => onChangeDraft({ ...draft, autoSyncOnStop: next })}
              />
            </div>
          </div>
        </div>

        {/* Sticky Footer Bar */}
        <div className="flex items-center justify-between pt-2">
          <span className="font-mono text-[11px] text-zinc-600">{runtimeLabel}</span>

          <div className="flex items-center gap-2">
            {savedIndicator && !isDirty && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
                <Check className="h-3.5 w-3.5" />
                <span>저장됨</span>
              </span>
            )}
            {isDirty && (
              <button
                type="button"
                onClick={onResetDraft}
                className="h-9 rounded-lg px-3 text-xs font-medium text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
              >
                되돌리기
              </button>
            )}
            <button
              type="submit"
              className={`h-9 rounded-lg px-4 text-xs font-semibold transition-all ${
                isDirty
                  ? "bg-indigo-500 text-white shadow-lg shadow-indigo-500/20 hover:bg-indigo-400"
                  : "bg-white/[0.08] text-zinc-300 hover:bg-white/[0.14]"
              }`}
            >
              저장
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
