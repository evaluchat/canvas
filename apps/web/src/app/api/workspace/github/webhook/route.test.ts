import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const harness = vi.hoisted(() => ({
  enabled: vi.fn(),
  verify: vi.fn(),
  Webhooks: vi.fn(function WebhooksMock() {
    return { verify: harness.verify };
  }),
  findOwners: vi.fn(),
  claimDelivery: vi.fn(),
  releaseDelivery: vi.fn(),
  deleteCredentials: vi.fn(),
  updateInstallation: vi.fn(),
  updateRepositories: vi.fn(),
  recordPush: vi.fn(),
}));

vi.mock("@octokit/webhooks", () => ({ Webhooks: harness.Webhooks }));
vi.mock("@/lib/research-workspaces-enabled.server", () => ({
  isGithubResearchWorkspacesEnabled: harness.enabled,
}));
vi.mock("@/lib/workspace/research-repository/credentials", () => ({
  findGithubCredentialOwnersByInstallationId: harness.findOwners,
  claimGithubWebhookDelivery: harness.claimDelivery,
  releaseGithubWebhookDelivery: harness.releaseDelivery,
  deleteGithubResearchCredentials: harness.deleteCredentials,
  updateGithubInstallation: harness.updateInstallation,
  updateGithubInstallationRepositories: harness.updateRepositories,
  recordGithubPush: harness.recordPush,
}));

import { POST } from "./route";

function request(
  body: unknown,
  headers: Record<string, string> = {},
  event = "push"
) {
  return new NextRequest("http://localhost/api/workspace/github/webhook", {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-github-delivery": "delivery-1",
      "x-github-event": event,
      "x-hub-signature-256": "sha256=valid",
      ...headers,
    },
  });
}

describe("POST /api/workspace/github/webhook", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_RESEARCH_APP_WEBHOOK_SECRET", "webhook-secret");
    for (const method of Object.values(harness)) method.mockReset();
    harness.enabled.mockReturnValue(true);
    harness.verify.mockResolvedValue(true);
    harness.findOwners.mockResolvedValue(["user-1"]);
    harness.claimDelivery.mockResolvedValue(true);
    harness.releaseDelivery.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 404 while the feature flag is off", async () => {
    harness.enabled.mockReturnValue(false);
    expect((await POST(request({ installation: { id: 99 } }))).status).toBe(
      404
    );
    expect(harness.verify).not.toHaveBeenCalled();
  });

  it("rejects a missing HMAC signature before handling the payload", async () => {
    const response = await POST(
      request({ installation: { id: 99 } }, { "x-hub-signature-256": "" })
    );
    expect(response.status).toBe(401);
    expect(harness.verify).not.toHaveBeenCalled();
    expect(harness.findOwners).not.toHaveBeenCalled();
  });

  it("rejects an HMAC failure before handling the payload", async () => {
    harness.verify.mockResolvedValue(false);
    const response = await POST(request({ installation: { id: 99 } }));
    expect(response.status).toBe(401);
    expect(harness.findOwners).not.toHaveBeenCalled();
  });

  it("ignores a duplicate delivery", async () => {
    harness.claimDelivery.mockResolvedValue(false);
    const response = await POST(request({ installation: { id: 99 } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ duplicate: true });
    expect(harness.recordPush).not.toHaveBeenCalled();
  });

  it("handles push without retaining its raw payload", async () => {
    const response = await POST(
      request({
        installation: { id: 99 },
        repository: { id: 101 },
        ref: "refs/heads/main",
        before: "abc",
        after: "def",
        commits: [{ message: "must not be persisted" }],
      })
    );
    expect(response.status).toBe(200);
    expect(harness.claimDelivery).toHaveBeenCalledWith("user-1", "delivery-1");
    expect(harness.recordPush).toHaveBeenCalledWith("user-1", {
      repositoryId: 101,
      ref: "refs/heads/main",
      before: "abc",
      after: "def",
    });
    expect(JSON.stringify(harness.recordPush.mock.calls)).not.toContain(
      "must not be persisted"
    );
  });

  it("updates only repository ids for installation repository events", async () => {
    await POST(
      request(
        {
          installation: { id: 99 },
          repositories_added: [{ id: 102, full_name: "private/name" }],
          repositories_removed: [{ id: 101 }],
        },
        {},
        "installation_repositories"
      )
    );
    expect(harness.updateRepositories).toHaveBeenCalledWith(
      "user-1",
      [102],
      [101]
    );
  });

  it("does not clear repositories when an installation event omits them", async () => {
    const response = await POST(
      request(
        { action: "suspend", installation: { id: 99 } },
        {},
        "installation"
      )
    );

    expect(response.status).toBe(200);
    expect(harness.updateInstallation).not.toHaveBeenCalled();
  });

  it("replaces repository ids when an installation event includes them", async () => {
    const response = await POST(
      request(
        {
          action: "created",
          installation: { id: 99 },
          repositories: [{ id: 102, full_name: "private/name" }],
        },
        {},
        "installation"
      )
    );

    expect(response.status).toBe(200);
    expect(harness.updateInstallation).toHaveBeenCalledWith("user-1", 99, [
      102,
    ]);
  });

  it("deletes credentials when the installation is deleted", async () => {
    const response = await POST(
      request(
        { action: "deleted", installation: { id: 99 } },
        {},
        "installation"
      )
    );

    expect(response.status).toBe(200);
    expect(harness.deleteCredentials).toHaveBeenCalledWith("user-1");
    expect(harness.updateInstallation).not.toHaveBeenCalled();
  });

  it("does not delete credentials when the installation is created", async () => {
    const response = await POST(
      request(
        {
          action: "created",
          installation: { id: 99 },
          repositories: [{ id: 102, full_name: "private/name" }],
        },
        {},
        "installation"
      )
    );

    expect(response.status).toBe(200);
    expect(harness.deleteCredentials).not.toHaveBeenCalled();
    expect(harness.updateInstallation).toHaveBeenCalledWith("user-1", 99, [
      102,
    ]);
  });

  it("releases a delivery claim when handling fails and returns 500", async () => {
    harness.recordPush.mockRejectedValue(new Error("store unavailable"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await POST(request({ installation: { id: 99 } }));

    expect(response.status).toBe(500);
    expect(harness.releaseDelivery).toHaveBeenCalledWith(
      "user-1",
      "delivery-1"
    );
  });
});
