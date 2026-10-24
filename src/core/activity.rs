//! A process-wide "background work changed" signal: the encode queue and the
//! media builder poke it, and the admin's live job feed (SSE) wakes on it.

use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub struct Activity {
    version: watch::Sender<u64>,
    closing: CancellationToken,
}

impl Default for Activity {
    fn default() -> Self {
        Self {
            version: watch::Sender::new(0),
            closing: CancellationToken::new(),
        }
    }
}

impl Activity {
    /// Something a job view shows changed.
    pub fn bump(&self) {
        self.version.send_modify(|v| *v = v.wrapping_add(1));
    }

    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.version.subscribe()
    }

    /// Fires on shutdown, so long-lived feeds end and the server can drain.
    pub fn closing(&self) -> CancellationToken {
        self.closing.clone()
    }

    pub fn close(&self) {
        self.closing.cancel();
    }
}
