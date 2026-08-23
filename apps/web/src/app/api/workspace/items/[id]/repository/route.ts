import { NextResponse } from "next/server";
import { isGithubResearchWorkspacesEnabled } from "@/lib/research-workspaces-enabled.server";
import { verifyUserAuthenticated } from "@/lib/supabase/verify_user_server";
import {
  getResearchRepositoryStatus,
  getWorkspaceItem,
} from "@/lib/workspace/store";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  if (!isGithubResearchWorkspacesEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await verifyUserAuthenticated();
  if (!auth?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  const item = await getWorkspaceItem(auth.user.id, id);
  if (!item || item.kind !== "research_repository") {
    return NextResponse.json(
      { error: "Research repository not found" },
      { status: 404 }
    );
  }

  try {
    const status = await getResearchRepositoryStatus(auth.user.id, item);
    const body = {
      status,
      ...(status.readonlyReason
        ? { readonlyReason: status.readonlyReason }
        : {}),
    };
    if (status.reason === "repository_deleted") {
      return NextResponse.json(
        {
          ...body,
          error: "REPOSITORY_UNAVAILABLE",
          message: "Repository unavailable (deleted or access removed).",
        },
        { status: 409 }
      );
    }
    return NextResponse.json(body);
  } catch (error) {
    console.error("[github-research] failed to check repository", error);
    return NextResponse.json(
      { error: "Could not check research repository" },
      { status: 500 }
    );
  }
}
