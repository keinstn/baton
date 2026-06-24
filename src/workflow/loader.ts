import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BatonError } from "../errors.js";
import { parseFrontMatter } from "../util.js";

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
  let raw: Record<string, unknown>;
  let promptTemplate: string;
  try {
    ({ raw, body: promptTemplate } = parseFrontMatter(text));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith("YAML front matter must decode to a map")) {
      throw new BatonError("workflow_front_matter_not_a_map", msg);
    }
    throw new BatonError("workflow_parse_error", msg);
  }
  return { config: raw, promptTemplate };
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
