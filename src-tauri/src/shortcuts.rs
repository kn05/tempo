use std::sync::Mutex;

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tempo_core::{AppSettings, ShortcutStatus};

use crate::tray::{focus_quick_entry, toggle_running_timer};

/// Manages system-wide global shortcut registration with safe fallback on conflicts.
pub struct ShortcutManager {
    status: Mutex<ShortcutStatus>,
}

impl Default for ShortcutManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ShortcutManager {
    pub fn new() -> Self {
        Self {
            status: Mutex::new(ShortcutStatus::default()),
        }
    }

    pub fn status(&self) -> ShortcutStatus {
        match self.status.lock() {
            Ok(guard) => guard.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    /// Unregisters previous shortcuts and applies the latest configured shortcuts.
    /// Registration errors (invalid syntax or OS/app conflict) are captured as warnings
    /// instead of crashing the app.
    pub fn apply(&self, app: &AppHandle, settings: &AppSettings) -> ShortcutStatus {
        let mut next = ShortcutStatus::default();
        let global_shortcut = app.global_shortcut();

        if let Err(err) = global_shortcut.unregister_all() {
            next.warnings
                .push(format!("기존 전역 단축키 해제 중 경고: {err}"));
        }

        let toggle_key = settings.shortcut_toggle_timer.as_deref();
        let quick_key = settings.shortcut_quick_entry.as_deref();

        if let Some(combo) = toggle_key {
            match global_shortcut.on_shortcut(combo, |app_handle, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    toggle_running_timer(app_handle);
                }
            }) {
                Ok(()) => next.toggle_timer_registered = true,
                Err(err) => next.warnings.push(format!(
                    "타이머 토글 단축키({combo}) 등록 실패: {err}"
                )),
            }
        }

        if let Some(combo) = quick_key {
            if toggle_key.is_some_and(|t| t.eq_ignore_ascii_case(combo)) {
                next.warnings.push(format!(
                    "빠른 입력 단축키({combo})가 타이머 토글 단축키와 중복되어 건너뛰었습니다."
                ));
            } else {
                match global_shortcut.on_shortcut(combo, |app_handle, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        focus_quick_entry(app_handle);
                    }
                }) {
                    Ok(()) => next.quick_entry_registered = true,
                    Err(err) => next.warnings.push(format!(
                        "빠른 입력 단축키({combo}) 등록 실패: {err}"
                    )),
                }
            }
        }

        match self.status.lock() {
            Ok(mut guard) => *guard = next.clone(),
            Err(poisoned) => *poisoned.into_inner() = next.clone(),
        }
        next
    }
}
