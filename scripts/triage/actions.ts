const GITHUB_API = "https://api.github.com";

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
}

async function checkResponse(res: Response, context: string): Promise<void> {
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} ${context}`);
  }
}

export async function addLabel(
  repo: string,
  issueNumber: number,
  label: string,
  token: string,
): Promise<void> {
  const [owner, name] = repo.split("/");
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${name}/issues/${issueNumber}/labels`,
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ labels: [label] }),
    },
  );
  await checkResponse(res, `adding label "${label}" to ${repo}#${issueNumber}`);
}

export async function postComment(
  repo: string,
  issueNumber: number,
  body: string,
  token: string,
): Promise<void> {
  const [owner, name] = repo.split("/");
  const res = await fetch(
    `${GITHUB_API}/repos/${owner}/${name}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: headers(token),
      body: JSON.stringify({ body }),
    },
  );
  await checkResponse(res, `posting comment on ${repo}#${issueNumber}`);
}
