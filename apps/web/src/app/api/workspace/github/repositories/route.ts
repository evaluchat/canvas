import { NextResponse } from "next/server";
import { isGithubResearchWorkspacesEnabled } from "@/lib/research-workspaces-enabled.server";
import { verifyUserAuthenticated } from "@/lib/supabase/verify_user_server";
import { readGithubResearchCredentials } from "@/lib/workspace/research-repository/credentials";
import { buildGithubResearchTemplateUrl } from "@/lib/workspace/research-repository/template";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!isGithubResearchWorkspacesEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await verifyUserAuthenticated();
  if (!auth?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const credentials = await readGithubResearchCredentials(auth.user.id);
    if (!credentials || credentials.installationId === undefined) {
      return NextResponse.json({ connected: false, repositories: [] });
    }
    const login = credentials.displayMetadata.login;
    const displayRepositories = credentials.displayMetadata.repositories;
    const repositoryIds = new Set(credentials.repositoryIds);
    const repositories = Array.isArray(displayRepositories)
      ? displayRepositories
          .filter(
            (entry): entry is { id: number; nameWithOwner?: string } =>
              Boolean(entry) &&
              typeof entry === "object" &&
              typeof (entry as { id?: unknown }).id === "number" &&
              repositoryIds.has((entry as { id: number }).id)
          )
          .map((entry) => ({
            id: entry.id,
            nameWithOwner:
              typeof entry.nameWithOwner === "string"
                ? entry.nameWithOwner
                : `Repository #${entry.id}`,
          }))
      : [];
    return NextResponse.json({
      connected: true,
      installationId: credentials.installationId,
      login: typeof login === "string" ? login : undefined,
      repositories,
      createFromTemplateUrl:
        typeof login === "string"
          ? buildGithubResearchTemplateUrl(login)
          : undefined,
    });
  } catch (error) {
    console.error("[github-research] failed to list repositories", error);
    return NextResponse.json(
      { error: "Could not load GitHub repositories" },
      { status: 500 }
    );
  }
}
