"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RepositoryArtifactRef } from "@opencanvas/shared/research-repository";

type ArtifactEditorProps = {
  workspaceItemId: string;
  artifact?: RepositoryArtifactRef;
  refreshKey?: number;
  onCommitted?: (commitSha: string) => void;
};

type ArtifactContentResponse = {
  artifact?: RepositoryArtifactRef & { supported: boolean };
  content?: string;
  error?: string;
};

type CommitResponse = {
  commitSha?: string;
  currentHeadCommitSha?: string;
  error?: string;
};

type EditorError = {
  message: string;
  code?: string;
  stale?: boolean;
};

function newIdempotencyKey(): string {
  const value =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `repository-editor-${value}`;
}

export function ArtifactEditor({
  workspaceItemId,
  artifact,
  refreshKey = 0,
  onCommitted,
}: ArtifactEditorProps) {
  const artifactId = artifact?.artifactId;
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [baseCommitSha, setBaseCommitSha] = useState<string>();
  const [supported, setSupported] = useState<boolean>();
  const [loading, setLoading] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<EditorError>();
  const [confirmation, setConfirmation] = useState<string>();
  const loadVersion = useRef(0);
  const operationTokenRef = useRef(0);
  const currentSelectionRef = useRef({ workspaceItemId, artifactId });
  currentSelectionRef.current = { workspaceItemId, artifactId };

  const loadArtifact = useCallback(async () => {
    if (!artifactId) return;
    const version = ++loadVersion.current;
    setLoading(true);
    setError(undefined);
    setConfirmation(undefined);

    try {
      const response = await fetch(
        `/api/workspace/items/${encodeURIComponent(
          workspaceItemId
        )}/repository/artifacts?artifactId=${encodeURIComponent(artifactId)}`,
        { credentials: "include", cache: "no-store" }
      );
      const body = (await response.json()) as ArtifactContentResponse;
      if (!response.ok) {
        throw new Error(body.error || "Could not load repository artifact");
      }
      if (
        !body.artifact ||
        body.artifact.artifactId !== artifactId ||
        typeof body.content !== "string"
      ) {
        throw new Error("Repository artifact response was incomplete");
      }
      if (version !== loadVersion.current) return;
      setContent(body.content);
      setSavedContent(body.content);
      setBaseCommitSha(body.artifact.commitSha);
      setSupported(body.artifact.supported);
    } catch (cause) {
      if (version !== loadVersion.current) return;
      setBaseCommitSha(undefined);
      setError({
        message:
          cause instanceof Error
            ? cause.message
            : "Could not load repository artifact",
      });
    } finally {
      if (version === loadVersion.current) setLoading(false);
    }
  }, [artifactId, workspaceItemId]);

  useEffect(() => {
    setContent("");
    setSavedContent("");
    setBaseCommitSha(undefined);
    setSupported(undefined);
    setError(undefined);
    setConfirmation(undefined);
    if (artifactId) void loadArtifact();
    return () => {
      loadVersion.current += 1;
    };
  }, [artifactId, loadArtifact, refreshKey]);

  useEffect(() => {
    operationTokenRef.current += 1;
    setCommitting(false);
  }, [artifactId, workspaceItemId]);

  async function commitChanges() {
    if (
      !artifact ||
      !baseCommitSha ||
      content === savedContent ||
      supported === false
    ) {
      return;
    }
    const committedWorkspaceItemId = workspaceItemId;
    const committedArtifactId = artifact.artifactId;
    const operationToken = ++operationTokenRef.current;
    const isCurrentOperation = () =>
      committedWorkspaceItemId ===
        currentSelectionRef.current.workspaceItemId &&
      committedArtifactId === currentSelectionRef.current.artifactId &&
      operationToken === operationTokenRef.current;
    setCommitting(true);
    setError(undefined);
    setConfirmation(undefined);

    try {
      const response = await fetch(
        `/api/workspace/items/${encodeURIComponent(
          workspaceItemId
        )}/repository/commit`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            artifactId: artifact.artifactId,
            baseCommitSha,
            content,
            commitMessage: `Update ${artifact.path}`,
            idempotencyKey: newIdempotencyKey(),
          }),
        }
      );
      const body = (await response.json()) as CommitResponse;
      if (!isCurrentOperation()) return;

      if (!response.ok) {
        if (response.status === 409 && body.error === "stale_repository") {
          setError({
            message: "The repository changed since this artifact was opened.",
            stale: true,
          });
        } else if (response.status === 422) {
          setError({
            message: "The repository rejected this artifact.",
            code: body.error || "VALIDATION_ERROR",
          });
        } else {
          setError({
            message: body.error || "Could not commit repository artifact",
          });
        }
        return;
      }

      if (!body.commitSha) {
        throw new Error("Repository commit response was incomplete");
      }
      setSavedContent(content);
      setBaseCommitSha(body.commitSha);
      setConfirmation("Changes committed");
      onCommitted?.(body.commitSha);
    } catch (cause) {
      if (!isCurrentOperation()) return;
      setError({
        message:
          cause instanceof Error
            ? cause.message
            : "Could not commit repository artifact",
      });
    } finally {
      if (isCurrentOperation()) setCommitting(false);
    }
  }

  if (!artifact) {
    return (
      <section
        aria-labelledby="artifact-editor-heading"
        className="flex min-h-72 items-center justify-center rounded border border-dashed border-slate-300 bg-slate-50 p-6"
      >
        <h2 id="artifact-editor-heading" className="sr-only">
          Artifact editor
        </h2>
        <p className="text-sm text-slate-500">Select an artifact to edit.</p>
      </section>
    );
  }

  const dirty = content !== savedContent;

  return (
    <section aria-labelledby="artifact-editor-heading" className="min-w-0">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2
            id="artifact-editor-heading"
            className="truncate text-sm font-semibold text-slate-900"
            title={artifact.path}
          >
            {artifact.path}
          </h2>
          <p
            role="status"
            className={`text-xs ${dirty ? "text-amber-700" : "text-slate-500"}`}
          >
            {dirty ? "Unsaved changes" : "No unsaved changes"}
          </p>
        </div>
        <button
          type="button"
          disabled={
            supported === false ||
            !dirty ||
            loading ||
            committing ||
            !baseCommitSha
          }
          onClick={() => void commitChanges()}
          className="rounded border border-slate-300 bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {committing ? "Committing…" : "Commit changes"}
        </button>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          <p>{error.message}</p>
          {error.code && <code className="font-semibold">{error.code}</code>}
          {error.stale && (
            <button
              type="button"
              onClick={() => void loadArtifact()}
              className="mt-2 block rounded border border-red-300 bg-white px-2.5 py-1 font-medium text-red-800 hover:bg-red-100"
            >
              Refresh first
            </button>
          )}
        </div>
      )}
      {confirmation && (
        <p
          role="status"
          className="mb-3 rounded border border-emerald-200 bg-emerald-50 p-2 text-sm text-emerald-800"
        >
          {confirmation}
        </p>
      )}
      {supported === false && (
        <p
          role="note"
          className="mb-3 rounded border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800"
        >
          This artifact version is not supported by this workspace
        </p>
      )}

      {loading ? (
        <div className="flex min-h-72 items-center justify-center rounded border border-slate-300 bg-slate-50 text-sm text-slate-500">
          Loading artifact…
        </div>
      ) : (
        <textarea
          aria-label={`Edit ${artifact.path}`}
          disabled={supported === false}
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setConfirmation(undefined);
          }}
          spellCheck={false}
          className="min-h-[32rem] w-full resize-y rounded border border-slate-300 bg-white p-4 font-mono text-sm leading-6 text-slate-900 shadow-inner focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
        />
      )}
    </section>
  );
}
