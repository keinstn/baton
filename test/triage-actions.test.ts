import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addLabel, postComment } from "../scripts/triage/actions.js";

function okResponse(status = 200): Response {
  return {
    ok: true,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

function errorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("addLabel", () => {
  it("posts to the correct URL with the label in the body", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(okResponse(200));

    await addLabel("owner/repo", 42, "ai-ready", "tok");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls.at(0) ?? [];
    expect(url).toBe(
      "https://api.github.com/repos/owner/repo/issues/42/labels",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer tok",
      Accept: "application/vnd.github+json",
    });
    expect(JSON.parse(init?.body as string)).toEqual({ labels: ["ai-ready"] });
  });

  it("throws on non-2xx response with the status code", async () => {
    vi.mocked(fetch).mockResolvedValue(errorResponse(422));

    await expect(addLabel("owner/repo", 1, "ai-ready", "tok")).rejects.toThrow(
      "422",
    );
  });
});

describe("postComment", () => {
  it("posts to the correct URL with the comment body", async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValue(okResponse(201));

    await postComment("owner/repo", 7, "hello world", "tok");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls.at(0) ?? [];
    expect(url).toBe(
      "https://api.github.com/repos/owner/repo/issues/7/comments",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer tok",
      Accept: "application/vnd.github+json",
    });
    expect(JSON.parse(init?.body as string)).toEqual({ body: "hello world" });
  });

  it("throws on non-2xx response with the status code", async () => {
    vi.mocked(fetch).mockResolvedValue(errorResponse(403));

    await expect(postComment("owner/repo", 1, "msg", "tok")).rejects.toThrow(
      "403",
    );
  });
});
