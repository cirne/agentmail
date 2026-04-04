# Inbox customization and durable rules

This companion to [`../SKILL.md`](../SKILL.md) explains how to make **`zmail inbox`** align with what matters to the mailbox owner using **one mechanism**: **`~/.zmail/rules.json` v2** with **`kind: "regex"`** rules only.

**What inbox does:** It **compiles and applies regex patterns** against each candidate message — **subject**, **full stored body** (`bodyPattern`), **From address**, **sync category** (`categoryPattern`), and **sender domain** (`fromDomainPattern`). There is **no LLM** in the inbox path. **`ZMAIL_OPENAI_API_KEY`** is **not** required for **`zmail inbox`**. OpenAI is used elsewhere (**`zmail ask`**, **`draft edit`**, setup/wizard), not for triage.

**What inbox does not use:** There is **no** separate “context” or free-text layer for matching. A legacy **`context`** array in `rules.json` may be **round-tripped** on save but is **ignored** by the inbox matcher — do not rely on it; encode preferences as **regex rules** instead. There are **no** learned or embedding-based classifiers in inbox.

**Bundled defaults:** On first run, zmail installs **`default_rules.v2.json`** — the same **regex** shape as user rules (OTP-style subjects/bodies, `categoryPattern` for provider labels like `^list$`, noreply-style `fromPattern`, etc.). Edit or extend with **`zmail rules ...`** or by editing **`rules.json`** and running **`zmail rules validate`**.

**Cadence:** Run **`zmail refresh`** so the local index stays current. Run **`zmail inbox`** over the **already-indexed** unarchived window; run **`refresh`** first when **recency** matters. JSON output includes **`notify` / `inform` / `ignore`**, **`decisionSource`** (**`rule`** vs **`fallback`**), **`matchedRuleIds`**, optional **`hints`**, and (for forward compatibility) **`requiresUserAction`**, **`actionSummary`**, **`counts.actionRequired`**. In current deterministic inbox, **`requiresUserAction`** stays **false** and **`actionSummary`** empty unless a future release defines them. Use **`zmail inbox --diagnostics`** or **`--thorough`** when you need full rows or a complete rescan. Use **`zmail archive`** when mail no longer needs focused attention; **`search` / `read` / `ask`** still see archived mail. Table: [Inbox workflow](../SKILL.md#inbox-workflow) in **`SKILL.md`**.

The core idea: **preferences live in explicit regex rules** so neither you nor the agent has to rediscover the same patterns every time.

---

## Version check first

Treat the installed **`zmail`** binary as the source of truth:

1. Run **`zmail inbox --help`** and **`zmail rules --help`** to see supported flags in this version.
2. Prefer **`zmail rules validate`**, **`zmail rules add`**, **`zmail rules edit`**, **`zmail rules remove`**, **`zmail rules move`** over hand-editing when possible.
3. Keep **`~/.zmail/rules.json`** small, explicit, and auditable — every rule is **`kind: "regex"`**.

---

## Mental model

| Piece | Role |
| ----- | ---- |
| **Regex rules** (`rules.json`) | The only way to express **what should match** and **notify / inform / ignore**. Each rule has one or more of **`subjectPattern`**, **`bodyPattern`**, **`fromPattern`**, **`categoryPattern`**, **`fromDomainPattern`**, plus **`action`**. Rules are an **ordered list**: **earlier rules take precedence** over later ones when multiple rules match (the **first** matching rule picks the action; **`matchedRuleIds`** lists all matches in file order). |
| **Sync category** | Metadata from the provider/sync pipeline (e.g. list, promotional). Rules reference it with **`categoryPattern`** — it is **not** a separate “smart” classifier; it is **input** to your regex rules. |
| **No rule match** | **`decisionSource: "fallback"`** — zmail still assigns an action so output is complete. This path is **deterministic and not LLM-based**; for predictable behavior on specific mail, **add a regex rule** (or adjust bundled defaults). |
| **JSON compatibility fields** | **`requiresUserAction`**, **`actionSummary`** — reserved; current deterministic inbox does not populate them from triage. |

Think of **`rules.json`** as **mailbox memory** you control: add a pattern when the same class of mail should always be **notify**, **inform**, or **ignore**.

---

## File shape

Keep customization in **`~/.zmail/rules.json`** so it survives DB rebuilds and can be maintained by a human or an agent.

**Version 2** — rules are **`kind: "regex"`** only:

```json
{
  "version": 2,
  "rules": [
    {
      "kind": "regex",
      "id": "bank-domain",
      "action": "notify",
      "fromDomainPattern": "(?i)^mybank\\.example$",
      "description": "Bank notifications"
    },
    {
      "kind": "regex",
      "id": "invoice-subject",
      "action": "inform",
      "subjectPattern": "(?i)invoice|payment due"
    },
    {
      "kind": "regex",
      "id": "noreply-from",
      "action": "ignore",
      "fromPattern": "(?i)^no-?reply@",
      "description": "Noreply-style From (example; bundled defaults use a broader pattern)"
    }
  ]
}
```

Do **not** add a **`context`** block for inbox behavior — it is not consulted for matching.

Run **`zmail rules validate`** after edits. If the file is legacy v1, corrupt JSON, or rules lack **`kind`**, the CLI reports an error and may suggest **`zmail rules reset-defaults --yes`** (renames the current file to **`rules.json.bak.<uuid>`** and installs bundled v2 defaults).

**`zmail rules add`** requires **`--action`** and at least one of **`--subject-pattern`**, **`--body-pattern`**, **`--from-pattern`** (regex on subject, stored body text, or sender). **`categoryPattern`** and **`fromDomainPattern`** are edited in **`rules.json`** (or come from bundled defaults). New rules **append** to the end (lowest precedence) unless you pass **`--insert-before <rule-id>`** to place the rule before an existing id. Optional **`--description`**, **`--no-preview`**, **`--preview-window`**. See **`zmail rules add --help`**.

**`zmail rules move <rule-id> --before <other-id>`** or **`--after <other-id>`** reorders an existing rule (exactly one of **`--before`** / **`--after`**). Output is a **compact full list** after the move (`moved` plus every rule’s **`id`** and **`action`** in order; **`--text`** prints the same as lines). See **`zmail rules move --help`**.

Keep each rule:

- **Short**
- **Concrete**
- **Stable**
- **Easy to delete later**

Prefer one precise regex over a paragraph of prose.

---

## Actions

Rules map to **notify / inform / ignore**. **`requiresUserAction` / `actionSummary`** are **not** rule actions; current deterministic inbox does not set them from classification. For **OTP / magic-link** mail, **`notify`** rules (or bundled OTP-style regex) surface them; use **`search` + `read`** when the user asks for a code.

| Action | Use when | Typical effect |
| ------ | -------- | -------------- |
| **`notify`** | Missing this right now would be costly | High-attention in **`inbox`** output and briefings |
| **`inform`** | Worth mentioning, not interrupting for | Listed in **`inbox`** output |
| **`ignore`** | Routine noise or mail you do not want in proactive triage | Classifier deprioritizes surfacing. **Local auto-archive** may apply when **`ignore`** came from a **matched rule** (including bundled defaults) or from **fixed signals** (excluded provider category, noreply-style sender, **unsubscribe** in subject or short preview, mail from your own address) — mail remains **searchable**. In **`rules.json`**, match body text with **`bodyPattern`** only (no `snippetPattern`). Use **`zmail archive`** for **notify** / **inform** mail once handled |

Legacy CLI strings **`archive`** and **`suppress`** are accepted when adding rules and map to **`ignore`**.

---

## Writing good rules

Rules are **executable patterns**: each row is **`kind: "regex"`** with at least one of **`subjectPattern`**, **`bodyPattern`**, **`fromPattern`**, **`categoryPattern`**, **`fromDomainPattern`**. Bundled defaults illustrate **`categoryPattern`** (e.g. `^list$`) and combined patterns — see **`src/rules/default_rules.v2.json`** in the repo.

Good:

- **`categoryPattern`** / **`fromDomainPattern`** for routing from metadata without scanning the whole body
- **`fromPattern`** / **`zmail rules add --from-pattern`** for domains or full addresses
- A tight **`subjectPattern`** or **`bodyPattern`** for recurring phrases (invoices, security codes)

Avoid:

- Overly broad regex that false-positives on personal mail
- Duplicating bundled defaults unless you need a different **`action`** or **order** in the list
- One giant regex that mixes unrelated ideas — prefer several rules and use **array order** (or **`--insert-before`**) so specific rules run before broad ones

Encode “facts” as **matchers**, not prose: e.g. property manager → **`fromPattern`** for their address; project aliases → **`subjectPattern`** or **`bodyPattern`**. Use **`zmail who`** to discover exact addresses for regex.

---

## Agent workflow

Use a small write loop instead of ad hoc memory:

1. Run **`refresh`** (when needed) then **`inbox`** / **`search`**.
2. Notice repeated user preferences or misfires.
3. Propose a **regex rule** (or edit **order** / **action** in **`rules.json`**).
4. Get confirmation before changing **`rules.json`**.
5. Apply with **`zmail rules add`** / **`edit`** / hand-edit + **`validate`**.
6. Re-run **`inbox`** to confirm.

Example prompts to the user:

- “You keep ignoring LinkedIn digests. Add **`--from-pattern`** for `linkedin\\.com` with **`ignore`**?”
- “Security mail should always surface — extend **`notify`** patterns for your bank domain?”

Only add rules when the pattern is **repeated**, **clear**, and **likely to stay true**. Do not overfit on a single message.

**`zmail rules feedback "<phrase>"`** prints **keyword-based suggestions** for which kind of regex to add (not an LLM); use it as a hint, then write a real pattern with **`zmail rules add`** or edit **`rules.json`**.

---

## Maintenance

Aim for a small ruleset that stays legible.

Add a rule when:

- The same class of mail keeps appearing when the user would rather **ignore** or archive it
- The user states a stable preference
- A recurring workflow needs explicit **notify** / **inform** / **ignore**

Edit or remove a rule when:

- Circumstances change
- A rule is too broad or too narrow
- The user wants different surfacing behavior

---

## Diagnostics and trust

When diagnostics are available, use them to answer:

- Why was this message surfaced?
- Which rule matched (**`matchedRuleIds`**)?
- Was the decision **`rule`** or **`fallback`**?
- What **sync category** did indexing store (for **`categoryPattern`** rules)?

**`counts.actionRequired`** may stay **0**; do not rely on it for triage todos until a future release defines those fields.

If the result surprises the user:

1. Inspect the **rule** that matched, or the **`fallback`** note when no rule matched
2. Tighten, broaden, or remove the pattern
3. Rerun **`zmail inbox`** (or **`zmail inbox --thorough`** for a full rescan)

Personalization is only trustworthy if the user can understand and edit it.

---

## Patterns worth encoding

Common **regex** families:

- **Important people**: partner, family, boss, key client — **`fromPattern`** / **`fromDomainPattern`**
- **Security**: bank alerts, password resets, MFA — subject/body patterns (bundled defaults cover many OTP-style phrases)
- **Noise**: marketing, social, lists — **`categoryPattern`** and/or sender patterns
- **Routine transactional**: shipping, confirmations — specific **`fromPattern`** or subject regex if you want **ignore**
- **Non-urgent but relevant**: project names, travel — **`subjectPattern`** / **`bodyPattern`** with **`inform`** or **`notify`**

---

## Safety rules for agents

- Prefer **small edits** to the ruleset, not rewrites.
- Keep user wording recognizable in **`description`** when helpful.
- Ask before adding, removing, or broadening a rule.
- Do not silently create a durable preference from one ambiguous action.
- Keep the file auditable by humans.

The goal is not a “perfect” inbox — it is an inbox that **stays aligned** with explicit, editable **regex** rules.
