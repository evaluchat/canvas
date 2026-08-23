import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  class StaleRepositoryError extends Error {
    constructor(public readonly currentHeadCommitSha: string) {
      super("stale");
    }
  }
  class RepositoryOperationInProgressError extends Error {}
  return {
    StaleRepositoryError,
    RepositoryOperationInProgressError,
    enabled: vi.fn(),
    verifyUserAuthenticated: vi.fn(),
    getWorkspaceItem: vi.fn(),
    readCredentials: vi.fn(),
    updateHead: vi.fn(),
    getRepository: vi.fn(),
    getHead: vi.fn(),
    commitArtifacts: vi.fn(),
    claimOperation: vi.fn(),
    startOperation: vi.fn(),
    recordResult: vi.fn(),
    completeOperation: vi.fn(),
    failOperation: vi.fn(),
  };
});

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
  commitArtifactBlobs: harness.commitArtifacts,
  getRepositoryBranchHead: harness.getHead,
  StaleRepositoryError: harness.StaleRepositoryError,
}));
vi.mock("@/lib/workspace/research-repository/operations", () => ({
  claimRepositoryOperation: harness.claimOperation,
  startRepositoryOperation: harness.startOperation,
  recordRepositoryOperationResult: harness.recordResult,
  completeRepositoryOperation: harness.completeOperation,
  failRepositoryOperation: harness.failOperation,
  RepositoryOperationInProgressError:
    harness.RepositoryOperationInProgressError,
}));

import { POST } from "./route";
import { RepositoryLayoutError } from "@/lib/workspace/research-repository/layout";

const baseCommitSha = "a".repeat(40);
const resultCommitSha = "b".repeat(40);
const context = { params: Promise.resolve({ id: "workspace-one" }) };
const item = {
  id: "workspace-one",
  kind: "research_repository",
  binding: {
    installationId: 99,
    repositoryId: 101,
    branch: "evaluchat/workspace",
    layoutVersion: "1.0",
    headCommitSha: baseCommitSha,
  },
};
const pendingOperation = {
  operationId: "operation-one",
  workspaceId: "workspace-one",
  kind: "commit",
  idempotencyKey: "idempotency-key-0001",
  status: "pending",
  artifactIds: ["index"],
  baseCommitSha,
  createdAt: "2026-08-22T10:00:00.000Z",
  updatedAt: "2026-08-22T10:00:00.000Z",
};
const succeededOperation = {
  ...pendingOperation,
  status: "succeeded",
  resultCommitSha,
};
const runningOperation = { ...pendingOperation, status: "running" };
const landedOperation = { ...runningOperation, resultCommitSha };
const failedWithResultOperation = {
  ...landedOperation,
  status: "failed",
  errorCode: "COMMIT_LANDED_HEAD_UPDATE_FAILED",
};

const validMethodContent = `---
type: Method
id: synthetic-method
lang: en
origin: native
status: draft
version: 1.0.0
title: Synthetic method
description: A safe synthetic method.
---

# Synthetic method`;

function request(
  overrides: Partial<{
    artifactId: string;
    baseCommitSha: string;
    content: string;
    commitMessage: string;
    idempotencyKey: string;
  }> = {}
) {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      artifactId: "index",
      baseCommitSha,
      content: "unique file text that must not enter Store",
      commitMessage: "Update index",
      idempotencyKey: "idempotency-key-0001",
      ...overrides,
    }),
  });
}

describe("POST repository artifact commit", () => {
  beforeEach(() => {
    for (const value of Object.values(harness)) {
      if (typeof value === "function" && "mockReset" in value) {
        (value as ReturnType<typeof vi.fn>).mockReset();
      }
    }
    harness.enabled.mockReturnValue(true);
    harness.verifyUserAuthenticated.mockResolvedValue({
      user: {
        id: "user-1",
        email: "researcher@example.test",
        user_metadata: { full_name: "Researcher" },
      },
    });
    harness.getWorkspaceItem.mockResolvedValue(item);
    harness.readCredentials.mockResolvedValue({
      installationId: 99,
      repositoryIds: [101],
      displayMetadata: { githubUserId: 7, login: "researcher" },
    });
    harness.getRepository.mockResolvedValue({
      owner: "octocat",
      name: "private",
    });
    harness.claimOperation.mockResolvedValue(pendingOperation);
    harness.startOperation.mockResolvedValue(runningOperation);
    harness.recordResult.mockResolvedValue(landedOperation);
    harness.commitArtifacts.mockResolvedValue(resultCommitSha);
    harness.completeOperation.mockResolvedValue(succeededOperation);
    harness.updateHead.mockResolvedValue(undefined);
  });

  it("returns 404 while the feature flag is off", async () => {
    harness.enabled.mockReturnValue(false);
    const response = await POST(request(), context);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(harness.verifyUserAuthenticated).not.toHaveBeenCalled();
  });

  it("rejects commits to an unsupported repository layout", async () => {
    harness.getWorkspaceItem.mockResolvedValue({
      ...item,
      binding: { ...item.binding, layoutVersion: "1.1" },
    });

    const response = await POST(request(), context);

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "UNSUPPORTED_LAYOUT" });
    expect(harness.claimOperation).not.toHaveBeenCalled();
    expect(harness.commitArtifacts).not.toHaveBeenCalled();
  });

  it("commits an authorable artifact with valid front-matter", async () => {
    const response = await POST(
      request({
        artifactId: "method.synthetic-method",
        content: validMethodContent,
        commitMessage: "Update synthetic method",
      }),
      context
    );

    expect(response.status).toBe(200);
    expect(harness.commitArtifacts).toHaveBeenCalledWith(
      99,
      { owner: "octocat", name: "private" },
      "evaluchat/workspace",
      expect.objectContaining({
        files: [
          {
            path: "methods/synthetic-method/synthetic-method.en.md",
            content: validMethodContent,
          },
        ],
      })
    );
  });

  it("rejects invalid YAML before starting or committing an operation", async () => {
    const response = await POST(
      request({
        artifactId: "method.synthetic-method",
        content: validMethodContent.replace("status: draft", "status: ["),
      }),
      context
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "INVALID_FRONT_MATTER" });
    expect(harness.claimOperation).toHaveBeenCalledOnce();
    expect(harness.startOperation).not.toHaveBeenCalled();
    expect(harness.commitArtifacts).not.toHaveBeenCalled();
  });

  it("rejects a multi-document front-matter stream", async () => {
    const response = await POST(
      request({
        artifactId: "method.synthetic-method",
        content: `${validMethodContent.replace("\n\n# Synthetic method", "")}\n---\ntype: Method\n---`,
      }),
      context
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "INVALID_FRONT_MATTER" });
    expect(harness.commitArtifacts).not.toHaveBeenCalled();
  });

  it("does not validate arbitrary text in a non-front-matter artifact", async () => {
    const response = await POST(
      request({ content: "plain markdown with: [arbitrary text" }),
      context
    );

    expect(response.status).toBe(200);
    expect(harness.commitArtifacts).toHaveBeenCalledOnce();
  });

  it("replays a completed key without a second GitHub commit", async () => {
    harness.claimOperation
      .mockResolvedValueOnce(pendingOperation)
      .mockResolvedValueOnce(succeededOperation);

    const first = await POST(request(), context);
    const second = await POST(request(), context);

    expect(await first.json()).toEqual({
      operationId: "operation-one",
      commitSha: resultCommitSha,
    });
    expect(await second.json()).toEqual({
      operationId: "operation-one",
      commitSha: resultCommitSha,
    });
    expect(harness.commitArtifacts).toHaveBeenCalledTimes(1);
    expect(harness.commitArtifacts).toHaveBeenCalledWith(
      99,
      { owner: "octocat", name: "private" },
      "evaluchat/workspace",
      expect.objectContaining({
        authorUser: {
          name: "researcher",
          email: "7+researcher@users.noreply.github.com",
        },
        baseSha: baseCommitSha,
        files: [
          {
            path: "index.md",
            content: "unique file text that must not enter Store",
          },
        ],
      })
    );
    const storeFacingCalls = JSON.stringify({
      claim: harness.claimOperation.mock.calls,
      start: harness.startOperation.mock.calls,
      recordResult: harness.recordResult.mock.calls,
      complete: harness.completeOperation.mock.calls,
      fail: harness.failOperation.mock.calls,
      updateHead: harness.updateHead.mock.calls,
    });
    expect(storeFacingCalls).not.toContain("unique file text");
    expect(storeFacingCalls).not.toContain("Update index");
  });

  it("replays a successful authorable commit before validating new content", async () => {
    harness.claimOperation.mockResolvedValue(succeededOperation);

    const response = await POST(
      request({
        artifactId: "method.synthetic-method",
        content: "---\ntype: Method\nunsafe: [\n---",
      }),
      context
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      operationId: "operation-one",
      commitSha: resultCommitSha,
    });
    expect(harness.commitArtifacts).not.toHaveBeenCalled();
  });

  it("repairs a stale binding head when replaying a succeeded operation", async () => {
    harness.claimOperation.mockResolvedValue(succeededOperation);

    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      operationId: "operation-one",
      commitSha: resultCommitSha,
    });
    expect(harness.updateHead).toHaveBeenCalledWith(
      "user-1",
      "workspace-one",
      resultCommitSha
    );
    expect(harness.commitArtifacts).not.toHaveBeenCalled();
  });

  it("fails a landed commit when the head update fails and repairs it on replay", async () => {
    harness.claimOperation
      .mockResolvedValueOnce(pendingOperation)
      .mockResolvedValueOnce(failedWithResultOperation);
    harness.updateHead
      .mockRejectedValueOnce(new Error("Store unavailable"))
      .mockResolvedValueOnce(undefined);

    const first = await POST(request(), context);
    const replay = await POST(request(), context);

    expect(first.status).toBe(500);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      operationId: "operation-one",
      commitSha: resultCommitSha,
    });
    expect(harness.failOperation).toHaveBeenCalledWith(
      "user-1",
      landedOperation,
      "COMMIT_LANDED_HEAD_UPDATE_FAILED",
      resultCommitSha
    );
    expect(harness.updateHead).toHaveBeenCalledTimes(2);
    expect(harness.completeOperation).not.toHaveBeenCalled();
  });

  it("returns a stale conflict with the current remote head", async () => {
    const currentHeadCommitSha = "c".repeat(40);
    harness.commitArtifacts.mockRejectedValue(
      new harness.StaleRepositoryError(currentHeadCommitSha)
    );

    const response = await POST(request(), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "stale_repository",
      currentHeadCommitSha,
    });
    expect(harness.failOperation).toHaveBeenCalledWith(
      "user-1",
      runningOperation,
      "STALE_REPOSITORY"
    );
  });

  it("returns a redacted 4xx layout error without logging its path", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(vi.fn());
    harness.commitArtifacts.mockRejectedValue(
      new RepositoryLayoutError(
        "SYMLINK_ARTIFACT",
        "unsafe private/path/notes.lnk"
      )
    );

    try {
      const response = await POST(request(), context);
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({ error: "SYMLINK_ARTIFACT" });
      expect(consoleError).toHaveBeenLastCalledWith(
        "[github-research] failed to commit repository artifact",
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
