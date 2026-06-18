---
"baton": patch
---

Fix workspace directory identifier collisions when two repositories share the
same name under different owners. Workspace keys are now built from
`nameWithOwner` (`owner__repo-N`) instead of the bare repo name (`repo-N`),
making them globally unique across organisations.
