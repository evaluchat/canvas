import { NextResponse } from "next/server";
import { isGithubResearchWorkspacesEnabled } from "@/lib/research-workspaces-enabled.server";
import { verifyUserAuthenticated } from "@/lib/supabase/verify_user_server";
import {
  getWorkspaceItem,
  updateResearchRepositoryBindingHead,
} from "@/lib/workspace/store";
import { getGithubInstallationRepository } from "@/lib/workspace/research-repository/github-app";
import {
  RepositoryAccessError,
  assertRepositoryWriteAccess,
  repositoryAccessBody,
  repositoryAccessHttpStatus,
} from "@/lib/workspace/research-repository/access";
import { readGithubResearchCredentials } from "@/lib/workspace/research-repository/credentials";
import {
  commitArtifactBlobs,
  getRepositoryBranchHead,
  StaleRepositoryError,
} from "@/lib/workspace/research-repository/git-adapter";
import {
  RepositoryLayoutError,
  resolveRepositoryArtifactPath,
  validateRepositoryArtifactContent,
} from "@/lib/workspace/research-repository/layout";
import {
  claimRepositoryOperation,
  completeRepositoryOperation,
  failRepositoryOperation,
  recordRepositoryOperationResult,
  RepositoryOperationInProgressError,
  startRepositoryOperation,
} from "@/lib/workspace/research-repository/operations";
import { repositoryRouteErrorDetails } from "@/lib/workspace/research-repository/route-errors";
import {
  artifactKindFromId,
  validateArtifactFrontMatter,
} from "@/lib/workspace/research-repository/authoring";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function requestBody(value: unknown):
  | {
      artifactId: string;
      baseCommitSha: string;
      content: string;
      commitMessage: string;
      idempotencyKey: string;
    }
  | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const body = value as Record<string, unknown>;
  if (
    typeof body.artifactId !== "string" ||
    typeof body.baseCommitSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(body.baseCommitSha) ||
    typeof body.content !== "string" ||
    typeof body.commitMessage !== "string" ||
    !body.commitMessage.trim() ||
    body.commitMessage.length > 500 ||
    typeof body.idempotencyKey !== "string" ||
    body.idempotencyKey.length < 16 ||
    body.idempotencyKey.length > 200
  ) {
    return;
  }
  return {
    artifactId: body.artifactId,
    baseCommitSha: body.baseCommitSha,
    content: body.content,
    commitMessage: body.commitMessage,
    idempotencyKey: body.idempotencyKey,
  };
}

export async function POST(request: Request, context: RouteContext) {
  if (!isGithubResearchWorkspacesEnabled()) {
    return json({ error: "Not found" }, 404);
  }
  const auth = await verifyUserAuthenticated();
  if (!auth?.user) return json({ error: "Unauthorized" }, 401);

  let unparsed: unknown;
  try {
    unparsed = await request.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }
  const body = requestBody(unparsed);
  if (!body) return json({ error: "Invalid request body" }, 400);

  const { id } = await context.params;
  const item = await getWorkspaceItem(auth.user.id, id);
  if (!item || item.kind !== "research_repository") {
    return json({ error: "Research repository not found" }, 404);
  }

  let artifact;
  try {
    artifact = resolveRepositoryArtifactPath(
      body.artifactId,
      item.binding.layoutVersion
    );
    validateRepositoryArtifactContent(artifact.path, body.content);
  } catch (error) {
    if (error instanceof RepositoryLayoutError) {
      return json(
        { error: error.code },
        error.code === "ARTIFACT_TOO_LARGE" ? 413 : 422
      );
    }
    throw error;
  }

  try {
    await assertRepositoryWriteAccess({
      installationId: item.binding.installationId,
      repositoryId: item.binding.repositoryId,
      branch: item.binding.branch,
      expectedHeadSha: item.binding.headCommitSha,
      files: [artifact.path],
    });
  } catch (error) {
    if (error instanceof RepositoryAccessError) {
      return json(
        repositoryAccessBody(error),
        repositoryAccessHttpStatus(error.code)
      );
    }
    throw error;
  }

  let operation;
  try {
    operation = await claimRepositoryOperation(auth.user.id, {
      workspaceId: item.id,
      kind: "commit",
      idempotencyKey: body.idempotencyKey,
      artifactIds: [artifact.artifactId],
      baseCommitSha: body.baseCommitSha,
      getCurrentHeadCommitSha: async () => {
        const credentials = await readGithubResearchCredentials(auth.user.id);
        if (
          !credentials ||
          credentials.installationId !== item.binding.installationId ||
          !credentials.repositoryIds.includes(item.binding.repositoryId)
        ) {
          throw new Error("Research repository is disconnected");
        }
        const repository = await getGithubInstallationRepository(
          item.binding.installationId,
          item.binding.repositoryId
        );
        return getRepositoryBranchHead(
          item.binding.installationId,
          repository,
          item.binding.branch
        );
      },
    });
  } catch (error) {
    if (error instanceof RepositoryOperationInProgressError) {
      return json({ error: "repository_operation_in_progress" }, 409);
    }
    console.error(
      "[github-research] failed to claim repository operation",
      repositoryRouteErrorDetails(item.id, error)
    );
    if (error instanceof RepositoryLayoutError) {
      return json({ error: error.code }, 422);
    }
    return json({ error: "Could not commit repository artifact" }, 500);
  }

  if (
    (operation.status === "succeeded" || operation.status === "failed") &&
    operation.resultCommitSha
  ) {
    try {
      if (item.binding.headCommitSha !== operation.resultCommitSha) {
        await updateResearchRepositoryBindingHead(
          auth.user.id,
          item.id,
          operation.resultCommitSha
        );
      }
    } catch (error) {
      console.error(
        "[github-research] failed to repair repository binding head",
        repositoryRouteErrorDetails(item.id, error)
      );
      if (error instanceof RepositoryLayoutError) {
        return json({ error: error.code }, 422);
      }
      return json({ error: "Could not record repository commit" }, 500);
    }
    return json({
      operationId: operation.operationId,
      commitSha: operation.resultCommitSha,
    });
  }
  if (operation.status === "failed") {
    const errorCode = operation.errorCode ?? "REPOSITORY_OPERATION_FAILED";
    return json(
      { error: errorCode.toLowerCase() },
      errorCode === "STALE_REPOSITORY" ||
        errorCode === "REPOSITORY_DISCONNECTED"
        ? 409
        : 500
    );
  }

  if (artifactKindFromId(artifact.artifactId)) {
    const validation = validateArtifactFrontMatter(
      artifact.artifactId,
      body.content
    );
    if (!validation.ok) {
      return json({ error: "INVALID_FRONT_MATTER" }, 422);
    }
  }

  try {
    operation = await startRepositoryOperation(auth.user.id, operation);
  } catch (error) {
    console.error(
      "[github-research] failed to start repository operation",
      repositoryRouteErrorDetails(item.id, error)
    );
    if (error instanceof RepositoryLayoutError) {
      return json({ error: error.code }, 422);
    }
    return json({ error: "Could not commit repository artifact" }, 500);
  }

  let credentials;
  try {
    credentials = await readGithubResearchCredentials(auth.user.id);
  } catch (error) {
    try {
      await failRepositoryOperation(
        auth.user.id,
        operation,
        "CREDENTIAL_READ_FAILED"
      );
    } catch {
      // Preserve the credential failure as the response cause.
    }
    console.error(
      "[github-research] failed to read repository credentials",
      repositoryRouteErrorDetails(item.id, error)
    );
    if (error instanceof RepositoryLayoutError) {
      return json({ error: error.code }, 422);
    }
    return json({ error: "Could not authorize research repository" }, 500);
  }
  if (
    !credentials ||
    credentials.installationId !== item.binding.installationId ||
    !credentials.repositoryIds.includes(item.binding.repositoryId)
  ) {
    try {
      await failRepositoryOperation(
        auth.user.id,
        operation,
        "REPOSITORY_DISCONNECTED"
      );
    } catch {
      // The disconnected response is still authoritative.
    }
    return json({ error: "Research repository is disconnected" }, 409);
  }

  let commitSha: string;
  try {
    const repository = await getGithubInstallationRepository(
      item.binding.installationId,
      item.binding.repositoryId
    );
    const metadata = credentials.displayMetadata;
    const githubLogin =
      typeof metadata.login === "string" ? metadata.login : undefined;
    const githubUserId =
      typeof metadata.githubUserId === "number"
        ? metadata.githubUserId
        : undefined;
    const authorUser =
      githubLogin && githubUserId
        ? {
            name: githubLogin,
            email: `${githubUserId}+${githubLogin}@users.noreply.github.com`,
          }
        : undefined;
    commitSha = await commitArtifactBlobs(
      item.binding.installationId,
      repository,
      item.binding.branch,
      {
        authorUser,
        message: body.commitMessage,
        baseSha: body.baseCommitSha,
        files: [{ path: artifact.path, content: body.content }],
      }
    );
  } catch (error) {
    const stale = error instanceof StaleRepositoryError;
    try {
      await failRepositoryOperation(
        auth.user.id,
        operation,
        stale ? "STALE_REPOSITORY" : "COMMIT_FAILED"
      );
    } catch (storeError) {
      console.error(
        "[github-research] failed to record commit failure",
        repositoryRouteErrorDetails(item.id, storeError)
      );
    }
    if (stale) {
      return json(
        {
          error: "stale_repository",
          currentHeadCommitSha: error.currentHeadCommitSha,
        },
        409
      );
    }
    console.error(
      "[github-research] failed to commit repository artifact",
      repositoryRouteErrorDetails(item.id, error)
    );
    if (error instanceof RepositoryLayoutError) {
      return json({ error: error.code }, 422);
    }
    return json({ error: "Could not commit repository artifact" }, 500);
  }

  try {
    operation = await recordRepositoryOperationResult(
      auth.user.id,
      operation,
      commitSha
    );
  } catch (error) {
    try {
      await failRepositoryOperation(
        auth.user.id,
        operation,
        "COMMIT_LANDED_RESULT_RECORD_FAILED",
        commitSha
      );
    } catch (storeError) {
      console.error(
        "[github-research] failed to record landed commit failure",
        repositoryRouteErrorDetails(item.id, storeError)
      );
    }
    console.error(
      "[github-research] failed to record landed repository commit",
      repositoryRouteErrorDetails(item.id, error)
    );
    if (error instanceof RepositoryLayoutError) {
      return json({ error: error.code }, 422);
    }
    return json({ error: "Could not record repository commit" }, 500);
  }

  try {
    await updateResearchRepositoryBindingHead(auth.user.id, item.id, commitSha);
  } catch (error) {
    try {
      await failRepositoryOperation(
        auth.user.id,
        operation,
        "COMMIT_LANDED_HEAD_UPDATE_FAILED",
        commitSha
      );
    } catch (storeError) {
      console.error(
        "[github-research] failed to record binding-head failure",
        repositoryRouteErrorDetails(item.id, storeError)
      );
    }
    console.error(
      "[github-research] failed to update repository binding head",
      repositoryRouteErrorDetails(item.id, error)
    );
    if (error instanceof RepositoryLayoutError) {
      return json({ error: error.code }, 422);
    }
    return json({ error: "Could not record repository commit" }, 500);
  }

  try {
    const completed = await completeRepositoryOperation(
      auth.user.id,
      operation,
      commitSha
    );
    return json({ operationId: completed.operationId, commitSha });
  } catch (error) {
    try {
      await failRepositoryOperation(
        auth.user.id,
        operation,
        "COMMIT_LANDED_OPERATION_COMPLETE_FAILED",
        commitSha
      );
    } catch (storeError) {
      console.error(
        "[github-research] failed to record completion failure",
        repositoryRouteErrorDetails(item.id, storeError)
      );
    }
    console.error(
      "[github-research] failed to complete repository operation",
      repositoryRouteErrorDetails(item.id, error)
    );
    if (error instanceof RepositoryLayoutError) {
      return json({ error: error.code }, 422);
    }
    return json({ error: "Could not record repository commit" }, 500);
  }
}
