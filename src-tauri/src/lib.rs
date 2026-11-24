mod shortcuts;
mod tray;

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_opener::OpenerExt;
use tempo_core::{
    create_platform_idle_detector, create_platform_tracker, current_timestamp_ms,
    parse_quick_entry, ActiveWindowInfo, ActivityLog, ActivityTracker, AppSettings,
    CollectorEngine, CollectorHandle, CreateTimeEntryInput, CredentialManager, Database,
    IdleDetector, IdleResolutionInput, IdleResolutionResult, IdleReturnPrompt,
    OAuthLoginStartResult, ParsedQuickEntry, PresenceOverride, SaveOAuthConfigInput,
    ShortcutStatus, StartTimerInput, SyncWorkerHandle, Tag, TickTickConnectionStatus,
    TickTickProject, TickTickPullResult, TickTickService, TickTickSyncBatchResult, TickTickTask,
    TimeEntry, UpdateTimeEntryInput, DEFAULT_SYNC_WORKER_INTERVAL_SECS,
};

use crate::shortcuts::ShortcutManager;
use crate::tray::{focus_main_window, TrayController};

pub const EVENT_IDLE_RETURN: &str = "tempo://idle-return";
pub const EVENT_TIMER_CHANGED: &str = "tempo://timer-changed";
pub const EVENT_ENTRIES_CHANGED: &str = "tempo://entries-changed";
pub const EVENT_FOCUS_QUICK_ENTRY: &str = "tempo://focus-quick-entry";
pub const EVENT_TICKTICK_CHANGED: &str = "tempo://ticktick-changed";

pub const MINI_WINDOW_LABEL: &str = "mini";

pub(crate) struct AppState {
    pub db: Arc<Database>,
    pub collector: CollectorHandle,
    pub ticktick: Arc<TickTickService>,
    pub sync_worker: SyncWorkerHandle,
    tracker: Box<dyn ActivityTracker>,
    idle_detector: Box<dyn IdleDetector>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlatformStatus {
    os: &'static str,
    arch: &'static str,
    active_window: Option<ActiveWindowInfo>,
    idle_ms: u64,
    schema_version: i32,
}

fn sync_tray_from_db(app: &AppHandle, state: &AppState) {
    if let Some(tray_ctrl) = app.try_state::<TrayController>() {
        let running = state.db.get_running_timer().ok().flatten();
        tray_ctrl.sync(app, running.as_ref(), current_timestamp_ms());
    }
}

pub(crate) fn open_mini_timer_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MINI_WINDOW_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let always_on_top = app
        .try_state::<AppState>()
        .and_then(|s| s.db.get_settings().ok())
        .map(|s| s.mini_timer_always_on_top)
        .unwrap_or(true);

    WebviewWindowBuilder::new(
        app,
        MINI_WINDOW_LABEL,
        WebviewUrl::App("index.html?window=mini".into()),
    )
    .title("tempo mini")
    .inner_size(360.0, 96.0)
    .resizable(false)
    .decorations(false)
    .always_on_top(always_on_top)
    .skip_taskbar(true)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

pub(crate) fn close_mini_timer_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(MINI_WINDOW_LABEL) {
        window.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn toggle_mini_timer_window(app: &AppHandle) -> Result<bool, String> {
    if app.get_webview_window(MINI_WINDOW_LABEL).is_some() {
        close_mini_timer_window(app)?;
        Ok(false)
    } else {
        open_mini_timer_window(app)?;
        Ok(true)
    }
}

pub(crate) fn shutdown_app(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.ticktick.cancel_oauth_login();
        state.sync_worker.shutdown();
        state.collector.shutdown();
        if let Ok(settings) = state.db.get_settings() {
            if settings.stop_timer_on_quit {
                let _ = state.db.stop_running_timer(None);
            }
        }
    }
    app.exit(0);
}

#[tauri::command]
fn get_platform_status(state: State<'_, AppState>) -> PlatformStatus {
    let snapshot = state.collector.latest_snapshot();
    let (active_window, idle_ms) = match snapshot {
        Some(snap) => (snap.active_window, snap.idle_ms),
        None => (
            state.tracker.current_window(),
            state.idle_detector.idle_duration_ms(),
        ),
    };

    PlatformStatus {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        active_window,
        idle_ms,
        schema_version: state.db.schema_version().unwrap_or(0),
    }
}

#[tauri::command]
fn get_running_timer(state: State<'_, AppState>) -> Result<Option<TimeEntry>, String> {
    state.db.get_running_timer().map_err(|e| e.to_string())
}

#[tauri::command]
fn start_timer(
    app: AppHandle,
    state: State<'_, AppState>,
    input: StartTimerInput,
) -> Result<TimeEntry, String> {
    let entry = state.db.start_timer(input).map_err(|e| e.to_string())?;
    state.collector.clear_idle_prompt();
    sync_tray_from_db(&app, &state);
    let _ = app.emit(EVENT_TIMER_CHANGED, Some(entry.clone()));
    let _ = app.emit(EVENT_ENTRIES_CHANGED, ());
    Ok(entry)
}

#[tauri::command]
fn stop_timer(app: AppHandle, state: State<'_, AppState>) -> Result<Option<TimeEntry>, String> {
    let mut stopped = state
        .db
        .stop_running_timer(None)
        .map_err(|e| e.to_string())?;
    let mut auto_enqueued = false;
    if let Some(entry) = stopped.take() {
        if let Some(enqueued) = state.ticktick.maybe_auto_enqueue_stopped_entry(&entry) {
            stopped = Some(enqueued);
            auto_enqueued = true;
        } else {
            stopped = Some(entry);
        }
    }
    state.collector.clear_idle_prompt();
    sync_tray_from_db(&app, &state);
    let _ = app.emit(EVENT_TIMER_CHANGED, Option::<TimeEntry>::None);
    let _ = app.emit(EVENT_ENTRIES_CHANGED, ());
    if auto_enqueued {
        let _ = app.emit(EVENT_TICKTICK_CHANGED, ());
    }
    Ok(stopped)
}

#[tauri::command]
fn list_time_entries(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> Result<Vec<TimeEntry>, String> {
    state
        .db
        .list_time_entries(limit.unwrap_or(100))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_time_entries_in_range(
    state: State<'_, AppState>,
    from_ms: i64,
    to_ms: i64,
) -> Result<Vec<TimeEntry>, String> {
    state
        .db
        .list_time_entries_in_range(from_ms, to_ms)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn create_time_entry(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateTimeEntryInput,
) -> Result<TimeEntry, String> {
    let created = state.db.create_time_entry(input).map_err(|e| e.to_string())?;
    let _ = app.emit(EVENT_ENTRIES_CHANGED, ());
    Ok(created)
}

#[tauri::command]
fn update_time_entry(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    input: UpdateTimeEntryInput,
) -> Result<Option<TimeEntry>, String> {
    let was_running = state
        .db
        .get_time_entry(&id)
        .ok()
        .flatten()
        .is_some_and(|entry| entry.ended_at.is_none());

    let updated = state
        .db
        .update_time_entry(&id, input)
        .map_err(|e| e.to_string())?;

    let is_still_running = updated
        .as_ref()
        .is_some_and(|entry| entry.ended_at.is_none());

    sync_tray_from_db(&app, &state);
    if was_running || is_still_running {
        let running = state.db.get_running_timer().ok().flatten();
        let _ = app.emit(EVENT_TIMER_CHANGED, running);
    }
    if updated.is_some() {
        let _ = app.emit(EVENT_ENTRIES_CHANGED, ());
    }
    Ok(updated)
}

#[tauri::command]
fn delete_time_entry(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let was_running = state
        .db
        .get_time_entry(&id)
        .ok()
        .flatten()
        .is_some_and(|entry| entry.ended_at.is_none());

    let deleted = state
        .db
        .delete_time_entry(&id)
        .map_err(|e| e.to_string())?;
    if deleted {
        let running = state.db.get_running_timer().ok().flatten();
        if running.is_none() {
            state.collector.clear_idle_prompt();
        }
        sync_tray_from_db(&app, &state);
        if was_running {
            let _ = app.emit(EVENT_TIMER_CHANGED, running);
        }
        let _ = app.emit(EVENT_ENTRIES_CHANGED, ());
    }
    Ok(deleted)
}

#[tauri::command]
fn list_activity_logs(
    state: State<'_, AppState>,
    from_ms: i64,
    to_ms: i64,
    min_duration_ms: Option<i64>,
) -> Result<Vec<ActivityLog>, String> {
    state
        .db
        .list_activity_logs_filtered(from_ms, to_ms, min_duration_ms)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_tags(state: State<'_, AppState>) -> Result<Vec<Tag>, String> {
    state.db.list_tags().map_err(|e| e.to_string())
}

#[tauri::command]
fn upsert_tag(
    state: State<'_, AppState>,
    name: String,
    source: Option<String>,
    color: Option<String>,
) -> Result<Tag, String> {
    state
        .db
        .upsert_tag(&name, source.as_deref().unwrap_or("local"), color.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_tag(state: State<'_, AppState>, id: String) -> Result<bool, String> {
    state.db.delete_tag(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_ticktick_projects(
    state: State<'_, AppState>,
    include_closed: Option<bool>,
) -> Result<Vec<TickTickProject>, String> {
    state
        .db
        .list_ticktick_projects(include_closed.unwrap_or(false))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn list_ticktick_tasks(
    state: State<'_, AppState>,
    project_id: Option<String>,
    status: Option<i64>,
    query: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<TickTickTask>, String> {
    state
        .db
        .list_ticktick_tasks(
            project_id.as_deref(),
            status,
            query.as_deref(),
            limit.unwrap_or(100),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn parse_quick_entry_input(input: String) -> ParsedQuickEntry {
    parse_quick_entry(&input)
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state.db.get_settings().map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let saved = state
        .db
        .update_settings(&settings)
        .map_err(|e| e.to_string())?;
    state.collector.reload_settings(&saved);
    if let Some(shortcut_mgr) = app.try_state::<ShortcutManager>() {
        shortcut_mgr.apply(&app, &saved);
    }
    if let Some(mini) = app.get_webview_window(MINI_WINDOW_LABEL) {
        let _ = mini.set_always_on_top(saved.mini_timer_always_on_top);
    }
    Ok(saved)
}

#[tauri::command]
fn get_shortcut_status(app: AppHandle) -> ShortcutStatus {
    app.try_state::<ShortcutManager>()
        .map(|mgr| mgr.status())
        .unwrap_or_default()
}

#[tauri::command]
fn get_pending_idle_prompt(state: State<'_, AppState>) -> Option<IdleReturnPrompt> {
    state.collector.pending_idle_prompt()
}

#[tauri::command]
fn resolve_idle(
    app: AppHandle,
    state: State<'_, AppState>,
    input: IdleResolutionInput,
) -> Result<IdleResolutionResult, String> {
    let result = state.db.resolve_idle(input).map_err(|e| e.to_string())?;
    state.collector.clear_idle_prompt();
    sync_tray_from_db(&app, &state);
    let running = state.db.get_running_timer().ok().flatten();
    let _ = app.emit(EVENT_TIMER_CHANGED, running);
    let _ = app.emit(EVENT_ENTRIES_CHANGED, ());
    Ok(result)
}

#[tauri::command]
fn submit_presence_heartbeat(state: State<'_, AppState>, payload: PresenceOverride) {
    state.collector.presence().update(payload);
}

#[tauri::command]
async fn open_mini_timer(app: AppHandle) -> Result<(), String> {
    open_mini_timer_window(&app)
}

#[tauri::command]
async fn close_mini_timer(app: AppHandle) -> Result<(), String> {
    close_mini_timer_window(&app)
}

#[tauri::command]
async fn toggle_mini_timer(app: AppHandle) -> Result<bool, String> {
    toggle_mini_timer_window(&app)
}

#[tauri::command]
fn is_mini_timer_open(app: AppHandle) -> bool {
    app.get_webview_window(MINI_WINDOW_LABEL).is_some()
}

#[tauri::command]
async fn set_mini_timer_always_on_top(
    app: AppHandle,
    state: State<'_, AppState>,
    always_on_top: bool,
) -> Result<bool, String> {
    let mut settings = state.db.get_settings().map_err(|e| e.to_string())?;
    settings.mini_timer_always_on_top = always_on_top;
    let saved = state
        .db
        .update_settings(&settings)
        .map_err(|e| e.to_string())?;
    if let Some(mini) = app.get_webview_window(MINI_WINDOW_LABEL) {
        mini.set_always_on_top(saved.mini_timer_always_on_top)
            .map_err(|e| e.to_string())?;
    }
    Ok(saved.mini_timer_always_on_top)
}

#[tauri::command]
fn focus_main_window_cmd(app: AppHandle) {
    focus_main_window(&app);
}

// =============================================================================
// Phase 3: TickTick OAuth2, Pull Caching & Offline Sync Queue Commands
// =============================================================================

#[tauri::command]
fn get_ticktick_status(state: State<'_, AppState>) -> TickTickConnectionStatus {
    state.ticktick.status()
}

#[tauri::command]
fn save_ticktick_oauth_config(
    app: AppHandle,
    state: State<'_, AppState>,
    input: SaveOAuthConfigInput,
) -> Result<TickTickConnectionStatus, String> {
    let status = state
        .ticktick
        .save_oauth_config(input)
        .map_err(|e| e.to_string())?;
    let _ = app.emit(EVENT_TICKTICK_CHANGED, ());
    Ok(status)
}

#[tauri::command]
async fn connect_ticktick_personal_token(
    app: AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<TickTickConnectionStatus, String> {
    let status = state
        .ticktick
        .connect_personal_token(&token)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(EVENT_TICKTICK_CHANGED, ());
    Ok(status)
}

#[tauri::command]
async fn start_ticktick_oauth_login(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<OAuthLoginStartResult, String> {
    let (start, session) = state
        .ticktick
        .begin_oauth_login()
        .await
        .map_err(|e| e.to_string())?;

    let _ = app.emit(EVENT_TICKTICK_CHANGED, ());
    // Best-effort open in the system browser; UI also surfaces the copyable authorize URL.
    let _ = app
        .opener()
        .open_url(start.authorize_url.clone(), None::<&str>);

    let app_bg = app.clone();
    let ticktick_bg = Arc::clone(&state.ticktick);
    tauri::async_runtime::spawn(async move {
        match session.wait_and_complete().await {
            Ok(_) => {
                let _ = app_bg.emit(EVENT_TICKTICK_CHANGED, ());
                // Automatically pull projects/tasks/tags once OAuth2 completes.
                let _ = ticktick_bg.pull_cache().await;
                let _ = app_bg.emit(EVENT_ENTRIES_CHANGED, ());
                let _ = app_bg.emit(EVENT_TICKTICK_CHANGED, ());
                focus_main_window(&app_bg);
            }
            Err(_) => {
                let _ = app_bg.emit(EVENT_TICKTICK_CHANGED, ());
            }
        }
    });

    Ok(start)
}

#[tauri::command]
fn cancel_ticktick_oauth_login(
    app: AppHandle,
    state: State<'_, AppState>,
) -> TickTickConnectionStatus {
    state.ticktick.cancel_oauth_login();
    let _ = app.emit(EVENT_TICKTICK_CHANGED, ());
    state.ticktick.status()
}

#[tauri::command]
fn disconnect_ticktick(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TickTickConnectionStatus, String> {
    let status = state.ticktick.disconnect().map_err(|e| e.to_string())?;
    let _ = app.emit(EVENT_TICKTICK_CHANGED, ());
    Ok(status)
}

#[tauri::command]
async fn pull_ticktick_cache(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TickTickPullResult, String> {
    let result = state
        .ticktick
        .pull_cache()
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(EVENT_ENTRIES_CHANGED, ());
    let _ = app.emit(EVENT_TICKTICK_CHANGED, ());
    Ok(result)
}

#[tauri::command]
fn enqueue_ticktick_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    entry_id: String,
) -> Result<TimeEntry, String> {
    let entry = state
        .ticktick
        .enqueue_entry_sync(&entry_id)
        .map_err(|e| e.to_string())?;
    let _ = app.emit(EVENT_ENTRIES_CHANGED, ());
    let _ = app.emit(EVENT_TICKTICK_CHANGED, ());
    Ok(entry)
}

#[tauri::command]
async fn process_ticktick_sync_queue(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TickTickSyncBatchResult, String> {
    let batch = state
        .ticktick
        .process_sync_queue(false)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(EVENT_ENTRIES_CHANGED, ());
    let _ = app.emit(EVENT_TICKTICK_CHANGED, ());
    Ok(batch)
}

#[tauri::command]
async fn retry_failed_ticktick_syncs(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<TickTickSyncBatchResult, String> {
    let batch = state
        .ticktick
        .retry_failed_syncs()
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit(EVENT_ENTRIES_CHANGED, ());
    let _ = app.emit(EVENT_TICKTICK_CHANGED, ());
    Ok(batch)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("tempo.db");
            let db = Arc::new(
                Database::open(&db_path).map_err(|e| std::io::Error::other(e.to_string()))?,
            );
            let settings = db
                .get_settings()
                .map_err(|e| std::io::Error::other(e.to_string()))?;

            let tray_controller = TrayController::setup(app)?;
            let initial_running = db.get_running_timer().ok().flatten();
            tray_controller.sync(app.handle(), initial_running.as_ref(), current_timestamp_ms());
            app.manage(tray_controller);

            let engine = CollectorEngine::new(
                Arc::clone(&db),
                create_platform_tracker(),
                create_platform_idle_detector(),
                &settings,
            );

            let app_handle = app.handle().clone();
            let collector = CollectorHandle::spawn(engine, settings.poll_interval_ms, move |tick| {
                if let Some(tray_ctrl) = app_handle.try_state::<TrayController>() {
                    tray_ctrl.sync(&app_handle, tick.running_entry.as_ref(), tick.sampled_at_ms);
                }
                if let Some(prompt) = tick.idle_prompt {
                    let _ = app_handle.emit(EVENT_IDLE_RETURN, prompt);
                    focus_main_window(&app_handle);
                }
            });

            let ticktick = Arc::new(TickTickService::new(
                Arc::clone(&db),
                Arc::new(CredentialManager::system_keyring()),
            ));
            let sync_app_handle = app.handle().clone();
            let (sync_worker, sync_worker_future) = SyncWorkerHandle::prepare(
                Arc::clone(&ticktick),
                Duration::from_secs(DEFAULT_SYNC_WORKER_INTERVAL_SECS),
                move |_batch| {
                    let _ = sync_app_handle.emit(EVENT_ENTRIES_CHANGED, ());
                    let _ = sync_app_handle.emit(EVENT_TICKTICK_CHANGED, ());
                },
            );
            tauri::async_runtime::spawn(sync_worker_future);

            app.manage(AppState {
                db,
                collector,
                ticktick,
                sync_worker,
                tracker: create_platform_tracker(),
                idle_detector: create_platform_idle_detector(),
            });

            app.manage(ShortcutManager::new());
            let shortcut_app = app.handle().clone();
            let initial_settings = settings.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(mgr) = shortcut_app.try_state::<ShortcutManager>() {
                    mgr.apply(&shortcut_app, &initial_settings);
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Keep background collector alive in the system tray when the main window is closed.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_platform_status,
            get_running_timer,
            start_timer,
            stop_timer,
            list_time_entries,
            list_time_entries_in_range,
            create_time_entry,
            update_time_entry,
            delete_time_entry,
            list_activity_logs,
            list_tags,
            upsert_tag,
            delete_tag,
            list_ticktick_projects,
            list_ticktick_tasks,
            parse_quick_entry_input,
            get_settings,
            update_settings,
            get_shortcut_status,
            get_pending_idle_prompt,
            resolve_idle,
            submit_presence_heartbeat,
            open_mini_timer,
            close_mini_timer,
            toggle_mini_timer,
            is_mini_timer_open,
            set_mini_timer_always_on_top,
            focus_main_window_cmd,
            get_ticktick_status,
            save_ticktick_oauth_config,
            connect_ticktick_personal_token,
            start_ticktick_oauth_login,
            cancel_ticktick_oauth_login,
            disconnect_ticktick,
            pull_ticktick_cache,
            enqueue_ticktick_sync,
            process_ticktick_sync_queue,
            retry_failed_ticktick_syncs,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tempo");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.ticktick.cancel_oauth_login();
                state.sync_worker.shutdown();
                state.collector.shutdown();
                if let Ok(settings) = state.db.get_settings() {
                    if settings.stop_timer_on_quit {
                        let _ = state.db.stop_running_timer(None);
                    }
                }
            }
        }
    });
}
