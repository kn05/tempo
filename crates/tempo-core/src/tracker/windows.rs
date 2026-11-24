use std::collections::HashSet;

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::System::SystemInformation::GetTickCount;
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, EnumWindows, GetClassNameW, GetForegroundWindow, GetWindowLongW,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE,
    WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
};

use super::{
    compute_win32_idle_elapsed_ms, extract_executable_name, is_uwp_application_frame_host,
    normalize_process_match_key, ActiveWindowInfo, ActivityTracker, IdleDetector, RunningAppInfo,
};

const MAX_WINDOW_TITLE_LEN: usize = 4096;
const UWP_CORE_WINDOW_CLASS: &str = "Windows.UI.Core.CoreWindow";

const SHELL_NOISE_PROCESSES: &[&str] = &[
    "textinputhost.exe",
    "shellexperiencehost.exe",
    "startmenuexperiencehost.exe",
    "searchhost.exe",
    "searchapp.exe",
    "lockapp.exe",
    "systemsettingsbroker.exe",
];

pub struct WindowsActivityTracker;

impl ActivityTracker for WindowsActivityTracker {
    fn current_window(&self) -> Option<ActiveWindowInfo> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }

            let window_title = read_window_title(hwnd);

            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return None;
            }

            let mut process_name = query_process_name(pid).unwrap_or_else(|| format!("pid:{pid}"));

            // UWP / Microsoft Store apps are hosted inside `ApplicationFrameHost.exe`.
            // Inspect child windows (preferring `Windows.UI.Core.CoreWindow`) to resolve
            // the actual app process name, safely falling back to `ApplicationFrameHost.exe`.
            if is_uwp_application_frame_host(&process_name) {
                if let Some(child_pid) = resolve_uwp_child_pid(hwnd, pid) {
                    if let Some(child_name) = query_process_name(child_pid) {
                        process_name = child_name;
                    }
                }
            }

            Some(ActiveWindowInfo {
                source: "win_api".into(),
                process_name,
                window_title,
                metadata_json: None,
            })
        }
    }

    fn running_apps(&self) -> Vec<RunningAppInfo> {
        let mut state = RunningEnumState {
            seen_keys: HashSet::new(),
            apps: Vec::new(),
        };
        unsafe {
            let _ = EnumWindows(
                Some(enum_running_window_proc),
                LPARAM(&mut state as *mut RunningEnumState as isize),
            );
        }
        state.apps
    }
}

struct RunningEnumState {
    seen_keys: HashSet<String>,
    apps: Vec<RunningAppInfo>,
}

unsafe extern "system" fn enum_running_window_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if !IsWindowVisible(hwnd).as_bool() {
        return BOOL(1);
    }

    let ex_style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
    let is_tool_window = (ex_style & WS_EX_TOOLWINDOW.0) != 0;
    let is_app_window = (ex_style & WS_EX_APPWINDOW.0) != 0;
    if is_tool_window && !is_app_window {
        return BOOL(1);
    }

    let Some(title) = read_window_title(hwnd)
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
    else {
        return BOOL(1);
    };

    if title.eq_ignore_ascii_case("Program Manager")
        || title.eq_ignore_ascii_case("Windows Input Experience")
    {
        return BOOL(1);
    }

    let mut pid: u32 = 0;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == 0 {
        return BOOL(1);
    }

    let Some(mut process_name) = query_process_name(pid) else {
        return BOOL(1);
    };

    if is_uwp_application_frame_host(&process_name) {
        if let Some(child_pid) = resolve_uwp_child_pid(hwnd, pid) {
            if let Some(child_name) = query_process_name(child_pid) {
                process_name = child_name;
            } else {
                return BOOL(1);
            }
        } else {
            return BOOL(1);
        }
    }

    if SHELL_NOISE_PROCESSES
        .iter()
        .any(|noise| process_name.eq_ignore_ascii_case(noise))
    {
        return BOOL(1);
    }

    let key = normalize_process_match_key(&process_name);
    if key.is_empty() {
        return BOOL(1);
    }

    let state = &mut *(lparam.0 as *mut RunningEnumState);
    if state.seen_keys.insert(key) {
        state.apps.push(RunningAppInfo {
            process_name,
            window_title: Some(title),
        });
    }

    BOOL(1)
}

unsafe fn read_window_title(hwnd: HWND) -> Option<String> {
    let raw_len = GetWindowTextLengthW(hwnd);
    if raw_len <= 0 {
        return None;
    }

    let capacity = (raw_len as usize + 1).min(MAX_WINDOW_TITLE_LEN);
    if capacity <= 512 {
        let mut stack_buf = [0u16; 512];
        let copied = GetWindowTextW(hwnd, &mut stack_buf);
        if copied > 0 {
            return Some(String::from_utf16_lossy(&stack_buf[..copied as usize]));
        }
        return None;
    }

    let mut heap_buf = vec![0u16; capacity];
    let copied = GetWindowTextW(hwnd, &mut heap_buf);
    if copied > 0 {
        Some(String::from_utf16_lossy(&heap_buf[..copied as usize]))
    } else {
        None
    }
}

struct UwpEnumState {
    host_pid: u32,
    core_window_pid: Option<u32>,
    fallback_child_pid: Option<u32>,
}

unsafe extern "system" fn enum_uwp_child_proc(child_hwnd: HWND, lparam: LPARAM) -> BOOL {
    let state = &mut *(lparam.0 as *mut UwpEnumState);
    let mut child_pid: u32 = 0;
    GetWindowThreadProcessId(child_hwnd, Some(&mut child_pid));

    if child_pid != 0 && child_pid != state.host_pid {
        let mut class_buf = [0u16; 128];
        let class_len = GetClassNameW(child_hwnd, &mut class_buf);
        if class_len > 0 {
            let class_name = String::from_utf16_lossy(&class_buf[..class_len as usize]);
            if class_name == UWP_CORE_WINDOW_CLASS {
                state.core_window_pid = Some(child_pid);
                return BOOL(0); // Stop enumeration once CoreWindow is found.
            }
        }
        state.fallback_child_pid.get_or_insert(child_pid);
    }

    BOOL(1)
}

unsafe fn resolve_uwp_child_pid(parent_hwnd: HWND, host_pid: u32) -> Option<u32> {
    let mut state = UwpEnumState {
        host_pid,
        core_window_pid: None,
        fallback_child_pid: None,
    };
    let _ = EnumChildWindows(
        Some(parent_hwnd),
        Some(enum_uwp_child_proc),
        LPARAM(&mut state as *mut UwpEnumState as isize),
    );
    state.core_window_pid.or(state.fallback_child_pid)
}

fn query_process_name(pid: u32) -> Option<String> {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut size = buf.len() as u32;
        let query_result = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_FORMAT(0),
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);

        query_result.ok()?;
        let full_path = String::from_utf16_lossy(&buf[..size as usize]);
        extract_executable_name(&full_path)
    }
}

pub struct WindowsIdleDetector;

impl IdleDetector for WindowsIdleDetector {
    fn idle_duration_ms(&self) -> u64 {
        unsafe {
            let mut lii = LASTINPUTINFO {
                cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
                dwTime: 0,
            };
            if GetLastInputInfo(&mut lii).as_bool() {
                // `LASTINPUTINFO.dwTime` uses the 32-bit tick counter from `GetTickCount`.
                let now = GetTickCount();
                compute_win32_idle_elapsed_ms(now, lii.dwTime)
            } else {
                0
            }
        }
    }
}
