import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const harness = vi.hoisted(() => ({
  enabled: vi.fn(),
  verifyUserAuthenticated: vi.fn(),
  deleteGithubResearchCredentials: vi.fn(),
}));

vi.mock("@/lib/research-workspaces-enabled.server", () => ({
  isGithubResearchWorkspacesEnabled: harness.enabled,
}));
vi.mock("@/lib/supabase/verify_user_server", () => ({
  verifyUserAuthenticated: harness.verifyUserAuthenticated,
}));
vi.mock("@/lib/workspace/research-repository/credentials", () => ({
  deleteGithubResearchCredentials: harness.deleteGithubResearchCredentials,
}));

import { POST } from "./route";

function request() {
  return new NextRequest("http://localhost/api/workspace/github/disconnect", {
    method: "POST",
  });
}

describe("POST /api/workspace/github/disconnect", () => {
  beforeEach(() => {
    for (const method of Object.values(harness)) method.mockReset();
    harness.enabled.mockReturnValue(true);
    harness.verifyUserAuthenticated.mockResolvedValue({
      user: { id: "user-1" },
    });
  });

  it("returns 404 while the feature flag is off", async () => {
    harness.enabled.mockReturnValue(false);
    expect((await POST(request())).status).toBe(404);
  });

  it("returns 401 without a user", async () => {
    harness.verifyUserAuthenticated.mockResolvedValue(undefined);
    expect((await POST(request())).status).toBe(401);
  });

  it("removes the Store credentials item", async () => {
    const response = await POST(request());
    expect(response.status).toBe(204);
    expect(harness.deleteGithubResearchCredentials).toHaveBeenCalledWith(
      "user-1"
    );
  });

  it("is safe to disconnect twice", async () => {
    const first = await POST(request());
    const second = await POST(request());
    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    expect(harness.deleteGithubResearchCredentials).toHaveBeenCalledTimes(2);
  });
});
