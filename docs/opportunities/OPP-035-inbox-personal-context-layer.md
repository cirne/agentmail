# OPP-035: Inbox Personal Context Layer — Facts Separate from Rules

**Status:** Open. **Created:** 2026-04-01. **Tags:** inbox, personalization, context, rules, review, inform, llm

**Related:** [OPP-001](OPP-001-personalization.md) (personalization for search), [OPP-032](OPP-032-llm-rules-engine.md) (stateful inbox foundation), [OPP-034](OPP-034-simplified-inbox-cli-check-review.md) (review/check product contract), [OPP-036](OPP-036-inbox-triage-orthogonal-archive.md) (triage vs explicit archive + optional IMAP)

---

## Problem

`zmail review` currently has too little durable context about the user's world.

That creates a predictable failure mode:

- obvious bulk and promotional mail is filtered reasonably well
- but legitimate personal, family, business, financial, and operational mail often falls through to `archive`
- the system has no strong way to know that a sender, company, place, or topic is important to this specific user

Examples:

- "Kirsten is my wife"
- "Howie is my assistant"
- "Green Longhorn is my company"
- "Four Rivers is my fund"
- "The ranch is in Sunrise Beach"

These are not really inbox rules. They are durable facts about the user's world.

Today, those facts can only be approximated through:

- free-form context blobs in the rules file
- brittle action-oriented rules
- model guesswork from sender, subject, and snippet

That is enough for some prompt steering, but not enough for trustworthy inbox review. Prompt tuning alone will not solve this because the deeper issue is missing user context, not just wording.

---

## Why the current shape is wrong

Rules and context are serving two different jobs:

1. **Rules express policy.**
   Example: "Direct asks from Kirsten should usually be `notify`."

2. **Context expresses facts.**
   Example: "Kirsten is my wife."

When both are collapsed into one file and one prompt section, several problems appear:

- the model has to recover policy from prose facts every time
- factual context gets mixed with action instructions
- the file becomes harder for users and agents to maintain
- the system cannot easily promote stable facts into stronger structured signals later

The result is a fuzzy prompt blob instead of a clean personalization layer.

---

## Proposed direction

Introduce a dedicated personal-context layer for inbox workflows.

### Authoring model

Use a single canonical user-authored context document, preferably Markdown, as the primary authoring surface.

Example:

```md
# People

- Kirsten is my wife.
- Howie is my assistant.
- Sterling Clowdus works with me at Green Longhorn.

# Organizations

- Green Longhorn is my company.
- Four Rivers is my investment fund.

# Places and projects

- The ranch is in Sunrise Beach.
- "Son Story" refers to the ranch.
```

This should be optimized for:

- easy manual editing
- easy agent editing
- readable facts instead of JSON ceremony
- durable world knowledge, not per-message decisions

### Policy model

Keep explicit inbox rules separate and narrower.

Examples:

- "Direct asks from Kirsten -> notify"
- "Scheduling replies awaiting my response -> notify"
- "Green Longhorn operational threads -> inform"
- "Routine marketing newsletters -> suppress"

In short:

- **context file:** who/what/where matters
- **rules file:** what action to take when known conditions are met

### Runtime model

The context document should not remain only a raw prompt appendage forever.

Short term:

- include the context document in inbox classification prompts
- keep rules as a separate policy section

Longer term:

- parse or distill the context document into structured facts
- derive stronger triage features from those facts
- let classification use both structured signals and the original text

That keeps Markdown as the best authoring format without forcing the runtime to rely only on a giant prose blob.

---

## Design principles

1. **Separate facts from policy.**
   "Kirsten is my wife" should not live in the same layer as "messages from Kirsten with direct asks should notify."

2. **Optimize for human maintenance first.**
   Users should be able to edit one readable document about their world.

3. **Keep the authoring format richer than the storage contract.**
   Markdown can be the canonical authoring layer even if zmail later derives structured facts from it.

4. **Avoid forcing every important relationship into explicit rules.**
   The baseline review system should get better because it understands who and what matters, not only because the user hand-authored many action rules.

5. **Treat personal context as cross-cutting product infrastructure.**
   The same facts should eventually help inbox review, search, ask, and compose.

---

## Potential implementation shape

### Option A: Markdown-first

Add a canonical file under `~/.zmail/`, such as:

- `context.md`

Pros:

- most readable and editable
- easy for agents to append and reorganize
- expressive for users

Cons:

- requires parsing/summarization at runtime if we want structured features

### Option B: Split source + derived representation

Keep:

- `context.md` as the human-authored source

Optionally derive:

- `context.json` or SQLite-backed extracted facts for runtime use

Pros:

- preserves great UX for authoring
- enables stronger features later
- avoids turning the prompt into an ever-growing blob

Cons:

- adds a second representation to manage

### Option C: Put everything into `rules.json`

Not recommended as the long-term direction.

It is acceptable for small prototypes, but it keeps facts and policy entangled and pushes the system toward increasingly messy prompt assembly.

---

## Product impact

If this works well, inbox review should improve in exactly the class of misses we care about:

- family and close-contact mail
- assistant and scheduling mail
- company/fund/project threads
- important place/project references
- business and financial updates that are meaningful to this user even when not urgent

This should especially improve `inform`, because `inform` depends on personalized salience more than deterministic urgency.

---

## Open questions

- Should the context file be one free-form document or multiple sections/files such as people, organizations, and places?
- Should zmail support agent-suggested edits like "I noticed repeated references to Sunrise Beach; add this to context?"
- How much structure should be extracted automatically from Markdown?
- Should context be shared across search, ask, inbox review, and compose from day one, or introduced for inbox first?
- How do we keep context concise enough that prompts stay reliable?

---

## Acceptance criteria

### Product acceptance

- Users can maintain durable personal-world facts without encoding everything as rules.
- Inbox review recall improves for personalized `inform` cases.
- The model can distinguish between "important to this user" and merely "legitimate email."

### Design acceptance

- facts and action rules are represented separately
- Markdown is supported as a first-class authoring format for personal context
- the system leaves room for later structured extraction rather than hard-coding prompt-only use forever

### Evaluation acceptance

- eval cases covering family, assistant, company, fund, ranch/property, and finance threads improve materially
- prompt-only changes are no longer the sole mechanism for personalization

---

## Recommendation

Pursue a **Markdown-first personal context layer** and keep rules as the thinner explicit policy layer on top.

Recommended sequencing:

1. Introduce a canonical `context.md` authoring surface under `~/.zmail/`
2. Feed it into inbox-review classification separately from explicit rules
3. Build evals around personalized `inform` recall
4. Later, extract structured facts from the Markdown so personalization becomes stronger than prompt stuffing alone

This gives zmail a better long-term model:

- **context** explains the user's world
- **rules** express explicit triage policy
- **review** becomes personalized because the system knows what matters, not just what looks urgent
