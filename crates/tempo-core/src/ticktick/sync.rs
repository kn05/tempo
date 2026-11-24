use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::Utc;
use reqwest::Client;
use thiserror::Error;
use tokio::sync::{oneshot, Mutex as AsyncMutex, Notify};

use crate::db::{
    Database, DbError, SETTING_TICKTICK_LAST_PULL_AT, SETTING_TICKTICK_LAST_SYNC_ERROR,
};
use crate::models::{
    OAuthLoginStartResult, SaveOAuthConfigInput, SyncMode, SyncStatus, TickTickAuthMethod,
    TickTickConnectionStatus, TickTickProject, TickTickPullResult, TickTickSyncBatchResult,
    TickTickTask, TimeEntry,
};
use crate::ticktick::client::{
    build_default_http_client, format_ticktick_timestamp, CreateTaskRequest, TaskFilterRequest,
    TickTickClient, TickTickError, TickTickTaskDto, TICKTICK_API_BASE,
};
use crate::ticktick::oauth::{
    build_authorize_url, exchange_authorization_code, format_redirect_uri, generate_oauth_state,
    generate_pkce, refresh_access_token, LoopbackCallbackListener, OAuthEndpoints, OAuthError,
};
use crate::ticktick::secrets::{CredentialManager, SecretError, TickTickCredentials};

pub const DEFAULT_OAUTH_TIMEOUT_SECS: u64 = 300;
pub const DEFAULT_SYNC_WORKER_INTERVAL_SECS: u64 = 30;
pub const MAX_AUTO_SYNC_RETRIES: i64 = 5;

const TOKEN_REFRESH_LEEWAY_MS: i64 = 60_000;

#[derive(Debug, Error)]
pub enum SyncServiceError {
    #[error("TickTick 계정이 연결되어 있지 않습니다. 먼저 로그인해주세요.")]
    NotConnected,
    #[error("TickTick 인증이 만료되었거나 유효하지 않습니다. 다시 로그인해주세요.")]
    Unauthorized,
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Database error: {0}")]
    Db(#[from] DbError),
    #[error("Secret storage error: {0}")]
    Secret(#[from] SecretError),
    #[error("OAuth2 error: {0}")]
    OAuth(#[from] OAuthError),
    #[error("TickTick API error: {0}")]
    Api(#[from] TickTickError),
}

struct ActiveOAuthFlow {
    authorize_url: String,
    cancel_tx: Option<oneshot::Sender<()>>,
}

/// Handle representing a bound loopback OAuth2 session waiting for browser callback completion.
pub struct PendingOAuthSession {
    service: Arc<TickTickService>,
    listener: LoopbackCallbackListener,
    client_id: String,
    client_secret: String,
    state: String,
    code_verifier: String,
    redirect_uri: String,
    cancel_rx: oneshot::Receiver<()>,
    timeout: Duration,
}

impl PendingOAuthSession {
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub async fn wait_and_complete(self) -> Result<TickTickConnectionStatus, SyncServiceError> {
        let code_res = self
            .listener
            .wait_for_code(&self.state, self.timeout, self.cancel_rx)
            .await;

        let code = match code_res {
            Ok(code) => code,
            Err(err) => {
                self.service.clear_active_oauth_flow();
                if !matches!(err, OAuthError::Cancelled) {
                    self.service.record_last_error(Some(&err.to_string()));
                }
                return Err(SyncServiceError::OAuth(err));
            }
        };

        let exchange_res = exchange_authorization_code(
            &self.service.http,
            &self.service.oauth_endpoints,
            &self.client_id,
            &self.client_secret,
            &code,
            &self.redirect_uri,
            &self.code_verifier,
        )
        .await;

        self.service.clear_active_oauth_flow();

        match exchange_res {
            Ok(creds) => {
                self.service.credentials.save_credentials(&creds)?;
                self.service.record_last_error(None);
                self.service.wake_sync_worker();
                Ok(self.service.status())
            }
            Err(err) => {
                self.service.record_last_error(Some(&err.to_string()));
                Err(SyncServiceError::OAuth(err))
            }
        }
    }
}

/// Detects the local OS IANA timezone (e.g. `Asia/Seoul`), falling back to `UTC`.
pub fn detect_local_time_zone() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".to_string())
}

/// Computes exponential backoff duration for automatic background retries.
pub fn retry_backoff_ms(retry_count: i64) -> i64 {
    match retry_count {
        ..=0 => 0,
        1 => 30_000,
        2 => 60_000,
        3 => 120_000,
        4 => 300_000,
        _ => 600_000,
    }
}

/// Core Phase 3 TickTick synchronization service managing:
/// - OAuth2 loopback login (PKCE + State) & Personal API Token authentication
/// - OS keyring credential storage & automatic refresh token renewal
/// - Pull caching (`projects`, `inbox`, `tasks`, `tags`)
/// - Offline-first async push queue with 2-step idempotent subtask completion
pub struct TickTickService {
    db: Arc<Database>,
    credentials: Arc<CredentialManager>,
    http: Client,
    api_base_url: String,
    oauth_endpoints: OAuthEndpoints,
    active_oauth: Mutex<Option<ActiveOAuthFlow>>,
    pull_lock: AsyncMutex<()>,
    sync_lock: AsyncMutex<()>,
    wake_notify: Arc<Notify>,
}

impl TickTickService {
    pub fn new(db: Arc<Database>, credentials: Arc<CredentialManager>) -> Self {
        Self::with_endpoints(db, credentials, TICKTICK_API_BASE, OAuthEndpoints::default())
    }

    pub fn with_endpoints(
        db: Arc<Database>,
        credentials: Arc<CredentialManager>,
        api_base_url: impl Into<String>,
        oauth_endpoints: OAuthEndpoints,
    ) -> Self {
        Self {
            db,
            credentials,
            http: build_default_http_client(),
            api_base_url: api_base_url.into().trim_end_matches('/').to_string(),
            oauth_endpoints,
            active_oauth: Mutex::new(None),
            pull_lock: AsyncMutex::new(()),
            sync_lock: AsyncMutex::new(()),
            wake_notify: Arc::new(Notify::new()),
        }
    }

    pub fn wake_sync_worker(&self) {
        self.wake_notify.notify_one();
    }

    pub fn status(&self) -> TickTickConnectionStatus {
        let settings = self.db.get_settings().unwrap_or_default();
        let creds = self.credentials.load_credentials().ok().flatten();
        let has_client_secret = self.credentials.has_oauth_client_secret();
        let oauth_configured =
            settings.ticktick_oauth_client_id.is_some() && has_client_secret;

        let (auth_in_progress, pending_authorize_url) = match self.active_oauth.lock() {
            Ok(guard) => match guard.as_ref() {
                Some(flow) => (true, Some(flow.authorize_url.clone())),
                None => (false, None),
            },
            Err(poisoned) => match poisoned.into_inner().as_ref() {
                Some(flow) => (true, Some(flow.authorize_url.clone())),
                None => (false, None),
            },
        };

        let last_pull_at = self
            .db
            .get_setting_raw::<i64>(SETTING_TICKTICK_LAST_PULL_AT)
            .ok()
            .flatten();
        let last_sync_error = self
            .db
            .get_setting_raw::<String>(SETTING_TICKTICK_LAST_SYNC_ERROR)
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty());
        let queue = self.db.get_sync_queue_summary().unwrap_or_default();
        let oauth_redirect_uri = if settings.ticktick_oauth_redirect_port == 0 {
            "http://127.0.0.1:<ephemeral>/callback".to_string()
        } else {
            format_redirect_uri(settings.ticktick_oauth_redirect_port)
        };

        TickTickConnectionStatus {
            connected: creds.is_some(),
            auth_method: creds.as_ref().map(|c| c.auth_method),
            oauth_configured,
            has_client_secret,
            oauth_client_id: settings.ticktick_oauth_client_id,
            oauth_redirect_port: settings.ticktick_oauth_redirect_port,
            oauth_redirect_uri,
            auth_in_progress,
            pending_authorize_url,
            token_expires_at: creds.and_then(|c| c.expires_at_ms),
            last_pull_at,
            last_sync_error,
            detected_time_zone: detect_local_time_zone(),
            queue,
        }
    }

    pub fn save_oauth_config(
        &self,
        input: SaveOAuthConfigInput,
    ) -> Result<TickTickConnectionStatus, SyncServiceError> {
        let mut settings = self.db.get_settings()?;
        let trimmed_id = input.client_id.trim();
        settings.ticktick_oauth_client_id = if trimmed_id.is_empty() {
            None
        } else {
            Some(trimmed_id.to_string())
        };
        if let Some(port) = input.redirect_port {
            settings.ticktick_oauth_redirect_port = port;
        }
        self.db.update_settings(&settings)?;

        if let Some(secret) = input.client_secret {
            self.credentials.save_oauth_client_secret(&secret)?;
        }

        Ok(self.status())
    }

    /// Connects with a TickTick Personal API Token after verifying it against `GET /open/v1/project`.
    pub async fn connect_personal_token(
        &self,
        token: &str,
    ) -> Result<TickTickConnectionStatus, SyncServiceError> {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            return Err(SyncServiceError::Validation(
                "API 토큰을 입력해주세요.".into(),
            ));
        }

        let probe_client =
            TickTickClient::with_http_client(self.http.clone(), &self.api_base_url, trimmed);
        probe_client.list_projects().await.map_err(|err| {
            if err.is_unauthorized() {
                SyncServiceError::Unauthorized
            } else {
                SyncServiceError::Api(err)
            }
        })?;

        self.cancel_oauth_login();
        self.credentials.save_credentials(&TickTickCredentials {
            auth_method: TickTickAuthMethod::PersonalToken,
            access_token: trimmed.to_string(),
            refresh_token: None,
            token_type: Some("bearer".into()),
            scope: None,
            expires_at_ms: None,
        })?;
        self.record_last_error(None);
        self.wake_sync_worker();
        Ok(self.status())
    }

    /// Starts a loopback OAuth2 login flow (binds `127.0.0.1:<port>`, generates PKCE S256 + state).
    pub async fn begin_oauth_login(
        self: &Arc<Self>,
    ) -> Result<(OAuthLoginStartResult, PendingOAuthSession), SyncServiceError> {
        let settings = self.db.get_settings()?;
        let client_id = settings.ticktick_oauth_client_id.ok_or_else(|| {
            SyncServiceError::OAuth(OAuthError::InvalidConfig(
                "TickTick OAuth2 Client ID를 먼저 설정해주세요.".into(),
            ))
        })?;
        let client_secret = self
            .credentials
            .load_oauth_client_secret()?
            .ok_or_else(|| {
                SyncServiceError::OAuth(OAuthError::InvalidConfig(
                    "TickTick OAuth2 Client Secret을 먼저 설정해주세요.".into(),
                ))
            })?;

        // Cancel any previously pending login so the callback port is released first.
        self.cancel_oauth_login();

        let listener = LoopbackCallbackListener::bind(settings.ticktick_oauth_redirect_port).await?;
        let redirect_uri = listener.redirect_uri();
        let state = generate_oauth_state();
        let pkce = generate_pkce();
        let authorize_url = build_authorize_url(
            &self.oauth_endpoints,
            &client_id,
            &redirect_uri,
            &state,
            &pkce,
        )?;

        let (cancel_tx, cancel_rx) = oneshot::channel();
        {
            let mut guard = match self.active_oauth.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            *guard = Some(ActiveOAuthFlow {
                authorize_url: authorize_url.clone(),
                cancel_tx: Some(cancel_tx),
            });
        }

        let start_result = OAuthLoginStartResult {
            authorize_url,
            redirect_uri: redirect_uri.clone(),
        };
        let session = PendingOAuthSession {
            service: Arc::clone(self),
            listener,
            client_id,
            client_secret,
            state,
            code_verifier: pkce.verifier,
            redirect_uri,
            cancel_rx,
            timeout: Duration::from_secs(DEFAULT_OAUTH_TIMEOUT_SECS),
        };
        Ok((start_result, session))
    }

    pub fn cancel_oauth_login(&self) {
        let prev = match self.active_oauth.lock() {
            Ok(mut guard) => guard.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(mut flow) = prev {
            if let Some(tx) = flow.cancel_tx.take() {
                let _ = tx.send(());
            }
        }
    }

    fn clear_active_oauth_flow(&self) {
        match self.active_oauth.lock() {
            Ok(mut guard) => *guard = None,
            Err(poisoned) => *poisoned.into_inner() = None,
        }
    }

    /// Disconnects the TickTick account by deleting tokens from OS keyring while keeping local cache.
    pub fn disconnect(&self) -> Result<TickTickConnectionStatus, SyncServiceError> {
        self.cancel_oauth_login();
        self.credentials.clear_credentials()?;
        self.record_last_error(None);
        Ok(self.status())
    }

    /// Pulls projects, Inbox, open tasks, and tags from TickTick Open API v1 into local SQLite.
    pub async fn pull_cache(&self) -> Result<TickTickPullResult, SyncServiceError> {
        let _guard = self.pull_lock.lock().await;
        let synced_at = Utc::now().timestamp_millis();
        let mut warnings = Vec::new();

        // 1. Fetch projects
        let remote_projects = self
            .execute_api(|client| async move { client.list_projects().await })
            .await?;

        // 2. Fetch Inbox data
        let mut inbox_tasks = Vec::new();
        let mut partial_task_failure = false;
        match self
            .execute_api(|client| async move { client.get_inbox_data().await })
            .await
        {
            Ok(data) => inbox_tasks = data.tasks,
            Err(err) => {
                partial_task_failure = true;
                warnings.push(format!("Inbox 조회 경고: {err}"));
            }
        }

        // 3. Fetch open tasks per open project
        let mut task_map: HashMap<String, TickTickTaskDto> = HashMap::new();
        for task in inbox_tasks {
            task_map.insert(task.id.clone(), task);
        }

        for proj in remote_projects.iter().filter(|p| !p.closed) {
            let pid = proj.id.clone();
            match self
                .execute_api(|client| {
                    let pid = pid.clone();
                    async move { client.get_project_data(&pid).await }
                })
                .await
            {
                Ok(data) => {
                    for task in data.tasks {
                        task_map.insert(task.id.clone(), task);
                    }
                }
                Err(SyncServiceError::Unauthorized) => return Err(SyncServiceError::Unauthorized),
                Err(err) => {
                    partial_task_failure = true;
                    warnings.push(format!("프로젝트 '{}' 조회 실패: {err}", proj.name));
                }
            }
        }

        // 4. Supplement via POST /open/v1/task/filter (also discovers concrete inbox ID / subtasks)
        match self
            .execute_api(|client| async move {
                client.filter_tasks(&TaskFilterRequest::default()).await
            })
            .await
        {
            Ok(filtered) => {
                for task in filtered {
                    if task.status == 0 {
                        task_map.entry(task.id.clone()).or_insert(task);
                    }
                }
            }
            Err(SyncServiceError::Unauthorized) => return Err(SyncServiceError::Unauthorized),
            Err(err) => {
                warnings.push(format!("태스크 필터 보완 조회 건너뜀: {err}"));
            }
        }

        // 5. Fetch tags directly via GET /open/v1/tag
        let mut tags_to_sync: Vec<(String, Option<String>)> = Vec::new();
        match self
            .execute_api(|client| async move { client.list_tags().await })
            .await
        {
            Ok(remote_tags) => {
                for tag in remote_tags {
                    let display = tag
                        .label
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| tag.name.trim());
                    if !display.is_empty() {
                        tags_to_sync.push((display.to_string(), tag.color));
                    }
                }
            }
            Err(SyncServiceError::Unauthorized) => return Err(SyncServiceError::Unauthorized),
            Err(err) => {
                warnings.push(format!("태그 목록 조회 경고: {err}"));
            }
        }

        // Resolve concrete Inbox project ID (TickTick tasks often use e.g. `inbox12345678`).
        let discovered_inbox_id = task_map
            .values()
            .find(|t| t.project_id.to_ascii_lowercase().starts_with("inbox"))
            .map(|t| t.project_id.clone())
            .or_else(|| self.db.get_inbox_project_id().ok().flatten())
            .unwrap_or_else(|| "inbox".to_string());

        let mut cached_projects: Vec<TickTickProject> = Vec::with_capacity(remote_projects.len() + 1);
        if !remote_projects.iter().any(|p| p.id == discovered_inbox_id) {
            cached_projects.push(TickTickProject {
                id: discovered_inbox_id,
                name: "Inbox".into(),
                color: Some("#64748b".into()),
                sort_order: -1,
                is_inbox: true,
                closed: false,
                synced_at,
            });
        }

        for proj in remote_projects {
            let is_inbox = proj.id.to_ascii_lowercase().starts_with("inbox");
            cached_projects.push(TickTickProject {
                id: proj.id,
                name: proj.name,
                color: proj.color,
                sort_order: proj.sort_order,
                is_inbox,
                closed: proj.closed,
                synced_at,
            });
        }

        let cached_tasks: Vec<TickTickTask> = task_map
            .into_values()
            .map(|dto| TickTickTask {
                id: dto.id,
                project_id: dto.project_id,
                parent_id: dto.parent_id,
                title: dto.title,
                content: dto.content,
                tags: dto.tags,
                status: dto.status,
                start_date: dto.start_date,
                due_date: dto.due_date,
                synced_at,
            })
            .collect();

        let projects_synced = cached_projects.len();
        let tasks_synced = cached_tasks.len();
        let tags_synced = tags_to_sync.len();

        self.db.sync_ticktick_cache(
            &cached_projects,
            &cached_tasks,
            &tags_to_sync,
            synced_at,
            !partial_task_failure,
        )?;
        self.record_last_error(None);

        Ok(TickTickPullResult {
            projects_synced,
            tasks_synced,
            tags_synced,
            synced_at,
            warnings,
        })
    }

    /// Marks a completed local time entry as `pending` in the offline sync queue and wakes the worker.
    pub fn enqueue_entry_sync(&self, entry_id: &str) -> Result<TimeEntry, SyncServiceError> {
        let settings = self.db.get_settings()?;
        let entry = self
            .db
            .get_time_entry(entry_id)?
            .ok_or_else(|| DbError::NotFound(format!("time_entry {entry_id}")))?;
        let effective_mode = resolve_effective_sync_mode(&entry, &settings);
        let updated = self
            .db
            .enqueue_time_entry_sync(entry_id, &effective_mode)?;
        self.wake_sync_worker();
        Ok(updated)
    }

    /// Conditionally enqueues a just-stopped timer if `auto_sync_on_stop` is enabled, TickTick is
    /// connected, and the entry is linked to a TickTick parent task.
    pub fn maybe_auto_enqueue_stopped_entry(&self, entry: &TimeEntry) -> Option<TimeEntry> {
        if entry.ended_at.is_none() || entry.ticktick_parent_task_id.is_none() {
            return None;
        }
        let settings = self.db.get_settings().ok()?;
        if !settings.auto_sync_on_stop {
            return None;
        }
        if self.credentials.load_credentials().ok().flatten().is_none() {
            return None;
        }
        self.enqueue_entry_sync(&entry.id).ok()
    }

    /// Synchronizes a single queued entry to TickTick using 2-step idempotent creation & completion.
    pub async fn sync_single_entry(&self, entry_id: &str) -> Result<TimeEntry, SyncServiceError> {
        let _guard = self.sync_lock.lock().await;
        self.sync_single_entry_locked(entry_id).await
    }

    /// Drains all `pending` entries (and optionally backoff-eligible `failed` entries).
    pub async fn process_sync_queue(
        &self,
        include_backoff_retries: bool,
    ) -> Result<TickTickSyncBatchResult, SyncServiceError> {
        let _guard = self.sync_lock.lock().await;
        let pending = self.db.list_pending_sync_entries(100)?;
        let mut candidates = pending;

        if include_backoff_retries {
            let now_ms = Utc::now().timestamp_millis();
            let failed = self
                .db
                .list_retryable_failed_entries(MAX_AUTO_SYNC_RETRIES, 50)?;
            for entry in failed {
                let wait_ms = retry_backoff_ms(entry.retry_count);
                if now_ms.saturating_sub(entry.updated_at) >= wait_ms {
                    candidates.push(entry);
                }
            }
        }

        if candidates.is_empty() {
            return Ok(TickTickSyncBatchResult {
                processed: 0,
                synced: 0,
                failed: 0,
                skipped: 0,
            });
        }

        if self.credentials.load_credentials()?.is_none() {
            return Ok(TickTickSyncBatchResult {
                processed: 0,
                synced: 0,
                failed: 0,
                skipped: candidates.len(),
            });
        }

        let mut result = TickTickSyncBatchResult {
            processed: 0,
            synced: 0,
            failed: 0,
            skipped: 0,
        };

        for candidate in candidates {
            result.processed += 1;
            match self.sync_single_entry_locked(&candidate.id).await {
                Ok(updated) => {
                    if updated.sync_status == SyncStatus::Synced {
                        result.synced += 1;
                    } else {
                        result.failed += 1;
                    }
                }
                Err(SyncServiceError::NotConnected) => {
                    result.skipped += 1;
                    break;
                }
                Err(SyncServiceError::Unauthorized) => {
                    result.failed += 1;
                    break;
                }
                Err(_) => {
                    result.failed += 1;
                }
            }
        }

        Ok(result)
    }

    /// Re-queues all `failed` entries to `pending` and immediately attempts to drain the queue.
    pub async fn retry_failed_syncs(&self) -> Result<TickTickSyncBatchResult, SyncServiceError> {
        let _requeued = self.db.requeue_failed_entries()?;
        self.process_sync_queue(false).await
    }

    async fn sync_single_entry_locked(&self, entry_id: &str) -> Result<TimeEntry, SyncServiceError> {
        let Some(mut entry) = self.db.get_time_entry(entry_id)? else {
            return Err(SyncServiceError::Db(DbError::NotFound(format!(
                "time_entry {entry_id}"
            ))));
        };

        let Some(ended_at) = entry.ended_at else {
            return Err(SyncServiceError::Validation(
                "실행 중인 타이머는 동기화할 수 없습니다.".into(),
            ));
        };

        if entry.sync_status == SyncStatus::Synced {
            return Ok(entry);
        }

        // If disconnected, keep the entry safely in `pending` for offline-first automatic flush on login.
        if self.credentials.load_credentials()?.is_none() {
            return Err(SyncServiceError::NotConnected);
        }

        let settings = self.db.get_settings()?;
        let effective_mode = entry
            .sync_mode
            .as_deref()
            .map(SyncMode::from_db)
            .unwrap_or_else(|| resolve_effective_sync_mode(&entry, &settings));
        let cached_inbox_id = self.db.get_inbox_project_id()?;
        let parent_task = match entry.ticktick_parent_task_id.as_deref() {
            Some(pid) => self.db.get_ticktick_task(pid)?,
            None => None,
        };

        // ---------------------------------------------------------------------
        // Step 1: Create subtask (or fallback list task) if not already created.
        // ---------------------------------------------------------------------
        let (subtask_id, subtask_project_id) = if let Some(existing_subtask_id) =
            entry.ticktick_subtask_id.clone()
        {
            let recorded_project = self.db.get_recorded_subtask_project_id(entry_id)?;
            let project_id = recorded_project.unwrap_or_else(|| {
                resolve_target_project_id(
                    &effective_mode,
                    &entry,
                    parent_task.as_ref(),
                    &settings,
                    cached_inbox_id.as_deref(),
                )
            });
            (existing_subtask_id, project_id)
        } else {
            let target_project_id = resolve_target_project_id(
                &effective_mode,
                &entry,
                parent_task.as_ref(),
                &settings,
                cached_inbox_id.as_deref(),
            );
            let time_zone = settings
                .ticktick_time_zone
                .clone()
                .unwrap_or_else(detect_local_time_zone);
            let tag_names = self.db.get_tag_names_for_ids(&entry.tag_ids)?;

            let (title, content) = build_sync_task_title_and_content(
                &entry,
                parent_task.as_ref(),
                ended_at - entry.started_at,
            );

            let parent_id = if effective_mode == SyncMode::Subtask {
                entry.ticktick_parent_task_id.clone()
            } else {
                None
            };

            let req = CreateTaskRequest {
                title,
                project_id: Some(target_project_id.clone()),
                parent_id,
                content: Some(content),
                start_date: Some(format_ticktick_timestamp(entry.started_at)),
                due_date: Some(format_ticktick_timestamp(ended_at)),
                time_zone: Some(time_zone),
                is_all_day: Some(false),
                tags: tag_names,
            };

            let created = match self
                .execute_api(|client| {
                    let payload = req.clone();
                    async move { client.create_task(&payload).await }
                })
                .await
            {
                Ok(dto) => dto,
                Err(err) => return self.handle_sync_step_error(entry_id, err),
            };

            let actual_project_id = if created.project_id.trim().is_empty() {
                target_project_id
            } else {
                created.project_id.clone()
            };

            // Commit Step 1 immediately so retries never duplicate the created task.
            entry = self.db.record_ticktick_subtask_created(
                entry_id,
                &created.id,
                effective_mode.as_str(),
                &actual_project_id,
            )?;
            (created.id, actual_project_id)
        };

        // ---------------------------------------------------------------------
        // Step 2: Complete the created subtask / fallback task.
        // ---------------------------------------------------------------------
        if let Err(err) = self
            .execute_api(|client| {
                let pid = subtask_project_id.clone();
                let tid = subtask_id.clone();
                async move { client.complete_task(&pid, &tid).await }
            })
            .await
        {
            return self.handle_sync_step_error(entry_id, err);
        }

        // ---------------------------------------------------------------------
        // Step 3 (Optional): Complete parent task without touching its schedule.
        // ---------------------------------------------------------------------
        if entry.complete_parent_task {
            if let Some(parent_id) = entry.ticktick_parent_task_id.as_deref() {
                let parent_project_id = parent_task
                    .as_ref()
                    .map(|t| t.project_id.clone())
                    .or_else(|| entry.ticktick_project_id.clone())
                    .or_else(|| cached_inbox_id.clone())
                    .unwrap_or_else(|| "inbox".to_string());

                if let Err(err) = self
                    .execute_api(|client| {
                        let pid = parent_project_id.clone();
                        let tid = parent_id.to_string();
                        async move { client.complete_task(&pid, &tid).await }
                    })
                    .await
                {
                    return self.handle_sync_step_error(entry_id, err);
                }

                let _ = self.db.mark_ticktick_task_completed(parent_id);
            }
        }

        self.record_last_error(None);
        let synced = self.db.mark_time_entry_synced(entry_id)?;
        Ok(synced)
    }

    fn handle_sync_step_error(
        &self,
        entry_id: &str,
        err: SyncServiceError,
    ) -> Result<TimeEntry, SyncServiceError> {
        match &err {
            SyncServiceError::NotConnected => return Err(err),
            SyncServiceError::Unauthorized => {
                let msg = "TickTick 인증이 만료되었습니다. 다시 로그인해주세요.";
                self.record_last_error(Some(msg));
                let _ = self.db.mark_time_entry_sync_failed(entry_id, msg, false);
                return Err(err);
            }
            SyncServiceError::Api(api_err) => {
                let msg = api_err.sanitized_message();
                self.record_last_error(Some(&msg));
                let increment_retry = api_err.is_retryable();
                let updated = self
                    .db
                    .mark_time_entry_sync_failed(entry_id, &msg, increment_retry)?;
                return Ok(updated);
            }
            other => {
                let msg: String = other.to_string().chars().take(240).collect();
                self.record_last_error(Some(&msg));
                let updated = self.db.mark_time_entry_sync_failed(entry_id, &msg, true)?;
                return Ok(updated);
            }
        }
    }

    async fn execute_api<T, F, Fut>(&self, op: F) -> Result<T, SyncServiceError>
    where
        F: Fn(TickTickClient) -> Fut,
        Fut: Future<Output = Result<T, TickTickError>>,
    {
        let mut creds = self
            .credentials
            .load_credentials()?
            .ok_or(SyncServiceError::NotConnected)?;

        // Proactively refresh near-expiry OAuth2 access tokens if possible.
        if creds.auth_method == TickTickAuthMethod::OAuth2
            && creds.is_expired_or_near_expiry(Utc::now().timestamp_millis(), TOKEN_REFRESH_LEEWAY_MS)
        {
            if let Ok(refreshed) = self.try_refresh_credentials(&creds).await {
                creds = refreshed;
            }
        }

        let client = TickTickClient::with_http_client(
            self.http.clone(),
            &self.api_base_url,
            &creds.access_token,
        );
        match op(client).await {
            Ok(val) => Ok(val),
            Err(err) if err.is_unauthorized() => {
                if creds.auth_method == TickTickAuthMethod::OAuth2 {
                    if let Ok(refreshed) = self.try_refresh_credentials(&creds).await {
                        let retry_client = TickTickClient::with_http_client(
                            self.http.clone(),
                            &self.api_base_url,
                            &refreshed.access_token,
                        );
                        return op(retry_client).await.map_err(|retry_err| {
                            if retry_err.is_unauthorized() {
                                SyncServiceError::Unauthorized
                            } else {
                                SyncServiceError::Api(retry_err)
                            }
                        });
                    }
                }
                Err(SyncServiceError::Unauthorized)
            }
            Err(err) => Err(SyncServiceError::Api(err)),
        }
    }

    async fn try_refresh_credentials(
        &self,
        current: &TickTickCredentials,
    ) -> Result<TickTickCredentials, SyncServiceError> {
        let Some(refresh_token) = current.refresh_token.as_deref() else {
            return Err(SyncServiceError::Unauthorized);
        };
        let settings = self.db.get_settings()?;
        let Some(client_id) = settings.ticktick_oauth_client_id.as_deref() else {
            return Err(SyncServiceError::Unauthorized);
        };
        let Some(client_secret) = self.credentials.load_oauth_client_secret()? else {
            return Err(SyncServiceError::Unauthorized);
        };

        let refreshed = refresh_access_token(
            &self.http,
            &self.oauth_endpoints,
            client_id,
            &client_secret,
            refresh_token,
        )
        .await?;
        self.credentials.save_credentials(&refreshed)?;
        Ok(refreshed)
    }

    fn record_last_error(&self, message: Option<&str>) {
        match message {
            Some(msg) => {
                let _ = self
                    .db
                    .set_setting_raw(SETTING_TICKTICK_LAST_SYNC_ERROR, &msg.to_string());
            }
            None => {
                let _ = self.db.delete_setting_raw(SETTING_TICKTICK_LAST_SYNC_ERROR);
            }
        }
    }
}

/// Handle to the background asynchronous TickTick sync queue worker.
pub struct SyncWorkerHandle {
    shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
}

impl SyncWorkerHandle {
    /// Prepares a handle and an async worker future that can be spawned onto any Tokio runtime
    /// (including `tauri::async_runtime::spawn` during synchronous Tauri `.setup()`).
    pub fn prepare<F>(
        service: Arc<TickTickService>,
        poll_interval: Duration,
        on_change: F,
    ) -> (Self, impl Future<Output = ()> + Send + 'static)
    where
        F: Fn(TickTickSyncBatchResult) + Send + Sync + 'static,
    {
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel();
        let wake = Arc::clone(&service.wake_notify);
        let interval = poll_interval.max(Duration::from_secs(5));

        let fut = async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    _ = wake.notified() => {
                        if let Ok(batch) = service.process_sync_queue(false).await {
                            if batch.processed > 0 {
                                on_change(batch);
                            }
                        }
                    }
                    _ = tokio::time::sleep(interval) => {
                        if let Ok(batch) = service.process_sync_queue(true).await {
                            if batch.processed > 0 {
                                on_change(batch);
                            }
                        }
                    }
                }
            }
        };

        (
            Self {
                shutdown_tx: Mutex::new(Some(shutdown_tx)),
            },
            fut,
        )
    }

    pub fn spawn<F>(
        service: Arc<TickTickService>,
        poll_interval: Duration,
        on_change: F,
    ) -> Self
    where
        F: Fn(TickTickSyncBatchResult) + Send + Sync + 'static,
    {
        let (handle, fut) = Self::prepare(service, poll_interval, on_change);
        tokio::spawn(fut);
        handle
    }

    pub fn shutdown(&self) {
        let tx = match self.shutdown_tx.lock() {
            Ok(mut guard) => guard.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        if let Some(sender) = tx {
            let _ = sender.send(());
        }
    }
}

impl Drop for SyncWorkerHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn resolve_effective_sync_mode(entry: &TimeEntry, settings: &crate::models::AppSettings) -> SyncMode {
    match settings.sync_mode {
        SyncMode::Subtask if entry.ticktick_parent_task_id.is_some() => SyncMode::Subtask,
        SyncMode::Subtask => SyncMode::FallbackList,
        SyncMode::FallbackList => SyncMode::FallbackList,
    }
}

fn resolve_target_project_id(
    effective_mode: &SyncMode,
    entry: &TimeEntry,
    parent_task: Option<&TickTickTask>,
    settings: &crate::models::AppSettings,
    cached_inbox_id: Option<&str>,
) -> String {
    let inbox_fallback = cached_inbox_id.unwrap_or("inbox");
    match effective_mode {
        SyncMode::Subtask => parent_task
            .map(|t| t.project_id.clone())
            .or_else(|| entry.ticktick_project_id.clone())
            .unwrap_or_else(|| inbox_fallback.to_string()),
        SyncMode::FallbackList => settings
            .fallback_project_id
            .clone()
            .or_else(|| entry.ticktick_project_id.clone())
            .or_else(|| parent_task.map(|t| t.project_id.clone()))
            .unwrap_or_else(|| inbox_fallback.to_string()),
    }
}

fn build_sync_task_title_and_content(
    entry: &TimeEntry,
    parent_task: Option<&TickTickTask>,
    duration_ms: i64,
) -> (String, String) {
    let duration_secs = duration_ms.max(0) / 1_000;
    let h = duration_secs / 3_600;
    let m = (duration_secs % 3_600) / 60;
    let s = duration_secs % 60;
    let duration_label = format!("{h:02}:{m:02}:{s:02}");

    let desc_trimmed = entry.description.trim();

    let title = if entry.ticktick_parent_task_id.is_some() {
        let base = parent_task
            .map(|t| t.title.trim())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| {
                if desc_trimmed.is_empty() {
                    "작업"
                } else {
                    desc_trimmed
                }
            });
        format!("[{base}] 수행")
    } else if desc_trimmed.is_empty() {
        "(Untitled)".to_string()
    } else {
        desc_trimmed.to_string()
    };

    let content = match parent_task {
        Some(parent)
            if !desc_trimmed.is_empty()
                && !desc_trimmed.eq_ignore_ascii_case(parent.title.trim()) =>
        {
            format!("{desc_trimmed}\n\nLogged by tempo ({duration_label})")
        }
        _ => format!("Logged by tempo ({duration_label})"),
    };

    (title, content)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::*;
    use crate::models::{AppSettings, CreateTimeEntryInput};
    use crate::ticktick::oauth::compute_s256_challenge;
    use crate::ticktick::secrets::MemorySecretStore;

    #[derive(Clone)]
    struct RecordedRequest {
        method: String,
        path: String,
        auth: Option<String>,
        body: String,
    }

    async fn spawn_mock_server<F>(handler: F) -> (String, Arc<Mutex<Vec<RecordedRequest>>>)
    where
        F: Fn(&RecordedRequest) -> (u16, String) + Send + Sync + 'static,
    {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let recorded_bg = Arc::clone(&recorded);
        let handler = Arc::new(handler);

        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let recorded_req = Arc::clone(&recorded_bg);
                let handler = Arc::clone(&handler);
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let mut content_length = 0usize;
                    let mut header_end = None;

                    loop {
                        let Ok(n) = stream.read(&mut tmp).await else {
                            return;
                        };
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        if header_end.is_none() {
                            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                header_end = Some(pos + 4);
                                let headers_str = String::from_utf8_lossy(&buf[..pos]);
                                for line in headers_str.lines() {
                                    if let Some((k, v)) = line.split_once(':') {
                                        if k.eq_ignore_ascii_case("content-length") {
                                            content_length = v.trim().parse().unwrap_or(0);
                                        }
                                    }
                                }
                            }
                        }
                        if let Some(end) = header_end {
                            if buf.len() >= end + content_length {
                                break;
                            }
                        }
                    }

                    let Some(end) = header_end else {
                        return;
                    };
                    let head = String::from_utf8_lossy(&buf[..end]);
                    let body =
                        String::from_utf8_lossy(&buf[end..buf.len().min(end + content_length)])
                            .to_string();

                    let mut lines = head.lines();
                    let req_line = lines.next().unwrap_or("");
                    let mut parts = req_line.split_whitespace();
                    let method = parts.next().unwrap_or("").to_string();
                    let path = parts.next().unwrap_or("").to_string();
                    let mut auth = None;
                    for line in lines {
                        if let Some((k, v)) = line.split_once(':') {
                            if k.eq_ignore_ascii_case("authorization") {
                                auth = Some(v.trim().to_string());
                            }
                        }
                    }

                    let req = RecordedRequest {
                        method,
                        path,
                        auth,
                        body,
                    };
                    let (status, resp_body) = handler(&req);
                    recorded_req.lock().unwrap().push(req);

                    let reason = match status {
                        200 => "OK",
                        401 => "Unauthorized",
                        404 => "Not Found",
                        _ => "Error",
                    };
                    let resp = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
                        resp_body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes()).await;
                    let _ = stream.shutdown().await;
                });
            }
        });

        (format!("http://127.0.0.1:{port}"), recorded)
    }

    fn make_service(base_url: &str) -> (Arc<Database>, Arc<MemorySecretStore>, Arc<TickTickService>) {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let secret_store = Arc::new(MemorySecretStore::new());
        let creds = Arc::new(CredentialManager::new(secret_store.clone()));
        let endpoints = OAuthEndpoints {
            authorize_url: format!("{base_url}/oauth/authorize"),
            token_url: format!("{base_url}/oauth/token"),
        };
        let service = Arc::new(TickTickService::with_endpoints(
            Arc::clone(&db),
            creds,
            format!("{base_url}/open/v1"),
            endpoints,
        ));
        (db, secret_store, service)
    }

    #[tokio::test]
    async fn oauth_loopback_login_validates_pkce_and_stores_tokens_only_in_secret_store() {
        let (base_url, recorded) = spawn_mock_server(|req| {
            if req.method == "POST" && req.path == "/oauth/token" {
                assert!(req.auth.as_deref().unwrap_or("").starts_with("Basic "));
                assert!(req.body.contains("grant_type=authorization_code"));
                assert!(req.body.contains("code=auth-code-999"));
                assert!(req.body.contains("code_verifier="));
                return (
                    200,
                    r#"{"access_token":"oauth-access-secret","refresh_token":"oauth-refresh-secret","token_type":"bearer","scope":"tasks:read tasks:write","expires_in":3600}"#.into(),
                );
            }
            (404, "{}".into())
        })
        .await;

        let (db, _secret_store, service) = make_service(&base_url);
        service
            .save_oauth_config(SaveOAuthConfigInput {
                client_id: "cid-123".into(),
                client_secret: Some("csec-456".into()),
                redirect_port: Some(0), // ephemeral port for zero test conflicts
            })
            .unwrap();

        let (start, session) = service.begin_oauth_login().await.unwrap();
        let parsed = url::Url::parse(&start.authorize_url).unwrap();
        let q: HashMap<_, _> = parsed.query_pairs().into_owned().collect();
        let state = q.get("state").unwrap().clone();
        let challenge = q.get("code_challenge").unwrap().clone();

        let completion = tokio::spawn(async move {
            session
                .with_timeout(Duration::from_secs(5))
                .wait_and_complete()
                .await
        });

        // Simulate browser redirect back to loopback server
        let http = Client::new();
        let cb_url = format!("{}?code=auth-code-999&state={state}", start.redirect_uri);
        let resp = http.get(cb_url).send().await.unwrap();
        assert_eq!(resp.status().as_u16(), 200);

        let status = completion.await.unwrap().unwrap();
        assert!(status.connected);
        assert_eq!(status.auth_method, Some(TickTickAuthMethod::OAuth2));
        assert!(!status.auth_in_progress);
        assert!(status.token_expires_at.is_some());

        // Verify PKCE verifier submitted to token endpoint matches the S256 challenge sent in authorize_url.
        let reqs = recorded.lock().unwrap();
        let token_req = reqs.iter().find(|r| r.path == "/oauth/token").unwrap();
        let form_params: HashMap<String, String> = url::form_urlencoded::parse(token_req.body.as_bytes())
            .into_owned()
            .collect();
        let verifier = form_params.get("code_verifier").unwrap();
        assert_eq!(compute_s256_challenge(verifier), challenge);

        // Verify raw token is NEVER persisted into SQLite settings table.
        let settings_dump = db.get_settings().unwrap();
        let settings_json = serde_json::to_string(&settings_dump).unwrap();
        assert!(!settings_json.contains("oauth-access-secret"));
        assert!(!settings_json.contains("oauth-refresh-secret"));
        assert!(!settings_json.contains("csec-456"));
    }

    #[tokio::test]
    async fn pulls_projects_concrete_inbox_tasks_and_tags_preserving_local_tags() {
        let pull_round = Arc::new(AtomicUsize::new(0));
        let pull_round_srv = Arc::clone(&pull_round);

        let (base_url, _recorded) = spawn_mock_server(move |req| {
            if req.auth.as_deref() != Some("Bearer valid-personal-token") {
                return (401, r#"{"error":"unauthorized"}"#.into());
            }
            match (req.method.as_str(), req.path.as_str()) {
                ("GET", "/open/v1/project") => (
                    200,
                    r##"[{"id":"p-work","name":"Work","color":"#10b981","sortOrder":1,"closed":false}]"##.into(),
                ),
                ("GET", "/open/v1/project/inbox/data") => (
                    200,
                    r#"{"tasks":[{"id":"t-inbox","projectId":"inbox88421","title":"Inbox Triage","status":0,"tags":["quick"]}],"columns":[]}"#.into(),
                ),
                ("GET", "/open/v1/project/p-work/data") => {
                    let round = pull_round_srv.load(Ordering::SeqCst);
                    if round == 0 {
                        (
                            200,
                            r#"{"project":{"id":"p-work","name":"Work"},"tasks":[
                                {"id":"t-1","projectId":"p-work","title":"Build Phase 3","status":0,"tags":["dev"]},
                                {"id":"t-2","projectId":"p-work","title":"Old Task","status":0,"tags":[]}
                            ]}"#.into(),
                        )
                    } else {
                        // Second pull: t-2 was completed remotely so only t-1 remains open.
                        (
                            200,
                            r#"{"project":{"id":"p-work","name":"Work"},"tasks":[
                                {"id":"t-1","projectId":"p-work","title":"Build Phase 3","status":0,"tags":["dev"]}
                            ]}"#.into(),
                        )
                    }
                }
                ("POST", "/open/v1/task/filter") => (
                    200,
                    r#"[{"id":"t-filter-only","projectId":"p-work","title":"Filtered Task","status":0,"tags":[]}]"#.into(),
                ),
                ("GET", "/open/v1/tag") => (
                    200,
                    r##"[{"name":"dev","label":"Dev","color":"#6366f1","sortOrder":1,"type":0}]"##.into(),
                ),
                _ => (404, "{}".into()),
            }
        })
        .await;

        let (db, _store, service) = make_service(&base_url);
        let local_tag = db.upsert_tag("my-local-tag", "local", Some("#f59e0b")).unwrap();

        // Invalid token must fail cleanly without saving credentials.
        assert!(matches!(
            service.connect_personal_token("bad-token").await,
            Err(SyncServiceError::Unauthorized)
        ));
        assert!(!service.status().connected);

        // Valid personal token connects and pulls cache.
        let status = service
            .connect_personal_token("valid-personal-token")
            .await
            .unwrap();
        assert!(status.connected);
        assert_eq!(status.auth_method, Some(TickTickAuthMethod::PersonalToken));

        let pull1 = service.pull_cache().await.unwrap();
        assert_eq!(pull1.projects_synced, 2); // Work + concrete inbox88421
        assert_eq!(pull1.tasks_synced, 4); // t-inbox, t-1, t-2, t-filter-only
        assert_eq!(pull1.tags_synced, 1);
        assert!(pull1.warnings.is_empty());

        let projects = db.list_ticktick_projects(false).unwrap();
        assert!(projects.iter().any(|p| p.id == "inbox88421" && p.is_inbox));
        assert!(projects.iter().any(|p| p.id == "p-work" && !p.is_inbox));

        // Local custom tag is preserved alongside TickTick tag.
        let tags = db.list_tags().unwrap();
        assert!(tags.iter().any(|t| t.id == local_tag.id && t.source == "local"));
        assert!(tags.iter().any(|t| t.name == "Dev" && t.source == "ticktick"));

        // Second pull marks missing open task t-2 as completed (status = 2).
        pull_round.store(1, Ordering::SeqCst);
        let _pull2 = service.pull_cache().await.unwrap();
        let t2 = db.get_ticktick_task("t-2").unwrap().unwrap();
        assert_eq!(t2.status, 2);
        let open_tasks = db.list_ticktick_tasks(None, Some(0), None, 50).unwrap();
        assert!(!open_tasks.iter().any(|t| t.id == "t-2"));
    }

    #[tokio::test]
    async fn two_step_subtask_sync_is_idempotent_on_retry_and_completes_parent_without_editing_schedule() {
        let fail_first_complete = Arc::new(AtomicBool::new(true));
        let create_calls = Arc::new(AtomicUsize::new(0));
        let complete_subtask_calls = Arc::new(AtomicUsize::new(0));
        let complete_parent_calls = Arc::new(AtomicUsize::new(0));

        let fail_flag = Arc::clone(&fail_first_complete);
        let create_cnt = Arc::clone(&create_calls);
        let comp_sub_cnt = Arc::clone(&complete_subtask_calls);
        let comp_par_cnt = Arc::clone(&complete_parent_calls);

        let (base_url, recorded) = spawn_mock_server(move |req| {
            match (req.method.as_str(), req.path.as_str()) {
                ("GET", "/open/v1/project") => (200, "[]".into()),
                ("POST", "/open/v1/task") => {
                    create_cnt.fetch_add(1, Ordering::SeqCst);
                    let body: serde_json::Value = serde_json::from_str(&req.body).unwrap();
                    assert_eq!(body["title"], "[Write Phase 3 Spec] 수행");
                    assert_eq!(body["projectId"], "proj-1");
                    assert_eq!(body["parentId"], "parent-1");
                    assert_eq!(body["isAllDay"], false);
                    (
                        200,
                        r#"{"id":"sub-777","projectId":"proj-1","parentId":"parent-1","title":"[Write Phase 3 Spec] 수행","status":0}"#.into(),
                    )
                }
                ("POST", "/open/v1/project/proj-1/task/sub-777/complete") => {
                    comp_sub_cnt.fetch_add(1, Ordering::SeqCst);
                    if fail_flag.swap(false, Ordering::SeqCst) {
                        (500, r#"{"error":"transient_failure"}"#.into())
                    } else {
                        (200, "".into())
                    }
                }
                ("POST", "/open/v1/project/proj-1/task/parent-1/complete") => {
                    comp_par_cnt.fetch_add(1, Ordering::SeqCst);
                    (200, "".into())
                }
                _ => (404, "{}".into()),
            }
        })
        .await;

        let (db, _store, service) = make_service(&base_url);
        db.upsert_ticktick_project(&TickTickProject {
            id: "proj-1".into(),
            name: "tempo".into(),
            color: Some("#6366f1".into()),
            sort_order: 1,
            is_inbox: false,
            closed: false,
            synced_at: 100,
        })
        .unwrap();
        db.upsert_ticktick_task(&TickTickTask {
            id: "parent-1".into(),
            project_id: "proj-1".into(),
            parent_id: None,
            title: "Write Phase 3 Spec".into(),
            content: None,
            tags: vec![],
            status: 0,
            start_date: Some("2026-11-25T09:00:00+0000".into()),
            due_date: Some("2026-11-25T10:00:00+0000".into()),
            synced_at: 100,
        })
        .unwrap();

        let entry = db
            .create_time_entry(CreateTimeEntryInput {
                description: "Drafted OAuth2 and sync worker".into(),
                started_at: 1_700_000_000_000,
                ended_at: 1_700_000_900_000,
                ticktick_project_id: Some("proj-1".into()),
                ticktick_parent_task_id: Some("parent-1".into()),
                tag_ids: vec![],
                complete_parent_task: true,
            })
            .unwrap();

        // Queue while offline first -> stays pending without failing.
        let queued = service.enqueue_entry_sync(&entry.id).unwrap();
        assert_eq!(queued.sync_status, SyncStatus::Pending);
        let offline_batch = service.process_sync_queue(false).await.unwrap();
        assert_eq!(offline_batch.skipped, 1);
        assert_eq!(
            db.get_time_entry(&entry.id).unwrap().unwrap().sync_status,
            SyncStatus::Pending
        );

        // Connect token and run first sync attempt: Step 1 succeeds, Step 2 returns HTTP 500.
        service.connect_personal_token("tok").await.unwrap();
        let batch1 = service.process_sync_queue(false).await.unwrap();
        assert_eq!(batch1.processed, 1);
        assert_eq!(batch1.failed, 1);
        assert_eq!(create_calls.load(Ordering::SeqCst), 1);

        let after_fail = db.get_time_entry(&entry.id).unwrap().unwrap();
        assert_eq!(after_fail.sync_status, SyncStatus::Failed);
        assert_eq!(after_fail.retry_count, 1);
        assert_eq!(after_fail.ticktick_subtask_id.as_deref(), Some("sub-777"));

        // Retry: Step 1 MUST NOT be called again; Step 2 & Step 3 complete cleanly.
        let batch2 = service.retry_failed_syncs().await.unwrap();
        assert_eq!(batch2.synced, 1);
        assert_eq!(create_calls.load(Ordering::SeqCst), 1); // ZERO duplicate tasks!
        assert_eq!(complete_subtask_calls.load(Ordering::SeqCst), 2);
        assert_eq!(complete_parent_calls.load(Ordering::SeqCst), 1);

        let synced = db.get_time_entry(&entry.id).unwrap().unwrap();
        assert_eq!(synced.sync_status, SyncStatus::Synced);
        assert!(synced.sync_error.is_none());

        // Local parent task status updated to 2 without ever mutating remote parent schedule.
        let parent_after = db.get_ticktick_task("parent-1").unwrap().unwrap();
        assert_eq!(parent_after.status, 2);
        let reqs = recorded.lock().unwrap();
        assert!(!reqs.iter().any(|r| r.path == "/open/v1/task/parent-1"));
    }

    #[tokio::test]
    async fn refreshes_expired_oauth_token_automatically_on_401_and_supports_fallback_list_mode() {
        let refresh_calls = Arc::new(AtomicUsize::new(0));
        let refresh_cnt = Arc::clone(&refresh_calls);

        let (base_url, _recorded) = spawn_mock_server(move |req| {
            if req.method == "POST" && req.path == "/oauth/token" {
                refresh_cnt.fetch_add(1, Ordering::SeqCst);
                assert!(req.body.contains("grant_type=refresh_token"));
                assert!(req.body.contains("refresh_token=rt-old"));
                return (
                    200,
                    r#"{"access_token":"at-fresh","refresh_token":"rt-rotated","expires_in":3600}"#.into(),
                );
            }
            if req.auth.as_deref() != Some("Bearer at-fresh") {
                return (401, r#"{"error":"expired"}"#.into());
            }
            match (req.method.as_str(), req.path.as_str()) {
                ("POST", "/open/v1/task") => {
                    let body: serde_json::Value = serde_json::from_str(&req.body).unwrap();
                    assert_eq!(body["projectId"], "proj-timelog");
                    assert!(body.get("parentId").is_none());
                    (
                        200,
                        r#"{"id":"fb-100","projectId":"proj-timelog","title":"Fallback entry","status":0}"#.into(),
                    )
                }
                ("POST", "/open/v1/project/proj-timelog/task/fb-100/complete") => (200, "".into()),
                _ => (404, "{}".into()),
            }
        })
        .await;

        let (db, _store, service) = make_service(&base_url);
        service
            .save_oauth_config(SaveOAuthConfigInput {
                client_id: "cid".into(),
                client_secret: Some("csec".into()),
                redirect_port: Some(0),
            })
            .unwrap();

        let mut settings = AppSettings::default();
        settings.sync_mode = SyncMode::FallbackList;
        settings.fallback_project_id = Some("proj-timelog".into());
        settings.ticktick_oauth_client_id = Some("cid".into());
        db.update_settings(&settings).unwrap();

        // Seed an expired OAuth2 token in the secret store.
        service
            .credentials
            .save_credentials(&TickTickCredentials {
                auth_method: TickTickAuthMethod::OAuth2,
                access_token: "at-stale".into(),
                refresh_token: Some("rt-old".into()),
                token_type: Some("bearer".into()),
                scope: None,
                expires_at_ms: Some(Utc::now().timestamp_millis() + 600_000), // force 401 path
            })
            .unwrap();

        let entry = db
            .create_time_entry(CreateTimeEntryInput {
                description: "Fallback entry".into(),
                started_at: 1_700_000_000_000,
                ended_at: 1_700_000_300_000,
                ticktick_project_id: Some("proj-other".into()),
                ticktick_parent_task_id: None,
                tag_ids: vec![],
                complete_parent_task: false,
            })
            .unwrap();

        service.enqueue_entry_sync(&entry.id).unwrap();
        let synced = service.sync_single_entry(&entry.id).await.unwrap();
        assert_eq!(synced.sync_status, SyncStatus::Synced);
        assert_eq!(synced.sync_mode.as_deref(), Some("fallback_list"));
        assert_eq!(synced.ticktick_subtask_id.as_deref(), Some("fb-100"));
        assert_eq!(refresh_calls.load(Ordering::SeqCst), 1);

        let updated_creds = service.credentials.load_credentials().unwrap().unwrap();
        assert_eq!(updated_creds.access_token, "at-fresh");
        assert_eq!(updated_creds.refresh_token.as_deref(), Some("rt-rotated"));
    }

    #[tokio::test]
    async fn sync_worker_wakes_immediately_on_enqueue_and_notifies_callback() {
        let (base_url, _recorded) = spawn_mock_server(|req| match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/open/v1/project") => (200, "[]".into()),
            ("POST", "/open/v1/task") => (
                200,
                r#"{"id":"w-sub-1","projectId":"inbox","title":"Worker task","status":0}"#.into(),
            ),
            ("POST", "/open/v1/project/inbox/task/w-sub-1/complete") => (200, "".into()),
            _ => (404, "{}".into()),
        })
        .await;

        let (db, _store, service) = make_service(&base_url);
        service.connect_personal_token("tok").await.unwrap();

        let (tx, rx) = tokio::sync::oneshot::channel();
        let tx_cell = Arc::new(Mutex::new(Some(tx)));
        let worker = SyncWorkerHandle::spawn(
            Arc::clone(&service),
            Duration::from_secs(60),
            move |batch| {
                if let Some(sender) = tx_cell.lock().unwrap().take() {
                    let _ = sender.send(batch);
                }
            },
        );

        let entry = db
            .create_time_entry(CreateTimeEntryInput {
                description: "Worker task".into(),
                started_at: 1_700_000_000_000,
                ended_at: 1_700_000_120_000,
                ticktick_project_id: None,
                ticktick_parent_task_id: None,
                tag_ids: vec![],
                complete_parent_task: false,
            })
            .unwrap();

        service.enqueue_entry_sync(&entry.id).unwrap();

        let batch = tokio::time::timeout(Duration::from_secs(3), rx)
            .await
            .expect("worker notified promptly")
            .unwrap();
        assert_eq!(batch.synced, 1);
        assert_eq!(
            db.get_time_entry(&entry.id).unwrap().unwrap().sync_status,
            SyncStatus::Synced
        );
        worker.shutdown();
    }
}
