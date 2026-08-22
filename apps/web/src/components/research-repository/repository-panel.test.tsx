// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
