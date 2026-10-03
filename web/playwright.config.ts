import { defineConfig, devices } from "@playwright/test";

const PORT = "8787";

// The workspace used for development has a preinstalled Chromium that does not
// match the Playwright revision; PW_CHROMIUM_PATH points to it there. CI installs
// the matching browsers and leaves the variable unset.
const chromiumPath = process.env["PW_CHROMIUM_PATH"];
const chromiumLaunch = chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {};

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  // Locally, several Firefox and WebKit instances started in parallel crashed or
  // timed out on a Windows workstation, while the same tests passed one at a time.
  // One worker by default keeps local runs reliable; pass --workers to override.
  // CI keeps Playwright's default.
  ...(process.env["CI"] ? {} : { workers: 1 }),
  // In CI, the "github" reporter turns each failure into an annotation on the PR.
  reporter: process.env["CI"] ? [["list"], ["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    // Tests only ever target the local build of this project.
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // The build is served by wrangler, the local runtime of Cloudflare Workers, so
  // the tests see the same responses and headers (public/_headers) as production.
  webServer: {
    command: "npm run serve",
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env["CI"],
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"], ...chromiumLaunch } },
    { name: "chromium-mobile", use: { ...devices["Pixel 7"], ...chromiumLaunch } },
    { name: "firefox-desktop", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit-desktop", use: { ...devices["Desktop Safari"] } },
    { name: "webkit-mobile", use: { ...devices["iPhone 15"] } },
  ],
});
