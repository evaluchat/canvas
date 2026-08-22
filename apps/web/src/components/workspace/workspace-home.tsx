"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ClipboardList,
  FileText,
  FlaskConical,
  GitBranch,
  ListChecks,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { CreateWorkspaceItemDialog } from "./create-workspace-item-dialog";
import type { WorkspaceItem } from "@/lib/workspace/types";
import { Card, CardContent } from "@/components/ui/card";
import {
  workspaceNavGhostClass,
  WorkspaceSiteHeader,
} from "@/components/teaching/workspace-site-header";
import { DOCS_URL } from "@/components/auth/login/login-branding";
import { WorkspaceItemDeleteDialog } from "./workspace-item-delete-dialog";
import { UserMenu } from "./user-menu";
import { UserProvider, useUserContext } from "@/contexts/UserContext";
import { useToast } from "@/hooks/use-toast";
import {
  formatWorkspaceItemDate,
  workspaceItemDescription,
  workspaceItemHref,
  workspaceItemKicker,
  workspaceItemTitle,
  workspaceItemType,
} from "@/lib/workspace/display";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRouter } from "next/navigation";
import { ResearchRepositoryStatus } from "./research-repository-status";

function WorkspaceItemTypeIcon({ item }: { item: WorkspaceItem }) {
  const type = workspaceItemType(item);
  const Icon =
    item.kind === "research_repository"
      ? GitBranch
      : item.kind === "form_template"
        ? ClipboardList
        : item.kind === "ledger" || item.kind === "ledger_snapshot"
          ? ListChecks
          : item.kind === "method" || item.kind === "method_participant"
            ? FlaskConical
            : FileText;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border ${type.colorClass}`}
            role="img"
            aria-label={type.label}
          >
            <Icon className={`h-5 w-5 ${type.iconClass}`} aria-hidden />
          </span>
        </TooltipTrigger>
        <TooltipContent>{type.label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function WorkspaceHome({
  githubResearchEnabled,
}: {
  githubResearchEnabled: boolean;
}) {
  const [items, setItems] = useState<WorkspaceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [itemToDelete, setItemToDelete] = useState<WorkspaceItem>();
  const [isDeleting, setIsDeleting] = useState(false);
  const { toast } = useToast();
  const { user, loading: userLoading } = useUserContext();

  useEffect(() => {
    fetch("/api/workspace/items", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Could not load workspace");
        }
        return response.json() as Promise<{ items?: WorkspaceItem[] }>;
      })
      .then((body) =>
        setItems(
          (body.items || []).filter(
            (item) =>
              githubResearchEnabled || item.kind !== "research_repository"
          )
        )
      )
      .catch((error) => {
        console.error("Failed to load workspace", error);
        toast({
          title: "Could not load workspace",
          description: "Please refresh and try again.",
          variant: "destructive",
        });
      })
      .finally(() => setLoading(false));
  }, [githubResearchEnabled]);

  async function deleteItem() {
    if (!itemToDelete) return;
    setIsDeleting(true);
    try {
      const response = await fetch(
        `/api/workspace/items/${encodeURIComponent(itemToDelete.id)}`,
        { method: "DELETE", credentials: "include" }
      );
      if (!response.ok) throw new Error("Could not delete workspace item");
      setItems((current) =>
        current.filter((item) => item.id !== itemToDelete.id)
      );
      setItemToDelete(undefined);
    } catch (error) {
      console.error("Failed to delete workspace item", error);
      toast({
        title: "Could not delete item",
        description: "Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50">
      <WorkspaceSiteHeader workspaceLabel="Workspace" maxWidthClass="max-w-6xl">
        <a
          href={DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={workspaceNavGhostClass}
        >
          Docs
        </a>
        {!userLoading && user ? <UserMenu user={user} /> : null}
      </WorkspaceSiteHeader>
      <section className="mx-auto flex h-[calc(100vh-60px)] max-w-5xl flex-col overflow-hidden px-4 py-6 sm:px-6">
        <div className="mb-4 flex justify-end">
          <CreateWorkspaceItemDialog
            githubResearchEnabled={githubResearchEnabled}
            onCreated={(item) => setItems((current) => [item, ...current])}
          />
        </div>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading workspace…</p>
        ) : items.length === 0 ? (
          <Card className="border-dashed bg-white/70">
            <CardContent className="flex min-h-40 flex-col items-center justify-center gap-3 text-center">
              <p className="font-medium text-slate-900">
                Your workspace is empty
              </p>
              <p className="max-w-md text-sm text-slate-600">
                Create a reviewed workspace item when you are ready to start.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
            {items.map((item) => (
              <Card
                key={item.id}
                className="shrink-0 bg-white transition-colors hover:bg-slate-50"
              >
                <CardContent className="flex items-center gap-3 px-4 py-3 sm:gap-4">
                  <WorkspaceItemTypeIcon item={item} />
                  {item.kind === "research_repository" ? (
                    <div className="min-w-0 flex-1">
                      <Link
                        href={workspaceItemHref(item)}
                        className="block rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <p className="truncate text-base font-medium text-slate-900">
                          {workspaceItemTitle(item)}
                        </p>
                        <span className="mt-1 inline-flex rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                          {workspaceItemKicker(item)}
                        </span>
                      </Link>
                      <ResearchRepositoryStatus item={item} />
                    </div>
                  ) : (
                    <Link
                      href={workspaceItemHref(item)}
                      className="min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <p className="truncate text-base font-medium text-slate-900">
                        {workspaceItemTitle(item)}
                      </p>
                      {workspaceItemKicker(item) && (
                        <span
                          className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            item.kind === "method" && item.run
                              ? "bg-violet-50 text-violet-700"
                              : item.kind === "method_participant"
                                ? "bg-emerald-50 text-emerald-700"
                                : item.kind === "form_template" &&
                                    item.submission?.status === "submitted"
                                  ? "bg-emerald-50 text-emerald-700"
                                  : "bg-amber-50 text-amber-700"
                          }`}
                        >
                          {workspaceItemKicker(item)}
                        </span>
                      )}
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <p
                              className="truncate text-sm text-slate-500"
                              title={workspaceItemDescription(item)}
                            >
                              {workspaceItemDescription(item)}
                            </p>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-sm">
                            {workspaceItemDescription(item)}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </Link>
                  )}
                  <time
                    dateTime={item.createdAt}
                    title={new Date(item.createdAt).toLocaleString()}
                    className="shrink-0 text-[11px] tabular-nums text-slate-500 sm:text-xs"
                  >
                    {formatWorkspaceItemDate(item.createdAt)}
                  </time>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${workspaceItemTitle(item)}`}
                    data-testid={`delete-workspace-item-${item.id}`}
                    onClick={() => setItemToDelete(item)}
                  >
                    <Trash2 className="h-4 w-4 text-slate-500" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>
      {itemToDelete && (
        <WorkspaceItemDeleteDialog
          open={Boolean(itemToDelete)}
          onOpenChange={(open) => !open && setItemToDelete(undefined)}
          onConfirm={() => void deleteItem()}
          itemTitle={workspaceItemTitle(itemToDelete)}
          isDeleting={isDeleting}
        />
      )}
    </main>
  );
}

export function AuthenticatedWorkspaceHome({
  githubResearchEnabled,
}: {
  githubResearchEnabled: boolean;
}) {
  const { user, loading } = useUserContext();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user) router.replace("/auth/login");
  }, [loading, user, router]);

  if (loading || !user) {
    return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;
  }
  return <WorkspaceHome githubResearchEnabled={githubResearchEnabled} />;
}

export function WorkspacePageClient({
  githubResearchEnabled,
}: {
  githubResearchEnabled: boolean;
}) {
  return (
    <UserProvider>
      <AuthenticatedWorkspaceHome
        githubResearchEnabled={githubResearchEnabled}
      />
    </UserProvider>
  );
}
