---
"baton": patch
---

Fix `handoff_count` reset when re-entering agent review after human approval

When an issue passed agent review (`status=pass`), was rejected by a human reviewer, and re-entered Agent Review, the old `handoff_count` carried over — exhausting the 3-loop limit on normal agent → human → agent round-trips instead of pure agent-only loops.

The reviewer workflow now resets `handoff_count` to `0` when it detects a prior `status=pass` in the existing summary comment, scoping the loop limit to consecutive agent-only cycles as intended.
