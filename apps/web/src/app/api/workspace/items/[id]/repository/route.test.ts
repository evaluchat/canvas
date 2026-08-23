import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  enabled: vi.fn(),
  verifyUserAuthenticated: vi.fn(),
  getWorkspaceItem: vi.fn(),
  getResearchRepositoryStatus: vi.fn(),
}));

vi.mock("@/lib/research-workspaces-enabled.server", () => ({
  isGithubResearchWorkspacesEnabled: harness.enabled,
}));
vi.mock("@/lib/supabase/verify_user_server", () => ({
  verifyUserAuthenticated: harness.verifyUserAuthenticated,
}));
vi.mock("@/lib/workspace/store", () => ({
  getWorkspaceItem: harness.getWorkspaceItem,
  getResearchRepositoryStatus: harness.getResearchRepositoryStatus,
}));

import { GET } from "./route";

const context = (id = "wi_repository") => ({
  params: Promise.resolve({ id }),
});

describe("GET /api/workspace/items/[id]/repository", () => {
  beforeEach(() => {
    for (const method of Object.values(harness)) method.mockReset();
    harness.enabled.mockReturnValue(true);
    harness.verifyUserAuthenticated.mockResolvedValue({
      user: { id: "user-1" },
    });
  });

  it("returns 404 while the feature flag is off", async () => {
    harness.enabled.mockReturnValue(false);

    expect((await GET(new Request("http://localhost"), context())).status).toBe(
      404
    );
    expect(harness.verifyUserAuthenticated).not.toHaveBeenCalled();
  });

  it("returns 401 without an authenticated user", async () => {
    harness.verifyUserAuthenticated.mockResolvedValue(undefined);

    expect((await GET(new Request("http://localhost"), context())).status).toBe(
      401
    );
  });

  it("returns 404 for a missing or different item kind", async () => {
    harness.getWorkspaceItem.mockResolvedValue({
      id: "wi_repository",
      kind: "markdown_template",
    });

    expect((await GET(new Request("http://localhost"), context())).status).toBe(
      404
    );
  });

  it("returns the current repository status", async () => {
    const item = { id: "wi_repository", kind: "research_repository" };
    const status = {
      workspaceId: "wi_repository",
      repositoryId: 101,
      state: "ready",
    };
    harness.getWorkspaceItem.mockResolvedValue(item);
    harness.getResearchRepositoryStatus.mockResolvedValue(status);

    const response = await GET(new Request("http://localhost"), context());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status });
    expect(harness.getResearchRepositoryStatus).toHaveBeenCalledWith(
      "user-1",
      item
    );
  });

  it("surfaces a deleted repository as REPOSITORY_UNAVAILABLE", async () => {
    const item = { id: "wi_repository", kind: "research_repository" };
    const status = {
      workspaceId: "wi_repository",
      repositoryId: 101,
      state: "blocked",
      reason: "repository_deleted",
    };
    harness.getWorkspaceItem.mockResolvedValue(item);
    harness.getResearchRepositoryStatus.mockResolvedValue(status);

    const response = await GET(new Request("http://localhost"), context());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "REPOSITORY_UNAVAILABLE",
      status,
    });
  });
});
