"use client";

import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { RESEARCH_REPOSITORY_TRUST_COPY } from "@/components/research-repository/copy";
import { WorkspaceItem } from "@/lib/workspace/types";

export type CatalogResult = {
  id: string;
  title: string;
  description: string;
  kind: "template" | "method" | "ledger";
  templateKind?: "markdown" | "form";
  disabled?: boolean;
  status?: string;
  reason?: string;
  methodVersion?: string;
  evidenceTemplate?: { id: string; version: string };
  acceptedEvidenceCount?: number;
};

export type ResearchRepositoryOption = {
  id: number;
  nameWithOwner: string;
};

type GithubRepositoriesResponse = {
  connected: boolean;
  installationId?: number;
  repositories: ResearchRepositoryOption[];
  createFromTemplateUrl?: string;
};

export function workspaceItemCreationKinds(githubResearchEnabled: boolean) {
  return [
    "template",
    "ledger",
    "method",
    ...(githubResearchEnabled ? (["research_repository"] as const) : []),
  ] as const;
}

export function buildWorkspaceItemCreateBody(
  result: Pick<CatalogResult, "id" | "kind">
): Record<string, unknown> {
  if (result.kind === "method") {
    return { kind: "method", methodId: result.id };
  }
  if (result.kind === "ledger") {
    return { kind: "ledger", methodId: result.id };
  }
  return { kind: "template", templateId: result.id };
}

export function buildResearchRepositoryCreateBody(
  repository: Pick<ResearchRepositoryOption, "id">,
  installationId: number
): Record<string, unknown> {
  return {
    kind: "research_repository",
    installationId,
    repositoryId: repository.id,
  };
}

export function CreateWorkspaceItemDialog({
  onCreated,
  githubResearchEnabled = false,
}: {
  onCreated: (item: WorkspaceItem) => void;
  githubResearchEnabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<
    "template" | "method" | "ledger" | "research_repository"
  >("template");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CatalogResult[]>([]);
  const [githubRepositories, setGithubRepositories] =
    useState<GithubRepositoriesResponse>();
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (!open || kind !== "research_repository") return;
    let cancelled = false;
    setLoading(true);
    setResults([]);
    setGithubRepositories(undefined);
    fetch("/api/workspace/github/repositories", { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load repositories");
        return response.json() as Promise<GithubRepositoriesResponse>;
      })
      .then((body) => {
        if (!cancelled) setGithubRepositories(body);
      })
      .catch(() => {
        if (!cancelled) {
          setGithubRepositories({ connected: false, repositories: [] });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, kind]);

  useEffect(() => {
    if (!open || kind === "research_repository") return;
    let cancelled = false;
    setLoading(true);
    setResults([]);
    fetch(
      `/api/workspace/catalog?kind=${kind}&q=${encodeURIComponent(query)}`,
      { credentials: "include" }
    )
      .then((response) => response.json())
      .then(
        (body: {
          kind: "template" | "method" | "ledger";
          results?: CatalogResult[];
        }) => {
          if (!cancelled) {
            setResults(
              (body.results || []).map((result) => ({
                ...result,
                kind: body.kind,
              }))
            );
          }
        }
      )
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, kind, query]);

  async function create(result: CatalogResult) {
    return createWithBody(buildWorkspaceItemCreateBody(result));
  }

  async function createResearchRepository(
    repository: ResearchRepositoryOption
  ) {
    if (githubRepositories?.installationId === undefined) {
      toast({
        title: "GitHub installation is unavailable",
        variant: "destructive",
      });
      return;
    }
    return createWithBody(
      buildResearchRepositoryCreateBody(
        repository,
        githubRepositories.installationId
      )
    );
  }

  async function createWithBody(requestBody: Record<string, unknown>) {
    setCreating(true);
    try {
      const response = await fetch("/api/workspace/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(requestBody),
      });
      if (!response.ok) throw new Error("Could not create workspace item");
      const responseBody = (await response.json()) as { item: WorkspaceItem };
      onCreated(responseBody.item);
      handleOpenChange(false);
    } catch (error) {
      console.error(error);
      toast({
        title: "Could not create workspace item",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setKind("template");
      setQuery("");
      setGithubRepositories(undefined);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          Create
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create workspace item</DialogTitle>
          <DialogDescription>
            Search reviewed templates, methods, and published evidence-ledger
            sources, or bind a private research repository. Markdown templates
            are editable.
          </DialogDescription>
        </DialogHeader>
        {kind !== "research_repository" && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3">
            <Search className="h-4 w-4 text-muted-foreground" />
            <Input
              className="border-0 bg-transparent shadow-none focus-visible:ring-0"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search templates, methods, or ledgers"
              autoFocus
            />
          </div>
        )}
        <div className="flex gap-2">
          {workspaceItemCreationKinds(githubResearchEnabled).map((option) => (
            <Button
              key={option}
              variant={kind === option ? "default" : "outline"}
              size="sm"
              onClick={() => {
                setKind(option);
              }}
            >
              {option === "template"
                ? "Templates"
                : option === "ledger"
                  ? "Evidence Ledger"
                  : option === "method"
                    ? "Methods"
                    : "Private research repository"}
            </Button>
          ))}
        </div>
        {kind === "research_repository" ? (
          <div className="max-h-72 space-y-3 overflow-y-auto">
            {loading && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Loading GitHub repositories…
              </p>
            )}
            {!loading && !githubRepositories?.connected && (
              <div className="rounded-lg border p-4">
                <p className="text-sm text-muted-foreground">
                  Connect GitHub to choose an installation repository.{" "}
                  {RESEARCH_REPOSITORY_TRUST_COPY}
                </p>
                <Button asChild className="mt-3" size="sm">
                  <a href="/api/workspace/github/authorize">Connect GitHub</a>
                </Button>
              </div>
            )}
            {!loading && githubRepositories?.connected && (
              <>
                {githubRepositories.createFromTemplateUrl && (
                  <div className="rounded-lg border bg-muted/20 p-4">
                    <p className="text-sm text-muted-foreground">
                      Start a new private repository, then reconnect GitHub to
                      refresh this list.
                    </p>
                    <Button
                      asChild
                      className="mt-3"
                      size="sm"
                      variant="outline"
                    >
                      <a
                        href={githubRepositories.createFromTemplateUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Create from template
                      </a>
                    </Button>
                  </div>
                )}
                {githubRepositories.repositories.length === 0 ? (
                  <div className="rounded-lg border p-4">
                    <p className="text-sm text-muted-foreground">
                      No installation repositories are available.
                    </p>
                    <Button asChild className="mt-3" size="sm">
                      <a href="/api/workspace/github/authorize">
                        Connect GitHub
                      </a>
                    </Button>
                  </div>
                ) : (
                  githubRepositories.repositories.map((repository) => (
                    <button
                      key={repository.id}
                      type="button"
                      disabled={
                        creating ||
                        githubRepositories.installationId === undefined
                      }
                      onClick={() => void createResearchRepository(repository)}
                      className="w-full rounded-lg border p-4 text-left transition hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="font-medium">
                        {repository.nameWithOwner}
                      </span>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Bind to evaluchat/workspace
                      </p>
                    </button>
                  ))
                )}
              </>
            )}
          </div>
        ) : (
          <div className="max-h-72 space-y-2 overflow-y-auto">
            {loading && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Searching…
              </p>
            )}
            {!loading && results.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No results.
              </p>
            )}
            {!loading &&
              results.map((result) => (
                <button
                  key={result.id}
                  type="button"
                  disabled={result.disabled || creating}
                  onClick={() => void create(result)}
                  className="w-full rounded-lg border p-4 text-left transition hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{result.title}</span>
                    {result.status && (
                      <span className="text-xs text-muted-foreground">
                        {result.status}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {result.description}
                  </p>
                  {result.kind === "ledger" && result.evidenceTemplate && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {result.id}@{result.methodVersion} ·{" "}
                      {result.evidenceTemplate.id}@
                      {result.evidenceTemplate.version} ·{" "}
                      {result.acceptedEvidenceCount} accepted evidence
                      {result.reason ? ` · ${result.reason}` : ""}
                    </p>
                  )}
                  {result.kind === "template" &&
                    result.templateKind === "form" && (
                      <p className="mt-2 text-xs font-medium text-amber-700">
                        Protected form · Submit to lock
                      </p>
                    )}
                </button>
              ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
