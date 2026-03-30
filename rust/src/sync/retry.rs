//! Bounded retries with exponential backoff (std-only).

use std::time::Duration;

/// Retry policy for transient I/O (IMAP fetch batches, etc.).
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    pub max_attempts: usize,
    pub initial_backoff: Duration,
    pub backoff_num: u32,
    pub backoff_den: u32,
}

impl RetryPolicy {
    /// Two attempts, 500ms then ×1.5 (Node `fetch-all-timeout` retry shape).
    pub const fn uid_fetch_batch() -> Self {
        Self {
            max_attempts: 2,
            initial_backoff: Duration::from_millis(500),
            backoff_num: 3,
            backoff_den: 2,
        }
    }
}

/// Runs `op` until success or `max_attempts` is exhausted. Sleeps with exponential backoff between tries.
///
/// `on_retry` is invoked after each failure when another attempt will follow (`attempt` is 1-based).
pub fn retry_with_backoff<T, E, F, H>(
    policy: &RetryPolicy,
    mut op: F,
    mut on_retry: H,
) -> Result<T, E>
where
    F: FnMut() -> Result<T, E>,
    H: FnMut(usize, &E, Duration),
{
    assert!(
        policy.max_attempts > 0,
        "retry_with_backoff: max_attempts must be positive"
    );

    let mut backoff = policy.initial_backoff;
    let mut last_err: Option<E> = None;

    for attempt in 0..policy.max_attempts {
        match op() {
            Ok(v) => return Ok(v),
            Err(e) => {
                if attempt + 1 < policy.max_attempts {
                    on_retry(attempt + 1, &e, backoff);
                    std::thread::sleep(backoff);
                    backoff = (backoff * policy.backoff_num) / policy.backoff_den;
                }
                last_err = Some(e);
            }
        }
    }

    Err(last_err.expect("retry_with_backoff: exhausted without storing error"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn succeeds_on_first_try() {
        let mut calls = 0;
        let r = retry_with_backoff(
            &RetryPolicy {
                max_attempts: 3,
                initial_backoff: Duration::from_millis(1),
                backoff_num: 2,
                backoff_den: 1,
            },
            || {
                calls += 1;
                Ok(42)
            },
            |_: usize, _: &i32, _: Duration| panic!("on_retry should not run"),
        );
        assert_eq!(r.unwrap(), 42);
        assert_eq!(calls, 1);
    }

    #[test]
    fn succeeds_after_failures() {
        let mut calls = 0;
        let r = retry_with_backoff(
            &RetryPolicy {
                max_attempts: 3,
                initial_backoff: Duration::from_millis(1),
                backoff_num: 2,
                backoff_den: 1,
            },
            || {
                calls += 1;
                if calls < 3 {
                    Err(calls)
                } else {
                    Ok("ok")
                }
            },
            |_, _, _| {},
        );
        assert_eq!(r.unwrap(), "ok");
        assert_eq!(calls, 3);
    }
}
