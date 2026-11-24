pub mod migrations;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::de::DeserializeOwned;
use serde::Serialize;
use thiserror::Error;
use uuid::Uuid;

use crate::models::{
    ActivityLog, AppSettings, CreateTimeEntryInput, DiscoverableApp, IdleResolutionAction,
    IdleResolutionInput, IdleResolutionResult, NewActivityLog, StartTimerInput, SyncMode,
    SyncStatus, Tag, TickTickProject, TickTickSyncQueueSummary, TickTickTask, TimeEntry,
    UpdateTimeEntryInput,
};

pub use migrations::CURRENT_SCHEMA_VERSION;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("SQLite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("Database mutex poisoned")]
    LockPoisoned,
    #[error("Unsupported database schema version {found} (max supported: {supported})")]
    UnsupportedSchemaVersion { found: i32, supported: i32 },
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Record not found: {0}")]
    NotFound(String),
    #[error("Invalid state: {0}")]
    InvalidState(String),
}

pub type DbResult<T> = Result<T, DbError>;

pub struct Database {
    conn: Mutex<Connection>,
}

const SETTING_POLL_INTERVAL_MS: &str = "poll_interval_ms";
const SETTING_IDLE_THRESHOLD_MS: &str = "idle_threshold_ms";
const SETTING_SLEEP_GAP_THRESHOLD_MS: &str = "sleep_gap_threshold_ms";
const SETTING_REDACTED_PROCESSES: &str = "redacted_processes";
const SETTING_REDACTED_TITLE_KEYWORDS: &str = "redacted_title_keywords";
const SETTING_EXCLUDED_PROCESSES: &str = "excluded_processes";
const SETTING_SYNC_MODE: &str = "sync_mode";
const SETTING_FALLBACK_PROJECT_ID: &str = "fallback_project_id";
const SETTING_STOP_TIMER_ON_QUIT: &str = "stop_timer_on_quit";
const SETTING_TIMELINE_MIN_DURATION_MS: &str = "timeline_min_duration_ms";
const SETTING_SHORTCUT_TOGGLE_TIMER: &str = "shortcut_toggle_timer";
const SETTING_SHORTCUT_QUICK_ENTRY: &str = "shortcut_quick_entry";
const SETTING_MINI_TIMER_ALWAYS_ON_TOP: &str = "mini_timer_always_on_top";
const SETTING_AUTO_SYNC_ON_STOP: &str = "auto_sync_on_stop";
const SETTING_TICKTICK_TIME_ZONE: &str = "ticktick_time_zone";
const SETTING_TICKTICK_OAUTH_CLIENT_ID: &str = "ticktick_oauth_client_id";
const SETTING_TICKTICK_OAUTH_REDIRECT_PORT: &str = "ticktick_oauth_redirect_port";

pub const SETTING_TICKTICK_LAST_PULL_AT: &str = "ticktick_last_pull_at";
pub const SETTING_TICKTICK_LAST_SYNC_ERROR: &str = "ticktick_last_sync_error";
const SETTING_SUBTASK_PROJECT_PREFIX: &str = "ticktick_subtask_project:";

impl Database {
    pub fn open(path: impl AsRef<Path>) -> DbResult<Self> {
        let conn = Connection::open(path)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> DbResult<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init(conn)
    }

    fn init(mut conn: Connection) -> DbResult<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )?;
        migrations::run_migrations(&mut conn)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn schema_version(&self) -> DbResult<i32> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        migrations::current_user_version(&conn)
    }

    // -------------------------------------------------------------------------
    // Settings
    // -------------------------------------------------------------------------

    pub fn get_setting_raw<T: DeserializeOwned>(&self, key: &str) -> DbResult<Option<T>> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let raw: Option<String> = conn
            .query_row(
                "SELECT value_json FROM settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()?;
        match raw {
            Some(json) => Ok(Some(serde_json::from_str(&json)?)),
            None => Ok(None),
        }
    }

    pub fn set_setting_raw<T: Serialize>(&self, key: &str, value: &T) -> DbResult<()> {
        let now = Utc::now().timestamp_millis();
        let json = serde_json::to_string(value)?;
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        Self::upsert_setting_row(&conn, key, &json, now)?;
        Ok(())
    }

    pub fn delete_setting_raw(&self, key: &str) -> DbResult<()> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    pub fn get_settings(&self) -> DbResult<AppSettings> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let mut stmt = conn.prepare("SELECT key, value_json FROM settings")?;
        let map: HashMap<String, String> = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
            .collect::<Result<HashMap<_, _>, _>>()?;

        let mut settings = AppSettings::default();
        if let Some(v) = Self::decode_setting::<u64>(&map, SETTING_POLL_INTERVAL_MS)? {
            settings.poll_interval_ms = v;
        }
        if let Some(v) = Self::decode_setting::<u64>(&map, SETTING_IDLE_THRESHOLD_MS)? {
            settings.idle_threshold_ms = v;
        }
        if let Some(v) = Self::decode_setting::<i64>(&map, SETTING_SLEEP_GAP_THRESHOLD_MS)? {
            settings.sleep_gap_threshold_ms = v;
        }
        if let Some(v) = Self::decode_setting::<Vec<String>>(&map, SETTING_REDACTED_PROCESSES)? {
            settings.redacted_processes = v;
        }
        if let Some(v) =
            Self::decode_setting::<Vec<String>>(&map, SETTING_REDACTED_TITLE_KEYWORDS)?
        {
            settings.redacted_title_keywords = v;
        }
        if let Some(v) = Self::decode_setting::<Vec<String>>(&map, SETTING_EXCLUDED_PROCESSES)? {
            settings.excluded_processes = v;
        }
        if let Some(v) = Self::decode_setting::<SyncMode>(&map, SETTING_SYNC_MODE)? {
            settings.sync_mode = v;
        }
        if let Some(v) = Self::decode_setting::<Option<String>>(&map, SETTING_FALLBACK_PROJECT_ID)?
        {
            settings.fallback_project_id = v;
        }
        if let Some(v) = Self::decode_setting::<bool>(&map, SETTING_STOP_TIMER_ON_QUIT)? {
            settings.stop_timer_on_quit = v;
        }
        if let Some(v) = Self::decode_setting::<i64>(&map, SETTING_TIMELINE_MIN_DURATION_MS)? {
            settings.timeline_min_duration_ms = v;
        }
        if let Some(v) =
            Self::decode_setting::<Option<String>>(&map, SETTING_SHORTCUT_TOGGLE_TIMER)?
        {
            settings.shortcut_toggle_timer = v;
        }
        if let Some(v) =
            Self::decode_setting::<Option<String>>(&map, SETTING_SHORTCUT_QUICK_ENTRY)?
        {
            settings.shortcut_quick_entry = v;
        }
        if let Some(v) = Self::decode_setting::<bool>(&map, SETTING_MINI_TIMER_ALWAYS_ON_TOP)? {
            settings.mini_timer_always_on_top = v;
        }
        if let Some(v) = Self::decode_setting::<bool>(&map, SETTING_AUTO_SYNC_ON_STOP)? {
            settings.auto_sync_on_stop = v;
        }
        if let Some(v) = Self::decode_setting::<Option<String>>(&map, SETTING_TICKTICK_TIME_ZONE)? {
            settings.ticktick_time_zone = v;
        }
        if let Some(v) =
            Self::decode_setting::<Option<String>>(&map, SETTING_TICKTICK_OAUTH_CLIENT_ID)?
        {
            settings.ticktick_oauth_client_id = v;
        }
        if let Some(v) = Self::decode_setting::<u16>(&map, SETTING_TICKTICK_OAUTH_REDIRECT_PORT)? {
            settings.ticktick_oauth_redirect_port = v;
        }

        Ok(settings.sanitized())
    }

    pub fn update_settings(&self, settings: &AppSettings) -> DbResult<AppSettings> {
        let clean = settings.sanitized();
        let now = Utc::now().timestamp_millis();

        let entries = [
            (
                SETTING_POLL_INTERVAL_MS,
                serde_json::to_string(&clean.poll_interval_ms)?,
            ),
            (
                SETTING_IDLE_THRESHOLD_MS,
                serde_json::to_string(&clean.idle_threshold_ms)?,
            ),
            (
                SETTING_SLEEP_GAP_THRESHOLD_MS,
                serde_json::to_string(&clean.sleep_gap_threshold_ms)?,
            ),
            (
                SETTING_REDACTED_PROCESSES,
                serde_json::to_string(&clean.redacted_processes)?,
            ),
            (
                SETTING_REDACTED_TITLE_KEYWORDS,
                serde_json::to_string(&clean.redacted_title_keywords)?,
            ),
            (
                SETTING_EXCLUDED_PROCESSES,
                serde_json::to_string(&clean.excluded_processes)?,
            ),
            (SETTING_SYNC_MODE, serde_json::to_string(&clean.sync_mode)?),
            (
                SETTING_FALLBACK_PROJECT_ID,
                serde_json::to_string(&clean.fallback_project_id)?,
            ),
            (
                SETTING_STOP_TIMER_ON_QUIT,
                serde_json::to_string(&clean.stop_timer_on_quit)?,
            ),
            (
                SETTING_TIMELINE_MIN_DURATION_MS,
                serde_json::to_string(&clean.timeline_min_duration_ms)?,
            ),
            (
                SETTING_SHORTCUT_TOGGLE_TIMER,
                serde_json::to_string(&clean.shortcut_toggle_timer)?,
            ),
            (
                SETTING_SHORTCUT_QUICK_ENTRY,
                serde_json::to_string(&clean.shortcut_quick_entry)?,
            ),
            (
                SETTING_MINI_TIMER_ALWAYS_ON_TOP,
                serde_json::to_string(&clean.mini_timer_always_on_top)?,
            ),
            (
                SETTING_AUTO_SYNC_ON_STOP,
                serde_json::to_string(&clean.auto_sync_on_stop)?,
            ),
            (
                SETTING_TICKTICK_TIME_ZONE,
                serde_json::to_string(&clean.ticktick_time_zone)?,
            ),
            (
                SETTING_TICKTICK_OAUTH_CLIENT_ID,
                serde_json::to_string(&clean.ticktick_oauth_client_id)?,
            ),
            (
                SETTING_TICKTICK_OAUTH_REDIRECT_PORT,
                serde_json::to_string(&clean.ticktick_oauth_redirect_port)?,
            ),
        ];

        let mut conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let tx = conn.transaction()?;
        for (key, value_json) in entries {
            Self::upsert_setting_row(&tx, key, &value_json, now)?;
        }
        tx.commit()?;

        Ok(clean)
    }

    fn decode_setting<T: DeserializeOwned>(
        map: &HashMap<String, String>,
        key: &str,
    ) -> DbResult<Option<T>> {
        match map.get(key) {
            Some(raw) => Ok(Some(serde_json::from_str(raw)?)),
            None => Ok(None),
        }
    }

    fn upsert_setting_row(
        conn: &Connection,
        key: &str,
        value_json: &str,
        updated_at: i64,
    ) -> DbResult<()> {
        conn.execute(
            "INSERT INTO settings (key, value_json, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET
                value_json = excluded.value_json,
                updated_at = excluded.updated_at",
            params![key, value_json, updated_at],
        )?;
        Ok(())
    }

    // -------------------------------------------------------------------------
    // Activity Logs
    // -------------------------------------------------------------------------

    pub fn insert_activity_log(&self, log: &NewActivityLog) -> DbResult<i64> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        conn.execute(
            "INSERT INTO activity_logs
                (source, process_name, window_title, metadata_json, is_idle, started_at, ended_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                log.source,
                log.process_name,
                log.window_title,
                log.metadata_json,
                i32::from(log.is_idle),
                log.started_at,
                log.ended_at,
            ],
        )?;
        Ok(conn.last_insert_rowid())
    }

    pub fn extend_activity_log(&self, id: i64, ended_at: i64) -> DbResult<()> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        conn.execute(
            "UPDATE activity_logs SET ended_at = MAX(started_at, ?1) WHERE id = ?2",
            params![ended_at, id],
        )?;
        Ok(())
    }

    pub fn list_activity_logs(&self, from_ms: i64, to_ms: i64) -> DbResult<Vec<ActivityLog>> {
        self.list_activity_logs_filtered(from_ms, to_ms, None)
    }

    pub fn list_activity_logs_filtered(
        &self,
        from_ms: i64,
        to_ms: i64,
        min_duration_ms: Option<i64>,
    ) -> DbResult<Vec<ActivityLog>> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let min_dur = min_duration_ms.unwrap_or(0).max(0);
        let mut stmt = conn.prepare(
            "SELECT id, source, process_name, window_title, metadata_json, is_idle, started_at, ended_at
             FROM activity_logs
             WHERE ended_at >= ?1
               AND started_at <= ?2
               AND (ended_at - started_at) >= ?3
             ORDER BY started_at ASC",
        )?;
        let rows = stmt.query_map(params![from_ms, to_ms, min_dur], |row| {
            Ok(ActivityLog {
                id: row.get(0)?,
                source: row.get(1)?,
                process_name: row.get(2)?,
                window_title: row.get(3)?,
                metadata_json: row.get(4)?,
                is_idle: row.get::<_, i32>(5)? != 0,
                started_at: row.get(6)?,
                ended_at: row.get(7)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Lists activity logs in `[from_ms, to_ms]` for timeline display, hiding non-idle rows whose
    /// process matches `excluded_processes` while preserving raw records in SQLite.
    pub fn list_activity_logs_visible(
        &self,
        from_ms: i64,
        to_ms: i64,
        min_duration_ms: Option<i64>,
        excluded_processes: &[String],
    ) -> DbResult<Vec<ActivityLog>> {
        let logs = self.list_activity_logs_filtered(from_ms, to_ms, min_duration_ms)?;
        if excluded_processes.is_empty() {
            return Ok(logs);
        }
        Ok(logs
            .into_iter()
            .filter(|log| {
                log.is_idle
                    || !crate::tracker::matches_any_process(excluded_processes, &log.process_name)
            })
            .collect())
    }

    /// Returns distinct non-idle applications previously recorded in `activity_logs`,
    /// ordered by most recent usage.
    pub fn list_recent_activity_apps(&self, limit: i64) -> DbResult<Vec<DiscoverableApp>> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let effective_limit = limit.clamp(1, 500);
        let mut stmt = conn.prepare(
            "SELECT
                a1.process_name,
                MAX(a1.ended_at) AS last_seen_at,
                SUM(CASE WHEN a1.ended_at > a1.started_at THEN a1.ended_at - a1.started_at ELSE 0 END) AS total_duration_ms,
                (
                    SELECT a2.window_title
                    FROM activity_logs a2
                    WHERE LOWER(TRIM(a2.process_name)) = LOWER(TRIM(a1.process_name))
                      AND a2.is_idle = 0
                      AND a2.window_title IS NOT NULL
                      AND TRIM(a2.window_title) != ''
                      AND a2.window_title != '[Redacted]'
                    ORDER BY a2.ended_at DESC
                    LIMIT 1
                ) AS latest_title
             FROM activity_logs a1
             WHERE a1.is_idle = 0
               AND TRIM(a1.process_name) != ''
               AND LOWER(TRIM(a1.process_name)) NOT IN ('idle', 'unknown')
             GROUP BY LOWER(TRIM(a1.process_name))
             ORDER BY last_seen_at DESC, total_duration_ms DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![effective_limit], |row| {
            Ok(DiscoverableApp {
                process_name: row.get(0)?,
                last_seen_at: row.get(1)?,
                total_duration_ms: row.get(2)?,
                window_title: row.get(3)?,
                is_running: false,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    // -------------------------------------------------------------------------
    // Time Entries CRUD
    // -------------------------------------------------------------------------

    pub fn start_timer(&self, input: StartTimerInput) -> DbResult<TimeEntry> {
        let now = input.started_at.unwrap_or_else(|| Utc::now().timestamp_millis());
        let wall_now = Utc::now().timestamp_millis();
        let id = Uuid::new_v4().to_string();

        let mut conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let tx = conn.transaction()?;

        // Stop any currently running timer before starting a new one.
        tx.execute(
            "UPDATE time_entries SET ended_at = MAX(started_at, ?1), updated_at = ?2 WHERE ended_at IS NULL",
            params![now, wall_now],
        )?;

        tx.execute(
            "INSERT INTO time_entries (
                id, description, started_at, ended_at,
                ticktick_project_id, ticktick_parent_task_id,
                sync_status, created_at, updated_at
            ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, 'local', ?6, ?6)",
            params![
                id,
                input.description,
                now,
                input.ticktick_project_id,
                input.ticktick_parent_task_id,
                wall_now,
            ],
        )?;

        Self::insert_entry_tags(&tx, &id, &input.tag_ids)?;
        tx.commit()?;
        drop(conn);

        self.get_time_entry(&id)?
            .ok_or_else(|| DbError::NotFound(format!("time_entry {id}")))
    }

    pub fn stop_running_timer(&self, ended_at: Option<i64>) -> DbResult<Option<TimeEntry>> {
        let stop_ts = ended_at.unwrap_or_else(|| Utc::now().timestamp_millis());
        let wall_now = Utc::now().timestamp_millis();
        let running_id: Option<String> = {
            let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
            let id = conn
                .query_row(
                    "SELECT id FROM time_entries WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
                    [],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(ref entry_id) = id {
                conn.execute(
                    "UPDATE time_entries SET ended_at = MAX(started_at, ?1), updated_at = ?2 WHERE id = ?3",
                    params![stop_ts, wall_now, entry_id],
                )?;
            }
            id
        };

        match running_id {
            Some(id) => self.get_time_entry(&id),
            None => Ok(None),
        }
    }

    pub fn create_time_entry(&self, input: CreateTimeEntryInput) -> DbResult<TimeEntry> {
        if input.ended_at < input.started_at {
            return Err(DbError::Validation(
                "ended_at must be greater than or equal to started_at".into(),
            ));
        }

        let id = Uuid::new_v4().to_string();
        let now = Utc::now().timestamp_millis();

        let mut conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO time_entries (
                id, description, started_at, ended_at,
                ticktick_project_id, ticktick_parent_task_id,
                sync_status, complete_parent_task, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'local', ?7, ?8, ?8)",
            params![
                id,
                input.description,
                input.started_at,
                input.ended_at,
                input.ticktick_project_id,
                input.ticktick_parent_task_id,
                i32::from(input.complete_parent_task),
                now,
            ],
        )?;
        Self::insert_entry_tags(&tx, &id, &input.tag_ids)?;
        tx.commit()?;
        drop(conn);

        self.get_time_entry(&id)?
            .ok_or_else(|| DbError::NotFound(format!("time_entry {id}")))
    }

    pub fn update_time_entry(
        &self,
        id: &str,
        input: UpdateTimeEntryInput,
    ) -> DbResult<Option<TimeEntry>> {
        let now = Utc::now().timestamp_millis();
        let mut conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let tx = conn.transaction()?;

        let Some(existing) = Self::get_time_entry_in_conn(&tx, id)? else {
            return Ok(None);
        };

        let description = input.description.unwrap_or(existing.description);
        let started_at = input.started_at.unwrap_or(existing.started_at);
        let ended_at = match input.ended_at {
            Some(ts) => Some(ts),
            None => existing.ended_at,
        };
        if let Some(end) = ended_at {
            if end < started_at {
                return Err(DbError::Validation(
                    "ended_at must be greater than or equal to started_at".into(),
                ));
            }
        }

        let ticktick_project_id = match input.ticktick_project_id {
            Some(v) => v,
            None => existing.ticktick_project_id,
        };
        let ticktick_parent_task_id = match input.ticktick_parent_task_id {
            Some(v) => v,
            None => existing.ticktick_parent_task_id,
        };
        let complete_parent_task = input
            .complete_parent_task
            .unwrap_or(existing.complete_parent_task);

        tx.execute(
            "UPDATE time_entries
             SET description = ?1,
                 started_at = ?2,
                 ended_at = ?3,
                 ticktick_project_id = ?4,
                 ticktick_parent_task_id = ?5,
                 complete_parent_task = ?6,
                 updated_at = ?7
             WHERE id = ?8",
            params![
                description,
                started_at,
                ended_at,
                ticktick_project_id,
                ticktick_parent_task_id,
                i32::from(complete_parent_task),
                now,
                id,
            ],
        )?;

        if let Some(tag_ids) = input.tag_ids {
            tx.execute(
                "DELETE FROM time_entry_tags WHERE time_entry_id = ?1",
                params![id],
            )?;
            Self::insert_entry_tags(&tx, id, &tag_ids)?;
        }

        let updated = Self::get_time_entry_in_conn(&tx, id)?;
        tx.commit()?;
        Ok(updated)
    }

    pub fn delete_time_entry(&self, id: &str) -> DbResult<bool> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let affected = conn.execute("DELETE FROM time_entries WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    pub fn get_running_timer(&self) -> DbResult<Option<TimeEntry>> {
        let id: Option<String> = {
            let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
            conn.query_row(
                "SELECT id FROM time_entries WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .optional()?
        };

        match id {
            Some(entry_id) => self.get_time_entry(&entry_id),
            None => Ok(None),
        }
    }

    pub fn get_time_entry(&self, id: &str) -> DbResult<Option<TimeEntry>> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        Self::get_time_entry_in_conn(&conn, id)
    }

    pub fn list_time_entries(&self, limit: i64) -> DbResult<Vec<TimeEntry>> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let mut stmt = conn.prepare(
            "SELECT id, description, started_at, ended_at,
                    ticktick_project_id, ticktick_parent_task_id, ticktick_subtask_id,
                    sync_mode, sync_status, sync_error, retry_count,
                    complete_parent_task, created_at, updated_at
             FROM time_entries
             ORDER BY started_at DESC
             LIMIT ?1",
        )?;
        let mut entries = stmt
            .query_map(params![limit], Self::map_time_entry_row)?
            .collect::<Result<Vec<_>, _>>()?;
        for entry in &mut entries {
            entry.tag_ids = Self::fetch_entry_tag_ids(&conn, &entry.id)?;
        }
        Ok(entries)
    }

    pub fn list_time_entries_in_range(&self, from_ms: i64, to_ms: i64) -> DbResult<Vec<TimeEntry>> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let mut stmt = conn.prepare(
            "SELECT id, description, started_at, ended_at,
                    ticktick_project_id, ticktick_parent_task_id, ticktick_subtask_id,
                    sync_mode, sync_status, sync_error, retry_count,
                    complete_parent_task, created_at, updated_at
             FROM time_entries
             WHERE started_at <= ?2
               AND (ended_at IS NULL OR ended_at >= ?1)
             ORDER BY started_at ASC",
        )?;
        let mut entries = stmt
            .query_map(params![from_ms, to_ms], Self::map_time_entry_row)?
            .collect::<Result<Vec<_>, _>>()?;
        for entry in &mut entries {
            entry.tag_ids = Self::fetch_entry_tag_ids(&conn, &entry.id)?;
        }
        Ok(entries)
    }

    // -------------------------------------------------------------------------
    // Idle Resolution Transactions
    // -------------------------------------------------------------------------

    pub fn resolve_idle(&self, input: IdleResolutionInput) -> DbResult<IdleResolutionResult> {
        match input.action {
            IdleResolutionAction::Keep => self.resolve_idle_keep(&input.entry_id),
            IdleResolutionAction::Discard => {
                self.resolve_idle_discard(&input.entry_id, input.idle_started_at)
            }
            IdleResolutionAction::DiscardAndContinue => self.resolve_idle_discard_and_continue(
                &input.entry_id,
                input.idle_started_at,
                input.returned_at,
            ),
            IdleResolutionAction::Split => self.resolve_idle_split(
                &input.entry_id,
                input.idle_started_at,
                input.returned_at,
                input.idle_description.as_deref(),
                input.resume_original,
            ),
        }
    }

    /// 1. Keep: leave the running manual timer untouched, including the idle period.
    pub fn resolve_idle_keep(&self, entry_id: &str) -> DbResult<IdleResolutionResult> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let entry = Self::require_running_entry(&conn, entry_id)?;
        Ok(IdleResolutionResult {
            action: IdleResolutionAction::Keep,
            updated_entry: entry,
            idle_entry: None,
            resumed_entry: None,
        })
    }

    /// 2. Discard: stop the running timer at `idle_started_at`.
    pub fn resolve_idle_discard(
        &self,
        entry_id: &str,
        idle_started_at: i64,
    ) -> DbResult<IdleResolutionResult> {
        let wall_now = Utc::now().timestamp_millis();
        let mut conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let tx = conn.transaction()?;

        let entry = Self::require_running_entry(&tx, entry_id)?;
        let effective_idle_start = idle_started_at.max(entry.started_at);

        tx.execute(
            "UPDATE time_entries SET ended_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![effective_idle_start, wall_now, entry_id],
        )?;

        let updated = Self::get_time_entry_in_conn(&tx, entry_id)?
            .ok_or_else(|| DbError::NotFound(format!("time_entry {entry_id}")))?;
        tx.commit()?;

        Ok(IdleResolutionResult {
            action: IdleResolutionAction::Discard,
            updated_entry: updated,
            idle_entry: None,
            resumed_entry: None,
        })
    }

    /// 3. Discard & Continue: stop at `idle_started_at` and start a new running timer at
    /// `returned_at` with identical description, TickTick linkage, and tags.
    pub fn resolve_idle_discard_and_continue(
        &self,
        entry_id: &str,
        idle_started_at: i64,
        returned_at: i64,
    ) -> DbResult<IdleResolutionResult> {
        let wall_now = Utc::now().timestamp_millis();
        let mut conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let tx = conn.transaction()?;

        let entry = Self::require_running_entry(&tx, entry_id)?;
        let effective_idle_start = idle_started_at.max(entry.started_at);
        let effective_returned_at = returned_at.max(effective_idle_start);

        tx.execute(
            "UPDATE time_entries SET ended_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![effective_idle_start, wall_now, entry_id],
        )?;

        let resumed_id =
            Self::clone_running_entry(&tx, &entry, effective_returned_at, wall_now)?;

        let updated = Self::get_time_entry_in_conn(&tx, entry_id)?
            .ok_or_else(|| DbError::NotFound(format!("time_entry {entry_id}")))?;
        let resumed = Self::get_time_entry_in_conn(&tx, &resumed_id)?
            .ok_or_else(|| DbError::NotFound(format!("time_entry {resumed_id}")))?;
        tx.commit()?;

        Ok(IdleResolutionResult {
            action: IdleResolutionAction::DiscardAndContinue,
            updated_entry: updated,
            idle_entry: None,
            resumed_entry: Some(resumed),
        })
    }

    /// 4. Split: stop the original entry at `idle_started_at`, record the idle interval
    /// (`idle_started_at..returned_at`) as a separate entry, and optionally resume the original
    /// task from `returned_at`.
    pub fn resolve_idle_split(
        &self,
        entry_id: &str,
        idle_started_at: i64,
        returned_at: i64,
        idle_description: Option<&str>,
        resume_original: bool,
    ) -> DbResult<IdleResolutionResult> {
        let wall_now = Utc::now().timestamp_millis();
        let mut conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let tx = conn.transaction()?;

        let entry = Self::require_running_entry(&tx, entry_id)?;
        let effective_idle_start = idle_started_at.max(entry.started_at);
        let effective_returned_at = returned_at.max(effective_idle_start);

        tx.execute(
            "UPDATE time_entries SET ended_at = ?1, updated_at = ?2 WHERE id = ?3",
            params![effective_idle_start, wall_now, entry_id],
        )?;

        let idle_id = Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO time_entries (
                id, description, started_at, ended_at,
                ticktick_project_id, ticktick_parent_task_id,
                sync_status, complete_parent_task, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, NULL, NULL, 'local', 0, ?5, ?5)",
            params![
                idle_id,
                idle_description.unwrap_or(""),
                effective_idle_start,
                effective_returned_at,
                wall_now,
            ],
        )?;

        let resumed_id = if resume_original {
            Some(Self::clone_running_entry(
                &tx,
                &entry,
                effective_returned_at,
                wall_now,
            )?)
        } else {
            None
        };

        let updated = Self::get_time_entry_in_conn(&tx, entry_id)?
            .ok_or_else(|| DbError::NotFound(format!("time_entry {entry_id}")))?;
        let idle_entry = Self::get_time_entry_in_conn(&tx, &idle_id)?
            .ok_or_else(|| DbError::NotFound(format!("time_entry {idle_id}")))?;
        let resumed_entry = match resumed_id {
            Some(rid) => Some(
                Self::get_time_entry_in_conn(&tx, &rid)?
                    .ok_or_else(|| DbError::NotFound(format!("time_entry {rid}")))?,
            ),
            None => None,
        };
        tx.commit()?;

        Ok(IdleResolutionResult {
            action: IdleResolutionAction::Split,
            updated_entry: updated,
            idle_entry: Some(idle_entry),
            resumed_entry,
        })
    }

    // -------------------------------------------------------------------------
    // Tags & TickTick Cache
    // -------------------------------------------------------------------------

    pub fn upsert_tag(&self, name: &str, source: &str, color: Option<&str>) -> DbResult<Tag> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(DbError::Validation("tag name cannot be empty".into()));
        }
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        if let Some(existing) = conn
            .query_row(
                "SELECT id, name, source, color, created_at FROM tags WHERE name = ?1",
                params![trimmed],
                |row| {
                    Ok(Tag {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        source: row.get(2)?,
                        color: row.get(3)?,
                        created_at: row.get(4)?,
                    })
                },
            )
            .optional()?
        {
            return Ok(existing);
        }

        let id = if source == "ticktick" {
            format!("tt:{trimmed}")
        } else {
            Uuid::new_v4().to_string()
        };
        conn.execute(
            "INSERT INTO tags (id, name, source, color, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, trimmed, source, color, now],
        )?;
        Ok(Tag {
            id,
            name: trimmed.to_string(),
            source: source.to_string(),
            color: color.map(ToOwned::to_owned),
            created_at: now,
        })
    }

    pub fn list_tags(&self) -> DbResult<Vec<Tag>> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let mut stmt = conn.prepare(
            "SELECT id, name, source, color, created_at FROM tags ORDER BY name COLLATE NOCASE ASC",
        )?;
        let tags = stmt
            .query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source: row.get(2)?,
                    color: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(tags)
    }

    pub fn delete_tag(&self, id: &str) -> DbResult<bool> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let affected = conn.execute("DELETE FROM tags WHERE id = ?1", params![id])?;
        Ok(affected > 0)
    }

    pub fn upsert_ticktick_project(&self, project: &TickTickProject) -> DbResult<()> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        conn.execute(
            "INSERT INTO ticktick_projects (id, name, color, sort_order, is_inbox, closed, synced_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                color = excluded.color,
                sort_order = excluded.sort_order,
                is_inbox = excluded.is_inbox,
                closed = excluded.closed,
                synced_at = excluded.synced_at",
            params![
                project.id,
                project.name,
                project.color,
                project.sort_order,
                i32::from(project.is_inbox),
                i32::from(project.closed),
                project.synced_at,
            ],
        )?;
        Ok(())
    }

    pub fn upsert_ticktick_task(&self, task: &TickTickTask) -> DbResult<()> {
        let tags_json = serde_json::to_string(&task.tags)?;
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        conn.execute(
            "INSERT INTO ticktick_tasks (
                id, project_id, parent_id, title, content, tags_json,
                status, start_date, due_date, synced_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
                project_id = excluded.project_id,
                parent_id = excluded.parent_id,
                title = excluded.title,
                content = excluded.content,
                tags_json = excluded.tags_json,
                status = excluded.status,
                start_date = excluded.start_date,
                due_date = excluded.due_date,
                synced_at = excluded.synced_at",
            params![
                task.id,
                task.project_id,
                task.parent_id,
                task.title,
                task.content,
                tags_json,
                task.status,
                task.start_date,
                task.due_date,
                task.synced_at,
            ],
        )?;
        Ok(())
    }

    pub fn list_ticktick_projects(&self, include_closed: bool) -> DbResult<Vec<TickTickProject>> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let sql = if include_closed {
            "SELECT id, name, color, sort_order, is_inbox, closed, synced_at
             FROM ticktick_projects
             ORDER BY is_inbox DESC, sort_order ASC, name COLLATE NOCASE ASC"
        } else {
            "SELECT id, name, color, sort_order, is_inbox, closed, synced_at
             FROM ticktick_projects
             WHERE closed = 0
             ORDER BY is_inbox DESC, sort_order ASC, name COLLATE NOCASE ASC"
        };
        let mut stmt = conn.prepare(sql)?;
        let projects = stmt
            .query_map([], |row| {
                Ok(TickTickProject {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    sort_order: row.get(3)?,
                    is_inbox: row.get::<_, i32>(4)? != 0,
                    closed: row.get::<_, i32>(5)? != 0,
                    synced_at: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(projects)
    }

    pub fn list_ticktick_tasks(
        &self,
        project_id: Option<&str>,
        status: Option<i64>,
        query: Option<&str>,
        limit: i64,
    ) -> DbResult<Vec<TickTickTask>> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let clamped_limit = limit.clamp(1, 500);
        let cleaned_query = query.map(str::trim).filter(|s| !s.is_empty());

        let mut sql = String::from(
            "SELECT id, project_id, parent_id, title, content, tags_json,
                    status, start_date, due_date, synced_at
             FROM ticktick_tasks
             WHERE 1 = 1",
        );
        let mut values: Vec<rusqlite::types::Value> = Vec::new();

        if let Some(pid) = project_id.map(str::trim).filter(|s| !s.is_empty()) {
            sql.push_str(" AND project_id = ?");
            values.push(rusqlite::types::Value::Text(pid.to_string()));
        }
        if let Some(st) = status {
            sql.push_str(" AND status = ?");
            values.push(rusqlite::types::Value::Integer(st));
        }
        if let Some(q) = cleaned_query {
            let needle = q.to_lowercase();
            sql.push_str(
                " AND (INSTR(LOWER(title), ?) > 0 OR INSTR(LOWER(COALESCE(content, '')), ?) > 0)",
            );
            values.push(rusqlite::types::Value::Text(needle.clone()));
            values.push(rusqlite::types::Value::Text(needle));
        }

        sql.push_str(" ORDER BY status ASC, synced_at DESC, title COLLATE NOCASE ASC LIMIT ?");
        values.push(rusqlite::types::Value::Integer(clamped_limit));

        let mut stmt = conn.prepare(&sql)?;
        let tasks = stmt
            .query_map(rusqlite::params_from_iter(values), |row| {
                let tags_raw: String = row.get(5)?;
                let tags: Vec<String> = serde_json::from_str(&tags_raw).unwrap_or_default();
                Ok(TickTickTask {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    parent_id: row.get(2)?,
                    title: row.get(3)?,
                    content: row.get(4)?,
                    tags,
                    status: row.get(6)?,
                    start_date: row.get(7)?,
                    due_date: row.get(8)?,
                    synced_at: row.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(tasks)
    }

    pub fn get_ticktick_task(&self, id: &str) -> DbResult<Option<TickTickTask>> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let task = conn
            .query_row(
                "SELECT id, project_id, parent_id, title, content, tags_json,
                        status, start_date, due_date, synced_at
                 FROM ticktick_tasks
                 WHERE id = ?1",
                params![id],
                |row| {
                    let tags_raw: String = row.get(5)?;
                    let tags: Vec<String> = serde_json::from_str(&tags_raw).unwrap_or_default();
                    Ok(TickTickTask {
                        id: row.get(0)?,
                        project_id: row.get(1)?,
                        parent_id: row.get(2)?,
                        title: row.get(3)?,
                        content: row.get(4)?,
                        tags,
                        status: row.get(6)?,
                        start_date: row.get(7)?,
                        due_date: row.get(8)?,
                        synced_at: row.get(9)?,
                    })
                },
            )
            .optional()?;
        Ok(task)
    }

    pub fn mark_ticktick_task_completed(&self, task_id: &str) -> DbResult<()> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        conn.execute(
            "UPDATE ticktick_tasks SET status = 2, synced_at = ?1 WHERE id = ?2",
            params![now, task_id],
        )?;
        Ok(())
    }

    pub fn get_inbox_project_id(&self) -> DbResult<Option<String>> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        conn.query_row(
            "SELECT id FROM ticktick_projects
             WHERE is_inbox = 1
             ORDER BY closed ASC, synced_at DESC
             LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
    }

    pub fn get_tag_names_for_ids(&self, tag_ids: &[String]) -> DbResult<Vec<String>> {
        if tag_ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let mut names = Vec::with_capacity(tag_ids.len());
        let mut stmt = conn.prepare("SELECT name FROM tags WHERE id = ?1")?;
        for tid in tag_ids {
            if let Some(name) = stmt.query_row(params![tid], |row| row.get::<_, String>(0)).optional()? {
                names.push(name);
            }
        }
        Ok(names)
    }

    /// Transactionally applies a TickTick Pull snapshot (projects, tasks, and TickTick tags)
    /// while preserving all local custom tags and historical `time_entries`.
    pub fn sync_ticktick_cache(
        &self,
        projects: &[TickTickProject],
        tasks: &[TickTickTask],
        ticktick_tags: &[(String, Option<String>)],
        synced_at: i64,
        prune_missing_tasks: bool,
    ) -> DbResult<()> {
        let mut conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let tx = conn.transaction()?;

        let mut known_project_ids: HashSet<String> = HashSet::new();
        let mut fresh_inbox_id: Option<String> = None;

        for project in projects {
            if project.is_inbox {
                fresh_inbox_id = Some(project.id.clone());
            }
            known_project_ids.insert(project.id.clone());
            tx.execute(
                "INSERT INTO ticktick_projects (id, name, color, sort_order, is_inbox, closed, synced_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    color = excluded.color,
                    sort_order = excluded.sort_order,
                    is_inbox = excluded.is_inbox,
                    closed = excluded.closed,
                    synced_at = excluded.synced_at",
                params![
                    project.id,
                    project.name,
                    project.color,
                    project.sort_order,
                    i32::from(project.is_inbox),
                    i32::from(project.closed),
                    synced_at,
                ],
            )?;
        }

        // Mark previously cached open projects absent from the fresh snapshot as closed
        // (never hard-delete so historical time entries preserve project metadata).
        {
            let mut stmt = tx.prepare("SELECT id, is_inbox FROM ticktick_projects WHERE closed = 0")?;
            let existing: Vec<(String, bool)> = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)? != 0)))?
                .collect::<Result<Vec<_>, _>>()?;
            for (existing_id, was_inbox) in existing {
                let stale_inbox = was_inbox
                    && fresh_inbox_id
                        .as_deref()
                        .is_some_and(|fresh| fresh != existing_id);
                if stale_inbox || !known_project_ids.contains(&existing_id) {
                    tx.execute(
                        "UPDATE ticktick_projects SET closed = 1, synced_at = ?1 WHERE id = ?2",
                        params![synced_at, existing_id],
                    )?;
                }
            }
        }

        // Ensure every task's project_id exists in ticktick_projects before upsert to satisfy FK.
        let mut fresh_open_task_ids: HashSet<String> = HashSet::new();
        for task in tasks {
            if !known_project_ids.contains(&task.project_id) {
                let is_inbox = task.project_id.to_ascii_lowercase().starts_with("inbox");
                let fallback_name = if is_inbox {
                    "Inbox"
                } else {
                    task.project_id.as_str()
                };
                tx.execute(
                    "INSERT INTO ticktick_projects (id, name, color, sort_order, is_inbox, closed, synced_at)
                     VALUES (?1, ?2, ?3, 0, ?4, 0, ?5)
                     ON CONFLICT(id) DO UPDATE SET synced_at = excluded.synced_at",
                    params![
                        task.project_id,
                        fallback_name,
                        if is_inbox { Some("#64748b") } else { None },
                        i32::from(is_inbox),
                        synced_at,
                    ],
                )?;
                known_project_ids.insert(task.project_id.clone());
            }

            if task.status == 0 {
                fresh_open_task_ids.insert(task.id.clone());
            }

            let tags_json = serde_json::to_string(&task.tags)?;
            tx.execute(
                "INSERT INTO ticktick_tasks (
                    id, project_id, parent_id, title, content, tags_json,
                    status, start_date, due_date, synced_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                ON CONFLICT(id) DO UPDATE SET
                    project_id = excluded.project_id,
                    parent_id = excluded.parent_id,
                    title = excluded.title,
                    content = excluded.content,
                    tags_json = excluded.tags_json,
                    status = excluded.status,
                    start_date = excluded.start_date,
                    due_date = excluded.due_date,
                    synced_at = excluded.synced_at",
                params![
                    task.id,
                    task.project_id,
                    task.parent_id,
                    task.title,
                    task.content,
                    tags_json,
                    task.status,
                    task.start_date,
                    task.due_date,
                    synced_at,
                ],
            )?;
        }

        if prune_missing_tasks {
            let mut stmt = tx.prepare("SELECT id FROM ticktick_tasks WHERE status = 0")?;
            let existing_open: Vec<String> = stmt
                .query_map([], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()?;
            for tid in existing_open {
                if !fresh_open_task_ids.contains(&tid) {
                    tx.execute(
                        "UPDATE ticktick_tasks SET status = 2, synced_at = ?1 WHERE id = ?2",
                        params![synced_at, tid],
                    )?;
                }
            }
        }

        // Upsert TickTick tags without disturbing local custom tags or existing tag IDs.
        for (raw_name, color) in ticktick_tags {
            let trimmed = raw_name.trim();
            if trimmed.is_empty() {
                continue;
            }
            let existing_id: Option<String> = tx
                .query_row(
                    "SELECT id FROM tags WHERE LOWER(name) = LOWER(?1) LIMIT 1",
                    params![trimmed],
                    |row| row.get(0),
                )
                .optional()?;

            if let Some(id) = existing_id {
                tx.execute(
                    "UPDATE tags
                     SET color = COALESCE(?1, color)
                     WHERE id = ?2",
                    params![color, id],
                )?;
            } else {
                let id = format!("tt:{trimmed}");
                tx.execute(
                    "INSERT INTO tags (id, name, source, color, created_at)
                     VALUES (?1, ?2, 'ticktick', ?3, ?4)
                     ON CONFLICT(id) DO UPDATE SET
                        name = excluded.name,
                        color = COALESCE(excluded.color, tags.color)",
                    params![id, trimmed, color, synced_at],
                )?;
            }
        }

        Self::upsert_setting_row(
            &tx,
            SETTING_TICKTICK_LAST_PULL_AT,
            &serde_json::to_string(&synced_at)?,
            synced_at,
        )?;

        tx.commit()?;
        Ok(())
    }

    // -------------------------------------------------------------------------
    // TickTick Sync Queue State Transitions
    // -------------------------------------------------------------------------

    pub fn enqueue_time_entry_sync(&self, id: &str, mode: &SyncMode) -> DbResult<TimeEntry> {
        let now = Utc::now().timestamp_millis();
        let mut conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let tx = conn.transaction()?;

        let Some(existing) = Self::get_time_entry_in_conn(&tx, id)? else {
            return Err(DbError::NotFound(format!("time_entry {id}")));
        };
        if existing.ended_at.is_none() {
            return Err(DbError::InvalidState(
                "실행 중인 타이머는 정지한 뒤에 TickTick으로 동기화할 수 있습니다.".into(),
            ));
        }
        if existing.sync_status == SyncStatus::Synced {
            tx.commit()?;
            return Ok(existing);
        }

        // Preserve existing sync_mode if Step 1 already created a remote task so Step 2 completes it.
        let effective_mode = if existing.ticktick_subtask_id.is_some() {
            existing
                .sync_mode
                .as_deref()
                .unwrap_or_else(|| mode.as_str())
                .to_string()
        } else {
            mode.as_str().to_string()
        };

        tx.execute(
            "UPDATE time_entries
             SET sync_status = 'pending',
                 sync_mode = ?1,
                 sync_error = NULL,
                 updated_at = ?2
             WHERE id = ?3",
            params![effective_mode, now, id],
        )?;

        let updated = Self::get_time_entry_in_conn(&tx, id)?
            .ok_or_else(|| DbError::NotFound(format!("time_entry {id}")))?;
        tx.commit()?;
        Ok(updated)
    }

    pub fn list_pending_sync_entries(&self, limit: i64) -> DbResult<Vec<TimeEntry>> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let mut stmt = conn.prepare(
            "SELECT id, description, started_at, ended_at,
                    ticktick_project_id, ticktick_parent_task_id, ticktick_subtask_id,
                    sync_mode, sync_status, sync_error, retry_count,
                    complete_parent_task, created_at, updated_at
             FROM time_entries
             WHERE ended_at IS NOT NULL
               AND sync_status = 'pending'
             ORDER BY updated_at ASC, started_at ASC
             LIMIT ?1",
        )?;
        let mut entries = stmt
            .query_map(params![limit.clamp(1, 500)], Self::map_time_entry_row)?
            .collect::<Result<Vec<_>, _>>()?;
        for entry in &mut entries {
            entry.tag_ids = Self::fetch_entry_tag_ids(&conn, &entry.id)?;
        }
        Ok(entries)
    }

    pub fn list_retryable_failed_entries(
        &self,
        max_retries: i64,
        limit: i64,
    ) -> DbResult<Vec<TimeEntry>> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let mut stmt = conn.prepare(
            "SELECT id, description, started_at, ended_at,
                    ticktick_project_id, ticktick_parent_task_id, ticktick_subtask_id,
                    sync_mode, sync_status, sync_error, retry_count,
                    complete_parent_task, created_at, updated_at
             FROM time_entries
             WHERE ended_at IS NOT NULL
               AND sync_status = 'failed'
               AND retry_count > 0
               AND retry_count < ?1
             ORDER BY updated_at ASC
             LIMIT ?2",
        )?;
        let mut entries = stmt
            .query_map(
                params![max_retries, limit.clamp(1, 500)],
                Self::map_time_entry_row,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        for entry in &mut entries {
            entry.tag_ids = Self::fetch_entry_tag_ids(&conn, &entry.id)?;
        }
        Ok(entries)
    }

    pub fn requeue_failed_entries(&self) -> DbResult<usize> {
        let now = Utc::now().timestamp_millis();
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let affected = conn.execute(
            "UPDATE time_entries
             SET sync_status = 'pending',
                 sync_error = NULL,
                 updated_at = ?1
             WHERE ended_at IS NOT NULL
               AND sync_status = 'failed'",
            params![now],
        )?;
        Ok(affected)
    }

    /// Commits Step 1 creation metadata immediately so any Step 2/3 failure never duplicates the task.
    pub fn record_ticktick_subtask_created(
        &self,
        entry_id: &str,
        subtask_id: &str,
        sync_mode: &str,
        created_project_id: &str,
    ) -> DbResult<TimeEntry> {
        let now = Utc::now().timestamp_millis();
        let mut conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let tx = conn.transaction()?;

        tx.execute(
            "UPDATE time_entries
             SET ticktick_subtask_id = ?1,
                 sync_mode = ?2,
                 updated_at = ?3
             WHERE id = ?4",
            params![subtask_id, sync_mode, now, entry_id],
        )?;

        let project_key = format!("{SETTING_SUBTASK_PROJECT_PREFIX}{entry_id}");
        Self::upsert_setting_row(
            &tx,
            &project_key,
            &serde_json::to_string(created_project_id)?,
            now,
        )?;

        let updated = Self::get_time_entry_in_conn(&tx, entry_id)?
            .ok_or_else(|| DbError::NotFound(format!("time_entry {entry_id}")))?;
        tx.commit()?;
        Ok(updated)
    }

    pub fn get_recorded_subtask_project_id(&self, entry_id: &str) -> DbResult<Option<String>> {
        let key = format!("{SETTING_SUBTASK_PROJECT_PREFIX}{entry_id}");
        self.get_setting_raw::<String>(&key)
    }

    pub fn mark_time_entry_synced(&self, entry_id: &str) -> DbResult<TimeEntry> {
        let now = Utc::now().timestamp_millis();
        let mut conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let tx = conn.transaction()?;

        tx.execute(
            "UPDATE time_entries
             SET sync_status = 'synced',
                 sync_error = NULL,
                 updated_at = ?1
             WHERE id = ?2",
            params![now, entry_id],
        )?;
        let project_key = format!("{SETTING_SUBTASK_PROJECT_PREFIX}{entry_id}");
        tx.execute("DELETE FROM settings WHERE key = ?1", params![project_key])?;

        let updated = Self::get_time_entry_in_conn(&tx, entry_id)?
            .ok_or_else(|| DbError::NotFound(format!("time_entry {entry_id}")))?;
        tx.commit()?;
        Ok(updated)
    }

    pub fn mark_time_entry_sync_failed(
        &self,
        entry_id: &str,
        error_message: &str,
        increment_retry: bool,
    ) -> DbResult<TimeEntry> {
        let now = Utc::now().timestamp_millis();
        let mut conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let tx = conn.transaction()?;

        if increment_retry {
            tx.execute(
                "UPDATE time_entries
                 SET sync_status = 'failed',
                     sync_error = ?1,
                     retry_count = retry_count + 1,
                     updated_at = ?2
                 WHERE id = ?3",
                params![error_message, now, entry_id],
            )?;
        } else {
            tx.execute(
                "UPDATE time_entries
                 SET sync_status = 'failed',
                     sync_error = ?1,
                     updated_at = ?2
                 WHERE id = ?3",
                params![error_message, now, entry_id],
            )?;
        }

        let updated = Self::get_time_entry_in_conn(&tx, entry_id)?
            .ok_or_else(|| DbError::NotFound(format!("time_entry {entry_id}")))?;
        tx.commit()?;
        Ok(updated)
    }

    pub fn get_sync_queue_summary(&self) -> DbResult<TickTickSyncQueueSummary> {
        let conn = self.conn.lock().map_err(|_| DbError::LockPoisoned)?;
        let mut stmt = conn.prepare(
            "SELECT sync_status, COUNT(*)
             FROM time_entries
             WHERE ended_at IS NOT NULL
             GROUP BY sync_status",
        )?;
        let mut summary = TickTickSyncQueueSummary::default();
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (status, count) = row?;
            match status.as_str() {
                "pending" => summary.pending_count = count,
                "synced" => summary.synced_count = count,
                "failed" => summary.failed_count = count,
                _ => summary.local_count += count,
            }
        }
        Ok(summary)
    }

    // -------------------------------------------------------------------------
    // Internal Helpers
    // -------------------------------------------------------------------------

    fn require_running_entry(conn: &Connection, entry_id: &str) -> DbResult<TimeEntry> {
        let entry = Self::get_time_entry_in_conn(conn, entry_id)?
            .ok_or_else(|| DbError::NotFound(format!("time_entry {entry_id}")))?;
        if entry.ended_at.is_some() {
            return Err(DbError::InvalidState(format!(
                "time_entry {entry_id} is no longer running"
            )));
        }
        Ok(entry)
    }

    fn clone_running_entry(
        conn: &Connection,
        template: &TimeEntry,
        started_at: i64,
        wall_now: i64,
    ) -> DbResult<String> {
        let new_id = Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO time_entries (
                id, description, started_at, ended_at,
                ticktick_project_id, ticktick_parent_task_id,
                sync_status, complete_parent_task, created_at, updated_at
            ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, 'local', ?6, ?7, ?7)",
            params![
                new_id,
                template.description,
                started_at,
                template.ticktick_project_id,
                template.ticktick_parent_task_id,
                i32::from(template.complete_parent_task),
                wall_now,
            ],
        )?;
        Self::insert_entry_tags(conn, &new_id, &template.tag_ids)?;
        Ok(new_id)
    }

    fn insert_entry_tags(conn: &Connection, entry_id: &str, tag_ids: &[String]) -> DbResult<()> {
        for tag_id in tag_ids {
            conn.execute(
                "INSERT OR IGNORE INTO time_entry_tags (time_entry_id, tag_id) VALUES (?1, ?2)",
                params![entry_id, tag_id],
            )?;
        }
        Ok(())
    }

    fn get_time_entry_in_conn(conn: &Connection, id: &str) -> DbResult<Option<TimeEntry>> {
        let entry = conn
            .query_row(
                "SELECT id, description, started_at, ended_at,
                        ticktick_project_id, ticktick_parent_task_id, ticktick_subtask_id,
                        sync_mode, sync_status, sync_error, retry_count,
                        complete_parent_task, created_at, updated_at
                 FROM time_entries
                 WHERE id = ?1",
                params![id],
                Self::map_time_entry_row,
            )
            .optional()?;

        match entry {
            Some(mut item) => {
                item.tag_ids = Self::fetch_entry_tag_ids(conn, &item.id)?;
                Ok(Some(item))
            }
            None => Ok(None),
        }
    }

    fn fetch_entry_tag_ids(conn: &Connection, entry_id: &str) -> DbResult<Vec<String>> {
        let mut stmt = conn.prepare(
            "SELECT tag_id FROM time_entry_tags WHERE time_entry_id = ?1 ORDER BY tag_id ASC",
        )?;
        let ids = stmt
            .query_map(params![entry_id], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        Ok(ids)
    }

    fn map_time_entry_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TimeEntry> {
        let sync_status_str: String = row.get(8)?;
        Ok(TimeEntry {
            id: row.get(0)?,
            description: row.get(1)?,
            started_at: row.get(2)?,
            ended_at: row.get(3)?,
            ticktick_project_id: row.get(4)?,
            ticktick_parent_task_id: row.get(5)?,
            ticktick_subtask_id: row.get(6)?,
            sync_mode: row.get(7)?,
            sync_status: SyncStatus::from_db(&sync_status_str),
            sync_error: row.get(9)?,
            retry_count: row.get(10)?,
            complete_parent_task: row.get::<_, i32>(11)? != 0,
            tag_ids: Vec::new(),
            created_at: row.get(12)?,
            updated_at: row.get(13)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runs_user_version_migrations_and_rejects_future_versions() {
        let db = Database::open_in_memory().expect("open in-memory db");
        assert_eq!(db.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);

        // Simulate opening a database created by a newer version of tempo.
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION + 1)
            .unwrap();
        let err = Database::init(conn).err().expect("should reject future version");
        assert!(matches!(
            err,
            DbError::UnsupportedSchemaVersion {
                found,
                supported
            } if found == CURRENT_SCHEMA_VERSION + 1 && supported == CURRENT_SCHEMA_VERSION
        ));
    }

    #[test]
    fn migrates_legacy_unversioned_phase0_database_idempotently() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(include_str!("schema.sql")).unwrap();
        assert_eq!(migrations::current_user_version(&conn).unwrap(), 0);

        let db = Database::init(conn).expect("upgrade legacy user_version=0 db");
        assert_eq!(db.schema_version().unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn persists_and_sanitizes_typed_app_settings() {
        let db = Database::open_in_memory().unwrap();
        let defaults = db.get_settings().unwrap();
        assert_eq!(defaults, AppSettings::default());

        let updated = db
            .update_settings(&AppSettings {
                poll_interval_ms: 50, // clamped to 250
                idle_threshold_ms: 120_000,
                sleep_gap_threshold_ms: 15_000,
                redacted_processes: vec![" 1password.exe ".into(), "".into()],
                redacted_title_keywords: vec!["Secret".into()],
                excluded_processes: vec!["KeePass.exe".into()],
                sync_mode: SyncMode::FallbackList,
                fallback_project_id: Some(" proj-timelog ".into()),
                stop_timer_on_quit: true,
                timeline_min_duration_ms: 10_000,
                shortcut_toggle_timer: Some(" Ctrl+Shift+S ".into()),
                shortcut_quick_entry: Some("   ".into()),
                mini_timer_always_on_top: false,
                auto_sync_on_stop: true,
                ticktick_time_zone: Some(" Asia/Seoul ".into()),
                ticktick_oauth_client_id: Some(" client-id-123 ".into()),
                ticktick_oauth_redirect_port: 19000,
            })
            .unwrap();

        assert_eq!(updated.poll_interval_ms, 250);
        assert_eq!(updated.redacted_processes, vec!["1password.exe"]);
        assert_eq!(updated.fallback_project_id.as_deref(), Some("proj-timelog"));
        assert_eq!(updated.shortcut_toggle_timer.as_deref(), Some("Ctrl+Shift+S"));
        assert_eq!(updated.shortcut_quick_entry, None);
        assert!(!updated.mini_timer_always_on_top);
        assert!(updated.auto_sync_on_stop);
        assert_eq!(updated.ticktick_time_zone.as_deref(), Some("Asia/Seoul"));
        assert_eq!(
            updated.ticktick_oauth_client_id.as_deref(),
            Some("client-id-123")
        );
        assert_eq!(updated.ticktick_oauth_redirect_port, 19000);
        assert_eq!(db.get_settings().unwrap(), updated);
    }

    #[test]
    fn initializes_schema_and_handles_timer_lifecycle() {
        let db = Database::open_in_memory().expect("open in-memory db");
        let tag = db.upsert_tag("focus", "local", Some("#6366f1")).unwrap();

        let started = db
            .start_timer(StartTimerInput {
                description: "Implement Phase 1".into(),
                ticktick_project_id: Some("proj-1".into()),
                ticktick_parent_task_id: Some("task-1".into()),
                tag_ids: vec![tag.id.clone()],
                started_at: Some(1_700_000_000_000),
            })
            .unwrap();

        assert!(started.ended_at.is_none());
        assert_eq!(started.tag_ids, vec![tag.id]);
        assert_eq!(started.sync_status, SyncStatus::Local);

        let running = db.get_running_timer().unwrap().expect("running timer");
        assert_eq!(running.id, started.id);

        let stopped = db
            .stop_running_timer(Some(1_700_000_060_000))
            .unwrap()
            .expect("stopped timer");
        assert_eq!(stopped.ended_at, Some(1_700_000_060_000));
        assert!(db.get_running_timer().unwrap().is_none());

        let entries = db.list_time_entries(10).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].description, "Implement Phase 1");
    }

    #[test]
    fn supports_manual_time_entry_create_update_delete_and_validation() {
        let db = Database::open_in_memory().unwrap();
        let tag_a = db.upsert_tag("rust", "local", None).unwrap();
        let tag_b = db.upsert_tag("phase1", "local", None).unwrap();

        // Reject inverted timestamps
        let invalid = db.create_time_entry(CreateTimeEntryInput {
            description: "Bad".into(),
            started_at: 2_000,
            ended_at: 1_000,
            ticktick_project_id: None,
            ticktick_parent_task_id: None,
            tag_ids: vec![],
            complete_parent_task: false,
        });
        assert!(matches!(invalid, Err(DbError::Validation(_))));

        let created = db
            .create_time_entry(CreateTimeEntryInput {
                description: "Retroactive session".into(),
                started_at: 10_000,
                ended_at: 70_000,
                ticktick_project_id: Some("p1".into()),
                ticktick_parent_task_id: Some("t1".into()),
                tag_ids: vec![tag_a.id.clone()],
                complete_parent_task: false,
            })
            .unwrap();
        assert_eq!(created.tag_ids, vec![tag_a.id]);

        let updated = db
            .update_time_entry(
                &created.id,
                UpdateTimeEntryInput {
                    description: Some("Edited session".into()),
                    started_at: Some(15_000),
                    ended_at: Some(80_000),
                    ticktick_project_id: Some(None), // explicitly clear
                    ticktick_parent_task_id: None,   // unchanged
                    tag_ids: Some(vec![tag_b.id.clone()]),
                    complete_parent_task: Some(true),
                },
            )
            .unwrap()
            .expect("updated entry");

        assert_eq!(updated.description, "Edited session");
        assert_eq!(updated.started_at, 15_000);
        assert_eq!(updated.ended_at, Some(80_000));
        assert_eq!(updated.ticktick_project_id, None);
        assert_eq!(updated.ticktick_parent_task_id.as_deref(), Some("t1"));
        assert_eq!(updated.tag_ids, vec![tag_b.id]);
        assert!(updated.complete_parent_task);

        let range = db.list_time_entries_in_range(20_000, 30_000).unwrap();
        assert_eq!(range.len(), 1);

        assert!(db.delete_time_entry(&created.id).unwrap());
        assert!(!db.delete_time_entry(&created.id).unwrap());
        assert!(db.get_time_entry(&created.id).unwrap().is_none());
    }

    #[test]
    fn resolves_all_four_idle_return_actions_transactionally() {
        let db = Database::open_in_memory().unwrap();
        let tag = db.upsert_tag("deep-work", "local", Some("#10b981")).unwrap();

        // 1. Keep
        let e1 = db
            .start_timer(StartTimerInput {
                description: "Task Keep".into(),
                ticktick_project_id: Some("proj-1".into()),
                ticktick_parent_task_id: Some("task-1".into()),
                tag_ids: vec![tag.id.clone()],
                started_at: Some(1_000),
            })
            .unwrap();
        let res_keep = db.resolve_idle_keep(&e1.id).unwrap();
        assert_eq!(res_keep.action, IdleResolutionAction::Keep);
        assert!(res_keep.updated_entry.ended_at.is_none());
        assert!(res_keep.idle_entry.is_none());
        assert!(res_keep.resumed_entry.is_none());

        // 2. Discard
        let res_discard = db.resolve_idle_discard(&e1.id, 60_000).unwrap();
        assert_eq!(res_discard.action, IdleResolutionAction::Discard);
        assert_eq!(res_discard.updated_entry.ended_at, Some(60_000));
        assert!(db.get_running_timer().unwrap().is_none());

        // Stale resolution on already-stopped entry must fail cleanly.
        assert!(matches!(
            db.resolve_idle_keep(&e1.id),
            Err(DbError::InvalidState(_))
        ));

        // 3. Discard & Continue
        let e2 = db
            .start_timer(StartTimerInput {
                description: "Task Continue".into(),
                ticktick_project_id: Some("proj-2".into()),
                ticktick_parent_task_id: Some("task-2".into()),
                tag_ids: vec![tag.id.clone()],
                started_at: Some(100_000),
            })
            .unwrap();
        let res_dc = db
            .resolve_idle_discard_and_continue(&e2.id, 200_000, 500_000)
            .unwrap();
        assert_eq!(res_dc.updated_entry.ended_at, Some(200_000));
        assert!(res_dc.idle_entry.is_none());
        let resumed = res_dc.resumed_entry.expect("resumed timer");
        assert_ne!(resumed.id, e2.id);
        assert_eq!(resumed.started_at, 500_000);
        assert!(resumed.ended_at.is_none());
        assert_eq!(resumed.description, "Task Continue");
        assert_eq!(resumed.ticktick_project_id.as_deref(), Some("proj-2"));
        assert_eq!(resumed.ticktick_parent_task_id.as_deref(), Some("task-2"));
        assert_eq!(resumed.tag_ids, vec![tag.id.clone()]);

        // 4. Split (with resume_original = true)
        let res_split = db
            .resolve_idle_split(&resumed.id, 600_000, 900_000, Some("Away"), true)
            .unwrap();
        assert_eq!(res_split.updated_entry.ended_at, Some(600_000));
        let idle_entry = res_split.idle_entry.expect("idle entry");
        assert_eq!(idle_entry.description, "Away");
        assert_eq!(idle_entry.started_at, 600_000);
        assert_eq!(idle_entry.ended_at, Some(900_000));
        assert!(idle_entry.tag_ids.is_empty());

        let resumed_after_split = res_split.resumed_entry.expect("resumed after split");
        assert_eq!(resumed_after_split.started_at, 900_000);
        assert!(resumed_after_split.ended_at.is_none());
        assert_eq!(resumed_after_split.description, "Task Continue");
        assert_eq!(resumed_after_split.tag_ids, vec![tag.id]);
    }

    #[test]
    fn inserts_extends_and_filters_activity_logs() {
        let db = Database::open_in_memory().unwrap();
        let row_id = db
            .insert_activity_log(&NewActivityLog {
                source: "win_api".into(),
                process_name: "Code.exe".into(),
                window_title: Some("tempo — Visual Studio Code".into()),
                metadata_json: None,
                is_idle: false,
                started_at: 1_000,
                ended_at: 2_000,
            })
            .unwrap();
        let _short_id = db
            .insert_activity_log(&NewActivityLog {
                source: "win_api".into(),
                process_name: "Explorer.exe".into(),
                window_title: Some("Desktop".into()),
                metadata_json: None,
                is_idle: false,
                started_at: 5_000,
                ended_at: 6_500,
            })
            .unwrap();

        db.extend_activity_log(row_id, 15_000).unwrap();
        let all_logs = db.list_activity_logs(0, 20_000).unwrap();
        assert_eq!(all_logs.len(), 2);
        assert_eq!(all_logs[0].ended_at, 15_000);
        assert!(!all_logs[0].is_idle);

        let filtered = db
            .list_activity_logs_filtered(0, 20_000, Some(10_000))
            .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].id, row_id);
    }

    #[test]
    fn hides_excluded_processes_in_visible_timeline_without_deleting_raw_rows_and_lists_recent_apps()
    {
        let db = Database::open_in_memory().unwrap();
        db.insert_activity_log(&NewActivityLog {
            source: "win_api".into(),
            process_name: "Discord.exe".into(),
            window_title: Some("#general — Discord".into()),
            metadata_json: None,
            is_idle: false,
            started_at: 1_000,
            ended_at: 11_000,
        })
        .unwrap();
        db.insert_activity_log(&NewActivityLog {
            source: "win_api".into(),
            process_name: "Code.exe".into(),
            window_title: Some("tempo — Visual Studio Code".into()),
            metadata_json: None,
            is_idle: false,
            started_at: 12_000,
            ended_at: 42_000,
        })
        .unwrap();
        db.insert_activity_log(&NewActivityLog {
            source: "idle".into(),
            process_name: "idle".into(),
            window_title: None,
            metadata_json: None,
            is_idle: true,
            started_at: 42_000,
            ended_at: 52_000,
        })
        .unwrap();

        // Excluding "Discord" (without .exe) hides "Discord.exe" from visible timeline logs
        // while keeping idle spans and preserving the raw DB rows.
        let visible = db
            .list_activity_logs_visible(0, 100_000, None, &["Discord".into()])
            .unwrap();
        assert_eq!(visible.len(), 2);
        assert_eq!(visible[0].process_name, "Code.exe");
        assert!(visible[1].is_idle);

        // Removing the exclusion immediately restores historical Discord rows.
        let restored = db.list_activity_logs_visible(0, 100_000, None, &[]).unwrap();
        assert_eq!(restored.len(), 3);

        // Recent app discovery skips idle and orders by recency.
        let recent = db.list_recent_activity_apps(20).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].process_name, "Code.exe");
        assert_eq!(recent[0].total_duration_ms, 30_000);
        assert_eq!(
            recent[0].window_title.as_deref(),
            Some("tempo — Visual Studio Code")
        );
        assert_eq!(recent[1].process_name, "Discord.exe");
        assert_eq!(recent[1].total_duration_ms, 10_000);
    }

    #[test]
    fn caches_and_queries_ticktick_projects_and_tasks() {
        let db = Database::open_in_memory().unwrap();
        db.upsert_ticktick_project(&TickTickProject {
            id: "p2".into(),
            name: "Personal".into(),
            color: Some("#f59e0b".into()),
            sort_order: 2,
            is_inbox: false,
            closed: false,
            synced_at: 100,
        })
        .unwrap();
        db.upsert_ticktick_project(&TickTickProject {
            id: "p1".into(),
            name: "Work".into(),
            color: Some("#4f46e5".into()),
            sort_order: 1,
            is_inbox: false,
            closed: false,
            synced_at: 100,
        })
        .unwrap();
        db.upsert_ticktick_project(&TickTickProject {
            id: "inbox".into(),
            name: "Inbox".into(),
            color: Some("#64748b".into()),
            sort_order: 99,
            is_inbox: true,
            closed: false,
            synced_at: 100,
        })
        .unwrap();
        db.upsert_ticktick_project(&TickTickProject {
            id: "p_archived".into(),
            name: "Archived".into(),
            color: None,
            sort_order: 0,
            is_inbox: false,
            closed: true,
            synced_at: 100,
        })
        .unwrap();

        let open_projects = db.list_ticktick_projects(false).unwrap();
        assert_eq!(
            open_projects.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            vec!["inbox", "p1", "p2"]
        );

        let all_projects = db.list_ticktick_projects(true).unwrap();
        assert_eq!(all_projects.len(), 4);

        db.upsert_ticktick_task(&TickTickTask {
            id: "t1".into(),
            project_id: "p1".into(),
            parent_id: None,
            title: "Verify TickTick API".into(),
            content: Some("Run PoC against Open API".into()),
            tags: vec!["tempo".into(), "api".into()],
            status: 0,
            start_date: None,
            due_date: None,
            synced_at: 200,
        })
        .unwrap();
        db.upsert_ticktick_task(&TickTickTask {
            id: "t2".into(),
            project_id: "p1".into(),
            parent_id: None,
            title: "Completed Milestone".into(),
            content: None,
            tags: vec![],
            status: 2,
            start_date: None,
            due_date: None,
            synced_at: 250,
        })
        .unwrap();
        db.upsert_ticktick_task(&TickTickTask {
            id: "t3".into(),
            project_id: "p2".into(),
            parent_id: None,
            title: "장보기 메모".into(),
            content: Some("우유, 커피 원두".into()),
            tags: vec!["home".into()],
            status: 0,
            start_date: None,
            due_date: None,
            synced_at: 300,
        })
        .unwrap();

        let open_tasks = db.list_ticktick_tasks(None, Some(0), None, 50).unwrap();
        assert_eq!(open_tasks.len(), 2);
        assert_eq!(open_tasks[0].id, "t3"); // newer synced_at first
        assert_eq!(open_tasks[1].id, "t1");
        assert_eq!(open_tasks[1].tags, vec!["tempo", "api"]);

        let work_open = db
            .list_ticktick_tasks(Some("p1"), Some(0), None, 50)
            .unwrap();
        assert_eq!(work_open.len(), 1);
        assert_eq!(work_open[0].id, "t1");

        let by_query = db
            .list_ticktick_tasks(None, None, Some("poc"), 50)
            .unwrap();
        assert_eq!(by_query.len(), 1);
        assert_eq!(by_query[0].id, "t1");

        let by_korean_query = db
            .list_ticktick_tasks(None, Some(0), Some("커피"), 50)
            .unwrap();
        assert_eq!(by_korean_query.len(), 1);
        assert_eq!(by_korean_query[0].id, "t3");

        let limited = db.list_ticktick_tasks(None, None, None, 1).unwrap();
        assert_eq!(limited.len(), 1);
    }

    #[test]
    fn validates_and_deletes_tags_cascading_entry_links() {
        let db = Database::open_in_memory().unwrap();
        assert!(matches!(
            db.upsert_tag("   ", "local", None),
            Err(DbError::Validation(_))
        ));

        let tag = db.upsert_tag(" deep-work ", "local", Some("#6366f1")).unwrap();
        assert_eq!(tag.name, "deep-work");

        let entry = db
            .create_time_entry(CreateTimeEntryInput {
                description: "Tagged work".into(),
                started_at: 1_000,
                ended_at: 2_000,
                ticktick_project_id: None,
                ticktick_parent_task_id: None,
                tag_ids: vec![tag.id.clone()],
                complete_parent_task: false,
            })
            .unwrap();
        assert_eq!(entry.tag_ids, vec![tag.id.clone()]);

        assert!(db.delete_tag(&tag.id).unwrap());
        assert!(!db.delete_tag(&tag.id).unwrap());

        let reloaded = db.get_time_entry(&entry.id).unwrap().unwrap();
        assert!(reloaded.tag_ids.is_empty());
    }
}
