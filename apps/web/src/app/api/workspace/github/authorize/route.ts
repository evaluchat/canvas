import { NextRequest, NextResponse } from "next/server";
import { isGithubResearchWorkspacesEnabled } from "@/lib/research-workspaces-enabled.server";
import { verifyUserAuthenticated } from "@/lib/supabase/verify_user_server";
import {
  buildGithubAuthorizationUrl,
  generateGithubOAuthState,
  generatePkcePair,
} from "@/lib/workspace/research-repository/github-app";
import { storeGithubOAuthState } from "@/lib/workspace/research-repository/credentials";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest) {
  if (!isGithubResearchWorkspacesEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await verifyUserAuthenticated();
  if (!auth?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const state = generateGithubOAuthState();
    const { verifier, challenge } = generatePkcePair();
    await storeGithubOAuthState(auth.user.id, state, verifier);
    return NextResponse.redirect(
      buildGithubAuthorizationUrl({ state, challenge })
    );
  } catch (error) {
    console.error("[github-research] failed to start OAuth", error);
    return NextResponse.json(
      { error: "Could not start GitHub authorization" },
      { status: 500 }
    );
  }
}
