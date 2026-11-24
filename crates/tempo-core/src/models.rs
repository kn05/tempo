use serde::{Deserialize, Deserializer, Serialize};

fn default_true() -> bool {
    true
}

fn default_shortcut_toggle_timer() -> Option<String> {
    Some("Ctrl+Alt+S".into())
}

fn default_shortcut_quick_entry() -> Option<String> {
    Some("Ctrl+Alt+T".into())
}

pub const DEFAULT_TICKTICK_OAUTH_REDIRECT_PORT: u16 = 18492;

fn default_ticktick_oauth_redirect_port() -> u16 {
    DEFAULT_TICKTICK_OAUTH_REDIRECT_PORT
}

fn deserialize_optional_nullable<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityLog {
    pub id: i64,
    pub source: String,
    pub process_name: String,
    pub window_title: Option<String>,
    pub metadata_json: Option<String>,
    pub is_idle: bool,
    pub started_at: i64,
    pub ended_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewActivityLog {
    pub source: String,
    pub process_name: String,
    pub window_title: Option<String>,
    pub metadata_json: Option<String>,
    pub is_idle: bool,
    pub started_at: i64,
    pub ended_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatus {
    Local,
    Pending,
    Synced,
    Failed,
}

impl SyncStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Pending => "pending",
            Self::Synced => "synced",
            Self::Failed => "failed",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "pending" => Self::Pending,
            "synced" => Self::Synced,
            "failed" => Self::Failed,
            _ => Self::Local,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SyncMode {
    Subtask,
    FallbackList,
}

impl Default for SyncMode {
    fn default() -> Self {
        Self::Subtask
    }
}

impl SyncMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Subtask => "subtask",
            Self::FallbackList => "fallback_list",
        }
    }

    pub fn from_db(value: &str) -> Self {
        match value {
            "fallback_list" => Self::FallbackList,
            _ => Self::Subtask,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TimeEntry {
    pub id: String,
    pub description: String,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub ticktick_project_id: Option<String>,
    pub ticktick_parent_task_id: Option<String>,
    pub ticktick_subtask_id: Option<String>,
    pub sync_mode: Option<String>,
    pub sync_status: SyncStatus,
    pub sync_error: Option<String>,
    pub retry_count: i64,
    pub complete_parent_task: bool,
    pub tag_ids: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTimerInput {
    pub description: String,
    pub ticktick_project_id: Option<String>,
    pub ticktick_parent_task_id: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    pub started_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTimeEntryInput {
    pub description: String,
    pub started_at: i64,
    pub ended_at: i64,
    #[serde(default)]
    pub ticktick_project_id: Option<String>,
    #[serde(default)]
    pub ticktick_parent_task_id: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    #[serde(default)]
    pub complete_parent_task: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTimeEntryInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_nullable"
    )]
    pub ticktick_project_id: Option<Option<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_nullable"
    )]
    pub ticktick_parent_task_id: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complete_parent_task: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Foreground window polling interval in milliseconds (default: 2000ms).
    pub poll_interval_ms: u64,
    /// User input inactivity threshold in milliseconds (default: 300_000ms = 5 min).
    pub idle_threshold_ms: u64,
    /// Maximum gap between polls before forcing a new activity span (default: 10_000ms).
    pub sleep_gap_threshold_ms: i64,
    /// Process names (case-insensitive) whose window titles are masked as "[Redacted]".
    pub redacted_processes: Vec<String>,
    /// Case-insensitive title substrings that trigger title masking as "[Redacted]".
    pub redacted_title_keywords: Vec<String>,
    /// Process names (case-insensitive) excluded from `activity_logs` recording (Denylist).
    pub excluded_processes: Vec<String>,
    /// TickTick sync strategy ("subtask" default per PoC, or "fallback_list").
    pub sync_mode: SyncMode,
    /// Optional TickTick project ID used when `sync_mode == FallbackList`.
    pub fallback_project_id: Option<String>,
    /// Whether quitting the app automatically stops any currently running manual timer.
    pub stop_timer_on_quit: bool,
    /// Minimum activity span duration (ms) used as a UI display filter (raw DB preserves all).
    pub timeline_min_duration_ms: i64,
    /// Global shortcut to toggle (start/stop) the manual timer. `None` disables the shortcut.
    #[serde(default = "default_shortcut_toggle_timer")]
    pub shortcut_toggle_timer: Option<String>,
    /// Global shortcut to focus the quick-entry timer input bar. `None` disables the shortcut.
    #[serde(default = "default_shortcut_quick_entry")]
    pub shortcut_quick_entry: Option<String>,
    /// Whether the floating Mini Timer window stays always on top.
    #[serde(default = "default_true")]
    pub mini_timer_always_on_top: bool,
    /// Whether stopping a manual timer automatically enqueues TickTick sync for task-linked entries.
    #[serde(default)]
    pub auto_sync_on_stop: bool,
    /// Optional IANA timezone override for TickTick task timestamps (None = auto-detect OS timezone).
    #[serde(default)]
    pub ticktick_time_zone: Option<String>,
    /// TickTick OAuth2 application client_id (non-secret; client_secret lives in OS keyring).
    #[serde(default)]
    pub ticktick_oauth_client_id: Option<String>,
    /// Loopback callback port for TickTick OAuth2 (`http://127.0.0.1:<port>/callback`; 0 = ephemeral).
    #[serde(default = "default_ticktick_oauth_redirect_port")]
    pub ticktick_oauth_redirect_port: u16,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub toggle_timer_registered: bool,
    pub quick_entry_registered: bool,
    pub warnings: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            poll_interval_ms: 2_000,
            idle_threshold_ms: 5 * 60 * 1_000,
            sleep_gap_threshold_ms: 10_000,
            redacted_processes: vec![
                "1password.exe".into(),
                "bitwarden.exe".into(),
                "keepass.exe".into(),
                "keepassxc.exe".into(),
            ],
            redacted_title_keywords: vec![
                "InPrivate".into(),
                "Incognito".into(),
                "Private Browsing".into(),
                "시크릿".into(),
            ],
            excluded_processes: Vec::new(),
            sync_mode: SyncMode::Subtask,
            fallback_project_id: None,
            stop_timer_on_quit: false,
            timeline_min_duration_ms: 0,
            shortcut_toggle_timer: default_shortcut_toggle_timer(),
            shortcut_quick_entry: default_shortcut_quick_entry(),
            mini_timer_always_on_top: true,
            auto_sync_on_stop: false,
            ticktick_time_zone: None,
            ticktick_oauth_client_id: None,
            ticktick_oauth_redirect_port: DEFAULT_TICKTICK_OAUTH_REDIRECT_PORT,
        }
    }
}

impl AppSettings {
    pub fn sanitized(&self) -> Self {
        let clean_list = |items: &[String]| -> Vec<String> {
            items
                .iter()
                .map(|item| item.trim())
                .filter(|item| !item.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        };
        let clean_opt = |value: &Option<String>| -> Option<String> {
            value
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(ToOwned::to_owned)
        };

        Self {
            poll_interval_ms: self.poll_interval_ms.clamp(250, 60_000),
            idle_threshold_ms: self.idle_threshold_ms.clamp(5_000, 86_400_000),
            sleep_gap_threshold_ms: self.sleep_gap_threshold_ms.clamp(1_000, 3_600_000),
            redacted_processes: clean_list(&self.redacted_processes),
            redacted_title_keywords: clean_list(&self.redacted_title_keywords),
            excluded_processes: clean_list(&self.excluded_processes),
            sync_mode: self.sync_mode.clone(),
            fallback_project_id: clean_opt(&self.fallback_project_id),
            stop_timer_on_quit: self.stop_timer_on_quit,
            timeline_min_duration_ms: self.timeline_min_duration_ms.max(0),
            shortcut_toggle_timer: clean_opt(&self.shortcut_toggle_timer),
            shortcut_quick_entry: clean_opt(&self.shortcut_quick_entry),
            mini_timer_always_on_top: self.mini_timer_always_on_top,
            auto_sync_on_stop: self.auto_sync_on_stop,
            ticktick_time_zone: clean_opt(&self.ticktick_time_zone),
            ticktick_oauth_client_id: clean_opt(&self.ticktick_oauth_client_id),
            ticktick_oauth_redirect_port: self.ticktick_oauth_redirect_port,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdleReturnPrompt {
    pub entry_id: String,
    pub entry_description: String,
    pub idle_started_at: i64,
    pub returned_at: i64,
    pub idle_duration_ms: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IdleResolutionAction {
    Keep,
    Discard,
    DiscardAndContinue,
    Split,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdleResolutionInput {
    pub entry_id: String,
    pub action: IdleResolutionAction,
    pub idle_started_at: i64,
    pub returned_at: i64,
    #[serde(default)]
    pub idle_description: Option<String>,
    #[serde(default = "default_true")]
    pub resume_original: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IdleResolutionResult {
    pub action: IdleResolutionAction,
    pub updated_entry: TimeEntry,
    pub idle_entry: Option<TimeEntry>,
    pub resumed_entry: Option<TimeEntry>,
}

/// External extension heartbeat payload reserved for Phase 4 local IPC (`POST /v1/presence`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PresenceOverride {
    pub source: String,
    /// Focused process names (case-insensitive) to override; empty matches any focused process.
    #[serde(default)]
    pub target_processes: Vec<String>,
    pub window_title: Option<String>,
    pub metadata_json: Option<String>,
    pub received_at_ms: i64,
    pub ttl_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TickTickProject {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i64,
    pub is_inbox: bool,
    pub closed: bool,
    pub synced_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TickTickTask {
    pub id: String,
    pub project_id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub content: Option<String>,
    pub tags: Vec<String>,
    pub status: i64,
    pub start_date: Option<String>,
    pub due_date: Option<String>,
    pub synced_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub source: String,
    pub color: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TickTickAuthMethod {
    #[serde(rename = "oauth2")]
    OAuth2,
    PersonalToken,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TickTickSyncQueueSummary {
    pub local_count: i64,
    pub pending_count: i64,
    pub synced_count: i64,
    pub failed_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TickTickConnectionStatus {
    pub connected: bool,
    pub auth_method: Option<TickTickAuthMethod>,
    pub oauth_configured: bool,
    pub has_client_secret: bool,
    pub oauth_client_id: Option<String>,
    pub oauth_redirect_port: u16,
    pub oauth_redirect_uri: String,
    pub auth_in_progress: bool,
    pub pending_authorize_url: Option<String>,
    pub token_expires_at: Option<i64>,
    pub last_pull_at: Option<i64>,
    pub last_sync_error: Option<String>,
    pub detected_time_zone: String,
    pub queue: TickTickSyncQueueSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TickTickPullResult {
    pub projects_synced: usize,
    pub tasks_synced: usize,
    pub tags_synced: usize,
    pub synced_at: i64,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TickTickSyncBatchResult {
    pub processed: usize,
    pub synced: usize,
    pub failed: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OAuthLoginStartResult {
    pub authorize_url: String,
    pub redirect_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOAuthConfigInput {
    pub client_id: String,
    /// `None` preserves any stored secret, `Some("")` clears it, `Some(val)` stores it in OS keyring.
    #[serde(default)]
    pub client_secret: Option<String>,
    #[serde(default)]
    pub redirect_port: Option<u16>,
}
