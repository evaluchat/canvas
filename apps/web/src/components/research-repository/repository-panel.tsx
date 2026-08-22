"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type {
  RepositoryArtifactRef,
  RepositoryStatus,
  ResearchRepositoryBinding,
} from "@opencanvas/shared/research-repository";
import { ArtifactEditor } from "./artifact-editor";
import { RepositoryBrowser } from "./repository-browser";

type RepositoryPanelItem = {
  id: string;
  binding?: ResearchRepositoryBinding;
};

type RepositoryPanelProps = {
  item?: RepositoryPanelItem;
  enabled?: boolean;
};

type RepositoryStatusResponse = {
  status?: RepositoryStatus;
  error?: string;
};

function shortCommit(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

function statusLabel(status: RepositoryStatus | undefined): string {
  if (!status) return "unavailable";
  return status.state.replace("_", " ");
}

function BoundRepositoryPanel({
  item,
}: {
  item: { id: string; binding: ResearchRepositoryBinding };
}) {
  const searchParams = useSearchParams();
  const urlArtifactId = searchParams.get("artifactId") ?? undefined;
  const [selectedArtifactId, setSelectedArtifactId] = useState(
    () => urlArtifactId
  );
  const [available, setAvailable] = useState<boolean>();
  const [status, setStatus] = useState<RepositoryStatus>();
  const [selectedArtifact, setSelectedArtifact] =
    useState<RepositoryArtifactRef>();
  const [browserRefreshKey, setBrowserRefreshKey] = useState(0);
  const [editorRefreshKey, setEditorRefreshKey] = useState(0);
  const [checkingError, setCheckingError] = useState<string>();
  const [reconcileError, setReconcileError] = useState<string>();
  const [reconcileConfirmation, setReconcileConfirmation] = useState<string>();
  const [reconciling, setReconciling] = useState(false);
  const previousUrlArtifactId = useRef(urlArtifactId);

  useEffect(() => {
    if (urlArtifactId === previousUrlArtifactId.current) return;
    previousUrlArtifactId.current = urlArtifactId;
    setSelectedArtifact(undefined);
    setSelectedArtifactId(urlArtifactId);
    setBrowserRefreshKey((current) => current + 1);
  }, [urlArtifactId]);

  useEffect(() => {
    let cancelled = false;
    setAvailable(undefined);
    setCheckingError(undefined);

    fetch(`/api/workspace/items/${encodeURIComponent(item.id)}/repository`, {
      credentials: "include",
      cache: "no-store",
    })
      .then(async (response) => {
        const body = (await response.json()) as RepositoryStatusResponse;
        if (response.status === 404) return { available: false as const };
        if (!response.ok || !body.status) {
          throw new Error(body.error || "Could not check repository binding");
        }
        return { available: true as const, status: body.status };
      })
      .then((result) => {
        if (cancelled) return;
        setAvailable(result.available);
        if (result.available) setStatus(result.status);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setAvailable(true);
        setCheckingError(
          cause instanceof Error
            ? cause.message
            : "Could not check repository binding"
        );
      });

    return () => {
      cancelled = true;
    };
  }, [item.id]);

  async function reconcile() {
    setReconciling(true);
    setReconcileError(undefined);
    setReconcileConfirmation(undefined);

    try {
      const response = await fetch(
        `/api/workspace/items/${encodeURIComponent(
          item.id
        )}/repository/reconcile`,
        { method: "POST", credentials: "include" }
      );
      const body = (await response.json()) as RepositoryStatusResponse;
      if (response.status === 404) {
        setAvailable(false);
        return;
      }
      if (!response.ok || !body.status) {
        throw new Error(body.error || "Could not reconcile repository");
      }
      setCheckingError(undefined);
      setStatus(body.status);
      setBrowserRefreshKey((current) => current + 1);
      setEditorRefreshKey((current) => current + 1);
      setReconcileConfirmation("Repository reconciled");
    } catch (cause) {
      setReconcileError(
        cause instanceof Error
          ? cause.message
          : "Could not reconcile repository"
      );
    } finally {
      setReconciling(false);
    }
  }

  if (available === undefined) {
    return (
      <section className="rounded-lg border bg-white p-6 text-sm text-slate-500">
        Checking repository binding…
      </section>
    );
  }
  if (!available) return null;

  const headCommitSha = status?.headCommitSha ?? item.binding.headCommitSha;

  return (
    <section className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 p-5">
        <div>
          <h1 className="text-lg font-semibold text-slate-950">
            Private research repository
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-800">
              {statusLabel(status)}
            </span>
            <span>{item.binding.branch}</span>
            <code className="rounded bg-slate-100 px-1.5 py-0.5">
              {shortCommit(headCommitSha)}
            </code>
          </div>
        </div>
        <button
          type="button"
          disabled={reconciling}
          onClick={() => void reconcile()}
          className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {reconciling ? "Reconciling…" : "Reconcile"}
        </button>
      </div>

      {(checkingError || reconcileError) && (
        <p
          role="alert"
          className="mx-5 mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {checkingError || reconcileError}
        </p>
      )}
      {reconcileConfirmation && (
        <p
          role="status"
          className="mx-5 mt-4 rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800"
        >
          {reconcileConfirmation}
        </p>
      )}

      <div className="grid gap-6 p-5 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]">
        <RepositoryBrowser
          workspaceItemId={item.id}
          selectedArtifactId={selectedArtifactId}
          refreshKey={browserRefreshKey}
          onSelectArtifact={(artifact) => {
            setSelectedArtifact(artifact);
            setSelectedArtifactId(artifact?.artifactId);
          }}
        />
        <ArtifactEditor
          workspaceItemId={item.id}
          artifact={selectedArtifact}
          refreshKey={editorRefreshKey}
          onCommitted={(commitSha) => {
            setStatus((current) =>
              current
                ? {
                    ...current,
                    state: "ready",
                    reason: undefined,
                    headCommitSha: commitSha,
                    checkedAt: new Date().toISOString(),
                  }
                : {
                    workspaceId: item.id,
                    repositoryId: item.binding.repositoryId,
                    state: "ready",
                    layoutVersion: item.binding.layoutVersion,
                    headCommitSha: commitSha,
                    checkedAt: new Date().toISOString(),
                  }
            );
            setBrowserRefreshKey((current) => current + 1);
          }}
        />
      </div>
    </section>
  );
}

export function RepositoryPanel({
  item,
  enabled = true,
}: RepositoryPanelProps) {
  if (!enabled || !item?.binding) return null;
  return <BoundRepositoryPanel item={{ id: item.id, binding: item.binding }} />;
}
