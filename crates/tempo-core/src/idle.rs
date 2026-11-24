use crate::models::{IdleReturnPrompt, TimeEntry};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdleTrackerState {
    Active,
    IdlePending {
        entry_id: String,
        entry_description: String,
        idle_started_at: i64,
    },
    AwaitingResolution(IdleReturnPrompt),
}

/// Deterministic state machine for manual-timer idle detection.
///
/// 1. When a manual timer is running and `idle_ms >= idle_threshold_ms`, enters `IdlePending`.
/// 2. When user input resumes (`idle_ms < idle_threshold_ms`), emits an `IdleReturnPrompt` once
///    and enters `AwaitingResolution` until resolved (or until the timer stops/switches).
/// 3. Also detects PC sleep/hibernate gaps (`now_ms - last_poll_at >= idle_threshold_ms`) where
///    the user already generated input upon waking up.
#[derive(Debug, Clone)]
pub struct IdleStateMachine {
    idle_threshold_ms: u64,
    state: IdleTrackerState,
    last_poll_at: Option<i64>,
}

impl IdleStateMachine {
    pub fn new(idle_threshold_ms: u64) -> Self {
        Self {
            idle_threshold_ms: idle_threshold_ms.max(1),
            state: IdleTrackerState::Active,
            last_poll_at: None,
        }
    }

    pub fn set_threshold_ms(&mut self, idle_threshold_ms: u64) {
        self.idle_threshold_ms = idle_threshold_ms.max(1);
    }

    pub fn threshold_ms(&self) -> u64 {
        self.idle_threshold_ms
    }

    pub fn state(&self) -> &IdleTrackerState {
        &self.state
    }

    pub fn pending_prompt(&self) -> Option<&IdleReturnPrompt> {
        match &self.state {
            IdleTrackerState::AwaitingResolution(prompt) => Some(prompt),
            _ => None,
        }
    }

    pub fn mark_resolved(&mut self) {
        self.state = IdleTrackerState::Active;
    }

    pub fn observe(
        &mut self,
        now_ms: i64,
        idle_ms: u64,
        running_entry: Option<&TimeEntry>,
    ) -> Option<IdleReturnPrompt> {
        let prev_poll = self.last_poll_at.replace(now_ms);

        let Some(entry) = running_entry else {
            self.state = IdleTrackerState::Active;
            return None;
        };

        // Reset stale idle state if the running entry changed.
        let stale_entry = match &self.state {
            IdleTrackerState::Active => false,
            IdleTrackerState::IdlePending { entry_id, .. } => entry_id != &entry.id,
            IdleTrackerState::AwaitingResolution(prompt) => prompt.entry_id != entry.id,
        };
        if stale_entry {
            self.state = IdleTrackerState::Active;
        }

        let sleep_gap_exceeded = prev_poll
            .map(|prev| now_ms.saturating_sub(prev))
            .is_some_and(|delta| delta >= 0 && (delta as u64) >= self.idle_threshold_ms);

        match &mut self.state {
            IdleTrackerState::Active => {
                if idle_ms >= self.idle_threshold_ms {
                    let raw_start = now_ms.saturating_sub(idle_ms.min(i64::MAX as u64) as i64);
                    let idle_started_at = raw_start.max(entry.started_at).min(now_ms);
                    self.state = IdleTrackerState::IdlePending {
                        entry_id: entry.id.clone(),
                        entry_description: entry.description.clone(),
                        idle_started_at,
                    };
                    None
                } else if let (Some(prev), true) = (prev_poll, sleep_gap_exceeded) {
                    // System woke from sleep/hibernate exceeding the idle threshold and the user
                    // already interacted before the first post-wake poll.
                    let idle_started_at = prev.max(entry.started_at).min(now_ms);
                    let prompt = IdleReturnPrompt {
                        entry_id: entry.id.clone(),
                        entry_description: entry.description.clone(),
                        idle_started_at,
                        returned_at: now_ms,
                        idle_duration_ms: (now_ms - idle_started_at).max(0),
                    };
                    self.state = IdleTrackerState::AwaitingResolution(prompt.clone());
                    Some(prompt)
                } else {
                    None
                }
            }
            IdleTrackerState::IdlePending {
                entry_id,
                entry_description,
                idle_started_at,
            } => {
                if idle_ms < self.idle_threshold_ms {
                    let prompt = IdleReturnPrompt {
                        entry_id: entry_id.clone(),
                        entry_description: entry_description.clone(),
                        idle_started_at: *idle_started_at,
                        returned_at: now_ms,
                        idle_duration_ms: (now_ms - *idle_started_at).max(0),
                    };
                    self.state = IdleTrackerState::AwaitingResolution(prompt.clone());
                    Some(prompt)
                } else {
                    *entry_description = entry.description.clone();
                    None
                }
            }
            IdleTrackerState::AwaitingResolution(_) => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::SyncStatus;

    fn running_entry(id: &str, started_at: i64) -> TimeEntry {
        TimeEntry {
            id: id.into(),
            description: format!("Work on {id}"),
            started_at,
            ended_at: None,
            ticktick_project_id: None,
            ticktick_parent_task_id: None,
            ticktick_subtask_id: None,
            sync_mode: None,
            sync_status: SyncStatus::Local,
            sync_error: None,
            retry_count: 0,
            complete_parent_task: false,
            tag_ids: vec![],
            created_at: started_at,
            updated_at: started_at,
        }
    }

    #[test]
    fn transitions_active_to_pending_to_return_prompt_once() {
        let mut sm = IdleStateMachine::new(300_000);
        let entry = running_entry("e1", 100_000);

        // Normal active ticks
        assert!(sm.observe(110_000, 0, Some(&entry)).is_none());
        assert_eq!(sm.state(), &IdleTrackerState::Active);

        // Crosses idle threshold (5 min idle -> idle started at 120_000)
        assert!(sm.observe(420_000, 300_000, Some(&entry)).is_none());
        assert_eq!(
            sm.state(),
            &IdleTrackerState::IdlePending {
                entry_id: "e1".into(),
                entry_description: "Work on e1".into(),
                idle_started_at: 120_000,
            }
        );

        // Remains idle -> no prompt yet
        assert!(sm.observe(450_000, 330_000, Some(&entry)).is_none());

        // User moves mouse -> prompt emitted once
        let prompt = sm
            .observe(452_000, 200, Some(&entry))
            .expect("return prompt");
        assert_eq!(prompt.entry_id, "e1");
        assert_eq!(prompt.idle_started_at, 120_000);
        assert_eq!(prompt.returned_at, 452_000);
        assert_eq!(prompt.idle_duration_ms, 332_000);
        assert_eq!(sm.pending_prompt(), Some(&prompt));

        // Subsequent polls while awaiting resolution do not re-emit
        assert!(sm.observe(454_000, 0, Some(&entry)).is_none());
        assert_eq!(sm.pending_prompt(), Some(&prompt));

        // Marking resolved returns to Active
        sm.mark_resolved();
        assert_eq!(sm.state(), &IdleTrackerState::Active);
        assert!(sm.pending_prompt().is_none());
    }

    #[test]
    fn ignores_idle_when_no_manual_timer_is_running() {
        let mut sm = IdleStateMachine::new(300_000);
        assert!(sm.observe(100_000, 500_000, None).is_none());
        assert_eq!(sm.state(), &IdleTrackerState::Active);
        assert!(sm.observe(102_000, 0, None).is_none());
        assert_eq!(sm.state(), &IdleTrackerState::Active);
    }

    #[test]
    fn resets_when_timer_stops_or_switches() {
        let mut sm = IdleStateMachine::new(300_000);
        let e1 = running_entry("e1", 10_000);
        let e2 = running_entry("e2", 500_000);

        assert!(sm.observe(320_000, 300_000, Some(&e1)).is_none());
        assert!(matches!(sm.state(), IdleTrackerState::IdlePending { .. }));

        // Switching to a new timer clears pending idle state for e1
        assert!(sm.observe(502_000, 0, Some(&e2)).is_none());
        assert_eq!(sm.state(), &IdleTrackerState::Active);

        // Stopping timer while awaiting resolution clears prompt
        assert!(sm.observe(810_000, 300_000, Some(&e2)).is_none());
        assert!(sm.observe(812_000, 0, Some(&e2)).is_some());
        assert!(sm.pending_prompt().is_some());

        assert!(sm.observe(814_000, 0, None).is_none());
        assert!(sm.pending_prompt().is_none());
        assert_eq!(sm.state(), &IdleTrackerState::Active);
    }

    #[test]
    fn clamps_idle_start_to_entry_start_and_handles_sleep_wake() {
        let mut sm = IdleStateMachine::new(300_000);
        let entry = running_entry("e1", 200_000);

        // Even if OS idle_ms exceeds elapsed timer duration, idle_started_at clamps to entry.started_at
        assert!(sm.observe(210_000, 400_000, Some(&entry)).is_none());
        let prompt = sm.observe(215_000, 0, Some(&entry)).expect("prompt");
        assert_eq!(prompt.idle_started_at, 200_000);
        assert_eq!(prompt.idle_duration_ms, 15_000);
        sm.mark_resolved();

        // Simulate PC sleep for 10 minutes with immediate user input on wake
        let wake_prompt = sm
            .observe(815_000, 100, Some(&entry))
            .expect("sleep wake prompt");
        assert_eq!(wake_prompt.idle_started_at, 215_000);
        assert_eq!(wake_prompt.returned_at, 815_000);
        assert_eq!(wake_prompt.idle_duration_ms, 600_000);
    }
}
