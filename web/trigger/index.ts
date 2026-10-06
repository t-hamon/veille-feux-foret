// Worker run by a Cloudflare Cron Trigger every 30 minutes (7 and 37 minutes
// past each hour, UTC): it asks GitHub to
// start the Deploy workflow on main (workflow_dispatch event).
//
// GitHub delays or drops many scheduled runs (the schedule event): between
// 5 October 2026 at 15:00 UTC and 6 October at 08:00 UTC, two of the 34
// scheduled runs of deploy.yml started. A run asked for through the API is not
// subject to that schedule. The schedule of deploy.yml stays as a fallback.
//
// The Worker has no public address and no fetch handler. Its only secret,
// GITHUB_TOKEN, is a fine-grained token limited to this repository with the
// Actions permission (write), set in the Cloudflare dashboard as a Secret.

import { dispatchDeploy } from "./dispatch";

interface Env {
  GITHUB_TOKEN?: string;
}

// The parts of the Workers runtime types this Worker uses.
interface ScheduledController {
  readonly cron: string;
  readonly scheduledTime: number;
}

export default {
  // A thrown error marks the invocation as failed; Workers Logs keep its
  // message (Workers & Pages > veille-feux-foret-trigger > Logs).
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await dispatchDeploy(env.GITHUB_TOKEN, (input, init) => fetch(input, init));
  },
};
