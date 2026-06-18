import { describe, expect, it } from "vitest";
import { ensureGitBashOnWindowsPath } from "../src/platform/git-bash.js";

const GIT_BASH_DIR = "C:\\Program Files\\Git\\bin";

/** fileExists stub: only the standard 64-bit Git Bash is installed. */
const gitBashInstalled = (path: string): boolean =>
  path === `${GIT_BASH_DIR}\\bash.exe`;

/** fileExists stub: no Git Bash anywhere. */
const noGitBash = (): boolean => false;

describe("ensureGitBashOnWindowsPath", () => {
  it("prepends Git Bash on Windows when it is not on PATH", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\System32;C:\\Windows",
    };
    ensureGitBashOnWindowsPath({
      env,
      platform: "win32",
      fileExists: gitBashInstalled,
    });
    expect(env.PATH).toBe(`${GIT_BASH_DIR};C:\\Windows\\System32;C:\\Windows`);
  });

  it("is a no-op when Git Bash is already first", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: `${GIT_BASH_DIR};C:\\Windows\\System32`,
    };
    ensureGitBashOnWindowsPath({
      env,
      platform: "win32",
      fileExists: gitBashInstalled,
    });
    expect(env.PATH).toBe(`${GIT_BASH_DIR};C:\\Windows\\System32`);
  });

  it("treats a case-different first entry as already present", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "c:\\program files\\git\\bin;C:\\Windows\\System32",
    };
    ensureGitBashOnWindowsPath({
      env,
      platform: "win32",
      fileExists: gitBashInstalled,
    });
    expect(env.PATH).toBe("c:\\program files\\git\\bin;C:\\Windows\\System32");
  });

  it("moves Git Bash to the head when it is present but not first", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: `C:\\Windows\\System32;${GIT_BASH_DIR};C:\\Windows`,
    };
    ensureGitBashOnWindowsPath({
      env,
      platform: "win32",
      fileExists: gitBashInstalled,
    });
    expect(env.PATH).toBe(`${GIT_BASH_DIR};C:\\Windows\\System32;C:\\Windows`);
  });

  it("is a no-op when the first entry is quoted with a trailing slash", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: `"${GIT_BASH_DIR}\\";C:\\Windows\\System32`,
    };
    ensureGitBashOnWindowsPath({
      env,
      platform: "win32",
      fileExists: gitBashInstalled,
    });
    expect(env.PATH).toBe(`"${GIT_BASH_DIR}\\";C:\\Windows\\System32`);
  });

  it("de-duplicates quoted Git Bash entries when prepending", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: `C:\\Windows\\System32;"${GIT_BASH_DIR}";C:\\Windows`,
    };
    ensureGitBashOnWindowsPath({
      env,
      platform: "win32",
      fileExists: gitBashInstalled,
    });
    expect(env.PATH).toBe(`${GIT_BASH_DIR};C:\\Windows\\System32;C:\\Windows`);
  });

  it("does nothing when Git Bash is not installed", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "C:\\Windows\\System32;C:\\Windows",
    };
    ensureGitBashOnWindowsPath({
      env,
      platform: "win32",
      fileExists: noGitBash,
    });
    expect(env.PATH).toBe("C:\\Windows\\System32;C:\\Windows");
  });

  it("does nothing on non-Windows platforms", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    ensureGitBashOnWindowsPath({
      env,
      platform: "linux",
      fileExists: gitBashInstalled,
    });
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  it("sets PATH to just Git Bash when PATH is empty", () => {
    const env: NodeJS.ProcessEnv = { PATH: "" };
    ensureGitBashOnWindowsPath({
      env,
      platform: "win32",
      fileExists: gitBashInstalled,
    });
    expect(env.PATH).toBe(GIT_BASH_DIR);
  });
});
