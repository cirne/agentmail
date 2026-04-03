# Inbox customization and durable rules

This companion to [`../SKILL.md`](../SKILL.md) explains how to make **`zmail check`** and **`zmail review`** smarter over time by giving them **durable memory** about what matters to the mailbox owner.

The core idea: do not force the agent to rediscover the same preferences on every pass. Keep a small, explicit ruleset plus a little background context so inbox triage gets better with use.

---

## Version check first

Treat the installed **`zmail`** binary as the source of truth:

1. Run **`zmail check --help`**, **`zmail review --help`**, and **`zmail search --help`** to see what triage/category flags exist in this version.
2. If the installed version exposes **`zmail rules ...`**, prefer that over editing files directly.
3. If the installed version documents **`~/.zmail/rules.json`**, keep the file small, explicit, and human-auditable.
4. If neither exists yet, treat this file as the **target workflow** for future personalization and do not invent unsupported commands.

---

## Mental model

Use three layers:

| Layer | Purpose | Example |
| ----- | ------- | ------- |
| **Deterministic category** | Fast machine labeling from headers/provider labels | `promotional`, `social`, `list`, `spam` |
| **Rules** | User preferences for action | "notify on bank security alerts" |
| **Context** | Background facts that help classification | "Kirsten is my property manager" |

The agent should think of this as **mailbox memory**:

- **Category** says what kind of email it is.
- **Rules** say what the user wants done with it.
- **Context** says what the user means when the rule is ambiguous.

That combination is what makes `zmail` improve over time instead of acting like a stateless filter.

---

## Durable file shape

When supported, keep inbox customization in **`~/.zmail/rules.json`** so it survives DB rebuilds and can be maintained by either a human or an agent.

Typical shape:

```json
{
  "version": 1,
  "rules": [
    {
      "id": "x9p4",
      "condition": "security alerts from any financial institution",
      "action": "notify"
    },
    {
      "id": "w5j1",
      "condition": "routine shipping and tracking updates unless delivery is today",
      "action": "ignore"
    },
    {
      "id": "q2r6",
      "condition": "personal mail from close friends that is usually worth mentioning but rarely urgent",
      "action": "inform"
    }
  ],
  "context": [
    {
      "id": "d1g5",
      "text": "Kirsten is my property manager"
    },
    {
      "id": "p7a3",
      "text": "Currently closing on a house; mortgage and title emails are high priority until June 2026"
    }
  ]
}
```

Keep entries:

- **Short**
- **Concrete**
- **Stable**
- **Easy to delete later**

Prefer one precise rule over a paragraph of prose.

---

## Actions to use

Rules should map to a small action set:

| Action | Use when | Typical effect |
| ------ | -------- | -------------- |
| **`notify`** | Missing this right now would be costly | Surface it in `check` immediately |
| **`inform`** | Worth mentioning, but not interrupting for | Surface it at the next `review` |
| **`ignore`** | Routine noise or low-value mail the user does not want in proactive triage | Classifier skips surfacing. **Local auto-archive** applies when a user rule matched, the message is in an excluded provider category, the sender looks like **no-reply**, or body/subject has **unsubscribe** boilerplate — otherwise mail stays in the working set (still searchable). Use **`zmail archive`** for **`notify`** / **`inform`** mail once handled |

Good examples:

- **`notify`**: fraud alerts, password resets, urgent direct asks, OTP codes.
- **`inform`**: personal updates, important non-urgent work mail, things the user should hear about at the next review.
- **`ignore`**: newsletters, recruiting drip campaigns, social digests, routine shipping updates.

Legacy CLI strings **`archive`** and **`suppress`** are accepted when adding rules and map to **`ignore`**.

---

## Write good rules

Prefer rules that describe **intent**, not a brittle implementation detail.

Good:

- "security alerts from any financial institution"
- "routine shipping and tracking updates unless delivery is today"
- "mailing list traffic from Rust or Go communities"

Avoid:

- "emails with subject line ending in 30% off"
- "anything from `noreply@example.com`" when the real preference is broader
- giant compound rules that mix unrelated concepts

Good rule-writing habits:

- Mention the **topic** or **meaning**, not just one sender.
- Include the **exception** when one matters.
- Split unrelated behaviors into separate rules.
- Remove time-bound rules when the situation ends.

---

## Use context for facts, not actions

Put stable background knowledge in **`context`**, not in rule text.

Good context:

- "Kirsten is my property manager"
- "Ranch and Son Story refer to the same real estate project"
- "I am job hunting through May 2026"

Bad context:

- "notify me about Kirsten"
- "ignore LinkedIn digests" (put that in a **rule** instead)

Rule of thumb: if the statement implies **what to do**, it is probably a rule. If it explains **why a message matters**, it is probably context.

---

## Agent workflow

Use a write loop instead of ad hoc memory:

1. Run normal `check`, `review`, and search workflows.
2. Notice repeat behavior from the user or agent.
3. Propose a durable rule or context entry.
4. Get confirmation before changing the ruleset.
5. Apply the change with **`zmail rules ...`** when available.
6. Re-check future passes to confirm behavior improved.

Examples of good prompts to the user:

- "I notice you keep archiving or ignoring LinkedIn digest mail. Want me to add an ignore rule?"
- "You always care about fraud alerts and password resets. Want a notify rule for financial security mail?"
- "You are in the middle of a house purchase. Want me to add temporary context so title and mortgage mail gets prioritized?"

Only create durable rules when the pattern is:

- **Repeated**
- **Understandable**
- **Likely to stay true**

Do not overfit on a single message.

---

## Maintenance strategy

Aim for a small ruleset that stays legible.

Add a rule when:

- the same class of mail keeps being surfaced when the user would rather ignore or archive it
- the user states a stable preference
- a recurring workflow would benefit from explicit notify/inform/ignore behavior

Edit or remove a rule when:

- life circumstances changed
- a rule is too broad or too narrow
- the user now wants different notification behavior

Prefer deleting stale temporary context instead of letting it accumulate forever.

---

## Diagnostics and trust

When the installed version supports diagnostics, use them to answer:

- Why was this message surfaced?
- Which rule matched?
- Was the decision from a rule, model, cache, or fallback?
- What category did zmail assign?

If the result surprises the user:

1. inspect the rule or context that likely fired
2. tighten or remove it
3. rerun the relevant `check` or `review`

Personalization is only trustworthy if the user can understand and edit it.

---

## Patterns worth encoding

Common rule families:

- **Important people**: partner, family, boss, key client, property manager
- **Security**: bank alerts, password resets, MFA, suspicious login mail
- **Noise**: marketing blasts, social digests, recruiting drips
- **Routine transactional**: shipping updates, package notices, repeated confirmations
- **Non-urgent but relevant**: project updates, logistics, travel plans, non-urgent client mail

Common context families:

- current project names and aliases
- active life events with an end date
- people-to-role mappings
- business entities or properties that have multiple names

---

## Safety rules for agents

- Prefer **small edits** to the ruleset, not rewrites.
- Keep user wording recognizable when possible.
- Ask before adding, removing, or broadening a rule.
- Do not silently create a durable preference from one ambiguous action.
- Keep the file auditable by humans.

The goal is not to make the inbox "perfect." The goal is to make it **steadily more aligned** with the user's real priorities.
