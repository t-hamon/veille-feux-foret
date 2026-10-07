import { describe, expect, it, vi } from "vitest";

import { DISPATCH_URL, USER_AGENT, dispatchDeploy } from "./dispatch";
import worker from "./index";

const TOKEN = "github_pat_test_value";

function answer(status: number, body = ""): Response {
  return new Response(status === 204 ? null : body, { status });
}

describe("dispatchDeploy", () => {
  it("asks GitHub to start Deploy on main", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(answer(204)));
    await dispatchDeploy(TOKEN, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.github.com/repos/t-hamon/veille-feux-foret/actions/workflows/deploy.yml/dispatches",
    );
    expect(url).toBe(DISPATCH_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ ref: "main" });
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(headers.get("user-agent")).toBe(USER_AGENT);
  });

  it("fails without calling GitHub when the secret is missing", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(answer(204)));
    await expect(dispatchDeploy(undefined, fetchFn)).rejects.toThrow("GITHUB_TOKEN secret missing");
    await expect(dispatchDeploy("", fetchFn)).rejects.toThrow("GITHUB_TOKEN secret missing");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports a refusal with GitHub's explanation, never the token", async () => {
    const body = JSON.stringify({
      message: "Bad credentials",
      documentation_url: "https://docs.github.com/rest",
      status: "401",
    });
    const fetchFn = vi.fn(() => Promise.resolve(answer(401, body)));
    const error = await dispatchDeploy(TOKEN, fetchFn).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("GitHub answered HTTP 401");
    expect(message).toContain("Bad credentials");
    expect(message).not.toContain(TOKEN);
  });

  it("keeps a long refusal to one short line", async () => {
    const body = `{"message":\n"Not Found"}${" x".repeat(500)}`;
    const fetchFn = vi.fn(() => Promise.resolve(answer(404, body)));
    const message = ((await dispatchDeploy(TOKEN, fetchFn).catch((e: unknown) => e)) as Error)
      .message;
    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThanOrEqual("GitHub answered HTTP 404: ".length + 200);
  });

  it("treats any other success code as a failure", async () => {
    const fetchFn = vi.fn(() => Promise.resolve(answer(200, "{}")));
    await expect(dispatchDeploy(TOKEN, fetchFn)).rejects.toThrow("GitHub answered HTTP 200");
  });
});

describe("scheduled handler", () => {
  it("is the only export of the main module, as the Workers runtime requires", async () => {
    expect(Object.keys(await import("./index"))).toEqual(["default"]);
  });

  it("uses the GITHUB_TOKEN secret and the global fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(answer(204));
    try {
      await worker.scheduled({ cron: "7,37 * * * *", scheduledTime: 0 }, { GITHUB_TOKEN: TOKEN });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const init = fetchSpy.mock.calls[0]?.[1];
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("fails the invocation when GitHub refuses", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(answer(403, "{}"));
    try {
      await expect(
        worker.scheduled({ cron: "7,37 * * * *", scheduledTime: 0 }, { GITHUB_TOKEN: TOKEN }),
      ).rejects.toThrow("HTTP 403");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
