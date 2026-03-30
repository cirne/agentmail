//! Batch fetch wall-clock limits (mirrors `src/sync/fetch-all-timeout.ts`).
//!
//! The sync engine logs `recommendedTimeoutMs` per UID FETCH retry attempt; the blocking `imap`
//! client does not yet apply that as a socket read deadline (retries use [`super::retry`]).

const FETCH_ALL_TIMEOUT_MIN_MS: u64 = 60_000;
const FETCH_ALL_TIMEOUT_PER_UID_MS: u64 = 300;
const FETCH_ALL_TIMEOUT_MAX_MS: u64 = 300_000;

/// Extra attempts after the first (one retry with longer limit).
pub const FETCH_ALL_TIMEOUT_EXTRA_ATTEMPTS: u32 = 1;

pub fn compute_fetch_all_timeout_ms(batch_len: usize) -> u64 {
    let scaled =
        30_000u64.saturating_add((batch_len as u64).saturating_mul(FETCH_ALL_TIMEOUT_PER_UID_MS));
    scaled.clamp(FETCH_ALL_TIMEOUT_MIN_MS, FETCH_ALL_TIMEOUT_MAX_MS)
}

pub fn timeout_ms_for_fetch_all_attempt(batch_len: usize, attempt: u32) -> u64 {
    let base = compute_fetch_all_timeout_ms(batch_len);
    if attempt <= 1 {
        base
    } else {
        (base.saturating_mul(3) / 2).min(FETCH_ALL_TIMEOUT_MAX_MS)
    }
}

pub fn is_fetch_all_timeout_message(msg: &str) -> bool {
    msg.contains("fetchAll timed out")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_with_batch() {
        let a = compute_fetch_all_timeout_ms(1);
        let b = compute_fetch_all_timeout_ms(200);
        assert!(b >= a);
        assert!(compute_fetch_all_timeout_ms(10_000) <= FETCH_ALL_TIMEOUT_MAX_MS);
    }
}
