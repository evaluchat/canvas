import { NextRequest, NextResponse } from "next/server";
import { isGithubResearchWorkspacesEnabled } from "@/lib/research-workspaces-enabled.server";
import { verifyUserAuthenticated } from "@/lib/supabase/verify_user_server";
import { deleteGithubResearchCredentials } from "@/lib/workspace/research-repository/credentials";

export const dynamic = "force-dynamic";

export async function POST(_request: NextRequest) {
  if (!isGithubResearchWorkspacesEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await verifyUserAuthenticated();
  if (!auth?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await deleteGithubResearchCredentials(auth.user.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    console.error("[github-research] disconnect failed", error);
    return NextResponse.json(
      { error: "Could not disconnect GitHub" },
      { status: 500 }
    );
  }
}
