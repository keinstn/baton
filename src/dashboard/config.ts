import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export interface DashboardTarget {
  name: string;
  url: string;
}

export interface DashboardConfig {
  server: {
    host: string;
    port: number;
  };
  targets: DashboardTarget[];
}

export async function loadDashboardConfig(
  path: string,
): Promise<DashboardConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err: unknown) {
    throw new Error(`cannot read config file ${path}: ${String(err)}`);
  }
  const doc = parse(raw) as unknown;
  return validateDashboardConfig(doc);
}

export function validateDashboardConfig(raw: unknown): DashboardConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("config must be an object");
  }
  const obj = raw as Record<string, unknown>;

  const server = obj.server;
  const host =
    typeof server === "object" && server !== null
      ? ((server as Record<string, unknown>).host ?? "127.0.0.1")
      : "127.0.0.1";
  const portRaw =
    typeof server === "object" && server !== null
      ? ((server as Record<string, unknown>).port ?? 8888)
      : 8888;

  if (typeof host !== "string") {
    throw new Error("config.server.host must be a string");
  }
  if (
    typeof portRaw !== "number" ||
    !Number.isInteger(portRaw) ||
    portRaw < 1 ||
    portRaw > 65535
  ) {
    throw new Error(
      "config.server.port must be an integer between 1 and 65535",
    );
  }

  const targets = obj.targets;
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error("config.targets must be a non-empty array");
  }

  const names = new Set<string>();
  const validatedTargets: DashboardTarget[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i] as unknown;
    if (typeof t !== "object" || t === null) {
      throw new Error(`config.targets[${i}] must be an object`);
    }
    const tObj = t as Record<string, unknown>;

    const name = tObj.name;
    if (typeof name !== "string" || name === "") {
      throw new Error(`config.targets[${i}].name must be a non-empty string`);
    }
    if (names.has(name)) {
      throw new Error(`config.targets[${i}].name is a duplicate: "${name}"`);
    }
    names.add(name);

    const url = tObj.url;
    if (typeof url !== "string") {
      throw new Error(`config.targets[${i}].url must be a string`);
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(
          `config.targets[${i}].url must use http or https: "${url}"`,
        );
      }
    } catch (err: unknown) {
      if (err instanceof TypeError) {
        throw new Error(
          `config.targets[${i}].url is not a valid URL: "${url}"`,
        );
      }
      throw err;
    }

    validatedTargets.push({ name, url });
  }

  return {
    server: { host, port: portRaw },
    targets: validatedTargets,
  };
}
