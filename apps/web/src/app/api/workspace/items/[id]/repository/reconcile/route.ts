import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { RepositoryStatusSchema } from "@opencanvas/shared/research-repository";
import { isGithubResearchWorkspacesEnabled } from "@/lib/research-workspaces-enabled.server";
import { verifyUserAuthenticated } from "@/lib/supabase/verify_user_server";
import {
  getWorkspaceItem,
  updateResearchRepositoryBindingHead,
} from "@/lib/workspace/store";
import {
  RepositoryAccessError,
  loadInstallationRepository,
  repositoryAccessBody,
  repositoryAccessHttpStatus,
} from "@/lib/workspace/research-repository/access";
import { readGithubResearchCredentials } from "@/lib/workspace/research-repository/credentials";
import { listRepositoryArtifactRefs } from "@/lib/workspace/research-repository/git-adapter";
import { RepositoryLayoutError } from "@/lib/workspace/research-repository/layout";
import {
  claimRepositoryOperation,
  completeRepositoryOperation,
  failRepositoryOperation,
  startRepositoryOperation,
} from "@/lib/workspace/research-repository/operations";
import { repositoryRouteErrorDetails } from "@/lib/workspace/research-repository/route-errors";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(_request: Request, context: RouteContext) {
  if (!isGithubResearchWorkspacesEnabled()) {
    return json({ error: "Not found" }, 404);
  }
  const auth = await verifyUserAuthenticated();
  if (!auth?.user) return json({ error: "Unauthorized" }, 401);

  const { id } = await context.params;
  const item = await getWorkspaceItem(auth.user.id, id);
  if (!item || item.kind !== "research_repository") {
    return json({ error: "Research repository not found" }, 404);
  }

  let operation;
  try {
    const credentials = await readGithubResearchCredentials(auth.user.id);
    if (
      !credentials ||
      credentials.installationId !== item.binding.installationId ||
      !credentials.repositoryIds.includes(item.binding.repositoryId)
    ) {
      return json({ error: "Research repository is disconnected" }, 409);
    }
    const repository = await loadInstallationRepository(
      item.binding.installationId,
      item.binding.repositoryId
    );
    const result = await listRepositoryArtifactRefs(
      item.binding.installationId,
      repository,
      item.binding.branch,
      item.binding.layoutVersion
    );
    operation = await claimRepositoryOperation(auth.user.id, {
      workspaceId: item.id,
      kind: "reconcile",
      idempotencyKey: `reconcile-${randomUUID()}`,
      artifactIds: result.artifacts.map((artifact) => artifact.artifactId),
    });
    operation = await startRepositoryOperation(auth.user.id, operation);
    await updateResearchRepositoryBindingHead(
      auth.user.id,
      item.id,
      result.commitSha
    );
    await completeRepositoryOperation(
      auth.user.id,
      operation,
      result.commitSha
    );
    const status = repository.private
      ? RepositoryStatusSchema.parse({
          workspaceId: item.id,
          repositoryId: item.binding.repositoryId,
          state: "ready",
          layoutVersion: item.binding.layoutVersion,
          headCommitSha: result.commitSha,
          checkedAt: new Date().toISOString(),
        })
      : RepositoryStatusSchema.parse({
          workspaceId: item.id,
          repositoryId: item.binding.repositoryId,
          state: "read_only",
          reason: "repository_public",
          readonlyReason: "repository_public",
          layoutVersion: item.binding.layoutVersion,
          headCommitSha: result.commitSha,
          checkedAt: new Date().toISOString(),
        });
    return json({
      status,
      artifacts: result.artifacts,
      ...(status.readonlyReason
        ? { readonlyReason: status.readonlyReason }
        : {}),
    });
  } catch (error) {
    if (operation) {
      try {
        await failRepositoryOperation(
          auth.user.id,
          operation,
          "RECONCILE_FAILED"
        );
      } catch (storeError) {
        console.error(
          "[github-research] failed to record reconcile failure",
          repositoryRouteErrorDetails(item.id, storeError)
        );
      }
    }
    console.error(
      "[github-research] failed to reconcile repository",
      repositoryRouteErrorDetails(item.id, error)
    );
    if (error instanceof RepositoryAccessError) {
      return json(
        repositoryAccessBody(error),
        repositoryAccessHttpStatus(error.code)
      );
    }
    if (error instanceof RepositoryLayoutError) {
      return json({ error: error.code }, 422);
    }
    return json({ error: "Could not reconcile research repository" }, 500);
  }
}
