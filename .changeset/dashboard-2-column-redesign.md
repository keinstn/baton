---
"baton": minor
---

Redesign the daemon dashboard with a 2-column dark terminal layout

The HTTP dashboard now renders a two-column dark "terminal" layout that surfaces running agents and recent activity more legibly. This affects the server-rendered views in `src/dashboard/render.ts` and `src/observability/dashboard.ts`.
