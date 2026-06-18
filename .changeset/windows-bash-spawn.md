---
"baton": patch
---

Fix Windows bash spawn failures: prefer Git Bash over WSL's `System32\bash.exe`
on PATH so hook and agent subprocesses can find `git`/`gh`, and pass
`windowsHide: true` to all `spawn` calls so detached children don't pop up
console windows.
