import { createHash } from "node:crypto";
import { RepositoryArtifactRefSchema } from "@opencanvas/shared/research-repository";
import type { RepositoryArtifactRef } from "@opencanvas/shared/research-repository";
import {
  createGithubInstallationOctokit,
  getGithubRepositoryBranchHead,
} from "./github-app";
import {
  identifyRepositoryArtifactPath,
  RepositoryLayoutError,
  validateRepositoryArtifactContent,
  validateRepositoryArtifactCount,
  validateRepositoryArtifactMode,
} from "./layout";

const GITHUB_API_VERSION = "2022-11-28";

export type GithubRepositoryCoordinates = { owner: string; name: string };

export type GithubCommitAuthor = {
  name: string;
  email: string;
  date?: string;
};

export const GITHUB_RESEARCH_APP_COMMITTER = {
  name: "Evaluchat GitHub App",
  email: "github-app@evaluchat.org",
} as const;

export class StaleRepositoryError extends Error {
  constructor(public readonly currentHeadCommitSha: string) {
    super("The research repository head has changed");
    this.name = "StaleRepositoryError";
  }
}

export async function getRepositoryBranchHead(
  installationId: number,
  repository: GithubRepositoryCoordinates,
  branch: string
): Promise<string> {
  return getGithubRepositoryBranchHead(installationId, repository, branch);
}

type TreeEntry = {
  path: string;
  mode: string;
  type: string;
  sha: string;
};

function headers() {
  return { "x-github-api-version": GITHUB_API_VERSION };
}

function repositoryParameters(repository: GithubRepositoryCoordinates) {
  return { owner: repository.owner, repo: repository.name };
}

function githubErrorStatus(error: unknown): number | undefined {
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  const status =
    candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status;
  return typeof status === "number" ? status : undefined;
}

async function repositoryTree(
  installationId: number,
  repository: GithubRepositoryCoordinates,
  commitSha: string
): Promise<TreeEntry[]> {
  const octokit = createGithubInstallationOctokit(installationId);
  const commitResponse = await octokit.request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    {
      ...repositoryParameters(repository),
      commit_sha: commitSha,
      headers: headers(),
    }
  );
  const treeSha = (commitResponse.data as { tree?: { sha?: unknown } }).tree
    ?.sha;
  if (typeof treeSha !== "string") {
    throw new Error("GitHub returned an invalid commit tree");
  }
  const treeResponse = await octokit.request(
    "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
    {
      ...repositoryParameters(repository),
      tree_sha: treeSha,
      recursive: "1",
      headers: headers(),
    }
  );
  const data = treeResponse.data as {
    truncated?: unknown;
    tree?: Array<{
      path?: unknown;
      mode?: unknown;
      type?: unknown;
      sha?: unknown;
    }>;
  };
  if (data.truncated === true || !Array.isArray(data.tree)) {
    throw new Error("GitHub returned an incomplete repository tree");
  }
  return data.tree
    .filter(
      (entry): entry is TreeEntry =>
        typeof entry.path === "string" &&
        typeof entry.mode === "string" &&
        typeof entry.type === "string" &&
        typeof entry.sha === "string"
    )
    .map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      type: entry.type,
      sha: entry.sha,
    }));
}

async function readBlobBuffer(
  installationId: number,
  repository: GithubRepositoryCoordinates,
  blobSha: string
): Promise<Buffer> {
  const octokit = createGithubInstallationOctokit(installationId);
  const response = await octokit.request(
    "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
    {
      ...repositoryParameters(repository),
      file_sha: blobSha,
      headers: headers(),
    }
  );
  const blob = response.data as { content?: unknown; encoding?: unknown };
  if (typeof blob.content !== "string" || blob.encoding !== "base64") {
    throw new Error("GitHub returned an invalid repository blob");
  }
  return Buffer.from(blob.content.replace(/\s/g, ""), "base64");
}

export async function resolveArtifactBlobSha(
  installationId: number,
  repository: GithubRepositoryCoordinates,
  branch: string,
  path: string
): Promise<string | undefined> {
  const commitSha = await getGithubRepositoryBranchHead(
    installationId,
    repository,
    branch
  );
  const tree = await repositoryTree(installationId, repository, commitSha);
  return tree.find((entry) => entry.path === path && entry.type === "blob")
    ?.sha;
}

export async function listRepositoryArtifactRefs(
  installationId: number,
  repository: GithubRepositoryCoordinates,
  branch: string,
  layoutVersion = "1.0"
): Promise<{ artifacts: RepositoryArtifactRef[]; commitSha: string }> {
  const commitSha = await getGithubRepositoryBranchHead(
    installationId,
    repository,
    branch
  );
  const tree = await repositoryTree(installationId, repository, commitSha);
  const managed = tree.flatMap((entry) => {
    if (entry.type !== "blob") return [];
    const artifact = identifyRepositoryArtifactPath(entry.path, layoutVersion);
    return artifact ? [{ entry, artifact }] : [];
  });
  validateRepositoryArtifactCount(managed.length);

  const artifactIds = new Set<string>();
  const artifacts = await Promise.all(
    managed.map(async ({ entry, artifact }) => {
      if (artifactIds.has(artifact.artifactId)) {
        throw new Error(`Duplicate managed artifact id ${artifact.artifactId}`);
      }
      artifactIds.add(artifact.artifactId);
      validateRepositoryArtifactMode(entry.path, entry.mode);
      const buffer = await readBlobBuffer(
        installationId,
        repository,
        entry.sha
      );
      const content = buffer.toString("utf8");
      validateRepositoryArtifactContent(entry.path, content);
      return RepositoryArtifactRefSchema.parse({
        ...artifact,
        commitSha,
        blobSha: entry.sha,
        contentSha256: createHash("sha256").update(buffer).digest("hex"),
      });
    })
  );

  return {
    artifacts: artifacts.sort((left, right) =>
      left.path.localeCompare(right.path)
    ),
    commitSha,
  };
}

export async function commitArtifactBlobs(
  installationId: number,
  repository: GithubRepositoryCoordinates,
  branch: string,
  input: {
    authorUser?: GithubCommitAuthor;
    message: string;
    baseSha: string;
    files: Array<{ path: string; content: string }>;
  }
): Promise<string> {
  if (!/^[0-9a-f]{40}$/.test(input.baseSha)) {
    throw new Error("Invalid base commit SHA");
  }
  if (!input.message.trim() || input.files.length === 0) {
    throw new Error("A commit message and at least one artifact are required");
  }
  validateRepositoryArtifactCount(input.files.length);
  const paths = new Set<string>();
  for (const file of input.files) {
    validateRepositoryArtifactContent(file.path, file.content);
    if (paths.has(file.path))
      throw new RepositoryLayoutError(
        "INVALID_ARTIFACT_PATH",
        `Duplicate artifact path ${file.path}`
      );
    paths.add(file.path);
  }

  const currentHead = await getGithubRepositoryBranchHead(
    installationId,
    repository,
    branch
  );
  if (currentHead !== input.baseSha) {
    throw new StaleRepositoryError(currentHead);
  }

  const octokit = createGithubInstallationOctokit(installationId);
  const baseCommit = await octokit.request(
    "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
    {
      ...repositoryParameters(repository),
      commit_sha: input.baseSha,
      headers: headers(),
    }
  );
  const baseTree = (baseCommit.data as { tree?: { sha?: unknown } }).tree?.sha;
  if (typeof baseTree !== "string") {
    throw new Error("GitHub returned an invalid base tree");
  }

  const entries = await Promise.all(
    input.files.map(async (file) => {
      const response = await octokit.request(
        "POST /repos/{owner}/{repo}/git/blobs",
        {
          ...repositoryParameters(repository),
          content: file.content,
          encoding: "utf-8",
          headers: headers(),
        }
      );
      const sha = (response.data as { sha?: unknown }).sha;
      if (typeof sha !== "string") {
        throw new Error("GitHub returned an invalid blob SHA");
      }
      return {
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha,
      };
    })
  );

  const treeResponse = await octokit.request(
    "POST /repos/{owner}/{repo}/git/trees",
    {
      ...repositoryParameters(repository),
      base_tree: baseTree,
      tree: entries,
      headers: headers(),
    }
  );
  const treeSha = (treeResponse.data as { sha?: unknown }).sha;
  if (typeof treeSha !== "string") {
    throw new Error("GitHub returned an invalid new tree SHA");
  }

  const commitResponse = await octokit.request(
    "POST /repos/{owner}/{repo}/git/commits",
    {
      ...repositoryParameters(repository),
      message: input.message,
      tree: treeSha,
      parents: [input.baseSha],
      // V08-10: keep author+committer on the configured app identity when the
      // researcher identity is absent. Never attribute to VALERY_GITHUB_TOKEN.
      author: input.authorUser ?? GITHUB_RESEARCH_APP_COMMITTER,
      committer: GITHUB_RESEARCH_APP_COMMITTER,
      headers: headers(),
    }
  );
  const commitSha = (commitResponse.data as { sha?: unknown }).sha;
  if (typeof commitSha !== "string") {
    throw new Error("GitHub returned an invalid commit SHA");
  }

  try {
    await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
      ...repositoryParameters(repository),
      ref: `heads/${branch}`,
      sha: commitSha,
      force: false,
      headers: headers(),
    });
  } catch (error) {
    if (githubErrorStatus(error) !== 422) throw error;
    const refreshedHead = await getGithubRepositoryBranchHead(
      installationId,
      repository,
      branch
    );
    throw new StaleRepositoryError(refreshedHead);
  }
  return commitSha;
}

export async function readArtifactBlob(
  installationId: number,
  repository: GithubRepositoryCoordinates,
  branch: string,
  path: string
): Promise<{ content: string; blobSha: string; commitSha: string }> {
  const commitSha = await getGithubRepositoryBranchHead(
    installationId,
    repository,
    branch
  );
  const tree = await repositoryTree(installationId, repository, commitSha);
  const entry = tree.find(
    (candidate) => candidate.path === path && candidate.type === "blob"
  );
  if (!entry)
    throw Object.assign(new Error("Artifact not found"), { status: 404 });
  validateRepositoryArtifactMode(entry.path, entry.mode);
  const content = (
    await readBlobBuffer(installationId, repository, entry.sha)
  ).toString("utf8");
  validateRepositoryArtifactContent(path, content);
  return { content, blobSha: entry.sha, commitSha };
}
