//! The info channel's encode queue. Every per-customer stream build goes
//! through it instead of a free `tokio::spawn`, so a burst of admin edits or
//! overlapping bulk rebuilds no longer start one ffmpeg per request.
//!
//! - **Coalescing**: one entry per customer. A repeat request merges into the
//!   queued one (highest priority wins, `force` is OR-ed, waiters and batches
//!   are joined).
//! - **Latest wins**: a request for a customer whose stream is encoding
//!   cancels that encode and queues a fresh one; its waiters move over, so
//!   they get the newer stream instead of an "aborted" error.
//! - **Priorities**: a player waiting on a missing stream, then admin edits,
//!   then bulk and scheduled rebuilds; first come, first served within one.
//! - **Bounded**: the encoder runs `ENCODE_WORKERS` jobs at once, and one
//!   customer is never encoded twice at the same time.
//! - **Retry**: a failed encode is retried once after a pause.
//!
//! This is the scheduling state only — the encoder executes the jobs — so it
//! is unit tested without ffmpeg.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::{Notify, oneshot};
use tokio_util::sync::CancellationToken;

use crate::core::activity::Activity;
use crate::core::util::iso_now;

/// Attempts per job: the first plus one retry.
const MAX_ATTEMPTS: u32 = 2;
const RETRY_DELAY: Duration = Duration::from_secs(5);
/// Finished jobs kept for the admin's "recent" list.
const HISTORY: usize = 40;
/// Queued jobs listed in a snapshot (the total is always given).
const LISTED: usize = 50;
/// Reasons kept on a job that absorbed several requests.
const MAX_REASONS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Priority {
    /// Bulk and scheduled rebuilds.
    Background,
    /// One customer, after an admin change.
    Admin,
    /// A player is waiting on a stream that does not exist yet.
    Viewer,
}

/// What a job's waiters are told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobResult {
    Encoded(PathBuf),
    UpToDate(PathBuf),
    Cancelled,
    NotFound,
    Failed(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Encoded,
    UpToDate,
    Cancelled,
    NotFound,
    Failed,
}

impl JobResult {
    pub const fn outcome(&self) -> Outcome {
        match self {
            Self::Encoded(_) => Outcome::Encoded,
            Self::UpToDate(_) => Outcome::UpToDate,
            Self::Cancelled => Outcome::Cancelled,
            Self::NotFound => Outcome::NotFound,
            Self::Failed(_) => Outcome::Failed,
        }
    }
}

/// One request for a customer's stream.
#[derive(Debug, Clone)]
pub struct Request {
    pub user_id: i64,
    pub label: String,
    pub reason: String,
    pub priority: Priority,
    pub force: bool,
}

/// A job handed to a worker.
#[derive(Debug)]
pub struct Job {
    pub id: u64,
    pub user_id: i64,
    pub reason: String,
    pub force: bool,
    pub cancel: CancellationToken,
}

#[derive(Debug)]
struct Pending {
    id: u64,
    user_id: i64,
    label: String,
    reasons: Vec<String>,
    priority: Priority,
    force: bool,
    attempt: u32,
    queued_at: String,
    /// A retry waits out its pause.
    not_before: Option<Instant>,
    batches: Vec<u64>,
    waiters: Vec<oneshot::Sender<JobResult>>,
}

#[derive(Debug)]
struct Running {
    id: u64,
    user_id: i64,
    label: String,
    reasons: Vec<String>,
    priority: Priority,
    force: bool,
    attempt: u32,
    queued_at: String,
    started_at: String,
    started: Instant,
    cancel: CancellationToken,
    batches: Vec<u64>,
    waiters: Vec<oneshot::Sender<JobResult>>,
    /// A newer request took this job's waiters; its end is not reported.
    superseded: bool,
    /// Cancelled by the admin (or the customer is gone): not retried.
    stopped: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BatchView {
    pub id: u64,
    pub reason: String,
    pub total: usize,
    pub done: usize,
    pub failed: usize,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Finished {
    pub id: u64,
    pub user_id: i64,
    pub label: String,
    pub reasons: Vec<String>,
    pub outcome: Outcome,
    pub error: Option<String>,
    pub attempt: u32,
    pub seconds: f64,
    pub ended_at: String,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Totals {
    pub encoded: u64,
    pub up_to_date: u64,
    pub failed: u64,
    pub cancelled: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunningView {
    pub id: u64,
    pub user_id: i64,
    pub label: String,
    pub reasons: Vec<String>,
    pub priority: Priority,
    pub force: bool,
    pub attempt: u32,
    pub queued_at: String,
    pub started_at: String,
    pub seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueuedView {
    pub id: u64,
    pub user_id: i64,
    pub label: String,
    pub reasons: Vec<String>,
    pub priority: Priority,
    pub force: bool,
    pub attempt: u32,
    pub queued_at: String,
    /// Seconds until a retry may start.
    pub retry_in: Option<f64>,
}

/// The admin's view of the queue.
#[derive(Debug, Clone, Serialize)]
pub struct Snapshot {
    pub workers: usize,
    pub running: Vec<RunningView>,
    /// In the order they will run (the first [`LISTED`]).
    pub queued: Vec<QueuedView>,
    pub queued_total: usize,
    /// Active bulk rebuilds, then the last finished one.
    pub batches: Vec<BatchView>,
    pub recent: Vec<Finished>,
    pub totals: Totals,
    /// Moving average of a real encode, for an ETA.
    pub avg_seconds: Option<f64>,
}

#[derive(Debug, Default)]
struct State {
    seq: u64,
    closed: bool,
    pending: Vec<Pending>,
    running: Vec<Running>,
    batches: Vec<BatchView>,
    recent: VecDeque<Finished>,
    totals: Totals,
    avg_seconds: Option<f64>,
}

fn add_reason(reasons: &mut Vec<String>, reason: &str) {
    if reasons.iter().any(|r| r == reason) {
        return;
    }
    reasons.push(reason.to_owned());
    if reasons.len() > MAX_REASONS {
        reasons.remove(0);
    }
}

impl State {
    fn add(&mut self, req: &Request, batch: Option<u64>, waiter: Option<oneshot::Sender<JobResult>>) {
        if let Some(p) = self.pending.iter_mut().find(|p| p.user_id == req.user_id) {
            add_reason(&mut p.reasons, &req.reason);
            p.label.clone_from(&req.label);
            p.priority = p.priority.max(req.priority);
            p.force |= req.force;
            // Something changed again: a retry waiting out its pause runs now.
            p.not_before = None;
            if let Some(b) = batch
                && !p.batches.contains(&b)
            {
                p.batches.push(b);
            }
            p.waiters.extend(waiter);
            return;
        }
        self.seq += 1;
        let mut p = Pending {
            id: self.seq,
            user_id: req.user_id,
            label: req.label.clone(),
            reasons: vec![req.reason.clone()],
            priority: req.priority,
            force: req.force,
            attempt: 1,
            queued_at: iso_now(),
            not_before: None,
            batches: batch.into_iter().collect(),
            waiters: waiter.into_iter().collect(),
        };
        if let Some(r) = self
            .running
            .iter_mut()
            .find(|r| r.user_id == req.user_id && !r.superseded)
        {
            // Latest wins: stop the running encode and hand its waiters over.
            r.cancel.cancel();
            r.superseded = true;
            p.priority = p.priority.max(r.priority);
            p.force |= r.force;
            p.waiters.append(&mut r.waiters);
            for b in r.batches.drain(..) {
                if !p.batches.contains(&b) {
                    p.batches.push(b);
                }
            }
        }
        self.pending.push(p);
    }

    fn startable(&self, p: &Pending, now: Instant) -> bool {
        p.not_before.is_none_or(|t| t <= now) && !self.running.iter().any(|r| r.user_id == p.user_id)
    }

    fn take_next(&mut self, now: Instant) -> Option<Job> {
        let idx = self
            .pending
            .iter()
            .enumerate()
            .filter(|(_, p)| self.startable(p, now))
            .max_by_key(|(_, p)| (p.priority, std::cmp::Reverse(p.id)))?
            .0;
        let p = self.pending.remove(idx);
        let cancel = CancellationToken::new();
        let job = Job {
            id: p.id,
            user_id: p.user_id,
            reason: p.reasons.last().cloned().unwrap_or_default(),
            force: p.force,
            cancel: cancel.clone(),
        };
        self.running.push(Running {
            id: p.id,
            user_id: p.user_id,
            label: p.label,
            reasons: p.reasons,
            priority: p.priority,
            force: p.force,
            attempt: p.attempt,
            queued_at: p.queued_at,
            started_at: iso_now(),
            started: Instant::now(),
            cancel,
            batches: p.batches,
            waiters: p.waiters,
            superseded: false,
            stopped: false,
        });
        Some(job)
    }

    /// The soonest a waiting retry may start.
    fn next_retry(&self) -> Option<Instant> {
        self.pending.iter().filter_map(|p| p.not_before).min()
    }

    fn finish(&mut self, id: u64, result: &JobResult, now: Instant) {
        let Some(i) = self.running.iter().position(|r| r.id == id) else {
            return;
        };
        let r = self.running.remove(i);
        if r.superseded {
            return;
        }
        let seconds = r.started.elapsed().as_secs_f64();
        if matches!(result, JobResult::Failed(_)) && r.attempt < MAX_ATTEMPTS && !r.stopped && !self.closed {
            self.pending.push(Pending {
                id: r.id,
                user_id: r.user_id,
                label: r.label,
                reasons: r.reasons,
                priority: r.priority,
                force: r.force,
                attempt: r.attempt + 1,
                queued_at: r.queued_at,
                not_before: Some(now + RETRY_DELAY),
                batches: r.batches,
                waiters: r.waiters,
            });
            return;
        }
        if matches!(result, JobResult::Encoded(_)) {
            self.avg_seconds = Some(self.avg_seconds.map_or(seconds, |avg| avg * 0.7 + seconds * 0.3));
        }
        self.complete(
            Finished {
                id: r.id,
                user_id: r.user_id,
                label: r.label,
                reasons: r.reasons,
                outcome: result.outcome(),
                error: None,
                attempt: r.attempt,
                seconds,
                ended_at: String::new(),
            },
            &r.batches,
            r.waiters,
            result,
        );
    }

    /// Record a job's end: totals, its batches, history and its waiters.
    fn complete(
        &mut self,
        mut record: Finished,
        batches: &[u64],
        waiters: Vec<oneshot::Sender<JobResult>>,
        result: &JobResult,
    ) {
        let failed = matches!(result, JobResult::Failed(_) | JobResult::NotFound);
        match result {
            JobResult::Encoded(_) => self.totals.encoded += 1,
            JobResult::UpToDate(_) => self.totals.up_to_date += 1,
            JobResult::Cancelled => self.totals.cancelled += 1,
            JobResult::NotFound | JobResult::Failed(_) => self.totals.failed += 1,
        }
        let now = iso_now();
        for b in self.batches.iter_mut().filter(|b| batches.contains(&b.id)) {
            b.done += 1;
            if failed {
                b.failed += 1;
            }
            if b.done >= b.total && b.finished_at.is_none() {
                b.finished_at = Some(now.clone());
            }
        }
        self.prune_batches();
        if let JobResult::Failed(e) = result {
            record.error = Some(e.clone());
        }
        record.ended_at = now;
        self.recent.push_front(record);
        self.recent.truncate(HISTORY);
        for w in waiters {
            let _ = w.send(result.clone());
        }
    }

    /// Keep the active batches and the most recently finished one.
    fn prune_batches(&mut self) {
        let last_done = self
            .batches
            .iter()
            .filter(|b| b.finished_at.is_some())
            .map(|b| b.id)
            .max();
        self.batches
            .retain(|b| b.finished_at.is_none() || Some(b.id) == last_done);
    }

    fn cancel_pending_at(&mut self, idx: usize) {
        let p = self.pending.remove(idx);
        self.complete(
            Finished {
                id: p.id,
                user_id: p.user_id,
                label: p.label,
                reasons: p.reasons,
                outcome: Outcome::Cancelled,
                error: None,
                attempt: p.attempt,
                seconds: 0.0,
                ended_at: String::new(),
            },
            &p.batches,
            p.waiters,
            &JobResult::Cancelled,
        );
    }

    fn cancel(&mut self, id: u64) -> bool {
        if let Some(i) = self.pending.iter().position(|p| p.id == id) {
            self.cancel_pending_at(i);
            return true;
        }
        if let Some(r) = self.running.iter_mut().find(|r| r.id == id && !r.superseded) {
            r.stopped = true;
            r.cancel.cancel();
            return true;
        }
        false
    }

    fn snapshot(&self, workers: usize, now: Instant) -> Snapshot {
        let mut order: Vec<&Pending> = self.pending.iter().collect();
        order.sort_by_key(|p| (std::cmp::Reverse(p.priority), p.id));
        Snapshot {
            workers,
            running: self
                .running
                .iter()
                .filter(|r| !r.superseded)
                .map(|r| RunningView {
                    id: r.id,
                    user_id: r.user_id,
                    label: r.label.clone(),
                    reasons: r.reasons.clone(),
                    priority: r.priority,
                    force: r.force,
                    attempt: r.attempt,
                    queued_at: r.queued_at.clone(),
                    started_at: r.started_at.clone(),
                    seconds: r.started.elapsed().as_secs_f64(),
                })
                .collect(),
            queued: order
                .iter()
                .take(LISTED)
                .map(|p| QueuedView {
                    id: p.id,
                    user_id: p.user_id,
                    label: p.label.clone(),
                    reasons: p.reasons.clone(),
                    priority: p.priority,
                    force: p.force,
                    attempt: p.attempt,
                    queued_at: p.queued_at.clone(),
                    retry_in: p.not_before.filter(|t| *t > now).map(|t| (t - now).as_secs_f64()),
                })
                .collect(),
            queued_total: self.pending.len(),
            batches: self.batches.clone(),
            recent: self.recent.iter().cloned().collect(),
            totals: self.totals,
            avg_seconds: self.avg_seconds,
        }
    }
}

#[derive(Debug)]
pub struct EncodeQueue {
    state: Mutex<State>,
    wake: Notify,
    activity: Arc<Activity>,
    workers: usize,
}

impl EncodeQueue {
    pub fn new(workers: usize, activity: Arc<Activity>) -> Self {
        Self {
            state: Mutex::default(),
            wake: Notify::new(),
            activity,
            workers: workers.max(1),
        }
    }

    pub const fn workers(&self) -> usize {
        self.workers
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn changed(&self) {
        self.activity.bump();
        self.wake.notify_waiters();
    }

    /// Queue one customer's stream; the receiver resolves when it is done.
    /// Dropping the receiver is fine (fire and forget).
    pub fn enqueue(&self, req: &Request) -> oneshot::Receiver<JobResult> {
        let (tx, rx) = oneshot::channel();
        {
            let mut s = self.state();
            if s.closed {
                let _ = tx.send(JobResult::Cancelled);
                return rx;
            }
            s.add(req, None, Some(tx));
        }
        self.changed();
        rx
    }

    /// Queue a bulk rebuild of these customers as one tracked batch.
    pub fn enqueue_batch(
        &self,
        reason: &str,
        users: &[(i64, String)],
        priority: Priority,
    ) -> (u64, Vec<(i64, oneshot::Receiver<JobResult>)>) {
        let mut out = Vec::with_capacity(users.len());
        let batch_id = {
            let mut s = self.state();
            s.seq += 1;
            let batch_id = s.seq;
            if !s.closed && !users.is_empty() {
                s.batches.push(BatchView {
                    id: batch_id,
                    reason: reason.to_owned(),
                    total: users.len(),
                    done: 0,
                    failed: 0,
                    started_at: iso_now(),
                    finished_at: None,
                });
            }
            for (user_id, label) in users {
                let (tx, rx) = oneshot::channel();
                if s.closed {
                    let _ = tx.send(JobResult::Cancelled);
                } else {
                    let req = Request {
                        user_id: *user_id,
                        label: label.clone(),
                        reason: reason.to_owned(),
                        priority,
                        force: false,
                    };
                    s.add(&req, Some(batch_id), Some(tx));
                }
                out.push((*user_id, rx));
            }
            batch_id
        };
        self.changed();
        (batch_id, out)
    }

    /// The next job for a worker; `None` once the queue is closed.
    pub async fn next(&self) -> Option<Job> {
        loop {
            let notified = self.wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let retry_at = {
                let mut s = self.state();
                if s.closed {
                    return None;
                }
                if let Some(job) = s.take_next(Instant::now()) {
                    drop(s);
                    self.activity.bump();
                    return Some(job);
                }
                s.next_retry()
            };
            match retry_at {
                Some(at) => {
                    tokio::select! {
                        () = &mut notified => {}
                        () = tokio::time::sleep_until(at.into()) => {}
                    }
                }
                None => notified.await,
            }
        }
    }

    /// A worker is done with a job.
    pub fn finish(&self, id: u64, result: &JobResult) {
        self.state().finish(id, result, Instant::now());
        self.changed();
    }

    /// Drop a queued job or stop a running one.
    pub fn cancel(&self, id: u64) -> bool {
        let found = self.state().cancel(id);
        if found {
            self.changed();
        }
        found
    }

    /// Drop every queued job (running ones finish).
    pub fn clear_queued(&self) -> usize {
        let n = {
            let mut s = self.state();
            let n = s.pending.len();
            while !s.pending.is_empty() {
                s.cancel_pending_at(0);
            }
            n
        };
        if n > 0 {
            self.changed();
        }
        n
    }

    /// Queue a finished job's customer again.
    pub fn retry(&self, finished_id: u64) -> bool {
        let Some(req) = self
            .state()
            .recent
            .iter()
            .find(|f| f.id == finished_id)
            .map(|f| Request {
                user_id: f.user_id,
                label: f.label.clone(),
                reason: "admin retry".to_owned(),
                priority: Priority::Admin,
                force: false,
            })
        else {
            return false;
        };
        drop(self.enqueue(&req));
        true
    }

    /// The customer is gone: drop and stop their jobs.
    pub fn forget_user(&self, user_id: i64) {
        let ids: Vec<u64> = {
            let s = self.state();
            s.pending
                .iter()
                .map(|p| (p.id, p.user_id))
                .chain(s.running.iter().map(|r| (r.id, r.user_id)))
                .filter(|(_, u)| *u == user_id)
                .map(|(id, _)| id)
                .collect()
        };
        for id in ids {
            self.cancel(id);
        }
    }

    /// Shutdown: queued jobs are cancelled, running encodes stopped, and the
    /// workers return.
    pub fn close(&self) {
        {
            let mut s = self.state();
            s.closed = true;
            while !s.pending.is_empty() {
                s.cancel_pending_at(0);
            }
            for r in &mut s.running {
                r.stopped = true;
                r.cancel.cancel();
            }
        }
        self.changed();
    }

    pub fn snapshot(&self) -> Snapshot {
        self.state().snapshot(self.workers, Instant::now())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(user_id: i64, priority: Priority) -> Request {
        Request {
            user_id,
            label: format!("u{user_id}"),
            reason: "test".into(),
            priority,
            force: false,
        }
    }

    fn queue() -> EncodeQueue {
        EncodeQueue::new(2, Arc::new(Activity::default()))
    }

    fn take(q: &EncodeQueue) -> Option<Job> {
        q.state().take_next(Instant::now())
    }

    fn done() -> JobResult {
        JobResult::Encoded(PathBuf::from("x"))
    }

    #[test]
    fn repeat_requests_merge_into_one_job() {
        let q = queue();
        let mut a = q.enqueue(&req(1, Priority::Background));
        let mut b = q.enqueue(&Request {
            force: true,
            reason: "again".into(),
            ..req(1, Priority::Admin)
        });
        let snap = q.snapshot();
        assert_eq!(snap.queued_total, 1);
        assert_eq!(snap.queued[0].priority, Priority::Admin);
        assert_eq!(snap.queued[0].reasons, ["test", "again"]);
        let job = take(&q).unwrap();
        assert!(job.force);
        q.finish(job.id, &done());
        assert_eq!(a.try_recv().unwrap(), done());
        assert_eq!(b.try_recv().unwrap(), done());
    }

    #[test]
    fn higher_priority_runs_first_then_fifo() {
        let q = queue();
        for (id, p) in [
            (1, Priority::Background),
            (2, Priority::Background),
            (3, Priority::Admin),
            (4, Priority::Viewer),
        ] {
            drop(q.enqueue(&req(id, p)));
        }
        let order: Vec<i64> = std::iter::from_fn(|| take(&q)).map(|j| j.user_id).collect();
        assert_eq!(order, [4, 3, 1, 2]);
    }

    #[test]
    fn newer_request_supersedes_a_running_encode() {
        let q = queue();
        let mut first = q.enqueue(&req(1, Priority::Admin));
        let old = take(&q).unwrap();
        let mut second = q.enqueue(&req(1, Priority::Background));
        assert!(old.cancel.is_cancelled());
        // The same customer never runs twice at once.
        assert!(take(&q).is_none());
        q.finish(old.id, &JobResult::Cancelled);
        assert!(first.try_recv().is_err(), "waiters moved to the newer job");
        let new = take(&q).unwrap();
        assert_eq!(q.snapshot().running[0].priority, Priority::Admin);
        q.finish(new.id, &done());
        assert_eq!(first.try_recv().unwrap(), done());
        assert_eq!(second.try_recv().unwrap(), done());
        assert_eq!(q.snapshot().recent.len(), 1, "a superseded run is not history");
    }

    #[test]
    fn failure_is_retried_once_after_a_pause() {
        let q = queue();
        let mut rx = q.enqueue(&req(1, Priority::Admin));
        let job = take(&q).unwrap();
        q.finish(job.id, &JobResult::Failed("boom".into()));
        assert!(rx.try_recv().is_err());
        assert!(take(&q).is_none(), "waits out the retry delay");
        let later = Instant::now() + RETRY_DELAY + Duration::from_millis(10);
        let retry = q.state().take_next(later).unwrap();
        assert_eq!(q.snapshot().running[0].attempt, 2);
        q.finish(retry.id, &JobResult::Failed("boom".into()));
        assert_eq!(rx.try_recv().unwrap(), JobResult::Failed("boom".into()));
        let snap = q.snapshot();
        assert_eq!(snap.totals.failed, 1);
        assert_eq!(snap.recent[0].error.as_deref(), Some("boom"));
    }

    #[test]
    fn batch_progress_counts_every_outcome() {
        let q = queue();
        let users: Vec<(i64, String)> = (1..=3).map(|i| (i, format!("u{i}"))).collect();
        let (batch, mut rxs) = q.enqueue_batch("bulk", &users, Priority::Background);
        let a = take(&q).unwrap();
        q.finish(a.id, &done());
        let b = take(&q).unwrap();
        q.finish(b.id, &JobResult::NotFound);
        let snap = q.snapshot();
        assert_eq!(
            (snap.batches[0].id, snap.batches[0].done, snap.batches[0].failed),
            (batch, 2, 1)
        );
        assert!(snap.batches[0].finished_at.is_none());
        assert_eq!(q.clear_queued(), 1);
        let snap = q.snapshot();
        assert_eq!(snap.batches[0].done, 3);
        assert!(snap.batches[0].finished_at.is_some());
        assert_eq!(rxs.pop().unwrap().1.try_recv().unwrap(), JobResult::Cancelled);
    }

    #[test]
    fn cancel_and_forget() {
        let q = queue();
        let mut queued = q.enqueue(&req(1, Priority::Admin));
        let id = q.snapshot().queued[0].id;
        assert!(q.cancel(id));
        assert_eq!(queued.try_recv().unwrap(), JobResult::Cancelled);

        drop(q.enqueue(&req(2, Priority::Admin)));
        let running = take(&q).unwrap();
        drop(q.enqueue(&req(3, Priority::Admin)));
        q.forget_user(2);
        assert!(running.cancel.is_cancelled());
        // A stopped job is not retried even when it reports a failure.
        q.finish(running.id, &JobResult::Failed("killed".into()));
        let snap = q.snapshot();
        assert!(snap.running.is_empty());
        assert_eq!(snap.queued_total, 1);
        assert_eq!(snap.queued[0].user_id, 3);
    }

    #[tokio::test]
    async fn workers_wake_on_enqueue_and_stop_on_close() {
        let q = Arc::new(queue());
        let worker = {
            let q = Arc::clone(&q);
            tokio::spawn(async move {
                let mut ran = Vec::new();
                while let Some(job) = q.next().await {
                    ran.push(job.user_id);
                    q.finish(job.id, &done());
                }
                ran
            })
        };
        let rx = q.enqueue(&req(7, Priority::Admin));
        assert_eq!(rx.await.unwrap(), done());
        q.close();
        assert_eq!(worker.await.unwrap(), [7]);
        let mut late = q.enqueue(&req(8, Priority::Admin));
        assert_eq!(late.try_recv().unwrap(), JobResult::Cancelled);
    }
}
