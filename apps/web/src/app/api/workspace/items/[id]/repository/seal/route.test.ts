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
    authenticate: vi.fn(),
    getItem: vi.fn(),
    updateHead: vi.fn(),
    credentials: vi.fn(),
    repository: vi.fn(),
    preview: vi.fn(),
    commit: vi.fn(),
    supersede: vi.fn(),
    claim: vi.fn(),
    start: vi.fn(),
    record: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
  };
});

vi.mock("@/lib/research-workspaces-enabled.server", () => ({
  isGithubResearchWorkspacesEnabled: harness.enabled,
}));
vi.mock("@/lib/supabase/verify_user_server", () => ({
  verifyUserAuthenticated: harness.authenticate,
}));
vi.mock("@/lib/workspace/store", () => ({
  getWorkspaceItem: harness.getItem,
  updateResearchRepositoryBindingHead: harness.updateHead,
}));
vi.mock("@/lib/workspace/research-repository/credentials", () => ({
  readGithubResearchCredentials: harness.credentials,
}));
vi.mock("@/lib/workspace/research-repository/github-app", () => ({
  getGithubInstallationRepository: harness.repository,
}));
vi.mock(
  "@/lib/workspace/research-repository/git-adapter",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/lib/workspace/research-repository/git-adapter")
    >()),
    StaleRepositoryError: harness.StaleRepositoryError,
  })
);
vi.mock("@/lib/workspace/research-repository/operations", () => ({
  claimRepositoryOperation: harness.claim,
  startRepositoryOperation: harness.start,
  recordRepositoryOperationResult: harness.record,
  completeRepositoryOperation: harness.complete,
  failRepositoryOperation: harness.fail,
  RepositoryOperationInProgressError:
    harness.RepositoryOperationInProgressError,
}));
vi.mock("@/lib/workspace/research-repository/seals", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/workspace/research-repository/seals")
    >();
  return {
    ...actual,
    previewSealSnapshot: harness.preview,
    commitSealSnapshot: harness.commit,
    supersedeSeal: harness.supersede,
  };
});

import { POST } from "./route";
import { SealSnapshotError } from "@/lib/workspace/research-repository/seals";

const baseCommitSha = "a".repeat(40);
const resultCommitSha = "b".repeat(40);
const currentCommitSha = "c".repeat(40);
const snapshotOne = "11111111-1111-4111-8111-111111111111";
const snapshotTwo = "22222222-2222-4222-8222-222222222222";
const context = { params: Promise.resolve({ id: "workspace-one" }) };
const item = {
  id: "workspace-one",
  kind: "research_repository",
  binding: {
    provider: "github",
    installationId: 99,
    repositoryId: 101,
    branch: "evaluchat/workspace",
    layoutVersion: "1.0",
    headCommitSha: baseCommitSha,
    boundAt: "2026-08-23T00:00:00.000Z",
  },
};
const preview = {
  schemaVersion: "1",
  snapshotId: snapshotOne,
  sealedFromCommit: baseCommitSha,
  reviewerLogin: "researcher",
  reviewedAt: "2026-08-23T10:00:00.000Z",
  method: { id: "synthetic-method", version: "1.2.3" },
  inputs: [
    {
      path: "methods/synthetic-method/synthetic-method.en.md",
      blobSha: "d".repeat(40),
      sha256: "e".repeat(64),
    },
  ],
  configurationHash: "f".repeat(64),
  renderHash: "1".repeat(64),
  ledgerPath: `ledger/seals/${snapshotOne}.en.md`,
  sealPath: `ledger/seals/${snapshotOne}.seal.yml`,
  ledgerMarkdown: "private rendered ledger bytes",
  manifestYaml: "private manifest bytes",
  inputArtifactIds: ["method.synthetic-method"],
};
const pendingOperation = {
  operationId: "operation-one",
  workspaceId: "workspace-one",
  kind: "seal",
  idempotencyKey: `seal:${"1".repeat(64)}`,
  status: "pending",
  artifactIds: [snapshotOne],
  baseCommitSha,
  createdAt: "2026-08-23T10:00:00.000Z",
  updatedAt: "2026-08-23T10:00:00.000Z",
};
const runningOperation = { ...pendingOperation, status: "running" };
const landedOperation = {
  ...runningOperation,
  resultCommitSha,
};
const succeededOperation = {
  ...landedOperation,
  status: "succeeded",
};

function request(body: unknown) {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST repository seal", () => {
  beforeEach(() => {
    for (const value of Object.values(harness)) {
      if (typeof value === "function" && "mockReset" in value) {
        (value as ReturnType<typeof vi.fn>).mockReset();
      }
    }
    harness.enabled.mockReturnValue(true);
    harness.authenticate.mockResolvedValue({ user: { id: "user-1" } });
    harness.getItem.mockResolvedValue(item);
    harness.updateHead.mockResolvedValue(undefined);
    harness.credentials.mockResolvedValue({
      installationId: 99,
      repositoryIds: [101],
      tokens: { accessToken: "not-retained" },
      displayMetadata: { githubUserId: 7, login: "researcher" },
    });
    harness.repository.mockResolvedValue({ owner: "octocat", name: "private" });
    harness.preview.mockResolvedValue(preview);
    harness.commit.mockResolvedValue({
      commitSha: resultCommitSha,
      snapshotId: snapshotOne,
    });
    harness.supersede.mockResolvedValue({
      commitSha: resultCommitSha,
      snapshotId: snapshotTwo,
      preview: { ...preview, snapshotId: snapshotTwo, supersedes: snapshotOne },
    });
    harness.claim.mockResolvedValue(pendingOperation);
    harness.start.mockResolvedValue(runningOperation);
    harness.record.mockResolvedValue(landedOperation);
    harness.complete.mockResolvedValue(succeededOperation);
    harness.fail.mockResolvedValue(undefined);
  });

  it("returns 404 without doing work while the feature is off", async () => {
    harness.enabled.mockReturnValue(false);

    const response = await POST(request({ action: "preview" }), context);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(harness.authenticate).not.toHaveBeenCalled();
  });

  it("returns the deterministic preview shape without a commit", async () => {
    const response = await POST(request({ action: "preview" }), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ preview });
    expect(harness.preview).toHaveBeenCalledWith({
      binding: item.binding,
      credentials: expect.objectContaining({ installationId: 99 }),
      repository: { owner: "octocat", name: "private" },
    });
    expect(harness.commit).not.toHaveBeenCalled();
    expect(harness.claim).not.toHaveBeenCalled();
  });

  it("seals a preview and stores only operation ids and commit pointers", async () => {
    const response = await POST(request({ action: "seal", preview }), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      operationId: "operation-one",
      commitSha: resultCommitSha,
      snapshotId: snapshotOne,
    });
    expect(harness.commit).toHaveBeenCalledWith(expect.any(Object), preview, {
      name: "researcher",
      email: "7+researcher@users.noreply.github.com",
    });
    expect(harness.updateHead).toHaveBeenCalledWith(
      "user-1",
      "workspace-one",
      resultCommitSha
    );
    const storeFacingCalls = JSON.stringify({
      claim: harness.claim.mock.calls,
      start: harness.start.mock.calls,
      record: harness.record.mock.calls,
      complete: harness.complete.mock.calls,
      fail: harness.fail.mock.calls,
      updateHead: harness.updateHead.mock.calls,
    });
    expect(storeFacingCalls).not.toContain(preview.ledgerMarkdown);
    expect(storeFacingCalls).not.toContain(preview.manifestYaml);
    expect(harness.claim.mock.calls[0]?.[1]).toMatchObject({
      kind: "seal",
      artifactIds: [snapshotOne],
      baseCommitSha,
    });
  });

  it("replays a successful seal without committing twice", async () => {
    harness.claim
      .mockResolvedValueOnce(pendingOperation)
      .mockResolvedValueOnce(succeededOperation);

    const first = await POST(request({ action: "seal", preview }), context);
    const replay = await POST(request({ action: "seal", preview }), context);

    expect(await first.json()).toMatchObject({ commitSha: resultCommitSha });
    expect(await replay.json()).toEqual({
      operationId: "operation-one",
      commitSha: resultCommitSha,
      snapshotId: snapshotOne,
    });
    expect(harness.commit).toHaveBeenCalledTimes(1);
  });

  it("creates a new superseding snapshot id", async () => {
    harness.claim.mockResolvedValue({
      ...pendingOperation,
      artifactIds: [snapshotTwo],
    });

    const response = await POST(
      request({ action: "supersede", supersedes: snapshotOne }),
      context
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      operationId: "operation-one",
      commitSha: resultCommitSha,
      snapshotId: snapshotTwo,
    });
    expect(harness.supersede).toHaveBeenCalledWith(
      expect.any(Object),
      snapshotOne,
      expect.objectContaining({
        snapshotId: snapshotTwo,
        expectedHeadCommitSha: baseCommitSha,
      }),
      expect.any(Object)
    );
  });

  it("returns a stale repository conflict", async () => {
    harness.preview.mockRejectedValue(
      new harness.StaleRepositoryError(currentCommitSha)
    );

    const response = await POST(request({ action: "seal", preview }), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "stale_repository",
      currentHeadCommitSha: currentCommitSha,
    });
    expect(harness.fail).toHaveBeenCalledWith(
      "user-1",
      runningOperation,
      "STALE_REPOSITORY"
    );
  });

  it("returns 404 when a superseded snapshot is absent", async () => {
    harness.claim.mockResolvedValue({
      ...pendingOperation,
      artifactIds: [snapshotTwo],
    });
    harness.supersede.mockRejectedValue(
      new SealSnapshotError("UNKNOWN_SNAPSHOT", "missing")
    );

    const response = await POST(
      request({ action: "supersede", supersedes: snapshotOne }),
      context
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "UNKNOWN_SNAPSHOT" });
  });
});
