// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/dom";
import type { RepositoryArtifactRef } from "@opencanvas/shared/research-repository";
import { RepositoryBrowser } from "./repository-browser";

const commitSha = "a".repeat(40);

const artifacts = [
  {
    artifactId: "index",
    kind: "index",
    path: "index.md",
    commitSha,
    blobSha: "b".repeat(40),
    contentSha256: "c".repeat(64),
  },
  {
    artifactId: "method.interview",
    kind: "method",
    path: "methods/interview/interview.en.md",
    commitSha,
    blobSha: "d".repeat(40),
    contentSha256: "e".repeat(64),
  },
] satisfies RepositoryArtifactRef[];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("RepositoryBrowser", () => {
  it("renders repository directories and files from the artifacts response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ artifacts, headCommitSha: commitSha }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSelectArtifact = vi.fn();

    render(
      createElement(RepositoryBrowser, {
        workspaceItemId: "workspace-one",
        onSelectArtifact,
      })
    );

    expect(await screen.findByText("methods/")).toBeTruthy();
    expect(screen.getByText("interview/")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "interview.en.md" })
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "index.md" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "interview.en.md" }));
    expect(onSelectArtifact).toHaveBeenCalledWith(artifacts[1]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspace/items/workspace-one/repository/artifacts",
      { credentials: "include", cache: "no-store" }
    );
  });
});
