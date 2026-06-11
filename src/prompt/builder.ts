import { Liquid } from "liquidjs";
import { BatonError } from "../errors.js";
import type { Issue } from "../tracker/types.js";

// SPEC §5.4 / §12: strict template engine — unknown variables and unknown
// filters MUST fail rendering.
const engine = new Liquid({ strictVariables: true, strictFilters: true });

/** Template view of the issue, keyed by the SPEC §4.1.1 field names. */
export function issueView(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    item_id: issue.itemId,
    identifier: issue.identifier,
    number: issue.number,
    repository: issue.repository,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    closed: issue.closed,
    url: issue.url,
    labels: issue.labels,
    blocked_by: issue.blockedBy.map((b) => ({
      id: b.id,
      identifier: b.identifier,
      state: b.state,
      terminal: b.terminal,
    })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

/** Render the per-issue prompt (SPEC §12). Failures fail only the run attempt. */
export async function renderPrompt(
  template: string,
  issue: Issue,
  attempt: number | null,
): Promise<string> {
  let parsed: ReturnType<typeof engine.parse>;
  try {
    parsed = engine.parse(template);
  } catch (err) {
    throw new BatonError("template_parse_error", String(err));
  }
  try {
    const rendered: string = await engine.render(parsed, {
      issue: issueView(issue),
      attempt,
    });
    return rendered.trim();
  } catch (err) {
    throw new BatonError("template_render_error", String(err));
  }
}
