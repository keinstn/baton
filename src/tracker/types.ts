/** Normalized issue model (SPEC §4.1.1). */
export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
  /** True when the blocker no longer blocks (terminal state / closed). */
  terminal: boolean;
}

export interface Issue {
  /** GraphQL node ID of the Issue (`I_...`). */
  id: string;
  /** GraphQL node ID of the ProjectV2Item (`PVTI_...`). */
  itemId: string;
  /** `<repository_name>-<issue_number>` (example: `myrepo-123`). */
  identifier: string;
  number: number;
  /** `owner/name`. */
  repository: string;
  title: string;
  description: string | null;
  priority: number | null;
  /** Project Status field option name ("" when the field is unset). */
  state: string;
  /** True when the underlying GitHub Issue is CLOSED (always terminal, SPEC §5.3.1). */
  closed: boolean;
  url: string | null;
  /** Lowercased label names. */
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: string | null;
  updatedAt: string | null;
}

/** Tracker adapter contract (SPEC §11.1). */
export interface TrackerClient {
  fetchCandidateIssues(): Promise<Issue[]>;
  fetchIssuesByStates(stateNames: string[]): Promise<Issue[]>;
  fetchIssueStatesByIds(issueIds: string[]): Promise<Issue[]>;
}
