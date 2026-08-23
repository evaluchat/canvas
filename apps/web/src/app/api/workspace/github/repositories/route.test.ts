import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  enabled: vi.fn(),
  verifyUserAuthenticated: vi.fn(),
  readGithubResearchCredentials: vi.fn(),
  buildGithubResearchTemplateUrl: vi.fn(),
}));

vi.mock("@/lib/research-workspaces-enabled.server", () => ({
  isGithubResearchWorkspacesEnabled: harness.enabled,
}));
vi.mock("@/lib/supabase/verify_user_server", () => ({
  verifyUserAuthenticated: harness.verifyUserAuthenticated,
}));
vi.mock("@/lib/workspace/research-repository/credentials", () => ({
  readGithubResearchCredentials: harness.readGithubResearchCredentials,
}));
vi.mock("@/lib/workspace/research-repository/template", () => ({
  buildGithubResearchTemplateUrl: harness.buildGithubResearchTemplateUrl,
}));

import { GET } from "./route";

describe("GET /api/workspace/github/repositories", () => {
  beforeEach(() => {
    for (const method of Object.values(harness)) method.mockReset();
    harness.enabled.mockReturnValue(true);
    harness.verifyUserAuthenticated.mockResolvedValue({
      user: { id: "user-1" },
    });
    harness.buildGithubResearchTemplateUrl.mockReturnValue(
      "https://github.com/new?template_owner=evaluchat"
    );
  });

  it("returns 404 while the feature flag is off", async () => {
    harness.enabled.mockReturnValue(false);

    expect((await GET()).status).toBe(404);
    expect(harness.verifyUserAuthenticated).not.toHaveBeenCalled();
  });

  it("returns a connect state when credentials are absent", async () => {
    harness.readGithubResearchCredentials.mockResolvedValue(null);

    expect(await (await GET()).json()).toEqual({
      connected: false,
      repositories: [],
    });
  });

  it("lists only repositories retained for the installation", async () => {
    harness.readGithubResearchCredentials.mockResolvedValue({
      installationId: 99,
      repositoryIds: [101],
      displayMetadata: {
        login: "octocat",
        repositories: [
          { id: 101, nameWithOwner: "octocat/private" },
          { id: 202, nameWithOwner: "octocat/removed" },
        ],
      },
    });

    expect(await (await GET()).json()).toEqual({
      connected: true,
      installationId: 99,
      login: "octocat",
      repositories: [{ id: 101, nameWithOwner: "octocat/private" }],
      createFromTemplateUrl: "https://github.com/new?template_owner=evaluchat",
    });
    expect(harness.buildGithubResearchTemplateUrl).toHaveBeenCalledWith(
      "octocat"
    );
  });
});
