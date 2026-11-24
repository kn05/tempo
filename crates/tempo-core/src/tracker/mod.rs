#[cfg(target_os = "windows")]
mod windows;
#[cfg(not(target_os = "windows"))]
mod stub;

use serde::{Deserialize, Serialize};

use crate::models::{AppSettings, NewActivityLog};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWindowInfo {
    pub source: String,
    pub process_name: String,
    pub window_title: Option<String>,
    pub metadata_json: Option<String>,
}

/// Platform-abstracted foreground window tracker.
pub trait ActivityTracker: Send + Sync {
    fn current_window(&self) -> Option<ActiveWindowInfo>;
}

/// Platform-abstracted user input idle detector.
pub trait IdleDetector: Send + Sync {
    /// Returns milliseconds elapsed since the last keyboard/mouse input.
    fn idle_duration_ms(&self) -> u64;
}

pub fn create_platform_tracker() -> Box<dyn ActivityTracker> {
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WindowsActivityTracker)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Box::new(stub::StubActivityTracker)
    }
}

pub fn create_platform_idle_detector() -> Box<dyn IdleDetector> {
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WindowsIdleDetector)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Box::new(stub::StubIdleDetector)
    }
}

/// Extracts the executable filename from a Windows (or POSIX) full image path.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn extract_executable_name(full_path: &str) -> Option<String> {
    full_path
        .rsplit(['\\', '/'])
        .next()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
}

/// Returns true when the process is the Windows UWP frame host whose real app lives in a child window.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn is_uwp_application_frame_host(process_name: &str) -> bool {
    process_name.eq_ignore_ascii_case("ApplicationFrameHost.exe")
}

/// Computes elapsed idle milliseconds from 32-bit Win32 `GetTickCount` and `LASTINPUTINFO.dwTime`,
/// properly handling 49.7-day `u32` wraparound.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn compute_win32_idle_elapsed_ms(now_tick: u32, last_input_tick: u32) -> u64 {
    u64::from(now_tick.wrapping_sub(last_input_tick))
}

#[derive(Debug, Clone)]
pub struct AggregatorConfig {
    /// Force a new span if the gap since the last poll exceeds this value (e.g. PC sleep/hibernate).
    pub max_merge_gap_ms: i64,
    /// Mark sample as idle when idle duration reaches or exceeds this threshold.
    pub idle_threshold_ms: u64,
    /// Process names (case-insensitive) whose window titles should be redacted.
    pub redacted_processes: Vec<String>,
    /// Case-insensitive title substrings that trigger title redaction.
    pub redacted_title_keywords: Vec<String>,
    /// Process names (case-insensitive) completely excluded from recording (Denylist).
    pub excluded_processes: Vec<String>,
}

impl Default for AggregatorConfig {
    fn default() -> Self {
        Self::from(&AppSettings::default())
    }
}

impl From<&AppSettings> for AggregatorConfig {
    fn from(settings: &AppSettings) -> Self {
        Self {
            max_merge_gap_ms: settings.sleep_gap_threshold_ms,
            idle_threshold_ms: settings.idle_threshold_ms,
            redacted_processes: settings.redacted_processes.clone(),
            redacted_title_keywords: settings.redacted_title_keywords.clone(),
            excluded_processes: settings.excluded_processes.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ActiveSpanKey {
    source: String,
    process_name: String,
    window_title: Option<String>,
    metadata_json: Option<String>,
    is_idle: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AggregationAction {
    /// Extend the current database row's `ended_at`.
    ExtendCurrent { ended_at: i64 },
    /// Insert a new `activity_logs` row.
    StartNew(NewActivityLog),
    /// Skip persisting this sample (e.g. focused process is in the privacy denylist).
    Ignore,
}

/// Stateful activity span merger implementing contiguous merging, idle separation,
/// sleep/hibernate gap splitting, privacy title redaction, and process denylist exclusion.
#[derive(Debug)]
pub struct ActivityAggregator {
    config: AggregatorConfig,
    current_key: Option<ActiveSpanKey>,
    last_seen_at: Option<i64>,
}

impl ActivityAggregator {
    pub fn new(config: AggregatorConfig) -> Self {
        Self {
            config,
            current_key: None,
            last_seen_at: None,
        }
    }

    pub fn config(&self) -> &AggregatorConfig {
        &self.config
    }

    pub fn update_config(&mut self, config: AggregatorConfig) {
        self.config = config;
    }

    pub fn observe(
        &mut self,
        now_ms: i64,
        window: Option<ActiveWindowInfo>,
        idle_ms: u64,
    ) -> AggregationAction {
        let is_idle = idle_ms >= self.config.idle_threshold_ms;
        let next_key = if is_idle {
            ActiveSpanKey {
                source: "idle".into(),
                process_name: "idle".into(),
                window_title: None,
                metadata_json: None,
                is_idle: true,
            }
        } else if let Some(info) = window {
            let excluded = self
                .config
                .excluded_processes
                .iter()
                .any(|p| p.eq_ignore_ascii_case(&info.process_name));
            if excluded {
                // Break continuity so returning to a prior app does not swallow excluded time.
                self.current_key = None;
                self.last_seen_at = Some(now_ms);
                return AggregationAction::Ignore;
            }

            let redacted_by_process = self
                .config
                .redacted_processes
                .iter()
                .any(|p| p.eq_ignore_ascii_case(&info.process_name));
            let redacted_by_keyword = info.window_title.as_deref().is_some_and(|title| {
                let title_lower = title.to_lowercase();
                self.config
                    .redacted_title_keywords
                    .iter()
                    .any(|kw| !kw.is_empty() && title_lower.contains(&kw.to_lowercase()))
            });
            let redacted = redacted_by_process || redacted_by_keyword;

            ActiveSpanKey {
                source: info.source,
                process_name: info.process_name,
                window_title: if redacted {
                    Some("[Redacted]".into())
                } else {
                    info.window_title
                },
                metadata_json: if redacted { None } else { info.metadata_json },
                is_idle: false,
            }
        } else {
            ActiveSpanKey {
                source: "system".into(),
                process_name: "unknown".into(),
                window_title: None,
                metadata_json: None,
                is_idle: false,
            }
        };

        let gap_exceeded = self
            .last_seen_at
            .map(|prev| now_ms - prev > self.config.max_merge_gap_ms || now_ms < prev)
            .unwrap_or(true);

        let same_as_current = self.current_key.as_ref() == Some(&next_key);
        self.last_seen_at = Some(now_ms);

        if same_as_current && !gap_exceeded {
            AggregationAction::ExtendCurrent { ended_at: now_ms }
        } else {
            let draft = NewActivityLog {
                source: next_key.source.clone(),
                process_name: next_key.process_name.clone(),
                window_title: next_key.window_title.clone(),
                metadata_json: next_key.metadata_json.clone(),
                is_idle: next_key.is_idle,
                started_at: now_ms,
                ended_at: now_ms,
            };
            self.current_key = Some(next_key);
            AggregationAction::StartNew(draft)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vscode_window(title: &str) -> Option<ActiveWindowInfo> {
        Some(ActiveWindowInfo {
            source: "win_api".into(),
            process_name: "Code.exe".into(),
            window_title: Some(title.into()),
            metadata_json: None,
        })
    }

    #[test]
    fn merges_contiguous_samples_and_splits_on_change() {
        let mut agg = ActivityAggregator::new(AggregatorConfig::default());

        let first = agg.observe(1_000, vscode_window("main.rs"), 0);
        assert!(matches!(first, AggregationAction::StartNew(_)));

        let second = agg.observe(3_000, vscode_window("main.rs"), 100);
        assert_eq!(second, AggregationAction::ExtendCurrent { ended_at: 3_000 });

        let third = agg.observe(5_000, vscode_window("lib.rs"), 0);
        assert!(matches!(
            third,
            AggregationAction::StartNew(log) if log.window_title.as_deref() == Some("lib.rs")
        ));
    }

    #[test]
    fn splits_span_after_sleep_gap() {
        let mut agg = ActivityAggregator::new(AggregatorConfig {
            max_merge_gap_ms: 10_000,
            ..Default::default()
        });

        let _ = agg.observe(1_000, vscode_window("main.rs"), 0);
        // Simulate a 60-second system sleep even though the foreground window didn't change.
        let after_sleep = agg.observe(61_000, vscode_window("main.rs"), 0);
        assert!(matches!(
            after_sleep,
            AggregationAction::StartNew(log) if log.started_at == 61_000
        ));
    }

    #[test]
    fn separates_idle_and_redacts_sensitive_processes() {
        let mut agg = ActivityAggregator::new(AggregatorConfig::default());

        let sensitive = agg.observe(
            1_000,
            Some(ActiveWindowInfo {
                source: "win_api".into(),
                process_name: "Bitwarden.exe".into(),
                window_title: Some("Vault - My Secret".into()),
                metadata_json: None,
            }),
            0,
        );
        match sensitive {
            AggregationAction::StartNew(log) => {
                assert_eq!(log.window_title.as_deref(), Some("[Redacted]"));
            }
            other => panic!("expected StartNew, got {other:?}"),
        }

        let idle = agg.observe(3_000, vscode_window("main.rs"), 300_000);
        assert!(matches!(idle, AggregationAction::StartNew(log) if log.is_idle));
    }

    #[test]
    fn redacts_title_keywords_and_excludes_denylisted_processes() {
        let mut agg = ActivityAggregator::new(AggregatorConfig {
            excluded_processes: vec!["Signal.exe".into()],
            ..Default::default()
        });

        // Private browser tab matched by keyword ("InPrivate" / "시크릿")
        let incognito = agg.observe(
            1_000,
            Some(ActiveWindowInfo {
                source: "win_api".into(),
                process_name: "chrome.exe".into(),
                window_title: Some("은행 로그인 - 시크릿 모드".into()),
                metadata_json: Some("{\"url\":\"secret\"}".into()),
            }),
            0,
        );
        assert!(matches!(
            incognito,
            AggregationAction::StartNew(log)
                if log.window_title.as_deref() == Some("[Redacted]") && log.metadata_json.is_none()
        ));

        // Normal VS Code span
        let _ = agg.observe(3_000, vscode_window("main.rs"), 0);

        // Excluded process must be ignored and break continuity
        let ignored = agg.observe(
            5_000,
            Some(ActiveWindowInfo {
                source: "win_api".into(),
                process_name: "signal.exe".into(),
                window_title: Some("Private Chat".into()),
                metadata_json: None,
            }),
            0,
        );
        assert_eq!(ignored, AggregationAction::Ignore);

        // Returning to VS Code starts a fresh span instead of merging across the excluded window
        let resumed = agg.observe(7_000, vscode_window("main.rs"), 0);
        assert!(matches!(
            resumed,
            AggregationAction::StartNew(log) if log.started_at == 7_000
        ));
    }

    #[test]
    fn validates_windows_tracker_helpers() {
        assert_eq!(
            extract_executable_name(r"C:\Program Files\Microsoft VS Code\Code.exe").as_deref(),
            Some("Code.exe")
        );
        assert_eq!(extract_executable_name("   "), None);
        assert!(is_uwp_application_frame_host("ApplicationFrameHost.exe"));
        assert!(is_uwp_application_frame_host("applicationframehost.exe"));
        assert!(!is_uwp_application_frame_host("Code.exe"));

        // 32-bit tick wraparound (u32::MAX -> 100 => 101 ms elapsed)
        assert_eq!(compute_win32_idle_elapsed_ms(100, u32::MAX), 101);
        assert_eq!(compute_win32_idle_elapsed_ms(5_000, 1_500), 3_500);
    }
}
