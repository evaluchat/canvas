import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const harness = vi.hoisted(() => ({
  enabled: vi.fn(),
  verifyUserAuthenticated: vi.fn(),
  consumeGithubOAuthState: vi.fn(),
  exchangeGithubOAuthCode: vi.fn(),
  refreshGithubUserTokenIfNeeded: vi.fn(),
  resolveGithubResearchConnection: vi.fn(),
  storeGithubResearchCredentials: vi.fn(),
}));

vi.mock("@/lib/research-workspaces-enabled.server", () => ({
  isGithubResearchWorkspacesEnabled: harness.enabled,
}));
vi.mock("@/lib/supabase/verify_user_server", () => ({
  verifyUserAuthenticated: harness.verifyUserAuthenticated,
}));
vi.mock("@/lib/workspace/research-repository/github-app", () => ({
  exchangeGithubOAuthCode: harness.exchangeGithubOAuthCode,
  refreshGithubUserTokenIfNeeded: harness.refreshGithubUserTokenIfNeeded,
  resolveGithubResearchConnection: harness.resolveGithubResearchConnection,
}));
vi.mock("@/lib/workspace/research-repository/credentials", () => ({
  consumeGithubOAuthState: harness.consumeGithubOAuthState,
  storeGithubResearchCredentials: harness.storeGithubResearchCredentials,
}));

import { GET } from "./route";

function request(query = "code=code-1&state=state-1&installation_id=99") {
  return new NextRequest(
    `http://localhost/api/workspace/github/callback?${query}`
  );
}

describe("GET /api/workspace/github/callback", () => {
  beforeEach(() => {
    for (const method of Object.values(harness)) method.mockReset();
    harness.enabled.mockReturnValue(true);
    harness.verifyUserAuthenticated.mockResolvedValue({
      user: { id: "user-1" },
    });
    harness.consumeGithubOAuthState.mockResolvedValue("verifier-1");
    harness.exchangeGithubOAuthCode.mockResolvedValue({
      accessToken: "ghu_access",
      refreshToken: "ghr_refresh",
    });
    harness.refreshGithubUserTokenIfNeeded.mockResolvedValue({
      accessToken: "ghu_access",
      refreshToken: "ghr_refresh",
    });
    harness.resolveGithubResearchConnection.mockResolvedValue({
      installationId: 99,
      repositoryIds: [101],
      displayMetadata: { githubUserId: 7, login: "octo" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 404 while the feature flag is off", async () => {
    harness.enabled.mockReturnValue(false);
    expect((await GET(request())).status).toBe(404);
  });

  it("returns 401 without a user", async () => {
    harness.verifyUserAuthenticated.mockResolvedValue(undefined);
    expect((await GET(request())).status).toBe(401);
  });

  it("rejects invalid or already-used state", async () => {
    harness.consumeGithubOAuthState.mockResolvedValue(null);
    const response = await GET(request());
    expect(response.status).toBe(400);
    expect(harness.exchangeGithubOAuthCode).not.toHaveBeenCalled();
  });

  it("exchanges, refreshes if needed, stores, and redirects", async () => {
    const response = await GET(request());
    expect(harness.consumeGithubOAuthState).toHaveBeenCalledWith(
      "user-1",
      "state-1"
    );
    expect(harness.exchangeGithubOAuthCode).toHaveBeenCalledWith(
      "code-1",
      "verifier-1"
    );
    expect(harness.refreshGithubUserTokenIfNeeded).toHaveBeenCalledWith({
      accessToken: "ghu_access",
      refreshToken: "ghr_refresh",
    });
    expect(harness.resolveGithubResearchConnection).toHaveBeenCalledWith(
      "ghu_access",
      99
    );
    expect(harness.storeGithubResearchCredentials).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ installationId: 99 })
    );
    expect(
      harness.storeGithubResearchCredentials.mock.calls[0]?.[1]
    ).not.toHaveProperty("oauthCode");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/workspace/settings?github=connected"
    );
  });

  it("maps a GitHub API exchange error to the callback error redirect", async () => {
    harness.exchangeGithubOAuthCode.mockRejectedValue(
      Object.assign(new Error("Bad credentials"), { status: 401 })
    );

    const response = await GET(request());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/workspace/settings?github=error"
    );
    expect(harness.storeGithubResearchCredentials).not.toHaveBeenCalled();
  });

  it("logs only an error message when the OAuth callback fails", async () => {
    const error = Object.assign(new Error("exchange failed"), {
      request: { body: { client_secret: "must-not-leak" } },
    });
    harness.exchangeGithubOAuthCode.mockRejectedValue(error);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await GET(request());

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/workspace/settings?github=error"
    );
    expect(consoleError).toHaveBeenCalledWith(
      "[github-research] OAuth callback failed",
      "exchange failed"
    );
    expect(
      consoleError.mock.calls.flat().every((value) => typeof value === "string")
    ).toBe(true);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "must-not-leak"
    );
  });
});
