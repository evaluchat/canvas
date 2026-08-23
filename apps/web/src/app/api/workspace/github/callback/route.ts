import { NextRequest, NextResponse } from "next/server";
import { isGithubResearchWorkspacesEnabled } from "@/lib/research-workspaces-enabled.server";
import { verifyUserAuthenticated } from "@/lib/supabase/verify_user_server";
import {
  exchangeGithubOAuthCode,
  refreshGithubUserTokenIfNeeded,
  resolveGithubResearchConnection,
} from "@/lib/workspace/research-repository/github-app";
import {
  consumeGithubOAuthState,
  storeGithubResearchCredentials,
} from "@/lib/workspace/research-repository/credentials";

export const dynamic = "force-dynamic";

function positiveInteger(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function appRedirect(request: NextRequest, status: string): URL {
  const target = new URL("/workspace/settings", request.url);
  target.searchParams.set("github", status);
  return target;
}

export async function GET(request: NextRequest) {
  if (!isGithubResearchWorkspacesEnabled()) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const auth = await verifyUserAuthenticated();
  if (!auth?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (request.nextUrl.searchParams.has("error")) {
    return NextResponse.redirect(appRedirect(request, "denied"));
  }

  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state) {
    return NextResponse.json(
      { error: "Invalid OAuth callback" },
      { status: 400 }
    );
  }

  try {
    const verifier = await consumeGithubOAuthState(auth.user.id, state);
    if (!verifier) {
      return NextResponse.json(
        { error: "Invalid or expired OAuth state" },
        { status: 400 }
      );
    }

    const exchanged = await exchangeGithubOAuthCode(code, verifier);
    const tokens = await refreshGithubUserTokenIfNeeded(exchanged);
    const connection = await resolveGithubResearchConnection(
      tokens.accessToken,
      positiveInteger(request.nextUrl.searchParams.get("installation_id"))
    );
    await storeGithubResearchCredentials(auth.user.id, {
      tokens,
      installationId: connection.installationId,
      repositoryIds: connection.repositoryIds,
      displayMetadata: connection.displayMetadata,
    });
    return NextResponse.redirect(appRedirect(request, "connected"));
  } catch (error) {
    console.error(
      "[github-research] OAuth callback failed",
      error instanceof Error ? error.message : "unknown error"
    );
    return NextResponse.redirect(appRedirect(request, "error"));
  }
}
