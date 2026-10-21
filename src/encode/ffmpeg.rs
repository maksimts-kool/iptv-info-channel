//! Spawning ffmpeg/ffprobe, shared by the info channel and the media channel.

use std::process::Stdio;

use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

#[derive(Debug, thiserror::Error)]
pub enum RunError {
    /// A newer request for the same output superseded this one.
    #[error("generation aborted by newer request")]
    Aborted,
    #[error("{label} could not start: {source}")]
    Spawn { label: String, source: std::io::Error },
    #[error("{label} exited {code}: {output}")]
    Failed { label: String, code: i32, output: String },
}

impl RunError {
    pub fn is_aborted(&self) -> bool {
        matches!(self, Self::Aborted)
    }
}

/// ffprobe ships next to ffmpeg; derived from the ffmpeg path so one override
/// covers both (unless `FFPROBE_PATH` is set).
pub fn ffprobe_path(ffmpeg: &str) -> String {
    std::env::var("FFPROBE_PATH").unwrap_or_else(|_| {
        ffmpeg.strip_suffix("ffmpeg.exe").map_or_else(
            || {
                ffmpeg
                    .strip_suffix("ffmpeg")
                    .map_or_else(|| "ffprobe".to_owned(), |base| format!("{base}ffprobe"))
            },
            |base| format!("{base}ffprobe.exe"),
        )
    })
}

fn tail(s: &str, n: usize) -> String {
    let start = s.char_indices().rev().nth(n.saturating_sub(1)).map_or(0, |(i, _)| i);
    s[start..].to_owned()
}

/// Run a command to completion, killing it if `cancel` fires.
pub async fn run(cmd: &str, args: &[String], label: &str, cancel: Option<&CancellationToken>) -> Result<(), RunError> {
    let mut child = Command::new(cmd)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|source| {
            tracing::error!(target: "process", %label, error = %source, "could not start");
            RunError::Spawn {
                label: label.to_owned(),
                source,
            }
        })?;
    let mut stderr = child.stderr.take();
    let read_err = async {
        let mut buf = String::new();
        if let Some(s) = stderr.as_mut() {
            let _ = s.read_to_string(&mut buf).await;
        }
        buf
    };
    let never = CancellationToken::new();
    let cancel = cancel.unwrap_or(&never);
    let (status, output) = tokio::select! {
        () = cancel.cancelled() => {
            let _ = child.kill().await;
            return Err(RunError::Aborted);
        }
        (status, output) = async { let out = read_err.await; (child.wait().await, out) } => (status, output),
    };
    let status = status.map_err(|source| RunError::Spawn {
        label: label.to_owned(),
        source,
    })?;
    if status.success() {
        return Ok(());
    }
    let code = status.code().unwrap_or(-1);
    let output = tail(&output, 800);
    tracing::error!(target: "process", %label, code, output = %output, "failed");
    Err(RunError::Failed {
        label: label.to_owned(),
        code,
        output,
    })
}

/// Run a command and collect its stdout (ffprobe's JSON).
pub async fn capture(cmd: &str, args: &[String], label: &str) -> Result<String, RunError> {
    let out = Command::new(cmd)
        .args(args)
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|source| RunError::Spawn {
            label: label.to_owned(),
            source,
        })?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).into_owned());
    }
    Err(RunError::Failed {
        label: label.to_owned(),
        code: out.status.code().unwrap_or(-1),
        output: tail(&String::from_utf8_lossy(&out.stderr), 400),
    })
}

/// JS `Number.prototype.toFixed`: round half UP on the exact binary value.
/// Rust's `{:.N}` rounds ties to even, which would change pinned argv.
pub fn js_fixed(v: f64, digits: usize) -> String {
    let exact = format!("{:.40}", v.abs());
    let (int, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits_vec: Vec<u8> = int.bytes().chain(frac.bytes().take(digits)).map(|b| b - b'0').collect();
    let round_up = frac.as_bytes().get(digits).is_some_and(|d| *d >= b'5');
    if round_up {
        let mut i = digits_vec.len();
        loop {
            if i == 0 {
                digits_vec.insert(0, 1);
                break;
            }
            i -= 1;
            if digits_vec[i] == 9 {
                digits_vec[i] = 0;
            } else {
                digits_vec[i] += 1;
                break;
            }
        }
    }
    let split = digits_vec.len() - digits;
    let int_part: String = digits_vec[..split].iter().map(|d| char::from(b'0' + d)).collect();
    let frac_part: String = digits_vec[split..].iter().map(|d| char::from(b'0' + d)).collect();
    // JS: a negative input keeps its sign even when it rounds to zero.
    let sign = if v < 0.0 { "-" } else { "" };
    if digits == 0 {
        format!("{sign}{int_part}")
    } else {
        format!("{sign}{int_part}.{frac_part}")
    }
}

/// JS `String(number)` for the values these builders print.
pub fn js_num(v: f64) -> String {
    format!("{v}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_matches_js() {
        assert_eq!(js_fixed(3.2, 2), "3.20");
        assert_eq!(js_fixed(122.8, 2), "122.80");
        assert_eq!(js_fixed(0.125, 2), "0.13");
        assert_eq!(js_fixed(1.005, 2), "1.00"); // 1.005 is below the tie in binary
        assert_eq!(js_fixed(9.995, 2), "9.99");
        assert_eq!(js_fixed(99.999, 2), "100.00");
        assert_eq!(js_fixed(-0.001, 2), "-0.00");
        assert_eq!(js_num(4.0), "4");
        assert_eq!(js_num(4.5), "4.5");
        assert_eq!(ffprobe_path("/usr/bin/ffmpeg"), "/usr/bin/ffprobe");
    }
}
