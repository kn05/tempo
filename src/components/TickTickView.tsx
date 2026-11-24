import {
  AlertCircle,
  Calendar,
  Check,
  CheckCircle2,
  CheckSquare,
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
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { formatTimeHm } from "../lib/time";
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

function formatDueDateShort(raw: string | null): string | null {
  if (!raw) return null;
  const datePart = raw.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart.slice(5);
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
      // Ignore clipboard permission errors.
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
        redirectPort:
          Number.isFinite(parsedPort) && parsedPort >= 0 && parsedPort <= 65535
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
      setActionError("API Token을 입력하세요.");
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
    <section className="mx-auto max-w-5xl space-y-5">
      {/* Compact Connection & Sync Strip */}
      <div className="space-y-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left: Connection State + Sync Counters */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              {connected ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/12 px-2.5 py-1 text-xs font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/25">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span>{status?.authMethod === "oauth2" ? "OAuth2" : "API Token"}</span>
                  <span title="OS Keyring 보관">
                    <ShieldCheck className="h-3 w-3 text-emerald-400/80" />
                  </span>
                </span>
              ) : authInProgress ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-sky-500/12 px-2.5 py-1 text-xs font-medium text-sky-300 ring-1 ring-inset ring-sky-500/25">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>인증 중</span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-white/[0.05] px-2.5 py-1 text-xs font-medium text-zinc-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
                  <span>오프라인</span>
                </span>
              )}
            </div>

            <div className="h-4 w-px bg-white/[0.07]" aria-hidden="true" />

            {/* Compact Queue Counters */}
            <div className="flex items-center gap-3 text-xs tabular-nums">
              <span className="flex items-center gap-1.5 text-zinc-400" title="동기화 완료">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80" />
                <span className="font-mono font-medium text-zinc-200">{syncedCount}</span>
              </span>
              <span
                className={`flex items-center gap-1.5 ${pendingCount > 0 ? "text-amber-300" : "text-zinc-500"}`}
                title="대기 중"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${pendingCount > 0 ? "bg-amber-400" : "bg-zinc-700"}`}
                />
                <span className="font-mono font-medium">{pendingCount}</span>
              </span>
              <span
                className={`flex items-center gap-1.5 ${failedCount > 0 ? "text-rose-300" : "text-zinc-500"}`}
                title="실패"
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full ${failedCount > 0 ? "bg-rose-400" : "bg-zinc-700"}`}
                />
                <span className="font-mono font-medium">{failedCount}</span>
              </span>
            </div>

            {status?.lastPullAt && (
              <span className="hidden font-mono text-[11px] tabular-nums text-zinc-500 sm:inline">
                {formatTimeHm(status.lastPullAt)}
              </span>
            )}
          </div>

          {/* Right: Contextual Actions */}
          {connected ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {pendingCount > 0 && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void handleProcessQueue()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-amber-500/15 px-2.5 text-xs font-medium text-amber-300 ring-1 ring-inset ring-amber-500/25 transition-colors hover:bg-amber-500/25 disabled:opacity-50"
                >
                  <CloudUpload className="h-3.5 w-3.5" />
                  <span>전송 {pendingCount}</span>
                </button>
              )}

              {failedCount > 0 && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void handleRetryFailed()}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-rose-500/15 px-2.5 text-xs font-medium text-rose-300 ring-1 ring-inset ring-rose-500/25 transition-colors hover:bg-rose-500/25 disabled:opacity-50"
                >
                  <RotateCw
                    className={`h-3.5 w-3.5 ${busyAction === "retry" ? "animate-spin" : ""}`}
                  />
                  <span>재시도 {failedCount}</span>
                </button>
              )}

              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handlePull()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-indigo-500 px-3 text-xs font-medium text-white transition-colors hover:bg-indigo-400 disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${busyAction === "pull" ? "animate-spin" : ""}`}
                />
                <span>Pull</span>
              </button>

              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => void handleDisconnect()}
                title="연결 해제"
                className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-50"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <div className="inline-flex h-8 items-center rounded-lg border border-white/[0.08] bg-black/30 p-0.5 text-[11px]">
                <button
                  type="button"
                  onClick={() => setAuthTab("oauth2")}
                  className={`h-7 rounded-md px-2.5 font-medium transition-colors ${
                    authTab === "oauth2"
                      ? "bg-white/[0.1] text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  OAuth2
                </button>
                <button
                  type="button"
                  onClick={() => setAuthTab("token")}
                  className={`h-7 rounded-md px-2.5 font-medium transition-colors ${
                    authTab === "token"
                      ? "bg-white/[0.1] text-zinc-100"
                      : "text-zinc-500 hover:text-zinc-300"
                  }`}
                >
                  API Token
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Active OAuth2 Pending Flow */}
        {authInProgress && status?.pendingAuthorizeUrl && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-sky-500/30 bg-sky-500/10 p-2.5 text-xs">
            <input
              type="text"
              readOnly
              value={status.pendingAuthorizeUrl}
              className="h-7 min-w-[200px] flex-1 rounded-md border border-sky-500/25 bg-zinc-950/90 px-2 font-mono text-[11px] text-sky-200 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void copyText("auth-url", status.pendingAuthorizeUrl!)}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-sky-500/20 px-2 text-[11px] text-sky-200 transition-colors hover:bg-sky-500/30"
            >
              {copiedKey === "auth-url" ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              <span>{copiedKey === "auth-url" ? "복사됨" : "복사"}</span>
            </button>
            <button
              type="button"
              onClick={() => void onCancelOAuthLogin()}
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[11px] text-sky-300 transition-colors hover:bg-sky-500/20"
            >
              <X className="h-3 w-3" />
              <span>취소</span>
            </button>
          </div>
        )}

        {/* Disconnected Compact Auth Bar */}
        {!connected && (
          <div className="space-y-2.5 border-t border-white/[0.06] pt-3">
            {authTab === "oauth2" ? (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                    <span>Redirect</span>
                    <code className="rounded-md bg-black/40 px-2 py-1 font-mono text-zinc-300">
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
                      className="rounded-md p-1 text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
                      title="복사"
                    >
                      {copiedKey === "redirect-uri" ? (
                        <Check className="h-3 w-3 text-emerald-400" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>

                  <div className="flex items-center gap-2">
                    {status?.oauthConfigured && (
                      <button
                        type="button"
                        onClick={() => setShowOAuthConfig((v) => !v)}
                        className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs transition-colors ${
                          showOAuthConfig
                            ? "bg-white/[0.1] text-zinc-100"
                            : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-200"
                        }`}
                      >
                        <Settings2 className="h-3.5 w-3.5" />
                        <span>앱 설정</span>
                      </button>
                    )}

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
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-indigo-500 px-3.5 text-xs font-medium text-white transition-colors hover:bg-indigo-400 disabled:opacity-50"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      <span>로그인</span>
                    </button>
                  </div>
                </div>

                {(showOAuthConfig || !status?.oauthConfigured) && (
                  <form
                    onSubmit={(e) => void handleSaveOAuth(e)}
                    className="flex flex-wrap items-end gap-2 rounded-lg bg-black/25 p-3"
                  >
                    <label className="min-w-[160px] flex-1 space-y-1 text-[11px]">
                      <span className="text-zinc-500">Client ID</span>
                      <input
                        type="text"
                        value={oauthClientId}
                        onChange={(e) => setOauthClientId(e.target.value)}
                        placeholder="Client ID"
                        className="h-8 w-full rounded-lg border border-white/[0.08] bg-zinc-950/90 px-2.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500/70 focus:outline-none"
                      />
                    </label>

                    <label className="min-w-[160px] flex-1 space-y-1 text-[11px]">
                      <span className="flex items-center gap-1.5 text-zinc-500">
                        <span>Client Secret</span>
                        {status?.hasClientSecret && (
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" title="저장됨" />
                        )}
                      </span>
                      <input
                        type="password"
                        value={oauthClientSecret}
                        onChange={(e) => setOauthClientSecret(e.target.value)}
                        placeholder={status?.hasClientSecret ? "••••••••" : "Client Secret"}
                        className="h-8 w-full rounded-lg border border-white/[0.08] bg-zinc-950/90 px-2.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500/70 focus:outline-none"
                      />
                    </label>

                    <label className="w-24 space-y-1 text-[11px]">
                      <span className="text-zinc-500">Port</span>
                      <input
                        type="number"
                        min={0}
                        max={65535}
                        value={oauthPort}
                        onChange={(e) => setOauthPort(e.target.value)}
                        className="h-8 w-full rounded-lg border border-white/[0.08] bg-zinc-950/90 px-2.5 font-mono text-xs text-zinc-100 focus:border-indigo-500/70 focus:outline-none"
                      />
                    </label>

                    <button
                      type="submit"
                      disabled={busyAction !== null}
                      className="h-8 rounded-lg bg-white/[0.1] px-3 text-xs font-medium text-zinc-100 transition-colors hover:bg-white/[0.16] disabled:opacity-50"
                    >
                      저장
                    </button>
                  </form>
                )}
              </div>
            ) : (
              <form
                onSubmit={(e) => void handleConnectToken(e)}
                className="flex flex-wrap items-center gap-2"
              >
                <div className="relative min-w-[240px] flex-1">
                  <KeyRound className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
                  <input
                    type="password"
                    value={personalToken}
                    onChange={(e) => setPersonalToken(e.target.value)}
                    placeholder="Personal API Token"
                    className="h-8 w-full rounded-lg border border-white/[0.08] bg-zinc-950/90 pl-8 pr-3 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-indigo-500/70 focus:outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={busyAction !== null}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-indigo-500 px-3.5 text-xs font-medium text-white transition-colors hover:bg-indigo-400 disabled:opacity-50"
                >
                  {busyAction === "token-login" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  <span>연결</span>
                </button>
              </form>
            )}
          </div>
        )}

        {/* Error Banner */}
        {(actionError || status?.lastSyncError) && (
          <div className="flex items-center justify-between gap-2 rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300 ring-1 ring-inset ring-rose-500/25">
            <span className="flex min-w-0 items-center gap-2">
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
              <span className="truncate">{actionError ?? status?.lastSyncError}</span>
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

      {/* Master-Detail Projects & Tasks Explorer */}
      <div className="grid grid-cols-1 gap-5 md:grid-cols-12">
        {/* Left Project Rail */}
        <div className="space-y-0.5 md:col-span-3">
          <button
            type="button"
            onClick={() => setSelectedProjectId("all")}
            className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
              selectedProjectId === "all"
                ? "bg-white/[0.08] text-zinc-100"
                : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
            }`}
          >
            <span className="flex items-center gap-2">
              <CheckSquare className="h-3.5 w-3.5 text-indigo-400" />
              <span>전체</span>
            </span>
            <span className="font-mono text-[11px] tabular-nums text-zinc-500">
              {visiblePool.length}
            </span>
          </button>

          {projects.map((project) => {
            const active = selectedProjectId === project.id;
            return (
              <button
                key={project.id}
                type="button"
                onClick={() => setSelectedProjectId(project.id)}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                  active
                    ? "bg-white/[0.08] text-zinc-100"
                    : "text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200"
                }`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  {project.isInbox ? (
                    <Inbox className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  ) : (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: project.color ?? "#6366f1" }}
                    />
                  )}
                  <span className="truncate">{project.name}</span>
                </span>
                <span className="font-mono text-[11px] tabular-nums text-zinc-500">
                  {countByProject.get(project.id) ?? 0}
                </span>
              </button>
            );
          })}
        </div>

        {/* Right Task Workspace */}
        <div className="space-y-3 md:col-span-9">
          {/* Task Filter Bar */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="relative flex-1 max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="태스크 검색..."
                className="h-8 w-full rounded-lg border border-white/[0.07] bg-white/[0.03] pl-8 pr-7 text-xs text-zinc-100 placeholder:text-zinc-500 focus:border-indigo-500/60 focus:outline-none"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => setShowCompleted((v) => !v)}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors ${
                showCompleted
                  ? "bg-indigo-500/15 text-indigo-300 ring-1 ring-inset ring-indigo-500/30"
                  : "text-zinc-500 hover:bg-white/[0.05] hover:text-zinc-300"
              }`}
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              <span>완료 포함</span>
            </button>
          </div>

          {filteredTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] py-14 text-center">
              <CheckSquare className="h-5 w-5 text-zinc-600" />
              <p className="mt-2.5 text-xs font-medium text-zinc-500">태스크 없음</p>
              {connected && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void handlePull()}
                  className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg bg-white/[0.06] px-3 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/[0.1]"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Pull</span>
                </button>
              )}
            </div>
          ) : (
            <ul className="divide-y divide-white/[0.05] overflow-hidden rounded-xl border border-white/[0.06] bg-white/[0.02]">
              {filteredTasks.map((task) => {
                const project = projectMap.get(task.projectId);
                const dueLabel = formatDueDateShort(task.dueDate);
                const isCompleted = task.status === 2;
                return (
                  <li
                    key={task.id}
                    className={`group flex items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-white/[0.03] ${
                      isCompleted ? "opacity-55" : ""
                    }`}
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        {isCompleted && (
                          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                        )}
                        <span
                          className={`truncate text-[13.5px] font-medium ${
                            isCompleted ? "text-zinc-400 line-through" : "text-zinc-100"
                          }`}
                        >
                          {task.title}
                        </span>

                        {selectedProjectId === "all" && project && (
                          <span className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-400">
                            <span
                              className="h-1.5 w-1.5 rounded-full"
                              style={{ backgroundColor: project.color ?? "#6366f1" }}
                            />
                            <span>{project.name}</span>
                          </span>
                        )}

                        {dueLabel && (
                          <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[10.5px] tabular-nums text-zinc-500">
                            <Calendar className="h-3 w-3" />
                            <span>{dueLabel}</span>
                          </span>
                        )}

                        {task.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {task.tags.map((t) => (
                              <span
                                key={t}
                                className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-zinc-400"
                              >
                                #{t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {task.content && (
                        <p className="truncate text-xs text-zinc-500">{task.content}</p>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => void onStartTaskTimer(task)}
                      title="타이머 시작"
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-500/12 text-indigo-300 transition-all hover:bg-indigo-500 hover:text-white group-hover:bg-indigo-500/25"
                    >
                      <Play className="ml-0.5 h-3.5 w-3.5 fill-current" />
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
