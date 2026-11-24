use super::{ActiveWindowInfo, ActivityTracker, IdleDetector};

/// Non-Windows development/testing stub tracker.
pub struct StubActivityTracker;

impl ActivityTracker for StubActivityTracker {
    fn current_window(&self) -> Option<ActiveWindowInfo> {
        Some(ActiveWindowInfo {
            source: "stub".into(),
            process_name: "tempo-dev".into(),
            window_title: Some("Linux/Non-Windows Development Stub".into()),
            metadata_json: None,
        })
    }
}

/// Non-Windows development/testing stub idle detector.
pub struct StubIdleDetector;

impl IdleDetector for StubIdleDetector {
    fn idle_duration_ms(&self) -> u64 {
        0
    }
}
