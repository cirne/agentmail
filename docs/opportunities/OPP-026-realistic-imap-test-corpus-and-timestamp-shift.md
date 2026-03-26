# OPP-026: Realistic IMAP Test Corpus — Docker + Timestamp Shift at Index Time

**Problem:** We lack a **repeatable, large, realistic** mailbox for benchmarking **accuracy** (search, ask, threading, attachments) and **speed** (sync, index, refresh) against real-world-shaped data. Unit tests use small fixtures; dogfooding uses private mail — neither is shareable or deterministic across machines and CI.

**Direction:** Treat “realistic inbox” as a **pipeline**, not a single public IMAP host:

1. **Corpus** — Prefer released corpora with **many senders/recipients**, **To/Cc/Bcc variety**, **threads**, and **attachments** (e.g. Enron / EDRM-style MIME exports, mailing-list archives). Synthetic IMAP stress images (e.g. very large mailboxes) complement **scale** but not **linguistic realism**.
2. **Server** — Run **Dovecot** (or a packaged stack such as [MailCue](https://github.com/Olib-AI/mailcue)) in **Docker**, seed mail via **maildir import** or **IMAP APPEND** / API injection.
3. **zmail** — Document (or automate) **setup + sync** against that container so contributors and CI can reproduce the same workload.

**Goal:** A documented path to “attach this corpus + run this container + `zmail sync`” so we can measure regressions on **attachment extraction**, **header graphs**, and **end-to-end latency** without relying on a shared internet mailbox or personal accounts.

---

## Critical requirement: shift message timestamps at index time (“current” inbox)

Our **sync and refresh logic use sliding time windows** (e.g. `--since`, recent-mail assumptions). A static snapshot whose **newest** `Date` / internal time is years ago (e.g. corpus ending **Feb 2018**) will not exercise “recent mail” paths the same way production does: incremental sync may see nothing “new,” `inbox`-style windows may be empty, and benchmarks become misleading.

**Proposed behavior:** At **index time** (or immediately after fetch, before persisting indexed fields), apply a **single additive delta** to all message timestamps used for **windowing and ordering** so that the **most recent message in the corpus** aligns with **“just now”** (or a configurable anchor), preserving **relative spacing** between messages.

**Example:** Let `t_last` = timestamp of the newest message in the snapshot (e.g. 2018-02-28). Let `now` = wall-clock time when we index (or a fixed `TEST_ANCHOR_TIME` for reproducibility). Define:

`delta = now - t_last`

Store or derive **display/sync times** as `t_adjusted = t_original + delta` for every message in that import run (or for messages tagged as test-corpus). Internal message identity (IMAP UIDs, Message-IDs) stays unchanged; only **temporal fields used for sliding windows and “most recent” queries** shift.

**Why index time (or post-fetch, pre-query):** Keeps the **IMAP server** unmodified (still serves historical MIME); zmail’s DB reflects a **synthetic “as if synced today”** timeline for testing. Alternative — mutating raw mail files before ingest — is heavier and duplicates corpus management.

**Edge cases to decide later:**

- **Threads** — `In-Reply-To` / `References` unchanged; only **date-based** filters and sorts use shifted times.
- **Reproducibility** — CI may set `ZMAIL_TEST_TIME_ANCHOR` (or similar) so two runs produce identical ordering.
- **Dual clocks** — If we store both **raw** and **adjusted** dates, debugging remains possible; if only one, document that test imports are time-shifted.

---

## Out of scope / non-goals

- Shipping a multi-gigabyte corpus inside the main npm package (download or submodule instead).
- Replacing privacy-safe unit fixtures for fast PR checks (this is an **optional** integration / perf tier).

---

## Related

- Sliding-window sync and refresh behavior: [docs/SYNC.md](../SYNC.md) (and sync implementation in `src/sync/`).
- Attachment pipeline and caching: [OPP-006](OPP-006-attachment-search-and-caching.md).

---

## Acceptance criteria (when pursued)

- [ ] Written recipe: corpus source + Docker run + `zmail setup` / sync against localhost IMAP.
- [ ] Documented or implemented **timestamp shift** so the newest indexed message behaves as “current” under `--since` / recent windows.
- [ ] At least one automated or scripted check that a seeded corpus produces **non-empty** “recent” results after shift (smoke test).
