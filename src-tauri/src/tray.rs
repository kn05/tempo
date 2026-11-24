use std::sync::Mutex;

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Emitter, Manager, Wry};
use tempo_core::{current_timestamp_ms, format_tray_tooltip, StartTimerInput, TimeEntry};

use crate::{
    shutdown_app, toggle_mini_timer_window, AppState, EVENT_ENTRIES_CHANGED,
    EVENT_FOCUS_QUICK_ENTRY, EVENT_TICKTICK_CHANGED, EVENT_TIMER_CHANGED,
};

pub const TRAY_ID: &str = "tempo-tray";

const TRAY_ICON_IDLE_PNG: &[u8] = include_bytes!("../icons/tray-idle.png");
const TRAY_ICON_ACTIVE_PNG: &[u8] = include_bytes!("../icons/tray-active.png");

pub struct TrayController {
    toggle_item: MenuItem<Wry>,
    idle_icon: Image<'static>,
    active_icon: Image<'static>,
    last_is_running: Mutex<Option<bool>>,
}

impl TrayController {
    pub fn setup(app: &App) -> tauri::Result<Self> {
        let idle_icon = Image::from_bytes(TRAY_ICON_IDLE_PNG)?.to_owned();
        let active_icon = Image::from_bytes(TRAY_ICON_ACTIVE_PNG)?.to_owned();

        let toggle_item =
            MenuItem::with_id(app, "toggle_timer", "Start Timer", true, None::<&str>)?;
        let show_item = MenuItem::with_id(app, "show", "Open tempo", true, None::<&str>)?;
        let mini_item = MenuItem::with_id(app, "mini_timer", "Mini Timer", true, None::<&str>)?;
        let separator = PredefinedMenuItem::separator(app)?;
        let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

        let menu = Menu::with_items(
            app,
            &[&toggle_item, &show_item, &mini_item, &separator, &quit_item],
        )?;

        TrayIconBuilder::with_id(TRAY_ID)
            .icon(idle_icon.clone())
            .menu(&menu)
            .tooltip("tempo — Idle")
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "toggle_timer" => toggle_running_timer(app),
                "show" => focus_main_window(app),
                "mini_timer" => {
                    let handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = toggle_mini_timer_window(&handle);
                    });
                }
                "quit" => shutdown_app(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    focus_main_window(tray.app_handle());
                }
            })
            .build(app)?;

        Ok(Self {
            toggle_item,
            idle_icon,
            active_icon,
            last_is_running: Mutex::new(Some(false)),
        })
    }

    pub fn sync(&self, app: &AppHandle, running_entry: Option<&TimeEntry>, now_ms: i64) {
        let is_running = running_entry.is_some();
        let tooltip = format_tray_tooltip(running_entry, now_ms);

        let state_changed = {
            let mut guard = match self.last_is_running.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            if *guard != Some(is_running) {
                *guard = Some(is_running);
                true
            } else {
                false
            }
        };

        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            if state_changed {
                let icon = if is_running {
                    self.active_icon.clone()
                } else {
                    self.idle_icon.clone()
                };
                let _ = tray.set_icon(Some(icon));
                let _ = self
                    .toggle_item
                    .set_text(if is_running { "Stop Timer" } else { "Start Timer" });
            }
            let _ = tray.set_tooltip(Some(tooltip.as_str()));
        }
    }
}

pub fn focus_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn focus_quick_entry(app: &AppHandle) {
    focus_main_window(app);
    let _ = app.emit(EVENT_FOCUS_QUICK_ENTRY, ());
}

pub fn toggle_running_timer(app: &AppHandle) {
    let state = app.state::<AppState>();
    let now_ms = current_timestamp_ms();

    let updated_running = match state.db.get_running_timer() {
        Ok(Some(_)) => {
            if let Ok(Some(stopped)) = state.db.stop_running_timer(Some(now_ms)) {
                if state
                    .ticktick
                    .maybe_auto_enqueue_stopped_entry(&stopped)
                    .is_some()
                {
                    let _ = app.emit(EVENT_TICKTICK_CHANGED, ());
                }
            }
            state.collector.clear_idle_prompt();
            None
        }
        Ok(None) => {
            let last_entry = state
                .db
                .list_time_entries(1)
                .ok()
                .and_then(|mut entries| entries.pop());

            let (description, project_id, parent_task_id, tag_ids) = match last_entry {
                Some(entry) if !entry.description.trim().is_empty() => (
                    entry.description,
                    entry.ticktick_project_id,
                    entry.ticktick_parent_task_id,
                    entry.tag_ids,
                ),
                _ => ("(Quick Timer)".to_string(), None, None, Vec::new()),
            };

            state
                .db
                .start_timer(StartTimerInput {
                    description,
                    ticktick_project_id: project_id,
                    ticktick_parent_task_id: parent_task_id,
                    tag_ids,
                    started_at: Some(now_ms),
                })
                .ok()
        }
        Err(_) => return,
    };

    if let Some(tray_ctrl) = app.try_state::<TrayController>() {
        tray_ctrl.sync(app, updated_running.as_ref(), now_ms);
    }
    let _ = app.emit(EVENT_TIMER_CHANGED, updated_running);
    let _ = app.emit(EVENT_ENTRIES_CHANGED, ());
}
