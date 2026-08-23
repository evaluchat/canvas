import { NextRequest, NextResponse } from "next/server";
import { verifyUserAuthenticated } from "@/lib/supabase/verify_user_server";
import { FormValidationError } from "@/lib/workspace/form-validation";
import { ledgerEvidenceFilePath } from "@/lib/workspace/ledger-paths";
import {
  ledgerRenderHash,
  renderLedgerMarkdown,
  validateLedgerPublicationDeclarations,
} from "@/lib/workspace/ledger-publish";
import {
  getGithubResearchWriteAccess,
  getLedgerPullRequestStatus,
  openLedgerPullRequest,
} from "@/lib/workspace/evidence-github";
import {
  getLedgerSnapshotItem,
  updateLedgerSnapshotPublication,
  WorkspaceItemNotFoundError,
} from "@/lib/workspace/store";

type RouteContext = { params: Promise<{ id: string }> };

function publicationBody(input: {
  methodId: string;
  methodVersion: string;
  templateId: string;
  templateVersion: string;
  sourceCommit: string;
  inputFingerprint: string;
  buckets: Record<string, number>;
}): string {
  return [
    "## Evidence Ledger snapshot",
    "",
    `- Method: ${input.methodId}@${input.methodVersion}`,
    `- Evidence template: ${input.templateId}@${input.templateVersion}`,
    `- Source commit: ${input.sourceCommit}`,
    `- Input fingerprint: ${input.inputFingerprint}`,
    "- Bucket counts:",
    ...Object.entries(input.buckets)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bucket, count]) => `  - ${bucket}: ${count}`),
    "",
    "Human review required before merge.",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await verifyUserAuthenticated();
  if (!auth?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!isRecord(parsed)) throw new Error("invalid");
    body = parsed;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 }
    );
  }

  const { id } = await context.params;
  try {
    let item = await getLedgerSnapshotItem(auth.user.id, id);
    const rePublish = body.rePublish === true;
    if (item.publication && !rePublish) {
      return NextResponse.json(
        {
          error: "Ledger snapshot already has a publication pull request",
          publication: item.publication,
        },
        { status: 409 }
      );
    }

    // This uses the exact token-backed identity that would create the branch.
    // It deliberately precedes every write operation in openLedgerPullRequest.
    const access = await getGithubResearchWriteAccess();
    if (!access.allowed) {
      if (access.reason === "missing_identity") {
        return NextResponse.json(
          {
            error: "The publication service is not configured",
            reason: access.reason,
          },
          { status: 503 }
        );
      }
      return NextResponse.json(
        {
          error:
            "Your connected GitHub account needs collaborator write access to evaluchat/research before a ledger can be published.",
          reason: access.reason,
        },
        { status: 403 }
      );
    }

    let retry: number | undefined;
    if (item.publication && rePublish) {
      if (!item.publication.pullRequestNumber) {
        return NextResponse.json(
          { error: "The recorded ledger pull request is incomplete" },
          { status: 409 }
        );
      }
      const previous = await getLedgerPullRequestStatus(
        item.publication.pullRequestNumber
      );
      if (previous.merged || previous.state !== "closed") {
        return NextResponse.json(
          {
            error:
              "Only a closed, unmerged ledger pull request can be republished.",
            publication: item.publication,
          },
          { status: 409 }
        );
      }
      retry = Date.now();
    }

    // The same validator used by evidence submission verifies both required
    // owner declarations before any branch, commit, or PR is created.
    validateLedgerPublicationDeclarations(item.snapshot, body.values);
    // Reaching this point means both declarations were confirmed by the
    // server-side validator; pass that fact to the GitHub publication client.
    const consentConfirmed = true;

    const computedHash = ledgerRenderHash(item.snapshot, item.config);
    // Preserve whether the sealed snapshot already matched its rendered body.
    // A repaired stored hash may still be published for human review, but it
    // must not qualify that publication for automatic approval and merging.
    const renderHashMatches = item.snapshot.renderHash === computedHash;
    if (!renderHashMatches) {
      item = await updateLedgerSnapshotPublication(auth.user.id, id, {
        renderHash: computedHash,
      });
    }
    const markdown = renderLedgerMarkdown(item.snapshot, item.config);
    const pullRequest = await openLedgerPullRequest({
      ledgerId: item.snapshot.ledgerId,
      inputFingerprint: item.snapshot.inputFingerprint,
      filePath: ledgerEvidenceFilePath(
        item.snapshot.ledgerId,
        item.snapshot.methodId
      ),
      markdown,
      body: publicationBody(item.snapshot),
      renderHashMatches,
      consentConfirmed,
      sourceCommit: item.snapshot.sourceCommit,
      ...(retry ? { retry } : {}),
    });
    const publication = {
      status: pullRequest.status,
      pullRequestUrl: pullRequest.url,
      pullRequestNumber: pullRequest.number,
    };
    await updateLedgerSnapshotPublication(auth.user.id, id, { publication });
    return NextResponse.json({
      publication,
      pullRequestUrl: pullRequest.url,
      filePath: ledgerEvidenceFilePath(
        item.snapshot.ledgerId,
        item.snapshot.methodId
      ),
      lintConclusion: pullRequest.lintConclusion,
    });
  } catch (error) {
    if (error instanceof WorkspaceItemNotFoundError) {
      return NextResponse.json(
        { error: "Ledger snapshot not found" },
        { status: 404 }
      );
    }
    if (error instanceof FormValidationError) {
      return NextResponse.json(
        { error: "Validation failed", issues: error.issues },
        { status: 422 }
      );
    }
    console.error("[workspace] failed to publish ledger snapshot", error);
    return NextResponse.json(
      { error: "Could not create ledger publication pull request" },
      { status: 502 }
    );
  }
}
