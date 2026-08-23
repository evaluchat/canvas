import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  getRepository: vi.fn(),
  getHead: vi.fn(),
}));

vi.mock("./github-app", () => ({
  getGithubInstallationRepository: harness.getRepository,
}));
vi.mock("./git-adapter", () => ({
  getRepositoryBranchHead: harness.getHead,
}));

import {
  REPOSITORY_CHANGED,
  REPOSITORY_READ_ONLY,
  REPOSITORY_UNAVAILABLE,
  assertRepositoryWriteAccess,
  loadInstallationRepository,
} from "./access";

const head = "a".repeat(40);
const otherHead = "b".repeat(40);
const repository = {
  owner: "octocat",
  name: "private",
  private: true,
};

describe("repository access guards", () => {
  beforeEach(() => {
    for (const method of Object.values(harness)) method.mockReset();
    harness.getRepository.mockResolvedValue(repository);
    harness.getHead.mockResolvedValue(head);
  });

  it("maps a GitHub 404 to REPOSITORY_UNAVAILABLE", async () => {
    harness.getRepository.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    await expect(loadInstallationRepository(99, 101)).rejects.toMatchObject({
      code: REPOSITORY_UNAVAILABLE,
    });
  });

  it("rejects writes when the repository is public", async () => {
    harness.getRepository.mockResolvedValue({ ...repository, private: false });

    await expect(
      assertRepositoryWriteAccess({
        installationId: 99,
        repositoryId: 101,
        branch: "evaluchat/workspace",
        expectedHeadSha: head,
        files: ["index.md"],
      })
    ).rejects.toMatchObject({
      code: REPOSITORY_READ_ONLY,
    });
    expect(harness.getHead).not.toHaveBeenCalled();
  });

  it("rejects writes when the stored head no longer matches", async () => {
    harness.getHead.mockResolvedValue(otherHead);

    await expect(
      assertRepositoryWriteAccess({
        installationId: 99,
        repositoryId: 101,
        branch: "evaluchat/workspace",
        expectedHeadSha: head,
        files: ["index.md"],
      })
    ).rejects.toMatchObject({
      code: REPOSITORY_CHANGED,
      files: ["index.md"],
    });
  });
});
