/**
 * GraphQL documents for the GitHub Projects v2 tracker (SPEC §11.1). Kept apart
 * from the client so the adapter logic reads as data-flow, not query text.
 */

/** Project items fetched per page in {@link ITEMS_QUERY}. */
export const PAGE_SIZE = 50;

const FIELD_VALUES_FRAGMENT = `
  fieldValues(first: 30) {
    nodes {
      ... on ProjectV2ItemFieldSingleSelectValue {
        name
        field { ... on ProjectV2SingleSelectField { name } }
      }
    }
  }`;

const ISSUE_CONTENT_FRAGMENT = `
  __typename
  ... on Issue {
    id
    number
    title
    body
    url
    state
    createdAt
    updatedAt
    labels(first: 20) { nodes { name } }
    repository { name nameWithOwner }
  }`;

/** Op 2 (SPEC §11.1): page through all project items with their Status field. */
export const ITEMS_QUERY = `
query BatonItems($projectId: ID!, $after: String) {
  node(id: $projectId) {
    ... on ProjectV2 {
      items(first: ${PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          ${FIELD_VALUES_FRAGMENT}
          content { ${ISSUE_CONTENT_FRAGMENT} }
        }
      }
    }
  }
}`;

/** Op 3 (SPEC §11.1): refresh a batch of issues by node id for reconciliation. */
export const NODES_QUERY = `
query BatonIssueStates($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue {
      id
      number
      title
      body
      url
      state
      createdAt
      updatedAt
      labels(first: 20) { nodes { name } }
      repository { name nameWithOwner }
      projectItems(first: 10) {
        nodes {
          id
          project { id }
          ${FIELD_VALUES_FRAGMENT}
        }
      }
    }
  }
}`;

/** Op 1 setup (SPEC §11.2): resolve the project id and single-select options. */
export function projectQuery(ownerField: "organization" | "user"): string {
  return `
query BatonProject($owner: String!, $number: Int!) {
  ${ownerField}(login: $owner) {
    projectV2(number: $number) {
      id
      fields(first: 50) {
        nodes {
          ... on ProjectV2SingleSelectField { name options { name } }
        }
      }
    }
  }
}`;
}
