import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { isGithubResearchWorkspacesEnabled } from "@/lib/research-workspaces-enabled.server";
import { verifyUserAuthenticated } from "@/lib/supabase/verify_user_server";
import {
  getWorkspaceItem,
  updateResearchRepositoryBindingHead,
} from "@/lib/workspace/store";
import { readGithubResearchCredentials } from "@/lib/workspace/research-repository/credentials";
import {
  StaleRepositoryError,
  type GithubCommitAuthor,
} from "@/lib/workspace/research-repository/git-adapter";
import { getGithubInstallationRepository } from "@/lib/workspace/research-repository/github-app";
import { RepositoryLayoutError } from "@/lib/workspace/research-repository/layout";
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
  commitSealSnapshot,
  previewSealSnapshot,
  SealSnapshotError,
  supersedeSeal,
  type RepositorySealAccess,
  type SealSnapshotPreview,
} from "@/lib/workspace/research-repository/seals";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

type PreviewReference = {
  snapshotId: string;
  sealedFromCommit?: string;
  reviewedAt?: string;
  configurationHash?: string;
  renderHash?: string;
};

type SealRequest =
  | { action: "preview" }
  | { action: "seal"; preview: PreviewReference }
  | { action: "supersede"; supersedes: string };

const SNAPSHOT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function stringField(
  value: Record<string, unknown>,
  camel: string,
  snake: string
): string | undefined {
  const candidate = value[camel] ?? value[snake];
  return typeof candidate === "string" ? candidate : undefined;
}

function previewReference(value: unknown): PreviewReference | undefined {
  if (typeof value === "string") return { snapshotId: value };
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const candidate = value as Record<string, unknown>;
  const snapshotId = stringField(candidate, "snapshotId", "snapshot_id");
  if (!snapshotId || !SNAPSHOT_ID.test(snapshotId)) return;
  const sealedFromCommit = stringField(
    candidate,
    "sealedFromCommit",
    "sealed_from_commit"
  );
  if (sealedFromCommit && !/^[0-9a-f]{40}$/.test(sealedFromCommit)) return;
  return {
    snapshotId,
    sealedFromCommit,
    reviewedAt: stringField(candidate, "reviewedAt", "reviewed_at"),
    configurationHash: stringField(
      candidate,
      "configurationHash",
      "configuration_hash"
    ),
    renderHash: stringField(candidate, "renderHash", "render_hash"),
  };
}

function requestBody(value: unknown): SealRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const candidate = value as Record<string, unknown>;
  if (candidate.action === "preview") return { action: "preview" };
  if (candidate.action === "seal") {
    const preview = previewReference(candidate.preview);
    return preview ? { action: "seal", preview } : undefined;
  }
  if (
    candidate.action === "supersede" &&
    typeof candidate.supersedes === "string" &&
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(candidate.supersedes) &&
    candidate.supersedes.length <= 128
  ) {
    return { action: "supersede", supersedes: candidate.supersedes };
  }
  return;
}

function authorFor(
  access: RepositorySealAccess
): GithubCommitAuthor | undefined {
  const login = access.credentials.displayMetadata.login;
  const userId = access.credentials.displayMetadata.githubUserId;
  return typeof login === "string" && typeof userId === "number"
    ? {
        name: login,
        email: `${userId}+${login}@users.noreply.github.com`,
      }
    : undefined;
}

function operationKey(value: string): string {
  return `seal:${createHash("sha256").update(value).digest("hex")}`;
}

function sealError(error: unknown) {
  if (error instanceof StaleRepositoryError) {
    return json(
      {
        error: "stale_repository",
        currentHeadCommitSha: error.currentHeadCommitSha,
      },
      409
    );
  }
  if (error instanceof RepositoryOperationInProgressError) {
    return json({ error: "repository_operation_in_progress" }, 409);
  }
  if (error instanceof SealSnapshotError) {
    return json(
      { error: error.code },
      error.code === "UNKNOWN_SNAPSHOT" ? 404 : 422
    );
  }
  if (error instanceof RepositoryLayoutError) {
    return json({ error: error.code }, 422);
  }
}

function matchesPreview(
  accepted: PreviewReference,
  resolved: SealSnapshotPreview
): boolean {
  return (
    (!accepted.sealedFromCommit ||
      accepted.sealedFromCommit === resolved.sealedFromCommit) &&
    (!accepted.configurationHash ||
      accepted.configurationHash === resolved.configurationHash) &&
    (!accepted.renderHash || accepted.renderHash === resolved.renderHash)
  );
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

  if (body.action === "preview") {
    try {
      const credentials = await readGithubResearchCredentials(auth.user.id);
      if (
        !credentials ||
        credentials.installationId !== item.binding.installationId ||
        !credentials.repositoryIds.includes(item.binding.repositoryId)
      ) {
        return json({ error: "Research repository is disconnected" }, 409);
      }
      const repository = await getGithubInstallationRepository(
        item.binding.installationId,
        item.binding.repositoryId
      );
      const preview = await previewSealSnapshot({
        binding: item.binding,
        credentials,
        repository,
      });
      return json({ preview });
    } catch (error) {
      const response = sealError(error);
      if (response) return response;
      console.error(
        "[github-research] failed to preview repository seal",
        repositoryRouteErrorDetails(item.id, error)
      );
      return json({ error: "Could not preview repository seal" }, 500);
    }
  }

  const proposedSnapshotId =
    body.action === "seal" ? body.preview.snapshotId : randomUUID();
  const baseCommitSha =
    body.action === "seal"
      ? (body.preview.sealedFromCommit ?? item.binding.headCommitSha)
      : item.binding.headCommitSha;
  const idempotencyKey =
    body.action === "seal"
      ? operationKey(`${item.id}\0${proposedSnapshotId}`)
      : operationKey(`${item.id}\0supersede\0${body.supersedes}`);

  let operation;
  try {
    operation = await claimRepositoryOperation(auth.user.id, {
      workspaceId: item.id,
      kind: "seal",
      idempotencyKey,
      artifactIds: [proposedSnapshotId],
      baseCommitSha,
    });
  } catch (error) {
    const response = sealError(error);
    if (response) return response;
    console.error(
      "[github-research] failed to claim repository seal operation",
      repositoryRouteErrorDetails(item.id, error)
    );
    return json({ error: "Could not seal repository snapshot" }, 500);
  }

  const snapshotId = operation.artifactIds[0] ?? proposedSnapshotId;
  if (operation.resultCommitSha) {
    try {
      if (item.binding.headCommitSha !== operation.resultCommitSha) {
        await updateResearchRepositoryBindingHead(
          auth.user.id,
          item.id,
          operation.resultCommitSha
        );
      }
      return json({
        operationId: operation.operationId,
        commitSha: operation.resultCommitSha,
        snapshotId,
      });
    } catch (error) {
      console.error(
        "[github-research] failed to repair repository seal head",
        repositoryRouteErrorDetails(item.id, error)
      );
      return json({ error: "Could not record repository seal" }, 500);
    }
  }
  if (operation.status === "failed") {
    const errorCode = operation.errorCode ?? "REPOSITORY_OPERATION_FAILED";
    const validationError =
      errorCode === "INVALID_METHOD" ||
      errorCode === "INVALID_PREVIEW" ||
      errorCode === "MISSING_METHOD" ||
      errorCode === "NO_SEAL_INPUTS" ||
      errorCode === "PREVIEW_MISMATCH" ||
      errorCode === "SNAPSHOT_ALREADY_SEALED";
    const conflict =
      errorCode === "STALE_REPOSITORY" ||
      errorCode === "REPOSITORY_DISCONNECTED";
    return json(
      { error: conflict ? errorCode.toLowerCase() : errorCode },
      conflict
        ? 409
        : errorCode === "UNKNOWN_SNAPSHOT"
          ? 404
          : validationError
            ? 422
            : 500
    );
  }

  try {
    operation = await startRepositoryOperation(auth.user.id, operation);
  } catch (error) {
    const response = sealError(error);
    if (response) return response;
    console.error(
      "[github-research] failed to start repository seal operation",
      repositoryRouteErrorDetails(item.id, error)
    );
    return json({ error: "Could not seal repository snapshot" }, 500);
  }

  let access: RepositorySealAccess;
  try {
    const credentials = await readGithubResearchCredentials(auth.user.id);
    if (
      !credentials ||
      credentials.installationId !== item.binding.installationId ||
      !credentials.repositoryIds.includes(item.binding.repositoryId)
    ) {
      await failRepositoryOperation(
        auth.user.id,
        operation,
        "REPOSITORY_DISCONNECTED"
      );
      return json({ error: "Research repository is disconnected" }, 409);
    }
    const repository = await getGithubInstallationRepository(
      item.binding.installationId,
      item.binding.repositoryId
    );
    access = { binding: item.binding, credentials, repository };
  } catch (error) {
    try {
      await failRepositoryOperation(
        auth.user.id,
        operation,
        "CREDENTIAL_READ_FAILED"
      );
    } catch {
      // Preserve the authorization failure as the response cause.
    }
    console.error(
      "[github-research] failed to authorize repository seal",
      repositoryRouteErrorDetails(item.id, error)
    );
    return json({ error: "Could not authorize research repository" }, 500);
  }

  let commitSha: string;
  try {
    if (body.action === "seal") {
      const preview = await previewSealSnapshot(access, {
        snapshotId,
        reviewedAt: body.preview.reviewedAt,
        expectedHeadCommitSha: operation.baseCommitSha,
      });
      if (!matchesPreview(body.preview, preview)) {
        throw new SealSnapshotError(
          "PREVIEW_MISMATCH",
          "The accepted preview no longer matches the repository inputs"
        );
      }
      ({ commitSha } = await commitSealSnapshot(
        access,
        preview,
        authorFor(access)
      ));
    } else {
      ({ commitSha } = await supersedeSeal(
        access,
        body.supersedes,
        {
          snapshotId,
          expectedHeadCommitSha: operation.baseCommitSha,
        },
        authorFor(access)
      ));
    }
  } catch (error) {
    const stale = error instanceof StaleRepositoryError;
    const errorCode = stale
      ? "STALE_REPOSITORY"
      : error instanceof SealSnapshotError ||
          error instanceof RepositoryLayoutError
        ? error.code
        : "SEAL_FAILED";
    try {
      await failRepositoryOperation(auth.user.id, operation, errorCode);
    } catch (storeError) {
      console.error(
        "[github-research] failed to record repository seal failure",
        repositoryRouteErrorDetails(item.id, storeError)
      );
    }
    const response = sealError(error);
    if (response) return response;
    console.error(
      "[github-research] failed to commit repository seal",
      repositoryRouteErrorDetails(item.id, error)
    );
    return json({ error: "Could not seal repository snapshot" }, 500);
  }

  try {
    operation = await recordRepositoryOperationResult(
      auth.user.id,
      operation,
      commitSha
    );
    await updateResearchRepositoryBindingHead(auth.user.id, item.id, commitSha);
    const completed = await completeRepositoryOperation(
      auth.user.id,
      operation,
      commitSha
    );
    return json({ operationId: completed.operationId, commitSha, snapshotId });
  } catch (error) {
    try {
      await failRepositoryOperation(
        auth.user.id,
        operation,
        "SEAL_LANDED_STORE_UPDATE_FAILED",
        commitSha
      );
    } catch (storeError) {
      console.error(
        "[github-research] failed to record landed seal failure",
        repositoryRouteErrorDetails(item.id, storeError)
      );
    }
    console.error(
      "[github-research] failed to record landed repository seal",
      repositoryRouteErrorDetails(item.id, error)
    );
    return json({ error: "Could not record repository seal" }, 500);
  }
}
