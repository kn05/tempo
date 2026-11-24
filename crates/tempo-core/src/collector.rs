use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::db::{Database, DbResult};
use crate::idle::IdleStateMachine;
use crate::models::{AppSettings, IdleReturnPrompt, PresenceOverride, TimeEntry};
use crate::tracker::{
    ActiveWindowInfo, ActivityAggregator, ActivityTracker, AggregationAction, AggregatorConfig,
    IdleDetector,
};

/// Thread-safe slot accepting external extension heartbeats (e.g. VS Code extension in Phase 4).
///
/// When a matching process is focused and a non-expired override exists, its `source`,
/// `window_title` (if provided), and `metadata_json` take precedence over raw OS window data.
#[derive(Debug, Clone, Default)]
pub struct PresenceSlot {
    inner: Arc<Mutex<HashMap<String, PresenceOverride>>>,
}

impl PresenceSlot {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&self, payload: PresenceOverride) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(payload.source.clone(), payload);
        }
    }

    pub fn clear(&self, source: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(source);
        }
    }

    pub fn resolve(&self, now_ms: i64, focused: ActiveWindowInfo) -> ActiveWindowInfo {
        let Ok(mut map) = self.inner.lock() else {
            return focused;
        };

        // Purge expired or future-skewed overrides.
        map.retain(|_, ov| {
            ov.ttl_ms > 0
                && now_ms >= ov.received_at_ms
                && now_ms.saturating_sub(ov.received_at_ms) <= ov.ttl_ms
        });

        let matched = map
            .values()
            .filter(|ov| {
                ov.target_processes.is_empty()
                    || ov
                        .target_processes
                        .iter()
                        .any(|proc_name| proc_name.eq_ignore_ascii_case(&focused.process_name))
            })
            .max_by_key(|ov| ov.received_at_ms)
            .cloned();

        match matched {
            Some(ov) => ActiveWindowInfo {
                source: ov.source,
                process_name: focused.process_name,
                window_title: ov.window_title.or(focused.window_title),
                metadata_json: ov.metadata_json.or(focused.metadata_json),
            },
            None => focused,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CollectorSnapshot {
    pub active_window: Option<ActiveWindowInfo>,
    pub idle_ms: u64,
    pub sampled_at_ms: i64,
}

#[derive(Debug, Clone)]
pub struct CollectorTickResult {
    pub sampled_at_ms: i64,
    pub action: AggregationAction,
    pub activity_row_id: Option<i64>,
    pub active_window: Option<ActiveWindowInfo>,
    pub idle_ms: u64,
    pub running_entry: Option<TimeEntry>,
    pub idle_prompt: Option<IdleReturnPrompt>,
}

/// Synchronous, deterministic core of the background activity & idle collector.
pub struct CollectorEngine {
    db: Arc<Database>,
    tracker: Box<dyn ActivityTracker>,
    idle_detector: Box<dyn IdleDetector>,
    presence: PresenceSlot,
    aggregator: ActivityAggregator,
    idle_sm: IdleStateMachine,
    current_activity_row_id: Option<i64>,
    last_sample_at: Option<i64>,
}

impl CollectorEngine {
    pub fn new(
        db: Arc<Database>,
        tracker: Box<dyn ActivityTracker>,
        idle_detector: Box<dyn IdleDetector>,
        settings: &AppSettings,
    ) -> Self {
        Self {
            db,
            tracker,
            idle_detector,
            presence: PresenceSlot::new(),
            aggregator: ActivityAggregator::new(AggregatorConfig::from(settings)),
            idle_sm: IdleStateMachine::new(settings.idle_threshold_ms),
            current_activity_row_id: None,
            last_sample_at: None,
        }
    }

    pub fn with_presence(mut self, presence: PresenceSlot) -> Self {
        self.presence = presence;
        self
    }

    pub fn presence(&self) -> PresenceSlot {
        self.presence.clone()
    }

    pub fn apply_settings(&mut self, settings: &AppSettings) {
        self.aggregator.update_config(AggregatorConfig::from(settings));
        self.idle_sm.set_threshold_ms(settings.idle_threshold_ms);
    }

    pub fn pending_idle_prompt(&self) -> Option<IdleReturnPrompt> {
        self.idle_sm.pending_prompt().cloned()
    }

    pub fn clear_idle_prompt(&mut self) {
        self.idle_sm.mark_resolved();
    }

    pub fn tick(&mut self, now_ms: i64) -> DbResult<CollectorTickResult> {
        let resolved_window = self
            .tracker
            .current_window()
            .map(|win| self.presence.resolve(now_ms, win));
        let idle_ms = self.idle_detector.idle_duration_ms();

        let action = self
            .aggregator
            .observe(now_ms, resolved_window.clone(), idle_ms);

        match &action {
            AggregationAction::StartNew(draft) => {
                let id = self.db.insert_activity_log(draft)?;
                self.current_activity_row_id = Some(id);
            }
            AggregationAction::ExtendCurrent { ended_at } => {
                if let Some(id) = self.current_activity_row_id {
                    self.db.extend_activity_log(id, *ended_at)?;
                }
            }
            AggregationAction::Ignore => {
                self.current_activity_row_id = None;
            }
        }

        let running_entry = self.db.get_running_timer()?;
        let idle_prompt = self.idle_sm.observe(now_ms, idle_ms, running_entry.as_ref());
        self.last_sample_at = Some(now_ms);

        Ok(CollectorTickResult {
            sampled_at_ms: now_ms,
            action,
            activity_row_id: self.current_activity_row_id,
            active_window: resolved_window,
            idle_ms,
            running_entry,
            idle_prompt,
        })
    }

    /// Flushes the final `ended_at` timestamp of the active activity log row on clean shutdown.
    pub fn flush(&mut self, now_ms: i64) -> DbResult<()> {
        if let (Some(row_id), Some(last_seen)) = (self.current_activity_row_id, self.last_sample_at)
        {
            let delta = now_ms - last_seen;
            if delta >= 0 && delta <= self.aggregator.config().max_merge_gap_ms {
                self.db.extend_activity_log(row_id, now_ms)?;
                self.last_sample_at = Some(now_ms);
            }
        }
        Ok(())
    }
}

struct RunnerControl {
    stop: bool,
    poll_interval_ms: u64,
    pending_settings: Option<AppSettings>,
    clear_idle_prompt: bool,
}

#[derive(Default)]
struct SharedCollectorState {
    pending_prompt: Option<IdleReturnPrompt>,
    latest_snapshot: Option<CollectorSnapshot>,
}

/// Handle to a background collector thread that persists activity spans and emits tick events.
pub struct CollectorHandle {
    presence: PresenceSlot,
    control: Arc<(Mutex<RunnerControl>, Condvar)>,
    shared: Arc<Mutex<SharedCollectorState>>,
    join_handle: Mutex<Option<JoinHandle<()>>>,
}

impl CollectorHandle {
    pub fn spawn<F>(
        mut engine: CollectorEngine,
        poll_interval_ms: u64,
        on_tick: F,
    ) -> Self
    where
        F: Fn(CollectorTickResult) + Send + 'static,
    {
        let presence = engine.presence();
        let control = Arc::new((
            Mutex::new(RunnerControl {
                stop: false,
                poll_interval_ms: poll_interval_ms.clamp(250, 60_000),
                pending_settings: None,
                clear_idle_prompt: false,
            }),
            Condvar::new(),
        ));
        let shared = Arc::new(Mutex::new(SharedCollectorState::default()));

        let thread_control = Arc::clone(&control);
        let thread_shared = Arc::clone(&shared);

        let handle = thread::Builder::new()
            .name("tempo-collector".into())
            .spawn(move || {
                let (lock, cvar) = &*thread_control;
                loop {
                    let (should_stop, next_settings, clear_prompt, interval_ms) = {
                        let mut ctrl = match lock.lock() {
                            Ok(guard) => guard,
                            Err(poisoned) => poisoned.into_inner(),
                        };
                        (
                            ctrl.stop,
                            ctrl.pending_settings.take(),
                            std::mem::take(&mut ctrl.clear_idle_prompt),
                            ctrl.poll_interval_ms,
                        )
                    };

                    if let Some(settings) = next_settings {
                        engine.apply_settings(&settings);
                    }
                    if clear_prompt {
                        engine.clear_idle_prompt();
                        if let Ok(mut st) = thread_shared.lock() {
                            st.pending_prompt = None;
                        }
                    }
                    if should_stop {
                        let _ = engine.flush(Utc::now().timestamp_millis());
                        break;
                    }

                    let now_ms = Utc::now().timestamp_millis();
                    if let Ok(result) = engine.tick(now_ms) {
                        if let Ok(mut st) = thread_shared.lock() {
                            st.pending_prompt = engine.pending_idle_prompt();
                            st.latest_snapshot = Some(CollectorSnapshot {
                                active_window: result.active_window.clone(),
                                idle_ms: result.idle_ms,
                                sampled_at_ms: result.sampled_at_ms,
                            });
                        }
                        on_tick(result);
                    }

                    let ctrl = match lock.lock() {
                        Ok(guard) => guard,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                    if ctrl.stop || ctrl.pending_settings.is_some() || ctrl.clear_idle_prompt {
                        continue;
                    }
                    let _ = cvar.wait_timeout(ctrl, Duration::from_millis(interval_ms));
                }
            })
            .expect("failed to spawn tempo-collector thread");

        Self {
            presence,
            control,
            shared,
            join_handle: Mutex::new(Some(handle)),
        }
    }

    pub fn presence(&self) -> PresenceSlot {
        self.presence.clone()
    }

    pub fn reload_settings(&self, settings: &AppSettings) {
        let clean = settings.sanitized();
        let (lock, cvar) = &*self.control;
        if let Ok(mut ctrl) = lock.lock() {
            ctrl.poll_interval_ms = clean.poll_interval_ms;
            ctrl.pending_settings = Some(clean);
            cvar.notify_all();
        }
    }

    pub fn pending_idle_prompt(&self) -> Option<IdleReturnPrompt> {
        self.shared
            .lock()
            .ok()
            .and_then(|st| st.pending_prompt.clone())
    }

    pub fn clear_idle_prompt(&self) {
        if let Ok(mut st) = self.shared.lock() {
            st.pending_prompt = None;
        }
        let (lock, cvar) = &*self.control;
        if let Ok(mut ctrl) = lock.lock() {
            ctrl.clear_idle_prompt = true;
            cvar.notify_all();
        }
    }

    pub fn latest_snapshot(&self) -> Option<CollectorSnapshot> {
        self.shared
            .lock()
            .ok()
            .and_then(|st| st.latest_snapshot.clone())
    }

    /// Signals the collector thread to flush the active activity span and exit cleanly.
    pub fn shutdown(&self) {
        let (lock, cvar) = &*self.control;
        if let Ok(mut ctrl) = lock.lock() {
            ctrl.stop = true;
            cvar.notify_all();
        }
        if let Ok(mut guard) = self.join_handle.lock() {
            if let Some(handle) = guard.take() {
                let _ = handle.join();
            }
        }
    }
}

impl Drop for CollectorHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Returns current Unix timestamp in milliseconds.
pub fn current_timestamp_ms() -> i64 {
    Utc::now().timestamp_millis()
}

/// Formats the system tray tooltip text (kept well within Windows's 127-char tooltip limit).
pub fn format_tray_tooltip(running_entry: Option<&TimeEntry>, now_ms: i64) -> String {
    let Some(entry) = running_entry else {
        return "tempo — Idle".to_string();
    };

    let elapsed_secs = (now_ms - entry.started_at).max(0) / 1_000;
    let hours = elapsed_secs / 3_600;
    let minutes = (elapsed_secs % 3_600) / 60;
    let seconds = elapsed_secs % 60;

    let trimmed = entry.description.trim();
    let label = if trimmed.is_empty() {
        "(Untitled)".to_string()
    } else if trimmed.chars().count() > 64 {
        let mut s: String = trimmed.chars().take(63).collect();
        s.push('…');
        s
    } else {
        trimmed.to_string()
    };

    format!("tempo — {label} {hours:02}:{minutes:02}:{seconds:02}")
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;
    use crate::models::StartTimerInput;

    struct MockTracker {
        window: Mutex<Option<ActiveWindowInfo>>,
    }

    impl MockTracker {
        fn new(win: Option<ActiveWindowInfo>) -> Arc<Self> {
            Arc::new(Self {
                window: Mutex::new(win),
            })
        }

        fn set(&self, win: Option<ActiveWindowInfo>) {
            *self.window.lock().unwrap() = win;
        }
    }

    struct SharedMockTracker(Arc<MockTracker>);

    impl ActivityTracker for SharedMockTracker {
        fn current_window(&self) -> Option<ActiveWindowInfo> {
            self.0.window.lock().unwrap().clone()
        }
    }

    struct SharedMockIdle(Arc<AtomicU64>);

    impl IdleDetector for SharedMockIdle {
        fn idle_duration_ms(&self) -> u64 {
            self.0.load(Ordering::Relaxed)
        }
    }

    fn code_window(title: &str) -> ActiveWindowInfo {
        ActiveWindowInfo {
            source: "win_api".into(),
            process_name: "Code.exe".into(),
            window_title: Some(title.into()),
            metadata_json: None,
        }
    }

    #[test]
    fn persists_activity_spans_applies_presence_ttl_and_flushes() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let tracker = MockTracker::new(Some(code_window("mod.rs — Visual Studio Code")));
        let idle = Arc::new(AtomicU64::new(0));
        let settings = AppSettings::default();

        let mut engine = CollectorEngine::new(
            Arc::clone(&db),
            Box::new(SharedMockTracker(Arc::clone(&tracker))),
            Box::new(SharedMockIdle(Arc::clone(&idle))),
            &settings,
        );

        let presence = engine.presence();

        // Tick 1: raw Win32 window starts new row
        let t1 = engine.tick(10_000).unwrap();
        assert!(matches!(t1.action, AggregationAction::StartNew(_)));
        let first_id = t1.activity_row_id.unwrap();

        // Tick 2: same window extends row
        let t2 = engine.tick(12_000).unwrap();
        assert_eq!(t2.action, AggregationAction::ExtendCurrent { ended_at: 12_000 });
        assert_eq!(t2.activity_row_id, Some(first_id));

        // Inject VS Code extension heartbeat (TTL 10s)
        presence.update(PresenceOverride {
            source: "vscode_ext".into(),
            target_processes: vec!["code.exe".into()],
            window_title: Some("tempo (main) — collector.rs".into()),
            metadata_json: Some(r#"{"workspace":"tempo","branch":"main"}"#.into()),
            received_at_ms: 13_000,
            ttl_ms: 10_000,
        });

        // Tick 3: presence override replaces title & metadata, starting a new rich span
        let t3 = engine.tick(14_000).unwrap();
        assert!(matches!(
            &t3.action,
            AggregationAction::StartNew(log)
                if log.source == "vscode_ext"
                    && log.window_title.as_deref() == Some("tempo (main) — collector.rs")
                    && log.metadata_json.is_some()
        ));

        // Tick 4: still within TTL -> extends rich span
        let t4 = engine.tick(20_000).unwrap();
        assert_eq!(t4.action, AggregationAction::ExtendCurrent { ended_at: 20_000 });

        // Tick 5: after TTL expired (24_000 - 13_000 = 11_000 > 10_000) -> falls back to win_api
        let t5 = engine.tick(24_000).unwrap();
        assert!(matches!(
            &t5.action,
            AggregationAction::StartNew(log) if log.source == "win_api"
        ));

        // Flush on clean shutdown extends latest row to 26_500
        engine.flush(26_500).unwrap();

        let logs = db.list_activity_logs(0, 100_000).unwrap();
        assert_eq!(logs.len(), 3);
        assert_eq!(logs[0].started_at, 10_000);
        assert_eq!(logs[0].ended_at, 12_000);
        assert_eq!(logs[1].source, "vscode_ext");
        assert_eq!(logs[1].started_at, 14_000);
        assert_eq!(logs[1].ended_at, 20_000);
        assert_eq!(logs[2].source, "win_api");
        assert_eq!(logs[2].started_at, 24_000);
        assert_eq!(logs[2].ended_at, 26_500);
    }

    #[test]
    fn collector_triggers_idle_prompt_for_running_manual_timer_and_records_idle_log() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let tracker = MockTracker::new(Some(code_window("main.rs")));
        let idle = Arc::new(AtomicU64::new(0));
        let settings = AppSettings {
            idle_threshold_ms: 60_000,
            ..Default::default()
        };

        let entry = db
            .start_timer(StartTimerInput {
                description: "Build core engine".into(),
                ticktick_project_id: None,
                ticktick_parent_task_id: None,
                tag_ids: vec![],
                started_at: Some(1_000),
            })
            .unwrap();

        let mut engine = CollectorEngine::new(
            Arc::clone(&db),
            Box::new(SharedMockTracker(Arc::clone(&tracker))),
            Box::new(SharedMockIdle(Arc::clone(&idle))),
            &settings,
        );

        let _ = engine.tick(5_000).unwrap();
        idle.store(60_000, Ordering::Relaxed);
        let t_idle = engine.tick(65_000).unwrap();
        assert!(t_idle.idle_prompt.is_none());
        assert!(matches!(
            t_idle.action,
            AggregationAction::StartNew(ref log) if log.is_idle
        ));

        // User returns
        idle.store(0, Ordering::Relaxed);
        let t_return = engine.tick(70_000).unwrap();
        let prompt = t_return.idle_prompt.expect("idle return prompt");
        assert_eq!(prompt.entry_id, entry.id);
        assert_eq!(prompt.idle_started_at, 5_000);
        assert_eq!(prompt.returned_at, 70_000);
        assert_eq!(prompt.idle_duration_ms, 65_000);

        let logs = db.list_activity_logs(0, 100_000).unwrap();
        assert_eq!(logs.len(), 3);
        assert!(!logs[0].is_idle);
        assert!(logs[1].is_idle);
        assert!(!logs[2].is_idle);
    }

    #[test]
    fn background_collector_handle_runs_and_shuts_down_cleanly() {
        let db = Arc::new(Database::open_in_memory().unwrap());
        let tracker = MockTracker::new(Some(code_window("app.tsx")));
        let idle = Arc::new(AtomicU64::new(0));
        let settings = AppSettings {
            poll_interval_ms: 250,
            ..Default::default()
        };

        let engine = CollectorEngine::new(
            Arc::clone(&db),
            Box::new(SharedMockTracker(Arc::clone(&tracker))),
            Box::new(SharedMockIdle(Arc::clone(&idle))),
            &settings,
        );

        let (tx, rx) = std::sync::mpsc::channel();
        let handle = CollectorHandle::spawn(engine, settings.poll_interval_ms, move |tick| {
            let _ = tx.send(tick.sampled_at_ms);
        });

        // Wait for at least one tick to persist.
        let first_ts = rx.recv_timeout(Duration::from_secs(2)).expect("first tick");
        assert!(handle.latest_snapshot().is_some());

        // Hot-reload settings and switch tracked window
        tracker.set(Some(code_window("README.md")));
        handle.reload_settings(&settings);
        let _second_ts = rx.recv_timeout(Duration::from_secs(2)).expect("second tick");

        handle.shutdown();

        let logs = db.list_activity_logs(first_ts - 10_000, first_ts + 60_000).unwrap();
        assert!(!logs.is_empty());
    }

    #[test]
    fn formats_tray_tooltip_for_idle_running_and_long_utf8_titles() {
        assert_eq!(format_tray_tooltip(None, 50_000), "tempo — Idle");

        let short_entry = TimeEntry {
            id: "1".into(),
            description: "Phase 1 엔진 구현".into(),
            started_at: 10_000,
            ended_at: None,
            ticktick_project_id: None,
            ticktick_parent_task_id: None,
            ticktick_subtask_id: None,
            sync_mode: None,
            sync_status: crate::models::SyncStatus::Local,
            sync_error: None,
            retry_count: 0,
            complete_parent_task: false,
            tag_ids: vec![],
            created_at: 10_000,
            updated_at: 10_000,
        };
        assert_eq!(
            format_tray_tooltip(Some(&short_entry), 10_000 + (3661 * 1_000)),
            "tempo — Phase 1 엔진 구현 01:01:01"
        );

        let long_entry = TimeEntry {
            description: "한글작업설명".repeat(20),
            ..short_entry.clone()
        };
        let tooltip = format_tray_tooltip(Some(&long_entry), 10_000);
        assert!(tooltip.starts_with("tempo — "));
        assert!(tooltip.contains('…'));
        assert!(tooltip.ends_with(" 00:00:00"));
        assert!(tooltip.chars().count() < 120);

        let untitled = TimeEntry {
            description: "   ".into(),
            ..short_entry
        };
        assert_eq!(
            format_tray_tooltip(Some(&untitled), 15_000),
            "tempo — (Untitled) 00:00:05"
        );
    }
}
