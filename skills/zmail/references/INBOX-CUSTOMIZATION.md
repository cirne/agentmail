# Inbox customization and durable rules

This companion to [`../SKILL.md`](../SKILL.md) explains how to make **`zmail inbox`** smarter over time by giving it **durable memory** about what matters to the mailbox owner.

**Deterministic triage (Rust inbox as shipped):** **`zmail inbox`** does **not** call an LLM. It applies **`~/.zmail/rules.json` v2** (**`kind: "regex"`** only: patterns on subject, body, from address, **`categoryPattern`**, **`fromDomainPattern`**), then a **local fallback** when nothing matches. **`ZMAIL_OPENAI_API_KEY`** is **not** required for inbox. OpenAI remains for **`zmail ask`**, **`draft edit`**, and setup/wizard paths.

**Cadence:** schedule **`zmail refresh`** so the local index stays current. Run **`zmail inbox`** when you want triage over the **already-indexed** unarchived window; run **`zmail refresh`** first when **recency** matters. JSON carries **`notify` / `inform` / `ignore`**, **`decisionSource`**, **`matchedRuleIds`**, optional **`hints`**, and (for forward compatibility) **`requiresUserAction`**, **`actionSummary`**, **`counts.actionRequired`**. In **v1 deterministic** mode, **`requiresUserAction`** stays **false** and **`actionSummary`** empty unless a future extension sets them. Use **`zmail inbox --diagnostics`** or **`--thorough`** when you need full rows or a complete rescan. Use **`zmail archive`** when mail no longer needs focused attention; **`search` / `read` / `ask`** still see archived mail. Full table: [Inbox workflow](../SKILL.md#inbox-workflow) in **`SKILL.md`**.

The core idea: do not force the agent to rediscover the same preferences on every pass. Keep a small, explicit **typed** ruleset; optional **`context`** is for **agents** (human-readable facts), not for matching.

---

## Version check first

Treat the installed **`zmail`** binary as the source of truth:

1. Run **`zmail inbox --help`** and **`zmail search --help`** to see what triage/category flags exist in this version.
2. If the installed version exposes **`zmail rules ...`**, prefer that over editing files directly.
3. If the installed version documents **`~/.zmail/rules.json`**, keep the file small, explicit, and human-auditable.
4. If neither exists yet, treat this file as the **target workflow** for future personalization and do not invent unsupported commands.

---

## Mental model

Use **three layers** plus one **orthogonal classifier output**:

| Layer | Purpose | Example |
| ----- | ------- | ------- |
| **Deterministic category** | Fast machine labeling from headers/provider labels | `promotional`, `social`, `list`, `spam` |
| **Rules** | User preferences for action | "notify on bank security alerts" |
| **Context** | Background facts for **you** (the agent); inbox matching **ignores** context today | "Kirsten is my property manager" |
| **Action required** (JSON) | Reserved for future extensions; **v1 deterministic** inbox does not set these from rules | **`requiresUserAction`**, **`actionSummary`** — keep **`false` / empty** unless a later release defines typed signals |

The agent should think of this as **mailbox memory**:

- **Category** says what kind of email it is.
- **Rules** say what the user wants done with it (typed matchers only).
- **Context** documents meaning for agents; it does **not** change classification until a future feature uses it.
- **Action required** fields exist in JSON for compatibility; deterministic v1 does not populate them from triage.

That combination is what makes `zmail` improve over time instead of acting like a stateless filter.

---

## Durable file shape

When supported, keep inbox customization in **`~/.zmail/rules.json`** so it survives DB rebuilds and can be maintained by either a human or an agent.

**Version 2** shape (each rule has **`kind`**: **`regex`**):

```json
{
  "version": 2,
  "rules": [
    {
      "kind": "regex",
      "id": "bank-domain",
      "action": "notify",
      "priority": 0,
      "fromDomainPattern": "(?i)^mybank\\.example$",
      "description": "Bank notifications"
    },
    {
      "kind": "regex",
      "id": "invoice-subject",
      "action": "inform",
      "priority": 10,
      "subjectPattern": "(?i)invoice|payment due"
    },
    {
      "kind": "regex",
      "id": "noreply-from",
      "action": "ignore",
      "priority": 0,
      "fromPattern": "(?i)^no-?reply@",
      "description": "Noreply-style From (example; bundled defaults use a broader pattern)"
    }
  ],
  "context": [
    {
      "id": "d1g5",
      "text": "Kirsten is my property manager"
    }
  ]
}
```

Run **`zmail rules validate`** after edits. If the file is legacy v1, corrupt JSON, or missing **`kind`** on rules, the CLI prints a clear error and suggests **`zmail rules reset-defaults --yes`** (renames the current file to **`rules.json.bak.<uuid>`** and installs bundled v2 defaults) or manual / agent migration to typed rules. **`zmail rules add`** takes **`--action`** and at least one of **`--subject-pattern`** / **`--body-pattern`** / **`--from-pattern`** (regex on subject, stored body text, or sender address). Use **`--from-pattern`** for domains or full addresses (e.g. `@vendor\.com`). **`categoryPattern`** / **`fromDomainPattern`** are edited in **`rules.json`** (or come from bundled defaults). Optional **`--priority`**, **`--description`**, **`--no-preview`**, **`--preview-window`**. See **`zmail rules add --help`**.

Keep entries:

- **Short**
- **Concrete**
- **Stable**
- **Easy to delete later**

Prefer one precise rule over a paragraph of prose.

---

## Actions to use

Rules map to a small action set (**notify / inform / ignore**). **`requiresUserAction` / `actionSummary`** are **not** rule actions; deterministic v1 does not set them from classification. Ephemeral **OTP / magic-link** mail is often **`notify`** for visibility; agents still use **`search` + `read`** when the user asks for a code.

| Action | Use when | Typical effect |
| ------ | -------- | -------------- |
| **`notify`** | Missing this right now would be costly | Treat as high-attention in **`inbox`** output and agent briefing |
| **`inform`** | Worth mentioning, but not interrupting for | Include in **`inbox`** output; use **`actionSummary`** when briefing |
| **`ignore`** | Routine noise or low-value mail the user does not want in proactive triage | Classifier skips surfacing. **Local auto-archive** applies when a user rule matched, the message is in an excluded provider category, the sender looks like **no-reply**, or body/subject has **unsubscribe** boilerplate — otherwise mail stays in the working set (still searchable). Use **`zmail archive`** for **`notify`** / **`inform`** mail once handled |

Good examples:

- **`notify`**: fraud alerts, password resets, urgent direct asks; **OTP codes** are often **`notify`** for visibility but **`requiresUserAction`** is usually **false** (read the code, then archive)—still use **`search` + `read`** when the user asks for a code.
- **`inform`**: FYI threads, low-urgency updates, mail worth listing without treating as urgent.
- **`ignore`**: newsletters, recruiting drip campaigns, social digests, routine shipping updates.

Legacy CLI strings **`archive`** and **`suppress`** are accepted when adding rules and map to **`ignore`**.

---

## Write good rules

Rules are **executable**, not prose: every row is **`kind: "regex"`** with one or more of **`subjectPattern`**, **`bodyPattern`**, **`fromPattern`**, **`categoryPattern`** (regex on sync **`category`**), **`fromDomainPattern`** (regex on the sender’s domain), or CLI **`--from-pattern`** / **`--body-pattern`** / **`--subject-pattern`**. Bundled defaults use **`categoryPattern`** (e.g. `^list$`) plus from/subject/body patterns — see **`src/rules/default_rules.v2.json`**.

Good:

- **`categoryPattern`** / **`fromDomainPattern`** in **`rules.json`** for metadata routing without matching full body
- **`fromPattern`** / **`zmail rules add --from-pattern`** for sender domains or specific addresses
- A tight **`subjectPattern`** for recurring subject lines (invoices, security codes)

Avoid:

- Overly broad regex that false-positive on personal mail
- Duplicating the bundled defaults unless you need a different **`action`** or **`priority`**
- Mixing many unrelated signals in one regex — prefer several rules with clear **`priority`**

---

## Use context for facts (agent-facing)

Put stable background knowledge in **`context`** so **you** (the agent) remember user intent when proposing **new typed rules**. The inbox engine does **not** read context for matching today.

Good context:

- "Kirsten is my property manager"
- "Ranch and Son Story refer to the same real estate project"

Bad context:

- "notify me about Kirsten" → translate into a **`regex`** rule instead. (use `zmail who` to find the precise regex)

---

## Agent workflow

Use a write loop instead of ad hoc memory:

1. Run normal **`inbox`** and **`search`** workflows (after **`refresh`** when the index must be fresh).
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
- Was the decision from a **rule** (see **`matchedRuleIds`**) or **fallback**?
- What category did zmail assign (provider labels)?

**`counts.actionRequired`** may stay at **0** in deterministic v1; do not rely on it for triage todos until a future release defines how those fields are set.

If the result surprises the user:

1. inspect the rule or context that likely fired
2. tighten or remove it
3. rerun **`zmail inbox`** (or **`zmail inbox --thorough`** if you need a full rescan)

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
