export type SyncStatus = "local" | "pending" | "synced" | "failed";

export type SyncMode = "subtask" | "fallback_list";

export type NavTab = "timer" | "timeline" | "ticktick" | "settings";

export interface ActiveWindowInfo {
  source: string;
  processName: string;
  windowTitle: string | null;
  metadataJson: string | null;
}

export interface PlatformStatus {
  os: string;
  arch: string;
  activeWindow: ActiveWindowInfo | null;
  idleMs: number;
  schemaVersion?: number;
}

export interface ActivityLog {
  id: number;
  source: string;
  processName: string;
  windowTitle: string | null;
  metadataJson: string | null;
  isIdle: boolean;
  startedAt: number;
  endedAt: number;
}

export interface DiscoverableApp {
  processName: string;
  windowTitle: string | null;
  isRunning: boolean;
  lastSeenAt: number | null;
  totalDurationMs: number;
}

export interface TimeEntry {
  id: string;
  description: string;
  startedAt: number;
  endedAt: number | null;
  ticktickProjectId: string | null;
  ticktickParentTaskId: string | null;
  ticktickSubtaskId: string | null;
  syncMode: string | null;
  syncStatus: SyncStatus;
  syncError: string | null;
  retryCount: number;
  completeParentTask: boolean;
  tagIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface StartTimerInput {
  description: string;
  ticktickProjectId: string | null;
  ticktickParentTaskId: string | null;
  tagIds: string[];
  startedAt?: number | null;
}

export interface CreateTimeEntryInput {
  description: string;
  startedAt: number;
  endedAt: number;
  ticktickProjectId?: string | null;
  ticktickParentTaskId?: string | null;
  tagIds?: string[];
  completeParentTask?: boolean;
}

export interface UpdateTimeEntryInput {
  description?: string;
  startedAt?: number;
  endedAt?: number;
  ticktickProjectId?: string | null;
  ticktickParentTaskId?: string | null;
  tagIds?: string[];
  completeParentTask?: boolean;
}

export interface TickTickProject {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
  isInbox: boolean;
  closed: boolean;
  syncedAt: number;
}

export interface TickTickTask {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  content: string | null;
  tags: string[];
  status: number; // 0: open, 2: completed
  startDate: string | null;
  dueDate: string | null;
  syncedAt: number;
}

export interface Tag {
  id: string;
  name: string;
  source: string;
  color: string | null;
  createdAt: number;
}

export interface ParsedQuickEntry {
  description: string;
  projectHint: string | null;
  tagNames: string[];
}

export interface ShortcutStatus {
  toggleTimerRegistered: boolean;
  quickEntryRegistered: boolean;
  warnings: string[];
}

export interface AppSettings {
  pollIntervalMs: number;
  idleThresholdMs: number;
  sleepGapThresholdMs: number;
  redactedProcesses: string[];
  redactedTitleKeywords: string[];
  excludedProcesses: string[];
  syncMode: SyncMode;
  fallbackProjectId: string | null;
  stopTimerOnQuit: boolean;
  timelineMinDurationMs: number;
  shortcutToggleTimer: string | null;
  shortcutQuickEntry: string | null;
  miniTimerAlwaysOnTop: boolean;
  autoSyncOnStop: boolean;
  ticktickTimeZone: string | null;
  ticktickOauthClientId: string | null;
  ticktickOauthRedirectPort: number;
}

export type TickTickAuthMethod = "oauth2" | "personal_token";

export interface TickTickSyncQueueSummary {
  localCount: number;
  pendingCount: number;
  syncedCount: number;
  failedCount: number;
}

export interface TickTickConnectionStatus {
  connected: boolean;
  authMethod: TickTickAuthMethod | null;
  oauthConfigured: boolean;
  hasClientSecret: boolean;
  oauthClientId: string | null;
  oauthRedirectPort: number;
  oauthRedirectUri: string;
  authInProgress: boolean;
  pendingAuthorizeUrl: string | null;
  tokenExpiresAt: number | null;
  lastPullAt: number | null;
  lastSyncError: string | null;
  detectedTimeZone: string;
  queue: TickTickSyncQueueSummary;
}

export interface TickTickPullResult {
  projectsSynced: number;
  tasksSynced: number;
  tagsSynced: number;
  syncedAt: number;
  warnings: string[];
}

export interface TickTickSyncBatchResult {
  processed: number;
  synced: number;
  failed: number;
  skipped: number;
}

export interface OAuthLoginStartResult {
  authorizeUrl: string;
  redirectUri: string;
}

export interface SaveOAuthConfigInput {
  clientId: string;
  clientSecret?: string | null;
  redirectPort?: number | null;
}

export interface IdleReturnPrompt {
  entryId: string;
  entryDescription: string;
  idleStartedAt: number;
  returnedAt: number;
  idleDurationMs: number;
}

export type IdleResolutionAction = "keep" | "discard" | "discard_and_continue" | "split";

export interface IdleResolutionInput {
  entryId: string;
  action: IdleResolutionAction;
  idleStartedAt: number;
  returnedAt: number;
  idleDescription?: string | null;
  resumeOriginal?: boolean;
}

export interface IdleResolutionResult {
  action: IdleResolutionAction;
  updatedEntry: TimeEntry;
  idleEntry: TimeEntry | null;
  resumedEntry: TimeEntry | null;
}

export interface PresenceOverride {
  source: string;
  targetProcesses: string[];
  windowTitle: string | null;
  metadataJson: string | null;
  receivedAtMs: number;
  ttlMs: number;
}
