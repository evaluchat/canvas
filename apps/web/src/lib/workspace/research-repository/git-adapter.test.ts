import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  request: vi.fn(),
  getHead: vi.fn(),
  createOctokit: vi.fn(),
}));

vi.mock("./github-app", () => ({
  createGithubInstallationOctokit: harness.createOctokit,
  getGithubRepositoryBranchHead: harness.getHead,
}));

import { createHash } from "node:crypto";
import {
  commitArtifactBlobs,
  GITHUB_RESEARCH_APP_COMMITTER,
  listRepositoryArtifactRefs,
  StaleRepositoryError,
} from "./git-adapter";
import { RepositoryLayoutError } from "./layout";

const repository = { owner: "octocat", name: "private" };
const baseSha = "a".repeat(40);
const baseTreeSha = "b".repeat(40);
const blobSha = "c".repeat(40);
const treeSha = "d".repeat(40);
const commitSha = "e".repeat(40);

describe("GitHub repository Git Data adapter", () => {
  beforeEach(() => {
    for (const method of Object.values(harness)) method.mockReset();
    harness.createOctokit.mockReturnValue({ request: harness.request });
    harness.getHead.mockResolvedValue(baseSha);
  });

  it("creates blob, tree, commit, and a non-forced CAS ref update", async () => {
    harness.request.mockImplementation(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        return { data: { tree: { sha: baseTreeSha } } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/blobs") {
        return { data: { sha: blobSha } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/trees") {
        return { data: { sha: treeSha } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/commits") {
        return { data: { sha: commitSha } };
      }
      if (route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}") {
        return { data: {} };
      }
      throw new Error(`Unexpected route ${route}`);
    });

    await expect(
      commitArtifactBlobs(99, repository, "evaluchat/workspace", {
        authorUser: { name: "Researcher", email: "r@example.test" },
        message: "Update index",
        baseSha,
        files: [{ path: "index.md", content: "# Updated\n" }],
      })
    ).resolves.toBe(commitSha);

    expect(harness.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/git/trees",
      expect.objectContaining({
        base_tree: baseTreeSha,
        tree: [
          { path: "index.md", mode: "100644", type: "blob", sha: blobSha },
        ],
      })
    );
    expect(harness.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/git/commits",
      expect.objectContaining({
        tree: treeSha,
        parents: [baseSha],
        author: { name: "Researcher", email: "r@example.test" },
        committer: GITHUB_RESEARCH_APP_COMMITTER,
      })
    );
    expect(GITHUB_RESEARCH_APP_COMMITTER).toEqual({
      name: "Evaluchat GitHub App",
      email: "github-app@evaluchat.org",
    });
    expect(harness.request).toHaveBeenCalledWith(
      "PATCH /repos/{owner}/{repo}/git/refs/{ref}",
      expect.objectContaining({
        ref: "heads/evaluchat/workspace",
        sha: commitSha,
        force: false,
      })
    );
  });

  it("uses the configured app identity for both author and committer when none is supplied", async () => {
    harness.request.mockImplementation(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        return { data: { tree: { sha: baseTreeSha } } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/blobs") {
        return { data: { sha: blobSha } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/trees") {
        return { data: { sha: treeSha } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/commits") {
        return { data: { sha: commitSha } };
      }
      if (route === "PATCH /repos/{owner}/{repo}/git/refs/{ref}") {
        return { data: {} };
      }
      throw new Error(`Unexpected route ${route}`);
    });

    await commitArtifactBlobs(99, repository, "evaluchat/workspace", {
      message: "Update index",
      baseSha,
      files: [{ path: "index.md", content: "# Updated\n" }],
    });

    expect(harness.request).toHaveBeenCalledWith(
      "POST /repos/{owner}/{repo}/git/commits",
      expect.objectContaining({
        author: GITHUB_RESEARCH_APP_COMMITTER,
        committer: GITHUB_RESEARCH_APP_COMMITTER,
      })
    );
    expect(JSON.stringify(harness.request.mock.calls)).not.toContain("Valery");
    expect(JSON.stringify(harness.request.mock.calls)).not.toContain(
      "VALERY_GITHUB_TOKEN"
    );
  });

  it("rejects a stale base before creating blobs", async () => {
    const currentHead = "f".repeat(40);
    harness.getHead.mockResolvedValue(currentHead);

    await expect(
      commitArtifactBlobs(99, repository, "evaluchat/workspace", {
        message: "Update index",
        baseSha,
        files: [{ path: "index.md", content: "# Updated\n" }],
      })
    ).rejects.toMatchObject<Partial<StaleRepositoryError>>({
      currentHeadCommitSha: currentHead,
    });
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("maps a non-fast-forward 422 to the refreshed current head", async () => {
    const refreshedHead = "f".repeat(40);
    harness.getHead
      .mockResolvedValueOnce(baseSha)
      .mockResolvedValue(refreshedHead);
    harness.request.mockImplementation(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        return { data: { tree: { sha: baseTreeSha } } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/blobs") {
        return { data: { sha: blobSha } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/trees") {
        return { data: { sha: treeSha } };
      }
      if (route === "POST /repos/{owner}/{repo}/git/commits") {
        return { data: { sha: commitSha } };
      }
      throw Object.assign(new Error("Update is not a fast forward"), {
        status: 422,
      });
    });

    await expect(
      commitArtifactBlobs(99, repository, "evaluchat/workspace", {
        message: "Update index",
        baseSha,
        files: [{ path: "index.md", content: "# Updated\n" }],
      })
    ).rejects.toMatchObject({ currentHeadCommitSha: refreshedHead });
  });

  it("ignores unsafe unmanaged names while loading only managed blobs", async () => {
    harness.request.mockImplementation(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        return { data: { tree: { sha: baseTreeSha } } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
        return {
          data: {
            tree: [
              { path: "index.md", mode: "100644", type: "blob", sha: blobSha },
              {
                path: "notes.lnk",
                mode: "100644",
                type: "blob",
                sha: treeSha,
              },
              {
                path: "foo->bar.md",
                mode: "100644",
                type: "blob",
                sha: treeSha,
              },
            ],
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/git/blobs/{file_sha}") {
        return {
          data: {
            content: Buffer.from("# Index\n").toString("base64"),
            encoding: "base64",
          },
        };
      }
      throw new Error(`Unexpected route ${route}`);
    });

    await expect(
      listRepositoryArtifactRefs(99, repository, "evaluchat/workspace")
    ).resolves.toMatchObject({
      commitSha: baseSha,
      artifacts: [
        {
          artifactId: "index",
          path: "index.md",
          commitSha: baseSha,
          blobSha,
        },
      ],
    });
    expect(harness.request).toHaveBeenCalledWith(
      "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
      expect.objectContaining({ file_sha: blobSha })
    );
  });

  it("hashes managed blob bytes deterministically and ignores gitlink/submodule entries", async () => {
    const content = "# Index\n";
    const expectedHash = createHash("sha256").update(content).digest("hex");
    harness.request.mockImplementation(async (route: string) => {
      if (route === "GET /repos/{owner}/{repo}/git/commits/{commit_sha}") {
        return { data: { tree: { sha: baseTreeSha } } };
      }
      if (route === "GET /repos/{owner}/{repo}/git/trees/{tree_sha}") {
        return {
          data: {
            tree: [
              { path: "index.md", mode: "100644", type: "blob", sha: blobSha },
              {
                path: "vendor/lib",
                mode: "160000",
                type: "commit",
                sha: "0".repeat(40),
              },
              {
                path: ".gitmodules",
                mode: "100644",
                type: "blob",
                sha: treeSha,
              },
            ],
          },
        };
      }
      if (route === "GET /repos/{owner}/{repo}/git/blobs/{file_sha}") {
        return {
          data: {
            content: Buffer.from(content).toString("base64"),
            encoding: "base64",
          },
        };
      }
      throw new Error(`Unexpected route ${route}`);
    });

    const first = await listRepositoryArtifactRefs(
      99,
      repository,
      "evaluchat/workspace"
    );
    const second = await listRepositoryArtifactRefs(
      99,
      repository,
      "evaluchat/workspace"
    );

    expect(first.artifacts).toEqual([
      {
        artifactId: "index",
        kind: "index",
        path: "index.md",
        commitSha: baseSha,
        blobSha,
        contentSha256: expectedHash,
      },
    ]);
    expect(first).toEqual(second);
    expect(first.artifacts[0]?.contentSha256).toBe(expectedHash);
  });

  it("rejects an unsafe sibling in a managed commit", async () => {
    await expect(
      commitArtifactBlobs(99, repository, "evaluchat/workspace", {
        message: "Update index",
        baseSha,
        files: [
          { path: "index.md", content: "# Updated\n" },
          { path: "notes.lnk", content: "unsafe" },
        ],
      })
    ).rejects.toThrow(/Symbolic-link-looking/);
    expect(harness.getHead).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
  });

  it("rejects duplicate artifact paths with a layout error code", async () => {
    const duplicatePath = "index.md";

    await expect(
      commitArtifactBlobs(99, repository, "evaluchat/workspace", {
        message: "Update notes",
        baseSha,
        files: [
          { path: duplicatePath, content: "First\n" },
          { path: duplicatePath, content: "Second\n" },
        ],
      })
    ).rejects.toMatchObject<Partial<RepositoryLayoutError>>({
      code: "INVALID_ARTIFACT_PATH",
    });
    expect(harness.getHead).not.toHaveBeenCalled();
    expect(harness.request).not.toHaveBeenCalled();
  });
});
