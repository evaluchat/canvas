import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  enabled: vi.fn(),
  verifyUserAuthenticated: vi.fn(),
  getWorkspaceItem: vi.fn(),
  readCredentials: vi.fn(),
  updateHead: vi.fn(),
  getRepository: vi.fn(),
  listArtifacts: vi.fn(),
  claimOperation: vi.fn(),
  startOperation: vi.fn(),
  completeOperation: vi.fn(),
  failOperation: vi.fn(),
}));

vi.mock("@/lib/research-workspaces-enabled.server", () => ({
  isGithubResearchWorkspacesEnabled: harness.enabled,
}));
vi.mock("@/lib/supabase/verify_user_server", () => ({
  verifyUserAuthenticated: harness.verifyUserAuthenticated,
}));
vi.mock("@/lib/workspace/store", () => ({
  getWorkspaceItem: harness.getWorkspaceItem,
  updateResearchRepositoryBindingHead: harness.updateHead,
}));
vi.mock("@/lib/workspace/research-repository/credentials", () => ({
  readGithubResearchCredentials: harness.readCredentials,
}));
vi.mock("@/lib/workspace/research-repository/github-app", () => ({
  getGithubInstallationRepository: harness.getRepository,
}));
vi.mock("@/lib/workspace/research-repository/git-adapter", () => ({
  listRepositoryArtifactRefs: harness.listArtifacts,
}));
vi.mock("@/lib/workspace/research-repository/operations", () => ({
  claimRepositoryOperation: harness.claimOperation,
  startRepositoryOperation: harness.startOperation,
  completeRepositoryOperation: harness.completeOperation,
  failRepositoryOperation: harness.failOperation,
}));

import { POST } from "./route";
import { RepositoryLayoutError } from "@/lib/workspace/research-repository/layout";

const headCommitSha = "b".repeat(40);
const artifacts = [{ artifactId: "index", path: "index.md" }];
const context = { params: Promise.resolve({ id: "workspace-one" }) };
const item = {
  id: "workspace-one",
  kind: "research_repository",
  binding: {
    installationId: 99,
    repositoryId: 101,
    branch: "evaluchat/workspace",
    layoutVersion: "1.0",
  },
};
const operation = {
  operationId: "operation-reconcile",
  idempotencyKey: "reconcile-idempotency-key",
  status: "pending",
};
const runningOperation = { ...operation, status: "running" };

describe("POST repository reconcile", () => {
  beforeEach(() => {
    for (const method of Object.values(harness)) method.mockReset();
    harness.enabled.mockReturnValue(true);
    harness.verifyUserAuthenticated.mockResolvedValue({
      user: { id: "user-1" },
    });
    harness.getWorkspaceItem.mockResolvedValue(item);
    harness.readCredentials.mockResolvedValue({
      installationId: 99,
      repositoryIds: [101],
    });
    harness.getRepository.mockResolvedValue({
      owner: "octocat",
      name: "private",
      private: true,
    });
    harness.listArtifacts.mockResolvedValue({
      artifacts,
      commitSha: headCommitSha,
    });
    harness.claimOperation.mockResolvedValue(operation);
    harness.startOperation.mockResolvedValue(runningOperation);
    harness.updateHead.mockResolvedValue(undefined);
    harness.completeOperation.mockResolvedValue({
      ...operation,
      status: "succeeded",
      resultCommitSha: headCommitSha,
    });
  });

  it("returns 404 while the feature flag is off", async () => {
    harness.enabled.mockReturnValue(false);
    const response = await POST(new Request("http://localhost"), context);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(harness.verifyUserAuthenticated).not.toHaveBeenCalled();
  });

  it("reloads blobs, refreshes the binding head, and records reconcile", async () => {
    const response = await POST(new Request("http://localhost"), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(harness.listArtifacts).toHaveBeenCalledWith(
      99,
      { owner: "octocat", name: "private", private: true },
      "evaluchat/workspace",
      "1.0"
    );
    expect(harness.claimOperation).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({
        workspaceId: "workspace-one",
        kind: "reconcile",
        artifactIds: ["index"],
      })
    );
    expect(harness.updateHead).toHaveBeenCalledWith(
      "user-1",
      "workspace-one",
      headCommitSha
    );
    expect(harness.completeOperation).toHaveBeenCalledWith(
      "user-1",
      runningOperation,
      headCommitSha
    );
    expect(await response.json()).toMatchObject({
      status: {
        state: "ready",
        headCommitSha,
      },
      artifacts,
    });
  });

  it("surfaces a deleted repository as REPOSITORY_UNAVAILABLE", async () => {
    harness.getRepository.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const response = await POST(new Request("http://localhost"), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "REPOSITORY_UNAVAILABLE",
    });
    expect(harness.updateHead).not.toHaveBeenCalled();
  });

  it("returns a redacted 4xx layout error without logging its path", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(vi.fn());
    harness.listArtifacts.mockRejectedValue(
      new RepositoryLayoutError(
        "SYMLINK_ARTIFACT",
        "unsafe private/path/notes.lnk"
      )
    );

    try {
      const response = await POST(new Request("http://localhost"), context);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "SYMLINK_ARTIFACT" });
      expect(consoleError).toHaveBeenLastCalledWith(
        "[github-research] failed to reconcile repository",
        { workspaceId: "workspace-one", code: "SYMLINK_ARTIFACT" }
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
        "private/path"
      );
    } finally {
      consoleError.mockRestore();
    }
  });
});
