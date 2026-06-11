import type { TrackerConfig } from "../config/schema.js";
import { BatonError } from "../errors.js";
import type { Logger } from "../observability/logger.js";
import { isRecord, norm } from "../util.js";
import { ITEMS_QUERY, NODES_QUERY, projectQuery } from "./queries.js";
import type { Issue, TrackerClient } from "./types.js";

const NETWORK_TIMEOUT_MS = 30000;

export interface ProjectMeta {
  projectId: string;
  statusOptions: string[];
  priorityOptions: string[] | null;
}

type FetchFn = typeof fetch;

interface FieldValueNode {
  name?: string;
  field?: { name?: string };
}

interface ItemNode {
  id?: string;
  fieldValues?: { nodes?: (FieldValueNode | null)[] };
  content?: {
    __typename?: string;
    id?: string;
    number?: number;
    title?: string;
    body?: string | null;
    url?: string | null;
    state?: string;
    createdAt?: string | null;
    updatedAt?: string | null;
    labels?: { nodes?: ({ name?: string } | null)[] };
    repository?: { name?: string; nameWithOwner?: string };
  };
}

function readFieldValue(
  fieldValues: { nodes?: (FieldValueNode | null)[] } | undefined,
  fieldName: string,
): string | null {
  for (const fv of fieldValues?.nodes ?? []) {
    if (
      fv?.field?.name &&
      fv.name !== undefined &&
      norm(fv.field.name) === norm(fieldName)
    ) {
      return fv.name;
    }
  }
  return null;
}

/** GitHub Projects v2 tracker adapter (SPEC §11). Read-only by design (§11.5). */
export class GitHubProjectsClient implements TrackerClient {
  private meta: ProjectMeta | null = null;

  constructor(
    private cfg: TrackerConfig,
    private readonly fetchFn: FetchFn = fetch,
    private readonly logger?: Logger,
  ) {}

  /** Drop the cached project/field resolution (SPEC §11.2: refresh on reload/validation failure). */
  invalidateProjectCache(): void {
    this.meta = null;
  }

  /** Adopt a reloaded tracker config and drop the project cache (SPEC §6.2, §11.2). */
  applyConfig(cfg: TrackerConfig): void {
    this.cfg = cfg;
    this.invalidateProjectCache();
  }

  private async gql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.cfg.token) {
      throw new BatonError(
        "missing_tracker_token",
        "tracker token is not configured",
      );
    }
    const varKeys = Object.keys(variables).join(",");
    const startMs = Date.now();
    this.logger?.debug("github api request", { variables: varKeys });
    let res: Response;
    try {
      res = await this.fetchFn(this.cfg.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.cfg.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      });
    } catch (err) {
      throw new BatonError("github_api_request", String(err), { cause: err });
    }
    this.logger?.debug("github api response", {
      status: res.status,
      duration_ms: Date.now() - startMs,
    });
    if (!res.ok) {
      throw new BatonError(
        "github_api_status",
        `GitHub GraphQL HTTP ${res.status}`,
      );
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new BatonError(
        "github_unknown_payload",
        `invalid JSON response: ${String(err)}`,
        { cause: err },
      );
    }
    if (!isRecord(body)) {
      throw new BatonError(
        "github_unknown_payload",
        "GraphQL response is not an object",
      );
    }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw new BatonError(
        "github_graphql_errors",
        JSON.stringify(body.errors).slice(0, 1000),
      );
    }
    if (!isRecord(body.data)) {
      throw new BatonError(
        "github_unknown_payload",
        "GraphQL response has no data",
      );
    }
    return body.data;
  }

  /** Resolve and cache the project node ID and single-select field options (SPEC §11.2). */
  async resolveProject(): Promise<ProjectMeta> {
    if (this.meta) return this.meta;
    if (!this.cfg.owner || this.cfg.projectNumber === null) {
      throw new BatonError(
        "missing_tracker_project",
        "tracker.owner and tracker.project_number are required",
      );
    }
    const ownerField = this.cfg.ownerType;
    const data = await this.gql(projectQuery(ownerField), {
      owner: this.cfg.owner,
      number: this.cfg.projectNumber,
    });
    const ownerNode = data[ownerField] as
      | { projectV2?: { id?: string; fields?: { nodes?: unknown[] } } }
      | null
      | undefined;
    const project = ownerNode?.projectV2;
    if (!project?.id) {
      throw new BatonError(
        "missing_tracker_project",
        `project ${this.cfg.owner}/#${this.cfg.projectNumber} not found (check token scopes)`,
      );
    }
    const fields = (project.fields?.nodes ?? []) as {
      name?: string;
      options?: { name?: string }[];
    }[];
    const findField = (name: string) =>
      fields.find((f) => f?.name !== undefined && norm(f.name) === norm(name));
    const statusField = findField(this.cfg.statusField);
    if (!statusField?.options?.length) {
      throw new BatonError(
        "missing_status_field",
        `single-select field "${this.cfg.statusField}" not found on project`,
      );
    }
    const priorityField = this.cfg.priorityField
      ? findField(this.cfg.priorityField)
      : undefined;
    this.meta = {
      projectId: project.id,
      statusOptions: statusField.options.map((o) => o.name ?? ""),
      priorityOptions: priorityField?.options?.map((o) => o.name ?? "") ?? null,
    };
    this.logger?.debug("project resolved", {
      project_id: this.meta.projectId,
      status_options: this.meta.statusOptions,
    });
    return this.meta;
  }

  private normalizeContent(
    content: NonNullable<ItemNode["content"]>,
    itemId: string,
    state: string,
    meta: ProjectMeta,
    priorityName: string | null,
  ): Issue | null {
    if (content.__typename !== "Issue") return null; // drafts/PRs are never eligible (§8.2)
    const repoName = content.repository?.name;
    const nameWithOwner = content.repository?.nameWithOwner;
    if (
      !content.id ||
      content.number === undefined ||
      !repoName ||
      !nameWithOwner
    ) {
      return null;
    }
    let priority: number | null = null;
    if (priorityName && meta.priorityOptions) {
      const idx = meta.priorityOptions.findIndex(
        (o) => norm(o) === norm(priorityName),
      );
      priority = idx >= 0 ? idx + 1 : null;
    }
    return {
      id: content.id,
      itemId,
      identifier: `${repoName}-${content.number}`,
      number: content.number,
      repository: nameWithOwner,
      title: content.title ?? "",
      description: content.body ?? null,
      priority,
      state,
      closed: content.state === "CLOSED",
      url: content.url ?? null,
      labels: (content.labels?.nodes ?? [])
        .map((l) => (l?.name ?? "").trim().toLowerCase())
        .filter((l) => l !== ""),
      // Phase 1: issue-dependency integration lands later; SPEC §4.1.1 mandates
      // degrading to [] when the data is unavailable.
      blockedBy: [],
      createdAt: content.createdAt ?? null,
      updatedAt: content.updatedAt ?? null,
    };
  }

  private normalizeItem(node: ItemNode, meta: ProjectMeta): Issue | null {
    if (!node.content || !node.id) return null;
    const state = readFieldValue(node.fieldValues, this.cfg.statusField) ?? "";
    const priorityName = this.cfg.priorityField
      ? readFieldValue(node.fieldValues, this.cfg.priorityField)
      : null;
    return this.normalizeContent(
      node.content,
      node.id,
      state,
      meta,
      priorityName,
    );
  }

  /** Fetch all project issues whose Status is in `states` (SPEC §11.1 op 2). */
  async fetchIssuesByStates(stateNames: string[]): Promise<Issue[]> {
    if (stateNames.length === 0) return [];
    const meta = await this.resolveProject();
    const wanted = new Set(stateNames.map(norm));
    const out: Issue[] = [];
    let after: string | null = null;
    for (;;) {
      const data = await this.gql(ITEMS_QUERY, {
        projectId: meta.projectId,
        after,
      });
      const items = (data.node as { items?: unknown } | null)?.items as
        | {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: (ItemNode | null)[];
          }
        | undefined;
      if (!items) {
        throw new BatonError(
          "github_unknown_payload",
          "items connection missing",
        );
      }
      for (const node of items.nodes ?? []) {
        if (!node) continue;
        const issue = this.normalizeItem(node, meta);
        if (!issue) continue;
        if (!wanted.has(norm(issue.state))) continue;
        if (this.cfg.repos && !this.cfg.repos.includes(issue.repository))
          continue;
        out.push(issue);
      }
      if (!items.pageInfo?.hasNextPage) break;
      if (!items.pageInfo.endCursor) {
        throw new BatonError(
          "github_missing_end_cursor",
          "hasNextPage without endCursor",
        );
      }
      after = items.pageInfo.endCursor;
    }
    return out;
  }

  /** Candidate issues for dispatch = active states (SPEC §11.1 op 1). */
  fetchCandidateIssues(): Promise<Issue[]> {
    return this.fetchIssuesByStates(this.cfg.activeStates);
  }

  /** Minimal state refresh for reconciliation (SPEC §11.1 op 3). */
  async fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]> {
    if (issueIds.length === 0) return [];
    const meta = await this.resolveProject();
    const data = await this.gql(NODES_QUERY, { ids: issueIds });
    const nodes = (data.nodes ?? []) as (
      | (NonNullable<ItemNode["content"]> & {
          projectItems?: {
            nodes?: ({
              id?: string;
              project?: { id?: string };
              fieldValues?: { nodes?: (FieldValueNode | null)[] };
            } | null)[];
          };
        })
      | null
    )[];
    const out: Issue[] = [];
    for (const node of nodes) {
      if (node?.__typename !== "Issue") continue;
      const item = (node.projectItems?.nodes ?? []).find(
        (it) => it?.project?.id === meta.projectId,
      );
      const state = item
        ? (readFieldValue(item.fieldValues, this.cfg.statusField) ?? "")
        : "";
      const priorityName =
        item && this.cfg.priorityField
          ? readFieldValue(item.fieldValues, this.cfg.priorityField)
          : null;
      const issue = this.normalizeContent(
        node,
        item?.id ?? "",
        state,
        meta,
        priorityName,
      );
      if (issue) out.push(issue);
    }
    return out;
  }
}
