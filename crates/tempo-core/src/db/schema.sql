-- tempo v0.1 SQLite schema

CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'win_api',
    process_name TEXT NOT NULL,
    window_title TEXT,
    metadata_json TEXT,
    is_idle INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_time ON activity_logs(started_at, ended_at);

CREATE TABLE IF NOT EXISTS ticktick_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_inbox INTEGER NOT NULL DEFAULT 0,
    closed INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ticktick_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    parent_id TEXT,
    title TEXT NOT NULL,
    content TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    status INTEGER NOT NULL DEFAULT 0,
    start_date TEXT,
    due_date TEXT,
    synced_at INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES ticktick_projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ticktick_tasks_project_status ON ticktick_tasks(project_id, status);

CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT 'local',
    color TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS time_entries (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    ticktick_project_id TEXT,
    ticktick_parent_task_id TEXT,
    ticktick_subtask_id TEXT,
    sync_mode TEXT,
    sync_status TEXT NOT NULL DEFAULT 'local',
    sync_error TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    complete_parent_task INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_time_entries_time ON time_entries(started_at, ended_at);
CREATE INDEX IF NOT EXISTS idx_time_entries_sync ON time_entries(sync_status);

CREATE TABLE IF NOT EXISTS time_entry_tags (
    time_entry_id TEXT NOT NULL,
    tag_id TEXT NOT NULL,
    PRIMARY KEY (time_entry_id, tag_id),
    FOREIGN KEY (time_entry_id) REFERENCES time_entries(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
