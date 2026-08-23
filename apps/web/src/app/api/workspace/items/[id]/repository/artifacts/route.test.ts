import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  enabled: vi.fn(),
  verifyUserAuthenticated: vi.fn(),
  getWorkspaceItem: vi.fn(),
  readCredentials: vi.fn(),
  getRepository: vi.fn(),
  listArtifacts: vi.fn(),
  readArtifact: vi.fn(),
}));

vi.mock("@/lib/research-workspaces-enabled.server", () => ({
  isGithubResearchWorkspacesEnabled: harness.enabled,
}));
vi.mock("@/lib/supabase/verify_user_server", () => ({
  verifyUserAuthenticated: harness.verifyUserAuthenticated,
}));
vi.mock("@/lib/workspace/store", () => ({
  getWorkspaceItem: harness.getWorkspaceItem,
}));
vi.mock("@/lib/workspace/research-repository/credentials", () => ({
  readGithubResearchCredentials: harness.readCredentials,
}));
vi.mock("@/lib/workspace/research-repository/github-app", () => ({
  getGithubInstallationRepository: harness.getRepository,
}));
vi.mock("@/lib/workspace/research-repository/git-adapter", () => ({
  listRepositoryArtifactRefs: harness.listArtifacts,
  readArtifactBlob: harness.readArtifact,
}));

import { GET } from "./route";
import { RepositoryLayoutError } from "@/lib/workspace/research-repository/layout";

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

describe("GET repository artifacts", () => {
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
    });
    harness.listArtifacts.mockResolvedValue({
      artifacts: [{ artifactId: "index", path: "index.md" }],
      commitSha: "a".repeat(40),
    });
    harness.readArtifact.mockResolvedValue({
      content: "# Research index\n",
      blobSha: "b".repeat(40),
      commitSha: "c".repeat(40),
    });
  });

  it("returns 404 before authentication while the flag is off", async () => {
    harness.enabled.mockReturnValue(false);
    const response = await GET(new Request("http://localhost"), context);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(harness.verifyUserAuthenticated).not.toHaveBeenCalled();
  });

  it("surfaces a deleted repository as REPOSITORY_UNAVAILABLE", async () => {
    harness.getRepository.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    const response = await GET(new Request("http://localhost"), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "REPOSITORY_UNAVAILABLE",
    });
  });

  it("lists managed refs with no-store caching", async () => {
    const response = await GET(new Request("http://localhost"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      artifacts: [{ artifactId: "index", path: "index.md" }],
      headCommitSha: "a".repeat(40),
    });
    expect(harness.listArtifacts).toHaveBeenCalledWith(
      99,
      { owner: "octocat", name: "private" },
      "evaluchat/workspace",
      "1.0"
    );
  });

  it("reads one managed artifact by server-resolved artifact id", async () => {
    const response = await GET(
      new Request("http://localhost?artifactId=index"),
      context
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      artifact: {
        artifactId: "index",
        kind: "index",
        path: "index.md",
        commitSha: "c".repeat(40),
        blobSha: "b".repeat(40),
        contentSha256:
          "b9ac715e5c8f6d0a73cc7cc154715ba72f214528586a6699cd6ebb762800208c",
        supported: true,
      },
      content: "# Research index\n",
    });
    expect(harness.readArtifact).toHaveBeenCalledWith(
      99,
      { owner: "octocat", name: "private" },
      "evaluchat/workspace",
      "index.md"
    );
    expect(harness.listArtifacts).not.toHaveBeenCalled();
  });

  it("marks an artifact from an unsupported layout as read-only", async () => {
    harness.getWorkspaceItem.mockResolvedValue({
      ...item,
      binding: { ...item.binding, layoutVersion: "1.1" },
    });

    const response = await GET(
      new Request("http://localhost?artifactId=index"),
      context
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      artifact: { artifactId: "index", supported: false },
      content: "# Research index\n",
    });
    expect(harness.readArtifact).toHaveBeenCalledWith(
      99,
      { owner: "octocat", name: "private" },
      "evaluchat/workspace",
      "index.md"
    );
  });

  it("returns 404 when a managed artifact is no longer present", async () => {
    harness.readArtifact.mockRejectedValue(
      Object.assign(new Error("Artifact not found"), { status: 404 })
    );

    const response = await GET(
      new Request("http://localhost?artifactId=index"),
      context
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Artifact not found" });
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
      const response = await GET(new Request("http://localhost"), context);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "SYMLINK_ARTIFACT" });
      expect(consoleError).toHaveBeenCalledWith(
        "[github-research] failed to list repository artifacts",
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
