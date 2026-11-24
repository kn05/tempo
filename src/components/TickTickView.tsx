import {
  AlertCircle,
  Calendar,
  Check,
  CheckCircle2,
  CheckSquare,
  Cloud,
  CloudOff,
  CloudUpload,
  Copy,
  ExternalLink,
  Inbox,
  KeyRound,
  Loader2,
  LogOut,
  Play,
  RefreshCw,
  RotateCw,
  Search,
  Settings2,
  ShieldCheck,
  Tag as TagIcon,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { formatDateKey, formatTimeHms } from "../lib/time";
import type {
  OAuthLoginStartResult,
  SaveOAuthConfigInput,
  TickTickConnectionStatus,
  TickTickProject,
  TickTickPullResult,
  TickTickSyncBatchResult,
  TickTickTask,
} from "../types";

interface TickTickViewProps {
  status: TickTickConnectionStatus | null;
  projects: TickTickProject[];
  tasks: TickTickTask[];
  onStartTaskTimer: (task: TickTickTask) => Promise<void>;
  onSaveOAuthConfig: (input: SaveOAuthConfigInput) => Promise<void>;
  onStartOAuthLogin: () => Promise<OAuthLoginStartResult>;
  onCancelOAuthLogin: () => Promise<void>;
  onConnectPersonalToken: (token: string) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onPullCache: () => Promise<TickTickPullResult>;
  onProcessQueue: () => Promise<TickTickSyncBatchResult>;
  onRetryFailed: () => Promise<TickTickSyncBatchResult>;
}

function formatLastSyncLabel(ts: number | null): string {
  if (!ts) return "아직 Pull 기록 없음";
  return `${formatDateKey(ts)} ${formatTimeHms(ts)}`;
}

function formatDueDateShort(raw: string | null): string | null {
  if (!raw) return null;
  const datePart = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;
  return null;
}

export function TickTickView({
  status,
  projects,
  tasks,
  onStartTaskTimer,
  onSaveOAuthConfig,
  onStartOAuthLogin,
  onCancelOAuthLogin,
  onConnectPersonalToken,
  onDisconnect,
  onPullCache,
  onProcessQueue,
  onRetryFailed,
}: TickTickViewProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | "all">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);

  // Auth & configuration UI state
  const [authTab, setAuthTab] = useState<"oauth2" | "token">("oauth2");
  const [showOAuthConfig, setShowOAuthConfig] = useState(false);
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [oauthPort, setOauthPort] = useState("18492");
  const [personalToken, setPersonalToken] = useState("");

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  useEffect(() => {
    if (!status) return;
    setOauthClientId(status.oauthClientId ?? "");
    setOauthPort(String(status.oauthRedirectPort ?? 18492));
  }, [status?.oauthClientId, status?.oauthRedirectPort]);

  const projectMap = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects]);
  const openTasks = useMemo(() => tasks.filter((t) => t.status === 0), [tasks]);
  const visiblePool = useMemo(
    () => (showCompleted ? tasks : openTasks),
    [showCompleted, tasks, openTasks],
  );

  const countByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of visiblePool) {
      counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
    }
    return counts;
  }, [visiblePool]);

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return visiblePool.filter((task) => {
      if (selectedProjectId !== "all" && task.projectId !== selectedProjectId) return false;
      if (!q) return true;
      const hay = `${task.title} ${task.content ?? ""} ${task.tags.join(" ")}`.toLowerCase();
      return hay.includes(q);
    });
  }, [visiblePool, selectedProjectId, searchQuery]);

  async function copyText(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 2000);
    } catch {
      // Ignore clipboard permission errors in restricted contexts.
    }
  }

  async function handleSaveOAuth(event: FormEvent) {
    event.preventDefault();
    setBusyAction("save-oauth");
    setActionError(null);
    try {
      const parsedPort = Number.parseInt(oauthPort, 10);
      await onSaveOAuthConfig({
        clientId: oauthClientId.trim(),
        clientSecret: oauthClientSecret.trim() ? oauthClientSecret.trim() : null,
        redirectPort: Number.isFinite(parsedPort) && parsedPort >= 0 && parsedPort <= 65535
          ? parsedPort
          : 18492,
      });
      setOauthClientSecret("");
      setShowOAuthConfig(false);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleStartOAuth() {
    setBusyAction("oauth-login");
    setActionError(null);
    try {
      await onStartOAuthLogin();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleConnectToken(event: FormEvent) {
    event.preventDefault();
    if (!personalToken.trim()) {
      setActionError("Personal API Token을 입력해주세요.");
      return;
    }
    setBusyAction("token-login");
    setActionError(null);
    try {
      await onConnectPersonalToken(personalToken.trim());
      setPersonalToken("");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function handlePull() {
    setBusyAction("pull");
    setActionError(null);
    try {
      await onPullCache();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleProcessQueue() {
    setBusyAction("queue");
    setActionError(null);
    try {
      await onProcessQueue();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRetryFailed() {
    setBusyAction("retry");
    setActionError(null);
    try {
      await onRetryFailed();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  async function handleDisconnect() {
    setBusyAction("disconnect");
    setActionError(null);
    try {
      await onDisconnect();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyAction(null);
    }
  }

  const connected = status?.connected ?? false;
  const authInProgress = status?.authInProgress ?? false;
  const pendingCount = status?.queue.pendingCount ?? 0;
  const failedCount = status?.queue.failedCount ?? 0;
  const syncedCount = status?.queue.syncedCount ?? 0;

  return (
    <section className="mx-auto max-w-5xl space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">TickTick 연동 &amp; 할 일 목록</h1>
          <p className="text-xs text-zinc-500">
            캐시된 프로젝트 {projects.length}개 · 미완료 태스크 {openTasks.length}개 · 마지막 Pull:{" "}
            <span className="font-mono text-zinc-400">
              {formatLastSyncLabel(status?.lastPullAt ?? null)}
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={showCompleted}
              onChange={(e) => setShowCompleted(e.target.checked)}
              className="rounded border-zinc-600 bg-zinc-950"
            />
            완료 포함
          </label>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="태스크 검색..."
              className="h-9 w-52 rounded-lg border border-zinc-800 bg-zinc-900 pl-8 pr-3 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>
        </div>
      </div>

      {/* TickTick Connection & Sync Queue Control Card */}
      <div className="space-y-4 rounded-xl border border-zinc-800/90 bg-zinc-900/65 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            {connected ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300">
                <Cloud className="h-3.5 w-3.5" />
                연결됨 · {status?.authMethod === "oauth2" ? "OAuth2" : "Personal API Token"}
              </span>
            ) : authInProgress ? (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-xs font-medium text-sky-300">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                브라우저 OAuth2 인증 대기 중
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/80 px-2.5 py-1 text-xs font-medium text-zinc-300">
                <CloudOff className="h-3.5 w-3.5 text-zinc-400" />
                연결 안 됨 (오프라인 로컬 모드)
              </span>
            )}

            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="rounded-md border border-zinc-800 bg-zinc-950/70 px-2 py-0.5 text-zinc-400">
                동기화 완료 <strong className="font-mono text-emerald-300">{syncedCount}</strong>
              </span>
              <span
                className={`rounded-md border px-2 py-0.5 ${
                  pendingCount > 0
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
                    : "border-zinc-800 bg-zinc-950/70 text-zinc-400"
                }`}
              >
                대기 <strong className="font-mono">{pendingCount}</strong>
              </span>
              <span
                className={`rounded-md border px-2 py-0.5 ${
                  failedCount > 0
                    ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
                    : "border-zinc-800 bg-zinc-950/70 text-zinc-400"
                }`}
              >
                실패 <strong className="font-mono">{failedCount}</strong>
              </span>
            </div>
          </div>

          {connected && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handlePull()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-indigo-500 px-3 text-xs font-medium text-white transition hover:bg-indigo-400 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${busyAction === "pull" ? "animate-spin" : ""}`} />
                지금 Pull
              </button>

              {pendingCount > 0 && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void handleProcessQueue()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 text-xs font-medium text-amber-200 transition hover:bg-amber-500/25 disabled:opacity-50"
                >
                  <CloudUpload className="h-3.5 w-3.5" />
                  대기 큐 전송 ({pendingCount})
                </button>
              )}

              {failedCount > 0 && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void handleRetryFailed()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 text-xs font-medium text-rose-200 transition hover:bg-rose-500/25 disabled:opacity-50"
                >
                  <RotateCw className={`h-3.5 w-3.5 ${busyAction === "retry" ? "animate-spin" : ""}`} />
                  실패 재시도 ({failedCount})
                </button>
              )}

              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleDisconnect()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-xs text-zinc-300 transition hover:border-rose-500/50 hover:text-rose-300 disabled:opacity-50"
              >
                <LogOut className="h-3.5 w-3.5" />
                연결 해제
              </button>
            </div>
          )}
        </div>

        {/* Security Notice when connected */}
        {connected && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800/80 pt-3 text-[11px] text-zinc-400">
            <span className="inline-flex items-center gap-1.5">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
              인증 토큰은 OS 자격 증명 저장소(Keyring)에만 보관되며 SQLite에 평문 저장되지 않습니다.
            </span>
            <span className="font-mono text-zinc-500">
              타임존: {status?.detectedTimeZone ?? "UTC"}
            </span>
          </div>
        )}

        {/* Active OAuth2 Pending Flow Banner */}
        {authInProgress && status?.pendingAuthorizeUrl && (
          <div className="space-y-2 rounded-lg border border-sky-500/40 bg-sky-500/10 p-3 text-xs text-sky-100">
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 font-medium">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400" />
                브라우저에서 TickTick 인증을 완료하면 자동으로 연결됩니다 (PKCE + State 검증).
              </span>
              <button
                type="button"
                onClick={() => void onCancelOAuthLogin()}
                className="inline-flex items-center gap-1 rounded-md border border-sky-400/40 px-2 py-1 text-[11px] text-sky-200 hover:bg-sky-500/20"
              >
                <X className="h-3 w-3" />
                취소
              </button>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={status.pendingAuthorizeUrl}
                className="h-7 flex-1 rounded border border-sky-500/30 bg-zinc-950/90 px-2 font-mono text-[11px] text-sky-200"
              />
              <button
                type="button"
                onClick={() => void copyText("auth-url", status.pendingAuthorizeUrl!)}
                className="inline-flex h-7 items-center gap-1 rounded border border-sky-500/40 bg-zinc-950/70 px-2 text-[11px] text-sky-200 hover:bg-sky-500/20"
              >
                {copiedKey === "auth-url" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copiedKey === "auth-url" ? "복사됨" : "URL 복사"}
              </button>
            </div>
          </div>
        )}

        {/* Disconnected Login Controls */}
        {!connected && (
          <div className="space-y-3 border-t border-zinc-800/80 pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="inline-flex rounded-lg border border-zinc-800 bg-zinc-950 p-0.5 text-xs">
                <button
                  type="button"
                  onClick={() => setAuthTab("oauth2")}
                  className={`rounded-md px-3 py-1.5 font-medium transition ${
                    authTab === "oauth2"
                      ? "bg-indigo-500 text-white"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  OAuth2 루프백 로그인
                </button>
                <button
                  type="button"
                  onClick={() => setAuthTab("token")}
                  className={`rounded-md px-3 py-1.5 font-medium transition ${
                    authTab === "token"
                      ? "bg-indigo-500 text-white"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  Personal API Token
                </button>
              </div>

              {authTab === "oauth2" && (
                <button
                  type="button"
                  onClick={() => setShowOAuthConfig((v) => !v)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-zinc-700 hover:text-zinc-100"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  OAuth2 앱 설정 {status?.oauthConfigured ? "(구성됨)" : "(필요)"}
                </button>
              )}
            </div>

            {authTab === "oauth2" && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800/80 bg-zinc-950/60 px-3.5 py-3">
                  <div className="space-y-1 text-xs">
                    <div className="font-medium text-zinc-200">
                      루프백 리다이렉트 + PKCE(S256) 보안 로그인
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-400">
                      <span>TickTick Developer Portal에 등록할 Redirect URL:</span>
                      <code className="rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-indigo-300">
                        {status?.oauthRedirectUri ?? "http://127.0.0.1:18492/callback"}
                      </code>
                      <button
                        type="button"
                        onClick={() =>
                          void copyText(
                            "redirect-uri",
                            status?.oauthRedirectUri ?? "http://127.0.0.1:18492/callback",
                          )
                        }
                        className="rounded p-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                        title="Redirect URI 복사"
                      >
                        {copiedKey === "redirect-uri" ? (
                          <Check className="h-3 w-3 text-emerald-400" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>

                  <button
                    type="button"
                    disabled={busyAction !== null || authInProgress}
                    onClick={() => {
                      if (!status?.oauthConfigured) {
                        setShowOAuthConfig(true);
                        return;
                      }
                      void handleStartOAuth();
                    }}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-indigo-500 px-3.5 text-xs font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {status?.oauthConfigured ? "OAuth2로 로그인" : "OAuth2 앱 정보 입력"}
                  </button>
                </div>

                {(showOAuthConfig || !status?.oauthConfigured) && (
                  <form
                    onSubmit={(e) => void handleSaveOAuth(e)}
                    className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/70 p-3.5"
                  >
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <label className="block space-y-1 text-xs">
                        <span className="text-zinc-400">Client ID</span>
                        <input
                          type="text"
                          value={oauthClientId}
                          onChange={(e) => setOauthClientId(e.target.value)}
                          placeholder="TickTick Developer Client ID"
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                        />
                      </label>

                      <label className="block space-y-1 text-xs">
                        <span className="text-zinc-400">
                          Client Secret {status?.hasClientSecret ? "(Keyring 저장됨)" : ""}
                        </span>
                        <input
                          type="password"
                          value={oauthClientSecret}
                          onChange={(e) => setOauthClientSecret(e.target.value)}
                          placeholder={
                            status?.hasClientSecret
                              ? "변경 시에만 새로 입력"
                              : "OS Keyring에 안전 보관"
                          }
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                        />
                      </label>

                      <label className="block space-y-1 text-xs">
                        <span className="text-zinc-400">Callback Port (0 = 임시 포트)</span>
                        <input
                          type="number"
                          min={0}
                          max={65535}
                          value={oauthPort}
                          onChange={(e) => setOauthPort(e.target.value)}
                          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 font-mono text-xs text-zinc-100 focus:border-indigo-500 focus:outline-none"
                        />
                      </label>
                    </div>

                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-zinc-500">
                        Client Secret은 Windows Credential Manager / OS Keyring에만 저장됩니다.
                      </span>
                      <button
                        type="submit"
                        disabled={busyAction !== null}
                        className="rounded-lg bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
                      >
                        OAuth2 설정 저장
                      </button>
                    </div>
                  </form>
                )}
              </div>
            )}

            {authTab === "token" && (
              <form
                onSubmit={(e) => void handleConnectToken(e)}
                className="space-y-2.5 rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-3.5"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[240px] flex-1">
                    <KeyRound className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                    <input
                      type="password"
                      value={personalToken}
                      onChange={(e) => setPersonalToken(e.target.value)}
                      placeholder="TickTick Personal API Token 입력..."
                      className="h-9 w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-8 pr-3 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500 focus:outline-none"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={busyAction !== null}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-indigo-500 px-3.5 text-xs font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
                  >
                    {busyAction === "token-login" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    검증 후 연결
                  </button>
                </div>
                <p className="text-[11px] text-zinc-500">
                  TickTick Web → Settings → Account → API Token에서 발급할 수 있으며, 입력한 토큰은
                  즉시 API 검증 후 OS Keyring에 저장됩니다.
                </p>
              </form>
            )}
          </div>
        )}

        {/* Error Banner */}
        {(actionError || status?.lastSyncError) && (
          <div className="flex items-start justify-between gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            <span className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" />
              <span>{actionError ?? status?.lastSyncError}</span>
            </span>
            {actionError && (
              <button
                type="button"
                onClick={() => setActionError(null)}
                className="rounded p-0.5 text-rose-300 hover:bg-rose-500/20"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Cached Projects & Tasks Explorer */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
        {/* Project Sidebar */}
        <div className="space-y-1 rounded-xl border border-zinc-800/80 bg-zinc-900/50 p-2 md:col-span-4">
          <button
            type="button"
            onClick={() => setSelectedProjectId("all")}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-medium transition ${
              selectedProjectId === "all"
                ? "bg-indigo-500/15 text-indigo-300"
                : "text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            <span className="flex items-center gap-2">
              <CheckSquare className="h-3.5 w-3.5" />
              모든 태스크
            </span>
            <span className="font-mono text-[11px] text-zinc-400">{visiblePool.length}</span>
          </button>

          {projects.map((project) => {
            const active = selectedProjectId === project.id;
            return (
              <button
                key={project.id}
                type="button"
                onClick={() => setSelectedProjectId(project.id)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-medium transition ${
                  active
                    ? "bg-indigo-500/15 text-indigo-200"
                    : "text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {project.isInbox ? (
                    <Inbox className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                  ) : (
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: project.color ?? "#6366f1" }}
                    />
                  )}
                  <span className="truncate">{project.name}</span>
                </span>
                <span className="font-mono text-[11px] text-zinc-500">
                  {countByProject.get(project.id) ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        {/* Task List */}
        <div className="md:col-span-8">
          {filteredTasks.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/40 p-10 text-center text-xs text-zinc-400">
              {connected
                ? "표시할 태스크가 없습니다. 상단의 [지금 Pull] 버튼으로 최신 태스크를 불러오세요."
                : "표시할 캐시 태스크가 없습니다. TickTick 계정을 연결해 프로젝트와 태스크를 동기화하세요."}
            </div>
          ) : (
            <ul className="divide-y divide-zinc-800/70 overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/50">
              {filteredTasks.map((task) => {
                const project = projectMap.get(task.projectId);
                const dueLabel = formatDueDateShort(task.dueDate);
                const isCompleted = task.status === 2;
                return (
                  <li
                    key={task.id}
                    className={`flex items-center justify-between gap-3 px-4 py-3 transition hover:bg-zinc-800/40 ${
                      isCompleted ? "opacity-60" : ""
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {isCompleted && (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                        )}
                        <span
                          className={`truncate text-sm font-medium ${
                            isCompleted ? "text-zinc-400 line-through" : "text-zinc-100"
                          }`}
                        >
                          {task.title}
                        </span>
                        {project && (
                          <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-zinc-800 bg-zinc-950/80 px-2 py-0.5 text-[10px] text-zinc-300">
                            <span
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ backgroundColor: project.color ?? "#6366f1" }}
                            />
                            {project.name}
                          </span>
                        )}
                        {dueLabel && (
                          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] text-zinc-400">
                            <Calendar className="h-2.5 w-2.5 text-zinc-500" />
                            {dueLabel}
                          </span>
                        )}
                      </div>
                      {task.content && (
                        <p className="mt-0.5 truncate text-xs text-zinc-500">{task.content}</p>
                      )}
                      {task.tags.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {task.tags.map((t) => (
                            <span
                              key={t}
                              className="inline-flex items-center gap-0.5 rounded bg-zinc-800/80 px-1.5 py-0.5 text-[10px] text-zinc-300"
                            >
                              <TagIcon className="h-2.5 w-2.5 text-zinc-500" />#{t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => void onStartTaskTimer(task)}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-indigo-500/15 px-3 py-1.5 text-xs font-medium text-indigo-300 transition hover:bg-indigo-500 hover:text-white"
                    >
                      <Play className="h-3 w-3 fill-current" />
                      타이머 시작
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
