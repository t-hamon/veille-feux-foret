// Asks GitHub to start the Deploy workflow on main (workflow_dispatch event).
// Kept apart from index.ts: the main module of a Worker may only export its
// handlers.

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export const DISPATCH_URL =
  "https://api.github.com/repos/t-hamon/veille-feux-foret/actions/workflows/deploy.yml/dispatches";
export const USER_AGENT =
  "veille-feux-foret-trigger (+https://github.com/t-hamon/veille-feux-foret)";
const EXCERPT = 200;

export async function dispatchDeploy(token: string | undefined, fetchFn: Fetch): Promise<void> {
  if (!token) {
    throw new Error("GITHUB_TOKEN secret missing: Deploy not started");
  }
  const response = await fetchFn(DISPATCH_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  if (response.status !== 204) {
    // GitHub explains a refusal in its JSON body (expired token, missing
    // permission...); the token itself is never part of the message.
    const body = (await response.text()).replace(/\s+/g, " ").slice(0, EXCERPT);
    throw new Error(`GitHub answered HTTP ${String(response.status)}: ${body}`);
  }
}
