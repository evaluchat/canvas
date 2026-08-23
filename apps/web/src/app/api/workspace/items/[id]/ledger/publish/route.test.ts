import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { FormValidationError } from "@/lib/workspace/form-validation";

const harness = vi.hoisted(() => {
  class WorkspaceItemNotFoundError extends Error {}
  return {
    verifyUserAuthenticated: vi.fn(),
    getLedgerSnapshotItem: vi.fn(),
    updateLedgerSnapshotPublication: vi.fn(),
    getGithubResearchWriteAccess: vi.fn(),
    getLedgerPullRequestStatus: vi.fn(),
    openLedgerPullRequest: vi.fn(),
    ledgerRenderHash: vi.fn(),
    renderLedgerMarkdown: vi.fn(),
    validateLedgerPublicationDeclarations: vi.fn(),
    WorkspaceItemNotFoundError,
  };
});

vi.mock("@/lib/supabase/verify_user_server", () => ({
  verifyUserAuthenticated: harness.verifyUserAuthenticated,
}));
vi.mock("@/lib/workspace/store", () => ({
  getLedgerSnapshotItem: harness.getLedgerSnapshotItem,
  updateLedgerSnapshotPublication: harness.updateLedgerSnapshotPublication,
  WorkspaceItemNotFoundError: harness.WorkspaceItemNotFoundError,
}));
vi.mock("@/lib/workspace/evidence-github", () => ({
  RESEARCH_REPOSITORY: "evaluchat/research",
  getGithubResearchWriteAccess: harness.getGithubResearchWriteAccess,
  getLedgerPullRequestStatus: harness.getLedgerPullRequestStatus,
  openLedgerPullRequest: harness.openLedgerPullRequest,
}));
vi.mock("@/lib/workspace/ledger-publish", () => ({
  ledgerRenderHash: harness.ledgerRenderHash,
  renderLedgerMarkdown: harness.renderLedgerMarkdown,
  validateLedgerPublicationDeclarations:
    harness.validateLedgerPublicationDeclarations,
}));

import { POST } from "./route";
import { POST as statusPOST } from "./status/route";

const snapshot = {
  id: "wi_snapshot",
  kind: "ledger_snapshot",
  snapshot: {
    ledgerId: "ledger_demo",
    methodId: "demo-method",
    methodVersion: "1.0.0",
    templateId: "evidence-template",
    templateVersion: "1.2.0",
    inputFingerprint: "sha256:abcdef0123456789",
    renderHash: "sha256:render",
    sourceCommit: "commit123",
    buckets: { Included: 2, Unknown: 1 },
  },
  config: { filters: [] },
};

const context = (id = "wi_snapshot") => ({ params: Promise.resolve({ id }) });
const request = (body: unknown) =>
  new NextRequest("http://localhost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const validValues = {
  publication_authorisation: "confirmed-authorised-to-publish",
  anonymisation_status:
    "confirmed-no-student-identifiers-or-raw-student-material",
  public_data_declaration: "confirmed-public-data",
};

describe("ledger publish route", () => {
  beforeEach(() => {
    for (const value of Object.values(harness)) {
      if (typeof value === "function" && "mockReset" in value)
        value.mockReset();
    }
    harness.verifyUserAuthenticated.mockResolvedValue({
      user: { id: "user-1" },
    });
    harness.getLedgerSnapshotItem.mockResolvedValue(structuredClone(snapshot));
    harness.getGithubResearchWriteAccess.mockResolvedValue({
      allowed: true,
      login: "writer",
    });
    harness.ledgerRenderHash.mockReturnValue("sha256:render");
    harness.renderLedgerMarkdown.mockReturnValue(
      "---\ntype: Evidence Ledger\n---\n"
    );
    harness.openLedgerPullRequest.mockResolvedValue({
      number: 85,
      url: "https://github.com/evaluchat/research/pull/85",
      branch: "ledger/ledger_demo-abcdef012345",
      status: "draft",
      lintConclusion: "success",
    });
    harness.updateLedgerSnapshotPublication.mockImplementation(
      async (_userId, _id, update) => ({
        ...structuredClone(snapshot),
        ...(update.publication ? { publication: update.publication } : {}),
        snapshot: update.renderHash
          ? { ...snapshot.snapshot, renderHash: update.renderHash }
          : snapshot.snapshot,
      })
    );
  });

  it("denies missing write access before the PR client can create state", async () => {
    harness.getGithubResearchWriteAccess.mockResolvedValue({
      allowed: false,
      reason: "missing_write_access",
    });
    const response = await POST(request({ values: validValues }), context());

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      reason: "missing_write_access",
    });
    expect(harness.openLedgerPullRequest).not.toHaveBeenCalled();
  });

  it("returns 503 when the publication identity is missing", async () => {
    harness.getGithubResearchWriteAccess.mockResolvedValue({
      allowed: false,
      reason: "missing_identity",
    });
    const response = await POST(request({ values: validValues }), context());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "The publication service is not configured",
      reason: "missing_identity",
    });
    expect(harness.openLedgerPullRequest).not.toHaveBeenCalled();
  });

  it("creates a draft ledger PR with the one immutable artifact", async () => {
    const response = await POST(request({ values: validValues }), context());

    expect(response.status).toBe(200);
    expect(harness.openLedgerPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        ledgerId: "ledger_demo",
        inputFingerprint: "sha256:abcdef0123456789",
        filePath: "methods/demo-method/evidence/ledgers/ledger_demo.en.md",
        renderHashMatches: true,
        consentConfirmed: true,
        sourceCommit: "commit123",
      })
    );
    const openInput = harness.openLedgerPullRequest.mock.calls[0][0];
    expect(openInput.body).toContain("Method: demo-method@1.0.0");
    expect(openInput.body).toContain("Human review required before merge.");
    expect(openInput.body).not.toMatch(/closes/i);
    expect(harness.updateLedgerSnapshotPublication).toHaveBeenCalledWith(
      "user-1",
      "wi_snapshot",
      {
        publication: {
          status: "draft",
          pullRequestUrl: "https://github.com/evaluchat/research/pull/85",
          pullRequestNumber: 85,
        },
      }
    );
  });

  it("passes a failed render-integrity marker through to the draft PR fallback", async () => {
    harness.ledgerRenderHash.mockReturnValue("sha256:recomputed");

    const response = await POST(request({ values: validValues }), context());

    expect(response.status).toBe(200);
    expect(harness.openLedgerPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        renderHashMatches: false,
        consentConfirmed: true,
      })
    );
    expect(harness.updateLedgerSnapshotPublication).toHaveBeenNthCalledWith(
      1,
      "user-1",
      "wi_snapshot",
      { renderHash: "sha256:recomputed" }
    );
    expect(harness.updateLedgerSnapshotPublication).toHaveBeenLastCalledWith(
      "user-1",
      "wi_snapshot",
      expect.objectContaining({
        publication: expect.objectContaining({ status: "draft" }),
      })
    );
  });

  it("persists a draft ledger publication and does not claim a merge", async () => {
    const response = await POST(request({ values: validValues }), context());

    expect(response.status).toBe(200);
    expect(harness.updateLedgerSnapshotPublication).toHaveBeenCalledWith(
      "user-1",
      "wi_snapshot",
      {
        publication: {
          status: "draft",
          pullRequestUrl: "https://github.com/evaluchat/research/pull/85",
          pullRequestNumber: 85,
        },
      }
    );
    const body = await response.json();
    expect(body).toMatchObject({
      publication: { status: "draft", pullRequestNumber: 85 },
    });
    expect(body.publication.mergedAt).toBeUndefined();
    expect(body.autoMergeError).toBeUndefined();
  });

  it("does not create a second PR for an already published snapshot", async () => {
    harness.getLedgerSnapshotItem.mockResolvedValue({
      ...structuredClone(snapshot),
      publication: { status: "draft", pullRequestNumber: 85 },
    });
    const response = await POST(request({ values: validValues }), context());

    expect(response.status).toBe(409);
    expect(harness.openLedgerPullRequest).not.toHaveBeenCalled();
  });

  it("rejects republish when the recorded pull request is still open", async () => {
    harness.getLedgerSnapshotItem.mockResolvedValue({
      ...structuredClone(snapshot),
      publication: { status: "draft", pullRequestNumber: 85 },
    });
    harness.getLedgerPullRequestStatus.mockResolvedValue({
      state: "open",
      merged: false,
    });

    const response = await POST(
      request({ values: validValues, rePublish: true }),
      context()
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Only a closed, unmerged ledger pull request can be republished.",
      publication: { status: "draft", pullRequestNumber: 85 },
    });
    expect(harness.openLedgerPullRequest).not.toHaveBeenCalled();
  });

  it("rejects republish when the recorded pull request is merged", async () => {
    harness.getLedgerSnapshotItem.mockResolvedValue({
      ...structuredClone(snapshot),
      publication: { status: "draft", pullRequestNumber: 85 },
    });
    harness.getLedgerPullRequestStatus.mockResolvedValue({
      state: "closed",
      merged: true,
    });

    const response = await POST(
      request({ values: validValues, rePublish: true }),
      context()
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "Only a closed, unmerged ledger pull request can be republished.",
      publication: { status: "draft", pullRequestNumber: 85 },
    });
    expect(harness.openLedgerPullRequest).not.toHaveBeenCalled();
  });

  it("passes a distinct retry suffix for each republish of a closed PR", async () => {
    const now = vi.spyOn(Date, "now");
    now
      .mockReturnValueOnce(1_700_000_000_002)
      .mockReturnValueOnce(1_700_000_000_003);
    harness.getLedgerSnapshotItem.mockResolvedValue({
      ...structuredClone(snapshot),
      publication: { status: "draft", pullRequestNumber: 85 },
    });
    harness.getLedgerPullRequestStatus.mockResolvedValue({
      state: "closed",
      merged: false,
    });

    const first = await POST(
      request({ values: validValues, rePublish: true }),
      context()
    );
    expect(first.status).toBe(200);
    expect(harness.openLedgerPullRequest.mock.calls[0][0].retry).toBe(
      1_700_000_000_002
    );

    const second = await POST(
      request({ values: validValues, rePublish: true }),
      context()
    );
    expect(second.status).toBe(200);
    expect(harness.openLedgerPullRequest.mock.calls[1][0].retry).toBe(
      1_700_000_000_003
    );
    expect(harness.openLedgerPullRequest.mock.calls[0][0].retry).not.toBe(
      harness.openLedgerPullRequest.mock.calls[1][0].retry
    );
    now.mockRestore();
  });

  it("returns consent validation failures before creating a PR", async () => {
    harness.validateLedgerPublicationDeclarations.mockImplementation(() => {
      throw new FormValidationError([
        { fieldId: "anonymisation_status", message: "Required" },
      ]);
    });
    const response = await POST(request({ values: {} }), context());

    expect(response.status).toBe(422);
    expect(harness.openLedgerPullRequest).not.toHaveBeenCalled();
  });

  it("only marks a publication merged after GitHub reports a merge", async () => {
    harness.getLedgerSnapshotItem.mockResolvedValue({
      ...structuredClone(snapshot),
      publication: {
        status: "draft",
        pullRequestNumber: 85,
        pullRequestUrl: "https://github.com/evaluchat/research/pull/85",
      },
    });
    harness.getLedgerPullRequestStatus.mockResolvedValue({
      state: "closed",
      merged: true,
      mergedAt: "2026-08-19T15:00:00.000Z",
    });
    const response = await statusPOST(
      new Request("http://localhost"),
      context()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      publication: { status: "merged", mergedAt: "2026-08-19T15:00:00.000Z" },
    });
  });
});
