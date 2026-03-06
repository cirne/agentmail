# Bugs — Agent and User Reports

When an agent or user hits a failure, we document it here. Root cause and “agent-intuitive” implications matter: **is the CLI intuitive enough for the LLM?** See [VISION.md](./VISION.md) (agent-first, agent-intuitive interfaces).

---

| ID | Title | Summary |
|---|---|---|
| [BUG-001](bugs/BUG-001-attachment-and-read-agent-friction.md) | Attachment and Read/Thread Friction — Agent-Reported | `read`/`thread` fail when ID is missing angle brackets; `attachment read` argument order and extract-vs-download (`--raw`) unclear; PDF extraction broken in compiled binary. |
