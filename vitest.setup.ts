import { ensureGitBashOnWindowsPath } from "./src/platform/git-bash.js";

// The agent and hook subprocesses spawn `bash -lc <command>` (SPEC §10.1/§9.4)
// and pass Git-Bash-style paths. On Windows, `bash` may resolve to
// WSL's System32\bash.exe, which cannot execute those paths — so subprocess
// tests fail with exit code 127. Prefer Git Bash on PATH when it exists; on
// machines where `bash` already is Git Bash this is a no-op.
ensureGitBashOnWindowsPath();
