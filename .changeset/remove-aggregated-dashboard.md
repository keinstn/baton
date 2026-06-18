---
"baton": minor
---

Remove the aggregated dashboard (`baton-dashboard`) feature. A single baton instance can handle multiple repositories from one board (omit `tracker.repos` to target all repos; workspaces are namespaced as `<repo>-<issue#>`), so the separate aggregation process is no longer needed. This removes the `baton-dashboard` bin, `src/dashboard/`, the example config, and SPEC Appendix C. The per-instance HTTP server (§13.7 `/api/v1/state`, `/api/v1/refresh`) is unaffected.
