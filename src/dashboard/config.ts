import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { BatonError } from "../errors.js";

export interface DashboardTarget {
  name: string;
  url: string;
}

export interface DashboardServerConfig {
  host: string;
  port: number;
}

export interface DashboardConfig {
  server: DashboardServerConfig;
  pollIntervalMs: number;
  targets: DashboardTarget[];
}

/** Runtime state for a single scraped target instance. */
export interface BoardState {
  name: string;
  url: string;
  up: boolean;
  lastScrapedAt: Date | null;
  error?: string;
  snapshot?: unknown;
}

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function isValidUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function parsePort(v: unknown, name: string): number {
  if (v === undefined || v === null) return 8080;
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535) {
    return v;
  }
  throw new BatonError(
    "config_invalid",
    `${name} must be an integer in [1, 65535], got ${String(v)}`,
  );
}

function parsePollIntervalMs(v: unknown): number {
  if (v === undefined || v === null) return 5000;
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  throw new BatonError(
    "config_invalid",
    `poll_interval_ms must be a positive integer, got ${String(v)}`,
  );
}

export function buildDashboardConfig(raw: unknown): DashboardConfig {
  if (!isMap(raw)) {
    throw new BatonError(
      "config_invalid",
      "dashboard config must be a YAML mapping",
    );
  }

  const s = isMap(raw.server) ? raw.server : {};
  const server: DashboardServerConfig = {
    host: str(s.host) ?? "127.0.0.1",
    port: parsePort(s.port, "server.port"),
  };

  const pollIntervalMs = parsePollIntervalMs(raw.poll_interval_ms);

  const rawTargets = raw.targets;
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw new BatonError("config_invalid", "targets must be a non-empty array");
  }

  const targets: DashboardTarget[] = rawTargets.map((t, i) => {
    if (!isMap(t)) {
      throw new BatonError("config_invalid", `targets[${i}] must be a mapping`);
    }
    const name = str(t.name);
    if (!name) {
      throw new BatonError(
        "config_invalid",
        `targets[${i}].name must be a non-empty string`,
      );
    }
    const url = str(t.url);
    if (!url || !isValidUrl(url)) {
      throw new BatonError(
        "config_invalid",
        `targets[${i}].url must be a valid http/https URL, got ${String(t.url)}`,
      );
    }
    return { name, url };
  });

  const seen = new Set<string>();
  for (const t of targets) {
    if (seen.has(t.name)) {
      throw new BatonError(
        "config_invalid",
        `targets contains duplicate name: "${t.name}"`,
      );
    }
    seen.add(t.name);
  }

  return { server, pollIntervalMs, targets };
}

/** Appends an API suffix to a board base URL, preserving path, query, and hash. */
export function buildBoardApiUrl(base: string, suffix: string): string {
  const u = new URL(base);
  u.pathname = `${u.pathname.replace(/\/$/, "")}${suffix}`;
  u.hash = "";
  return u.toString();
}

export async function loadDashboardConfig(
  filePath: string,
): Promise<DashboardConfig> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (err) {
    throw new BatonError(
      "config_invalid",
      `cannot read dashboard config file: ${filePath}`,
      { cause: err },
    );
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new BatonError(
      "config_invalid",
      `failed to parse dashboard config YAML: ${String(err)}`,
      { cause: err },
    );
  }

  return buildDashboardConfig(raw);
}
