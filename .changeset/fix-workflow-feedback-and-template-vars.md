---
"baton": patch
---

Fix actionable feedback detection and LiquidJS template vars in example prompts

`baton-reviewer-finding` and `baton-reviewer-summary` PR comments are now treated as actionable feedback (requiring code changes and a `baton-agent-reply` response). Previously the Implementer silently skipped them because the exclusion filter matched all `<!-- baton-* -->` markers instead of just the Implementer's own comment types (`baton-agent-reply`, `baton-progress`).

Shell variables (`$BATON_ISSUE_IDENTIFIER`, `$BATON_ISSUE_REPO`) in example prompt bodies are replaced with LiquidJS template vars (`{{ issue.identifier }}`, `{{ issue.repository }}`). The shell vars are only injected into hook subprocesses, not the agent subprocess, so they expanded to empty strings in the rendered prompt.
