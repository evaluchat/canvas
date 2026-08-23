import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const harness = vi.hoisted(() => ({
  enabled: vi.fn(),
  verifyUserAuthenticated: vi.fn(),
  generateGithubOAuthState: vi.fn(),
  generatePkcePair: vi.fn(),
  buildGithubAuthorizationUrl: vi.fn(),
  storeGithubOAuthState: vi.fn(),
}));

vi.mock("@/lib/research-workspaces-enabled.server", () => ({
  isGithubResearchWorkspacesEnabled: harness.enabled,
}));
vi.mock("@/lib/supabase/verify_user_server", () => ({
  verifyUserAuthenticated: harness.verifyUserAuthenticated,
}));
vi.mock("@/lib/workspace/research-repository/github-app", () => ({
  generateGithubOAuthState: harness.generateGithubOAuthState,
  generatePkcePair: harness.generatePkcePair,
  buildGithubAuthorizationUrl: harness.buildGithubAuthorizationUrl,
}));
vi.mock("@/lib/workspace/research-repository/credentials", () => ({
  storeGithubOAuthState: harness.storeGithubOAuthState,
}));

import { GET } from "./route";

function request() {
  return new NextRequest("http://localhost/api/workspace/github/authorize");
}

describe("GET /api/workspace/github/authorize", () => {
  beforeEach(() => {
    for (const method of Object.values(harness)) method.mockReset();
    harness.enabled.mockReturnValue(true);
    harness.verifyUserAuthenticated.mockResolvedValue({
      user: { id: "user-1" },
    });
    harness.generateGithubOAuthState.mockReturnValue("state-1");
    harness.generatePkcePair.mockReturnValue({
      verifier: "verifier-1",
      challenge: "challenge-1",
    });
    harness.buildGithubAuthorizationUrl.mockReturnValue(
      "https://github.com/login/oauth/authorize?state=state-1"
    );
  });

  it("returns 404 while the feature flag is off", async () => {
    harness.enabled.mockReturnValue(false);
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(harness.verifyUserAuthenticated).not.toHaveBeenCalled();
  });

  it("returns 401 without a user", async () => {
    harness.verifyUserAuthenticated.mockResolvedValue(undefined);
    expect((await GET(request())).status).toBe(401);
  });

  it("stores one-time state and redirects to GitHub", async () => {
    const response = await GET(request());
    expect(harness.storeGithubOAuthState).toHaveBeenCalledWith(
      "user-1",
      "state-1",
      "verifier-1"
    );
    expect(harness.buildGithubAuthorizationUrl).toHaveBeenCalledWith({
      state: "state-1",
      challenge: "challenge-1",
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("github.com");
  });
});
