// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  RepositoryStatus,
  ResearchRepositoryBinding,
} from "@opencanvas/shared/research-repository";
import { RepositoryPanel } from "./repository-panel";

const navigation = vi.hoisted(() => ({ useSearchParams: vi.fn() }));

vi.mock("next/navigation", () => ({
  useSearchParams: navigation.useSearchParams,
}));

const binding = {
  provider: "github",
  repositoryId: 101,
  installationId: 99,
  branch: "evaluchat/workspace",
  layoutVersion: "1.0",
  headCommitSha: "a".repeat(40),
  boundAt: "2026-08-23T00:00:00.000Z",
} satisfies ResearchRepositoryBinding;

function readyStatus(headCommitSha = binding.headCommitSha): RepositoryStatus {
  return {
    workspaceId: "workspace-one",
    repositoryId: binding.repositoryId,
    state: "ready",
    layoutVersion: "1.0",
    headCommitSha,
    checkedAt: "2026-08-23T00:00:00.000Z",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  navigation.useSearchParams.mockReturnValue(new URLSearchParams());
});

describe("RepositoryPanel", () => {
  it("skips mounting when the binding is absent or the feature is disabled", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const withoutBinding = render(
      createElement(RepositoryPanel, { item: { id: "workspace-one" } })
    );
    expect(withoutBinding.container.innerHTML).toBe("");
    withoutBinding.unmount();

    const disabled = render(
      createElement(RepositoryPanel, {
        item: { id: "workspace-one", binding },
        enabled: false,
      })
    );
    expect(disabled.container.innerHTML).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hides when the server reports that the feature is off", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "Not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      createElement(RepositoryPanel, {
        item: { id: "workspace-one", binding },
      })
    );

    await waitFor(() => expect(view.container.innerHTML).toBe(""));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/workspace/items/workspace-one/repository"
    );
  });

  it("reconciles the binding and refreshes the artifact tree", async () => {
    const nextCommitSha = "f".repeat(40);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/repository/reconcile")) {
          return jsonResponse({ status: readyStatus(nextCommitSha) });
        }
        if (url.endsWith("/repository/artifacts")) {
          return jsonResponse({ artifacts: [], headCommitSha: nextCommitSha });
        }
        if (url.endsWith("/repository") && !init?.method) {
          return jsonResponse({ status: readyStatus() });
        }
        return jsonResponse({ error: "Unexpected request" }, 500);
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      createElement(RepositoryPanel, {
        item: { id: "workspace-one", binding },
      })
    );

    fireEvent.click(await screen.findByRole("button", { name: "Reconcile" }));

    expect(await screen.findByText("Repository reconciled")).toBeTruthy();
    expect(screen.getByText("fffffff")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspace/items/workspace-one/repository/reconcile",
      { method: "POST", credentials: "include" }
    );
    await waitFor(() => {
      const artifactRequests = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/repository/artifacts")
      );
      expect(artifactRequests.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("opens the artifact selected in the URL", async () => {
    navigation.useSearchParams.mockReturnValue(
      new URLSearchParams("artifactId=index")
    );
    const artifact = {
      artifactId: "index",
      kind: "index",
      path: "index.md",
      commitSha: binding.headCommitSha,
      blobSha: "b".repeat(40),
      contentSha256: "c".repeat(64),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/repository")) {
        return jsonResponse({ status: readyStatus() });
      }
      if (url.endsWith("/repository/artifacts")) {
        return jsonResponse({
          artifacts: [artifact],
          headCommitSha: binding.headCommitSha,
        });
      }
      if (url.endsWith("/repository/artifacts?artifactId=index")) {
        return jsonResponse({
          artifact: { ...artifact, supported: true },
          content: "# Research index",
        });
      }
      return jsonResponse({ error: "Unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      createElement(RepositoryPanel, {
        item: { id: "workspace-one", binding },
      })
    );

    expect(await screen.findByDisplayValue("# Research index")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspace/items/workspace-one/repository/artifacts?artifactId=index",
      { credentials: "include", cache: "no-store" }
    );
  });

  it("loads a new URL-selected artifact after mounted navigation", async () => {
    let searchParams = new URLSearchParams("artifactId=index");
    navigation.useSearchParams.mockImplementation(() => searchParams);
    const indexArtifact = {
      artifactId: "index",
      kind: "index",
      path: "index.md",
      commitSha: binding.headCommitSha,
      blobSha: "b".repeat(40),
      contentSha256: "c".repeat(64),
    };
    const readmeArtifact = {
      ...indexArtifact,
      artifactId: "readme",
      kind: "readme",
      path: "README.md",
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/repository")) {
        return jsonResponse({ status: readyStatus() });
      }
      if (url.endsWith("/repository/artifacts")) {
        return jsonResponse({
          artifacts: [indexArtifact, readmeArtifact],
          headCommitSha: binding.headCommitSha,
        });
      }
      if (url.endsWith("/repository/artifacts?artifactId=index")) {
        return jsonResponse({
          artifact: { ...indexArtifact, supported: true },
          content: "# Research index",
        });
      }
      if (url.endsWith("/repository/artifacts?artifactId=readme")) {
        return jsonResponse({
          artifact: { ...readmeArtifact, supported: true },
          content: "# Research readme",
        });
      }
      return jsonResponse({ error: "Unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      createElement(RepositoryPanel, {
        item: { id: "workspace-one", binding },
      })
    );

    expect(await screen.findByDisplayValue("# Research index")).toBeTruthy();

    searchParams = new URLSearchParams("artifactId=readme");
    view.rerender(
      createElement(RepositoryPanel, {
        item: { id: "workspace-one", binding },
      })
    );

    expect(await screen.findByDisplayValue("# Research readme")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspace/items/workspace-one/repository/artifacts?artifactId=readme",
      { credentials: "include", cache: "no-store" }
    );
  });

  it("clears the selected artifact when mounted navigation removes it", async () => {
    let searchParams = new URLSearchParams("artifactId=index");
    navigation.useSearchParams.mockImplementation(() => searchParams);
    const artifact = {
      artifactId: "index",
      kind: "index",
      path: "index.md",
      commitSha: binding.headCommitSha,
      blobSha: "b".repeat(40),
      contentSha256: "c".repeat(64),
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/repository")) {
        return jsonResponse({ status: readyStatus() });
      }
      if (url.endsWith("/repository/artifacts")) {
        return jsonResponse({
          artifacts: [artifact],
          headCommitSha: binding.headCommitSha,
        });
      }
      if (url.endsWith("/repository/artifacts?artifactId=index")) {
        return jsonResponse({
          artifact: { ...artifact, supported: true },
          content: "# Research index",
        });
      }
      return jsonResponse({ error: "Unexpected request" }, 500);
    });
    vi.stubGlobal("fetch", fetchMock);

    const view = render(
      createElement(RepositoryPanel, {
        item: { id: "workspace-one", binding },
      })
    );

    expect(await screen.findByDisplayValue("# Research index")).toBeTruthy();

    searchParams = new URLSearchParams();
    view.rerender(
      createElement(RepositoryPanel, {
        item: { id: "workspace-one", binding },
      })
    );

    expect(await screen.findByText("Select an artifact to edit.")).toBeTruthy();
    expect(screen.queryByDisplayValue("# Research index")).toBeNull();
  });

  it("previews and seals a repository snapshot", async () => {
    const snapshotId = "11111111-1111-4111-8111-111111111111";
    const previousSnapshotId = "22222222-2222-4222-8222-222222222222";
    const commitSha = "f".repeat(40);
    const sealPreview = {
      snapshotId,
      sealedFromCommit: binding.headCommitSha,
      reviewedAt: "2026-08-23T10:00:00.000Z",
      configurationHash: "c".repeat(64),
      renderHash: "d".repeat(64),
      inputs: [
        {
          path: "methods/synthetic/synthetic.en.md",
          blobSha: "b".repeat(40),
          sha256: "e".repeat(64),
        },
      ],
      ledgerPath: `ledger/seals/${snapshotId}.en.md`,
      sealPath: `ledger/seals/${snapshotId}.seal.yml`,
      latestSnapshotId: previousSnapshotId,
    };
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/repository/seal")) {
          const body = JSON.parse(String(init?.body)) as { action: string };
          if (body.action === "preview") {
            return jsonResponse({ preview: sealPreview });
          }
          if (body.action === "seal") {
            return jsonResponse({
              operationId: "operation-one",
              commitSha,
              snapshotId,
            });
          }
        }
        if (url.endsWith("/repository/artifacts")) {
          return jsonResponse({
            artifacts: [],
            headCommitSha: binding.headCommitSha,
          });
        }
        if (url.endsWith("/repository") && !init?.method) {
          return jsonResponse({ status: readyStatus() });
        }
        return jsonResponse({ error: "Unexpected request" }, 500);
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      createElement(RepositoryPanel, {
        item: { id: "workspace-one", binding },
      })
    );

    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    expect(await screen.findByText(snapshotId)).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText(/config c{12} · render d{12}/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Supersede" })).toBeTruthy();

    // Seal stays disabled until all three declarations are confirmed.
    const sealButton = () =>
      screen.getByRole("button", { name: "Seal" }) as HTMLButtonElement;
    expect(sealButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Publication Authorisation/), {
      target: { value: "confirmed-authorised-to-publish" },
    });
    fireEvent.change(screen.getByLabelText(/Anonymisation Status/), {
      target: {
        value: "confirmed-no-student-identifiers-or-raw-student-material",
      },
    });
    fireEvent.change(screen.getByLabelText(/Public Data Declaration/), {
      target: { value: "confirmed-public-data" },
    });
    expect(sealButton().disabled).toBe(false);

    fireEvent.click(sealButton());
    expect((await screen.findByRole("status")).textContent).toContain(
      snapshotId
    );
    expect(screen.getByRole("status").textContent).toContain(commitSha);

    const sealRequests = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/repository/seal"))
      .map(
        ([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>
      );
    const confirmedDeclarations = {
      publicationAuthorisation: "confirmed-authorised-to-publish",
      anonymisationStatus:
        "confirmed-no-student-identifiers-or-raw-student-material",
      publicDataDeclaration: "confirmed-public-data",
    };
    expect(sealRequests).toEqual([
      { action: "preview" },
      {
        action: "seal",
        preview: sealPreview,
        declarations: confirmedDeclarations,
      },
    ]);
  });

  it("supersedes the latest repository snapshot", async () => {
    const latestSnapshotId = "11111111-1111-4111-8111-111111111111";
    const replacementId = "22222222-2222-4222-8222-222222222222";
    const commitSha = "f".repeat(40);
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/repository/seal")) {
          const body = JSON.parse(String(init?.body)) as { action: string };
          if (body.action === "preview") {
            return jsonResponse({
              preview: {
                snapshotId: "33333333-3333-4333-8333-333333333333",
                sealedFromCommit: binding.headCommitSha,
                reviewedAt: "2026-08-23T10:00:00.000Z",
                configurationHash: "c".repeat(64),
                renderHash: "d".repeat(64),
                inputs: [],
                ledgerPath: "ledger/seals/preview.en.md",
                sealPath: "ledger/seals/preview.seal.yml",
                latestSnapshotId,
              },
            });
          }
          return jsonResponse({
            operationId: "operation-two",
            commitSha,
            snapshotId: replacementId,
          });
        }
        if (url.endsWith("/repository/artifacts")) {
          return jsonResponse({
            artifacts: [],
            headCommitSha: binding.headCommitSha,
          });
        }
        if (url.endsWith("/repository") && !init?.method) {
          return jsonResponse({ status: readyStatus() });
        }
        return jsonResponse({ error: "Unexpected request" }, 500);
      }
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      createElement(RepositoryPanel, {
        item: { id: "workspace-one", binding },
      })
    );
    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    const confirm = async () => {
      fireEvent.change(screen.getByLabelText(/Publication Authorisation/), {
        target: { value: "confirmed-authorised-to-publish" },
      });
      fireEvent.change(screen.getByLabelText(/Anonymisation Status/), {
        target: {
          value: "confirmed-no-student-identifiers-or-raw-student-material",
        },
      });
      fireEvent.change(screen.getByLabelText(/Public Data Declaration/), {
        target: { value: "confirmed-public-data" },
      });
    };
    await confirm();
    fireEvent.click(await screen.findByRole("button", { name: "Supersede" }));

    expect((await screen.findByRole("status")).textContent).toContain(
      replacementId
    );
    const call = fetchMock.mock.calls.find(([, init]) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      return body?.action === "supersede";
    });
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      action: "supersede",
      supersedes: latestSnapshotId,
      declarations: {
        publicationAuthorisation: "confirmed-authorised-to-publish",
        anonymisationStatus:
          "confirmed-no-student-identifiers-or-raw-student-material",
        publicDataDeclaration: "confirmed-public-data",
      },
    });
  });
});
