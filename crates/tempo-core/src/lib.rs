pub mod collector;
pub mod db;
pub mod idle;
pub mod models;
pub mod parser;
pub mod ticktick;
pub mod tracker;

pub use collector::{
    current_timestamp_ms, format_tray_tooltip, CollectorEngine, CollectorHandle, CollectorSnapshot,
    CollectorTickResult, PresenceSlot,
};
pub use db::{Database, DbError, DbResult, CURRENT_SCHEMA_VERSION};
pub use idle::{IdleStateMachine, IdleTrackerState};
pub use models::*;
pub use parser::{parse_quick_entry, ParsedQuickEntry};
pub use ticktick::{
    detect_local_time_zone, CredentialManager, KeyringSecretStore, MemorySecretStore,
    OAuthEndpoints, OAuthError, PendingOAuthSession, SecretError, SecretStore, SyncServiceError,
    SyncWorkerHandle, TickTickClient, TickTickCredentials, TickTickError, TickTickService,
    DEFAULT_SYNC_WORKER_INTERVAL_SECS,
};
pub use tracker::{
    create_platform_idle_detector, create_platform_tracker, matches_any_process,
    merge_discoverable_apps, normalize_process_match_key, process_name_matches, ActiveWindowInfo,
    ActivityAggregator, ActivityTracker, AggregationAction, AggregatorConfig, IdleDetector,
    RunningAppInfo,
};
