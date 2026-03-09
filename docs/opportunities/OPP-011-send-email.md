# OPP-011: Send Email — Draft + SMTP

**Status:** Opportunity. **Blocked** on customer validation for core search/index/onboarding — we want to nail that first.

## Context

zmail is read-only today. The vision (see [VISION.md](../VISION.md) — "The Full Loop") is read + write: the agent is the complete interface. User never opens inbox, never opens compose.

## Opportunity

Add send capability via SMTP (send-as-user through Gmail/Outlook/Fastmail). Same credentials as IMAP, same identity, messages appear in Sent, zero deliverability risk.

**Phases:**
1. **Send only** — `zmail send` + MCP `send_email`. Raw send, no voice, no tagline.
2. **Draft + confirm** — MCP `draft_reply`, confirmation step, tagline footer.
3. **Voice profile** — Per-recipient tone from sent history; drafts sound like the user in the right register.

**Killer differentiators:**
- Voice profile from history (how you write varies by recipient)
- Tagline as advertisement ("Sent via zmail")
- Intent-to-action ("rsvp yes" → draft → confirm → send)

## Blocked by

Customer validation for core search/index/onboarding. Agent-friendly setup ([OPP-009](archive/OPP-009-agent-friendly-setup.md)) is implemented; we need to validate the read/sync/search flow with real users before adding send.
