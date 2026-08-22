// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { RepositoryArtifactRef } from "@opencanvas/shared/research-repository";
import { ArtifactEditor } from "./artifact-editor";

const commitSha = "a".repeat(40);
const artifact = {
  artifactId: "index",
  kind: "index",
  path: "index.md",
  commitSha,
  blobSha: "b".repeat(40),
  contentSha256: "c".repeat(64),
} satisfies RepositoryArtifactRef;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function artifactResponse(
  content: string,
  sha = commitSha,
  responseArtifact: RepositoryArtifactRef = artifact,
  supported = true
): Response {
  return jsonResponse({
    artifact: { ...responseArtifact, commitSha: sha, supported },
    content,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ArtifactEditor", () => {
  it("loads a file, edits its text, and shows dirty state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(artifactResponse("# Original"));
    vi.stubGlobal("fetch", fetchMock);

    render(
      createElement(ArtifactEditor, {
        workspaceItemId: "workspace-one",
        artifact,
      })
    );

    const editor = (await screen.findByDisplayValue(
      "# Original"
    )) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: "# Edited" } });

    expect(editor.value).toBe("# Edited");
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/workspace/items/workspace-one/repository/artifacts?artifactId=index",
      { credentials: "include", cache: "no-store" }
    );
  });

  it("commits the edited artifact and confirms success", async () => {
    const nextCommitSha = "d".repeat(40);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(artifactResponse("# Original"))
      .mockResolvedValueOnce(jsonResponse({ commitSha: nextCommitSha }));
    vi.stubGlobal("fetch", fetchMock);
    const onCommitted = vi.fn();

    render(
      createElement(ArtifactEditor, {
        workspaceItemId: "workspace-one",
        artifact,
        onCommitted,
      })
    );

    const editor = await screen.findByDisplayValue("# Original");
    fireEvent.change(editor, { target: { value: "# Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit changes" }));

    expect(await screen.findByText("Changes committed")).toBeTruthy();
    expect(screen.getByText("No unsaved changes")).toBeTruthy();
    expect(onCommitted).toHaveBeenCalledWith(nextCommitSha);

    const [url, request] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/workspace/items/workspace-one/repository/commit");
    const requestBody = JSON.parse(String(request.body)) as Record<
      string,
      unknown
    >;
    expect(requestBody).toMatchObject({
      artifactId: "index",
      baseCommitSha: commitSha,
      content: "# Edited",
      commitMessage: "Update index.md",
    });
    expect(requestBody).not.toHaveProperty("path");
    expect(String(requestBody.idempotencyKey).length).toBeGreaterThanOrEqual(
      16
    );
  });

  it("ignores a commit result after switching artifacts", async () => {
    const artifactBCommitSha = "e".repeat(40);
    const artifactB = {
      ...artifact,
      artifactId: "readme",
      kind: "readme",
      path: "README.md",
      commitSha: artifactBCommitSha,
    } satisfies RepositoryArtifactRef;
    const committedArtifactBSha = "f".repeat(40);
    let resolveArtifactACommit!: (response: Response) => void;
    const artifactACommit = new Promise<Response>((resolve) => {
      resolveArtifactACommit = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("artifactId=index")) {
          return artifactResponse("# Artifact A");
        }
        if (url.includes("artifactId=readme")) {
          return artifactResponse(
            "# Artifact B",
            artifactBCommitSha,
            artifactB
          );
        }
        const body = JSON.parse(String(init?.body)) as {
          artifactId: string;
        };
        return body.artifactId === "index"
          ? artifactACommit
          : jsonResponse({ commitSha: committedArtifactBSha });
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const onCommitted = vi.fn();

    const view = render(
      createElement(ArtifactEditor, {
        workspaceItemId: "workspace-one",
        artifact,
        onCommitted,
      })
    );

    fireEvent.change(await screen.findByDisplayValue("# Artifact A"), {
      target: { value: "# Edited A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit changes" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    view.rerender(
      createElement(ArtifactEditor, {
        workspaceItemId: "workspace-one",
        artifact: artifactB,
        onCommitted,
      })
    );
    const editorB = await screen.findByDisplayValue("# Artifact B");
    fireEvent.change(editorB, { target: { value: "# Edited B" } });
    expect(
      (
        screen.getByRole("button", {
          name: "Commit changes",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);

    await act(async () => {
      resolveArtifactACommit(jsonResponse({ commitSha: "d".repeat(40) }));
      await artifactACommit;
    });

    expect(screen.queryByText("Changes committed")).toBeNull();
    expect(onCommitted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Commit changes" }));

    expect(await screen.findByText("Changes committed")).toBeTruthy();
    const commitBodies = fetchMock.mock.calls
      .filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "POST"
      )
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
    expect(commitBodies[1]).toMatchObject({
      artifactId: "readme",
      baseCommitSha: artifactBCommitSha,
      content: "# Edited B",
      commitMessage: "Update README.md",
    });
    expect(onCommitted).toHaveBeenCalledOnce();
    expect(onCommitted).toHaveBeenCalledWith(committedArtifactBSha);
  });

  it("ignores a commit result after switching workspaces", async () => {
    const workspaceBBaseCommitSha = "e".repeat(40);
    const workspaceBCommitSha = "f".repeat(40);
    let resolveWorkspaceACommit!: (response: Response) => void;
    const workspaceACommit = new Promise<Response>((resolve) => {
      resolveWorkspaceACommit = resolve;
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (init?.method === "POST") {
          return url.includes("workspace-one")
            ? workspaceACommit
            : jsonResponse({ commitSha: workspaceBCommitSha });
        }
        return url.includes("workspace-one")
          ? artifactResponse("# Workspace A")
          : artifactResponse("# Workspace B", workspaceBBaseCommitSha);
      }
    );
    vi.stubGlobal("fetch", fetchMock);
    const onCommitted = vi.fn();

    const view = render(
      createElement(ArtifactEditor, {
        workspaceItemId: "workspace-one",
        artifact,
        onCommitted,
      })
    );

    fireEvent.change(await screen.findByDisplayValue("# Workspace A"), {
      target: { value: "# Edited A" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit changes" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    view.rerender(
      createElement(ArtifactEditor, {
        workspaceItemId: "workspace-two",
        artifact,
        onCommitted,
      })
    );
    const workspaceBEditor = await screen.findByDisplayValue("# Workspace B");

    await act(async () => {
      resolveWorkspaceACommit(jsonResponse({ commitSha: "d".repeat(40) }));
      await workspaceACommit;
    });

    expect(screen.queryByText("Changes committed")).toBeNull();
    expect(onCommitted).not.toHaveBeenCalled();

    fireEvent.change(workspaceBEditor, {
      target: { value: "# Edited B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit changes" }));

    expect(await screen.findByText("Changes committed")).toBeTruthy();
    const workspaceBCommitCall = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).includes("workspace-two") &&
        (init as RequestInit | undefined)?.method === "POST"
    );
    const workspaceBCommitBody = JSON.parse(
      String((workspaceBCommitCall?.[1] as RequestInit).body)
    );
    expect(workspaceBCommitBody).toMatchObject({
      artifactId: "index",
      baseCommitSha: workspaceBBaseCommitSha,
      content: "# Edited B",
    });
    expect(onCommitted).toHaveBeenCalledOnce();
    expect(onCommitted).toHaveBeenCalledWith(workspaceBCommitSha);
  });

  it("renders unsupported artifacts as read-only", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        artifactResponse("# Original", commitSha, artifact, false)
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      createElement(ArtifactEditor, {
        workspaceItemId: "workspace-one",
        artifact,
      })
    );

    const editor = (await screen.findByDisplayValue(
      "# Original"
    )) as HTMLTextAreaElement;
    expect(editor.disabled).toBe(true);
    expect(
      screen.getByText(
        "This artifact version is not supported by this workspace"
      )
    ).toBeTruthy();
    const commitButton = screen.getByRole("button", {
      name: "Commit changes",
    });
    expect((commitButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(commitButton);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("offers a refresh after a stale repository response and refetches", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(artifactResponse("# Original"))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: "stale_repository",
            currentHeadCommitSha: "e".repeat(40),
          },
          409
        )
      )
      .mockResolvedValueOnce(artifactResponse("# Fresh", "e".repeat(40)));
    vi.stubGlobal("fetch", fetchMock);

    render(
      createElement(ArtifactEditor, {
        workspaceItemId: "workspace-one",
        artifact,
      })
    );

    const editor = await screen.findByDisplayValue("# Original");
    fireEvent.change(editor, { target: { value: "# Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit changes" }));

    const refresh = await screen.findByRole("button", {
      name: "Refresh first",
    });
    fireEvent.click(refresh);

    expect(await screen.findByDisplayValue("# Fresh")).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "/api/workspace/items/workspace-one/repository/artifacts?artifactId=index"
    );
  });

  it("shows the server error code for a 422 response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(artifactResponse("# Original"))
      .mockResolvedValueOnce(
        jsonResponse({ error: "INVALID_ARTIFACT_CONTENT" }, 422)
      );
    vi.stubGlobal("fetch", fetchMock);

    render(
      createElement(ArtifactEditor, {
        workspaceItemId: "workspace-one",
        artifact,
      })
    );

    const editor = await screen.findByDisplayValue("# Original");
    fireEvent.change(editor, { target: { value: "invalid" } });
    fireEvent.click(screen.getByRole("button", { name: "Commit changes" }));

    expect(await screen.findByText("INVALID_ARTIFACT_CONTENT")).toBeTruthy();
  });
});
