//! Injectable IMAP transport for sync (`run_sync`) and tests.

use imap::Session;
use imap::types::Mailbox;
use imap::Connection;

use super::error::RunSyncError;

/// STATUS / EXAMINE fields we care about for early-exit and checkpointing.
#[derive(Debug, Clone, Default)]
pub struct ImapStatusData {
    pub uid_next: Option<u32>,
    pub uid_validity: Option<u32>,
}

/// One message from UID FETCH.
#[derive(Debug, Clone)]
pub struct FetchedMessage {
    pub uid: u32,
    pub raw: Vec<u8>,
    pub labels: Vec<String>,
}

/// Minimal IMAP surface required by `run_sync`.
pub trait SyncImapTransport {
    fn mailbox_status(&mut self, mailbox: &str) -> Result<ImapStatusData, RunSyncError>;
    /// Returns UIDVALIDITY after EXAMINE (0 if missing).
    fn examine_mailbox(&mut self, mailbox: &str) -> Result<u32, RunSyncError>;
    fn uid_search_keys(&mut self, query: &str) -> Result<Vec<u32>, RunSyncError>;
    fn uid_fetch_rfc822_batch(&mut self, uid_csv: &str) -> Result<Vec<FetchedMessage>, RunSyncError>;
}

fn mailbox_to_status(m: &Mailbox) -> ImapStatusData {
    ImapStatusData {
        uid_next: m.uid_next,
        uid_validity: m.uid_validity,
    }
}

/// Live IMAP session (`imap` crate).
pub struct RealImapTransport<'a> {
    pub session: &'a mut Session<Connection>,
}

impl SyncImapTransport for RealImapTransport<'_> {
    fn mailbox_status(&mut self, mailbox: &str) -> Result<ImapStatusData, RunSyncError> {
        let m = self
            .session
            .status(mailbox, "(MESSAGES UIDNEXT UIDVALIDITY)")
            .map_err(|e| RunSyncError::Imap(e.to_string()))?;
        Ok(mailbox_to_status(&m))
    }

    fn examine_mailbox(&mut self, mailbox: &str) -> Result<u32, RunSyncError> {
        let m = self
            .session
            .examine(mailbox)
            .map_err(|e| RunSyncError::Imap(e.to_string()))?;
        Ok(m.uid_validity.unwrap_or(0))
    }

    fn uid_search_keys(&mut self, query: &str) -> Result<Vec<u32>, RunSyncError> {
        let set = self
            .session
            .uid_search(query)
            .map_err(|e| RunSyncError::Imap(e.to_string()))?;
        let mut v: Vec<u32> = set.iter().copied().collect();
        v.sort_unstable();
        Ok(v)
    }

    fn uid_fetch_rfc822_batch(&mut self, uid_csv: &str) -> Result<Vec<FetchedMessage>, RunSyncError> {
        if uid_csv.is_empty() {
            return Ok(Vec::new());
        }
        let query_gmail = "(UID BODY.PEEK[] X-GM-LABELS)";
        let fetches = match self.session.uid_fetch(uid_csv, query_gmail) {
            Ok(f) => Ok(f),
            Err(e) => {
                let es = e.to_string();
                if es.contains("X-GM-LABELS") || es.contains("BAD") || es.contains("Parse") {
                    self.session
                        .uid_fetch(uid_csv, "(UID BODY.PEEK[])")
                        .map_err(|e2| RunSyncError::Imap(e2.to_string()))
                } else {
                    Err(RunSyncError::Imap(es))
                }
            }
        }?;

        let mut out = Vec::new();
        for fetch in fetches.iter() {
            let Some(uid) = fetch.uid else {
                continue;
            };
            let Some(raw) = fetch.body().map(|b| b.to_vec()) else {
                continue;
            };
            let labels: Vec<String> = fetch
                .gmail_labels()
                .map(|it| it.map(str::to_string).collect())
                .unwrap_or_default();
            out.push(FetchedMessage {
                uid,
                raw,
                labels,
            });
        }
        Ok(out)
    }
}

/// Scripted transport for integration tests.
#[derive(Debug, Default)]
pub struct FakeImapTransport {
    pub status: ImapStatusData,
    pub uid_validity_on_examine: u32,
    pub search_uids: Vec<u32>,
    /// Each `uid_fetch_rfc822_batch` call pops the next vec (FIFO).
    pub fetch_batches: std::collections::VecDeque<Vec<FetchedMessage>>,
}

impl SyncImapTransport for FakeImapTransport {
    fn mailbox_status(&mut self, _mailbox: &str) -> Result<ImapStatusData, RunSyncError> {
        Ok(self.status.clone())
    }

    fn examine_mailbox(&mut self, _mailbox: &str) -> Result<u32, RunSyncError> {
        Ok(self.uid_validity_on_examine)
    }

    fn uid_search_keys(&mut self, _query: &str) -> Result<Vec<u32>, RunSyncError> {
        Ok(self.search_uids.clone())
    }

    fn uid_fetch_rfc822_batch(&mut self, _uid_csv: &str) -> Result<Vec<FetchedMessage>, RunSyncError> {
        Ok(self
            .fetch_batches
            .pop_front()
            .unwrap_or_default())
    }
}

/// Connect and log in (TLS/STARTTLS per `ClientBuilder` defaults — port 993 uses TLS).
pub fn connect_imap_session(
    host: &str,
    port: u16,
    user: &str,
    password: &str,
) -> Result<Session<Connection>, RunSyncError> {
    let client = imap::ClientBuilder::new(host, port)
        .connect()
        .map_err(|e| RunSyncError::Imap(e.to_string()))?;
    let session = client
        .login(user, password)
        .map_err(|(e, _)| RunSyncError::Imap(e.to_string()))?;
    Ok(session)
}
