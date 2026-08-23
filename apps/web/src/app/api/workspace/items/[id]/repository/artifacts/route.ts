import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { RepositoryArtifactRefSchema } from "@opencanvas/shared/research-repository";
import { isGithubResearchWorkspacesEnabled } from "@/lib/research-workspaces-enabled.server";
import { verifyUserAuthenticated } from "@/lib/supabase/verify_user_server";
import { getWorkspaceItem } from "@/lib/workspace/store";
import { readGithubResearchCredentials } from "@/lib/workspace/research-repository/credentials";
import {
  RepositoryAccessError,
  loadInstallationRepository,
  repositoryAccessBody,
  repositoryAccessHttpStatus,
} from "@/lib/workspace/research-repository/access";
import {
  listRepositoryArtifactRefs,
  readArtifactBlob,
} from "@/lib/workspace/research-repository/git-adapter";
import {
  isRepositoryLayoutVersionSupported,
  RepositoryLayoutError,
  resolveRepositoryArtifactPath,
} from "@/lib/workspace/research-repository/layout";
import { repositoryRouteErrorDetails } from "@/lib/workspace/research-repository/route-errors";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return;
  return typeof error.status === "number" ? error.status : undefined;
}

export async function GET(request: Request, context: RouteContext) {
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
    const artifactId = new URL(request.url).searchParams.get("artifactId");
    if (artifactId !== null) {
      const supported = isRepositoryLayoutVersionSupported(
        item.binding.layoutVersion
      );
      const identity = resolveRepositoryArtifactPath(
        artifactId,
        supported ? item.binding.layoutVersion : undefined
      );
      let result;
      try {
        result = await readArtifactBlob(
          item.binding.installationId,
          repository,
          item.binding.branch,
          identity.path
        );
      } catch (error) {
        if (errorStatus(error) === 404) {
          return json({ error: "Artifact not found" }, 404);
        }
        throw error;
      }
      const artifact = {
        ...RepositoryArtifactRefSchema.parse({
          ...identity,
          commitSha: result.commitSha,
          blobSha: result.blobSha,
          contentSha256: createHash("sha256")
            .update(result.content)
            .digest("hex"),
        }),
        supported,
      };
      return json({ artifact, content: result.content });
    }
    const result = await listRepositoryArtifactRefs(
      item.binding.installationId,
      repository,
      item.binding.branch,
      item.binding.layoutVersion
    );
    return json({
      artifacts: result.artifacts,
      headCommitSha: result.commitSha,
    });
  } catch (error) {
    console.error(
      "[github-research] failed to list repository artifacts",
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
    return json({ error: "Could not load repository artifacts" }, 500);
  }
}
