import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { BatonError } from "../errors.js";

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
  path: string;
  dir: string;
}

/**
 * Parse WORKFLOW.md text into front matter config + prompt body (SPEC §5.2).
 *
 * - File starting with `---` → lines until the next `---` are YAML front matter.
 * - Front matter must decode to a map; non-map YAML is an error.
 * - No front matter → whole file is prompt body, empty config.
 * - Prompt body is trimmed.
 */
export function parseWorkflow(text: string): {
  config: Record<string, unknown>;
  promptTemplate: string;
} {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") {
    return { config: {}, promptTemplate: text.trim() };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new BatonError(
      "workflow_parse_error",
      "unterminated YAML front matter",
    );
  }
  const frontMatter = lines.slice(1, end).join("\n");
  let parsed: unknown;
  try {
    parsed = parseYaml(frontMatter);
  } catch (err) {
    throw new BatonError(
      "workflow_parse_error",
      `invalid YAML front matter: ${String(err)}`,
    );
  }
  if (parsed === null || parsed === undefined) {
    parsed = {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BatonError(
      "workflow_front_matter_not_a_map",
      "YAML front matter must decode to a map",
    );
  }
  return {
    config: parsed as Record<string, unknown>,
    promptTemplate: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

/** Load and parse a WORKFLOW.md file (SPEC §5.1). */
export async function loadWorkflow(path: string): Promise<WorkflowDefinition> {
  const absPath = resolve(path);
  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch {
    throw new BatonError(
      "missing_workflow_file",
      `cannot read workflow file: ${absPath}`,
    );
  }
  const { config, promptTemplate } = parseWorkflow(text);
  return { config, promptTemplate, path: absPath, dir: dirname(absPath) };
}
