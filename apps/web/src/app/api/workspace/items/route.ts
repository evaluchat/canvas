import { NextRequest, NextResponse } from "next/server";
import { isGithubResearchWorkspacesEnabled } from "@/lib/research-workspaces-enabled.server";
import { verifyUserAuthenticated } from "@/lib/supabase/verify_user_server";
import {
  createResearchRepositoryItem,
  createMethodWorkspaceItem,
  createLedgerWorkspaceItem,
  createWorkspaceItem,
  ensureDefaultWorkspaceItem,
  listWorkspaceItems,
  UnsupportedMethodError,
  UnsupportedTemplateError,
  LedgerNotReadyError,
  ResearchRepositoryBindingError,
} from "@/lib/workspace/store";

async function authenticatedUser() {
  const auth = await verifyUserAuthenticated();
  return auth?.user;
}

export async function GET() {
  const user = await authenticatedUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    await ensureDefaultWorkspaceItem(user.id);
    const items = await listWorkspaceItems(user.id, { email: user.email });
    return NextResponse.json({
      items: isGithubResearchWorkspacesEnabled()
        ? items
        : items.filter((item) => item.kind !== "research_repository"),
    });
  } catch (error) {
    console.error("[workspace] failed to list items", error);
    return NextResponse.json(
      { error: "Could not load workspace items" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const githubResearchEnabled = isGithubResearchWorkspacesEnabled();
  if (!githubResearchEnabled) {
    try {
      const gatedBody = (await request.clone().json()) as unknown;
      if (
        gatedBody !== null &&
        typeof gatedBody === "object" &&
        (gatedBody as { kind?: unknown }).kind === "research_repository"
      ) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
    } catch {
      // Preserve the existing authentication and invalid-JSON response order.
    }
  }

  const user = await authenticatedUser();
  if (!user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  const parsedBody =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  const methodId =
    typeof parsedBody.methodId === "string" && parsedBody.methodId
      ? parsedBody.methodId
      : undefined;
  const templateId =
    typeof parsedBody.templateId === "string" && parsedBody.templateId
      ? parsedBody.templateId
      : undefined;
  const hasMethodId = methodId !== undefined;
  const isLedger = parsedBody.kind === "ledger";
  const isResearchRepository = parsedBody.kind === "research_repository";
  if (isResearchRepository && !githubResearchEnabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const repositoryId = parsedBody.repositoryId;
  const installationId = parsedBody.installationId;
  if (
    isResearchRepository &&
    (!Number.isSafeInteger(repositoryId) ||
      Number(repositoryId) <= 0 ||
      !Number.isSafeInteger(installationId) ||
      Number(installationId) <= 0)
  ) {
    return NextResponse.json(
      {
        error:
          "Repository creation requires valid repository and installation ids",
      },
      { status: 400 }
    );
  }
  if (isLedger && !hasMethodId) {
    return NextResponse.json(
      { error: "Ledger creation requires methodId" },
      { status: 400 }
    );
  }
  if (!isResearchRepository && !hasMethodId && templateId === undefined) {
    return NextResponse.json(
      { error: "Unsupported template" },
      { status: 400 }
    );
  }

  try {
    const item = isResearchRepository
      ? await createResearchRepositoryItem(user.id, {
          repositoryId: repositoryId as number,
          installationId: installationId as number,
        })
      : isLedger
        ? await createLedgerWorkspaceItem(user.id, methodId!)
        : hasMethodId
          ? await createMethodWorkspaceItem(user.id, methodId)
          : await createWorkspaceItem(user.id, templateId!);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    if (error instanceof UnsupportedMethodError) {
      return NextResponse.json(
        { error: "Unsupported method" },
        { status: 400 }
      );
    }
    if (error instanceof UnsupportedTemplateError) {
      return NextResponse.json(
        { error: "Unsupported template" },
        { status: 400 }
      );
    }
    if (error instanceof LedgerNotReadyError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof ResearchRepositoryBindingError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: 400 }
      );
    }
    console.error("[workspace] failed to create item", error);
    return NextResponse.json(
      { error: "Could not create workspace item" },
      { status: 500 }
    );
  }
}
