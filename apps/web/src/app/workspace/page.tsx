import { Suspense } from "react";
import { WorkspacePageClient } from "@/components/workspace/workspace-home";
import { isGithubResearchWorkspacesEnabled } from "@/lib/research-workspaces-enabled.server";

export const dynamic = "force-dynamic";

export default function WorkspacePage() {
  return (
    <Suspense
      fallback={
        <div className="p-8 text-sm text-muted-foreground">Loading…</div>
      }
    >
      <WorkspacePageClient
        githubResearchEnabled={isGithubResearchWorkspacesEnabled()}
      />
    </Suspense>
  );
}
