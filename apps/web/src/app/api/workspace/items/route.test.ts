import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const harness = vi.hoisted(() => ({
  UnsupportedMethodError: class UnsupportedMethodError extends Error {},
  UnsupportedTemplateError: class UnsupportedTemplateError extends Error {},
  LedgerNotReadyError: class LedgerNotReadyError extends Error {},
  ResearchRepositoryBindingError: class ResearchRepositoryBindingError extends Error {
    code = "repository_public";
  },
  enabled: vi.fn(),
  verifyUserAuthenticated: vi.fn(),
  createResearchRepositoryItem: vi.fn(),
  createWorkspaceItem: vi.fn(),
  createMethodWorkspaceItem: vi.fn(),
  createLedgerWorkspaceItem: vi.fn(),
  ensureDefaultWorkspaceItem: vi.fn(),
  listWorkspaceItems: vi.fn(),
}));

vi.mock("@/lib/supabase/verify_user_server", () => ({
  verifyUserAuthenticated: harness.verifyUserAuthenticated,
}));
vi.mock("@/lib/research-workspaces-enabled.server", () => ({
  isGithubResearchWorkspacesEnabled: harness.enabled,
}));
vi.mock("@/lib/workspace/store", () => ({
  UnsupportedMethodError: harness.UnsupportedMethodError,
  UnsupportedTemplateError: harness.UnsupportedTemplateError,
  LedgerNotReadyError: harness.LedgerNotReadyError,
  ResearchRepositoryBindingError: harness.ResearchRepositoryBindingError,
  createResearchRepositoryItem: harness.createResearchRepositoryItem,
  createWorkspaceItem: harness.createWorkspaceItem,
  createMethodWorkspaceItem: harness.createMethodWorkspaceItem,
  createLedgerWorkspaceItem: harness.createLedgerWorkspaceItem,
  ensureDefaultWorkspaceItem: harness.ensureDefaultWorkspaceItem,
  listWorkspaceItems: harness.listWorkspaceItems,
}));

import { POST } from "./route";

function request(body: unknown) {
  return new NextRequest("http://localhost/api/workspace/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function malformedRequest() {
  return new NextRequest("http://localhost/api/workspace/items", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
}

describe("POST /api/workspace/items", () => {
  beforeEach(() => {
    harness.verifyUserAuthenticated.mockReset();
    harness.createWorkspaceItem.mockReset();
    harness.createResearchRepositoryItem.mockReset();
    harness.createMethodWorkspaceItem.mockReset();
    harness.createLedgerWorkspaceItem.mockReset();
    harness.enabled.mockReset();
    harness.enabled.mockReturnValue(true);
    harness.verifyUserAuthenticated.mockResolvedValue({
      user: { id: "user-1" },
    });
  });

  it("creates a method draft from methodId", async () => {
    harness.createMethodWorkspaceItem.mockResolvedValue({
      id: "wi_method",
      kind: "method",
    });
    const response = await POST(request({ methodId: "ai-assisted-essay" }));
    expect(response.status).toBe(201);
    expect(harness.createMethodWorkspaceItem).toHaveBeenCalledWith(
      "user-1",
      "ai-assisted-essay"
    );
    expect(harness.createWorkspaceItem).not.toHaveBeenCalled();
  });

  it("creates an Evidence Ledger item from a ledger method id", async () => {
    harness.createLedgerWorkspaceItem.mockResolvedValue({
      id: "wi_ledger",
      kind: "ledger",
    });
    const response = await POST(
      request({ kind: "ledger", methodId: "ledger-demo-method" })
    );
    expect(response.status).toBe(201);
    expect(harness.createLedgerWorkspaceItem).toHaveBeenCalledWith(
      "user-1",
      "ledger-demo-method"
    );
  });

  it("creates a private research repository item", async () => {
    harness.createResearchRepositoryItem.mockResolvedValue({
      id: "wi_repository",
      kind: "research_repository",
    });

    const response = await POST(
      request({
        kind: "research_repository",
        installationId: 99,
        repositoryId: 101,
      })
    );

    expect(response.status).toBe(201);
    expect(harness.createResearchRepositoryItem).toHaveBeenCalledWith(
      "user-1",
      { installationId: 99, repositoryId: 101 }
    );
  });

  it("rejects non-positive or non-integer repository ids", async () => {
    for (const body of [
      { kind: "research_repository", installationId: 99, repositoryId: 0 },
      { kind: "research_repository", installationId: 99, repositoryId: 1.5 },
      { kind: "research_repository", installationId: -1, repositoryId: 101 },
    ]) {
      const response = await POST(request(body));
      expect(response.status).toBe(400);
      expect(harness.createResearchRepositoryItem).not.toHaveBeenCalled();
    }
  });

  it("returns a binding error code", async () => {
    harness.createResearchRepositoryItem.mockRejectedValue(
      new harness.ResearchRepositoryBindingError(
        "Research repositories must be private"
      )
    );

    const response = await POST(
      request({
        kind: "research_repository",
        installationId: 99,
        repositoryId: 101,
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Research repositories must be private",
      code: "repository_public",
    });
  });

  it("returns 404 for research repositories while the flag is off", async () => {
    harness.enabled.mockReturnValue(false);

    const response = await POST(
      request({
        kind: "research_repository",
        installationId: 99,
        repositoryId: 101,
      })
    );

    expect(response.status).toBe(404);
    expect(harness.createResearchRepositoryItem).not.toHaveBeenCalled();
    expect(harness.verifyUserAuthenticated).not.toHaveBeenCalled();
  });

  it("still creates v0.7 ledger items while the research workspace flag is off", async () => {
    harness.enabled.mockReturnValue(false);
    harness.createLedgerWorkspaceItem.mockResolvedValue({
      id: "wi_ledger",
      kind: "ledger",
    });

    const response = await POST(
      request({ kind: "ledger", methodId: "ledger-demo-method" })
    );

    expect(response.status).toBe(201);
    expect(harness.createLedgerWorkspaceItem).toHaveBeenCalledWith(
      "user-1",
      "ledger-demo-method"
    );
  });

  it("rejects an empty body", async () => {
    const response = await POST(request({}));
    expect(response.status).toBe(400);
    expect(harness.createMethodWorkspaceItem).not.toHaveBeenCalled();
    expect(harness.createWorkspaceItem).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON without calling the store", async () => {
    const response = await POST(malformedRequest());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(harness.createMethodWorkspaceItem).not.toHaveBeenCalled();
    expect(harness.createWorkspaceItem).not.toHaveBeenCalled();
  });

  it("returns 500 when the store rejects with an unexpected error", async () => {
    harness.createWorkspaceItem.mockRejectedValue(new Error("disk full"));

    const response = await POST(request({ templateId: "starter" }));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Could not create workspace item",
    });
  });

  it("returns 400 when the store rejects with an unsupported template", async () => {
    harness.createWorkspaceItem.mockRejectedValue(
      new harness.UnsupportedTemplateError("Unsupported workspace template")
    );

    const response = await POST(request({ templateId: "starter" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Unsupported template" });
  });
});
