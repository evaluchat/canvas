"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type {
  RepositoryArtifactRef,
  RepositoryStatus,
  ResearchRepositoryBinding,
} from "@opencanvas/shared/research-repository";
import { ArtifactEditor } from "./artifact-editor";
import {
  RESEARCH_REPOSITORY_TRUST_COPY,
  REPOSITORY_PUBLIC_COPY,
  REPOSITORY_UNAVAILABLE_COPY,
} from "./copy";
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
  message?: string;
  readonlyReason?: "repository_public";
};

type SealPreview = {
  snapshotId: string;
  sealedFromCommit: string;
  reviewedAt: string;
  configurationHash: string;
  renderHash: string;
  inputs: Array<{ path: string; blobSha: string; sha256: string }>;
  ledgerPath: string;
  sealPath: string;
  latestSnapshotId?: string;
};

type SealResponse = {
  preview?: SealPreview;
  operationId?: string;
  commitSha?: string;
  snapshotId?: string;
  error?: string;
};

/**
 * Researcher declarations required before a seal commits. Same field contract
 * as the v0.7 publication route; the seal API rejects unconfirmed values.
 */
const DECLARATION_OPTIONS = {
  publicationAuthorisation: [
    { value: "", label: "Select authorisation…" },
    {
      value: "confirmed-authorised-to-publish",
      label: "Confirmed: authorised to publish",
    },
    {
      value: "not-confirmed-do-not-submit",
      label: "Not confirmed: do not submit",
    },
  ],
  anonymisationStatus: [
    { value: "", label: "Select anonymisation…" },
    {
      value: "confirmed-no-student-identifiers-or-raw-student-material",
      label: "Confirmed: no student identifiers or raw material",
    },
    {
      value: "needs-human-privacy-review",
      label: "Needs human privacy review",
    },
  ],
  publicDataDeclaration: [
    { value: "", label: "Select public data…" },
    { value: "confirmed-public-data", label: "Confirmed: public data" },
    {
      value: "not-confirmed-do-not-submit",
      label: "Not confirmed: do not submit",
    },
  ],
} as const;

type DeclarationKey = keyof typeof DECLARATION_OPTIONS;

const DECLARATION_CONFIRMED: Record<DeclarationKey, string> = {
  publicationAuthorisation: "confirmed-authorised-to-publish",
  anonymisationStatus:
    "confirmed-no-student-identifiers-or-raw-student-material",
  publicDataDeclaration: "confirmed-public-data",
};

function shortCommit(sha: string | undefined): string {
  return sha ? sha.slice(0, 7) : "unknown";
}

function statusLabel(status: RepositoryStatus | undefined): string {
  if (!status) return "unavailable";
  return status.state.replace("_", " ");
}

function shortHash(value: string): string {
  return value.slice(0, 12);
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
  const [sealPreview, setSealPreview] = useState<SealPreview>();
  const [latestSnapshotId, setLatestSnapshotId] = useState<string>();
  const [sealResult, setSealResult] = useState<{
    commitSha: string;
    snapshotId: string;
  }>();
  const [sealError, setSealError] = useState<string>();
  const [sealAction, setSealAction] = useState<
    "preview" | "seal" | "supersede"
  >();
  const [declarations, setDeclarations] = useState<
    Record<DeclarationKey, string>
  >({
    publicationAuthorisation: "",
    anonymisationStatus: "",
    publicDataDeclaration: "",
  });
  const declarationsConfirmed = (
    Object.keys(DECLARATION_CONFIRMED) as DeclarationKey[]
  ).every((key) => declarations[key] === DECLARATION_CONFIRMED[key]);
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
        if (body.status) {
          return { available: true as const, status: body.status };
        }
        if (!response.ok) {
          throw new Error(
            body.message || body.error || "Could not check repository binding"
          );
        }
        throw new Error("Could not check repository binding");
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

  function recordSealResult(commitSha: string, snapshotId: string) {
    setSealResult({ commitSha, snapshotId });
    setLatestSnapshotId(snapshotId);
    setSealPreview(undefined);
    setStatus((current) =>
      current
        ? {
            ...current,
            state: "ready",
            reason: undefined,
            headCommitSha: commitSha,
            checkedAt: new Date().toISOString(),
          }
        : current
    );
    setBrowserRefreshKey((current) => current + 1);
    setEditorRefreshKey((current) => current + 1);
  }

  async function requestSeal(action: "preview" | "seal" | "supersede") {
    setSealAction(action);
    setSealError(undefined);
    setSealResult(undefined);
    try {
      const requestBody =
        action === "preview"
          ? { action }
          : action === "seal"
            ? { action, preview: sealPreview, declarations }
            : { action, supersedes: latestSnapshotId, declarations };
      const response = await fetch(
        `/api/workspace/items/${encodeURIComponent(item.id)}/repository/seal`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
        }
      );
      const body = (await response.json()) as SealResponse;
      if (response.status === 404 && body.error === "Not found") {
        setAvailable(false);
        return;
      }
      if (!response.ok) {
        throw new Error(body.error || "Could not seal repository snapshot");
      }
      if (action === "preview" && body.preview) {
        setSealPreview(body.preview);
        setLatestSnapshotId(body.preview.latestSnapshotId);
        return;
      }
      if (body.commitSha && body.snapshotId) {
        recordSealResult(body.commitSha, body.snapshotId);
        return;
      }
      throw new Error("The repository seal response was incomplete");
    } catch (cause) {
      setSealError(
        cause instanceof Error
          ? cause.message
          : "Could not seal repository snapshot"
      );
    } finally {
      setSealAction(undefined);
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
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            {RESEARCH_REPOSITORY_TRUST_COPY}
          </p>
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

      {(status?.reason === "repository_deleted" ||
        (status?.state === "blocked" &&
          (status.reason === "permission_lost" ||
            status.reason === "branch_deleted" ||
            status.reason === "force_push"))) && (
        <p
          role="status"
          className="mx-5 mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {REPOSITORY_UNAVAILABLE_COPY}
        </p>
      )}
      {(status?.readonlyReason === "repository_public" ||
        status?.reason === "repository_public") && (
        <p
          role="status"
          className="mx-5 mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
        >
          {REPOSITORY_PUBLIC_COPY}
        </p>
      )}
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
          readOnly={status?.state !== "ready"}
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

      <div className="border-t border-slate-200 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-950">
              Seal snapshot
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-slate-600">
              Review a deterministic ledger preview, then commit the ledger and
              its seal manifest together.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={Boolean(sealAction) || status?.state !== "ready"}
              onClick={() => void requestSeal("preview")}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sealAction === "preview" ? "Previewing…" : "Preview"}
            </button>
            <button
              type="button"
              disabled={
                Boolean(sealAction) ||
                status?.state !== "ready" ||
                !sealPreview ||
                !declarationsConfirmed
              }
              onClick={() => void requestSeal("seal")}
              className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sealAction === "seal" ? "Sealing…" : "Seal"}
            </button>
            {latestSnapshotId && (
              <button
                type="button"
                disabled={
                  Boolean(sealAction) ||
                  status?.state !== "ready" ||
                  !declarationsConfirmed
                }
                onClick={() => void requestSeal("supersede")}
                className="rounded border border-amber-300 bg-amber-50 px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {sealAction === "supersede" ? "Superseding…" : "Supersede"}
              </button>
            )}
          </div>
        </div>

        {sealError && (
          <p
            role="alert"
            className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          >
            {sealError}
          </p>
        )}
        <fieldset className="mt-4 grid gap-x-6 gap-y-2 rounded border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-3">
          <legend className="px-1 text-xs font-medium text-slate-600">
            Researcher declarations (required before sealing)
          </legend>
          {(Object.keys(DECLARATION_OPTIONS) as DeclarationKey[]).map((key) => (
            <label
              key={key}
              className="flex flex-col gap-1 text-xs font-medium text-slate-700"
            >
              {key.charAt(0).toUpperCase() +
                key.replace(/([a-z])([A-Z])/g, "$1 $2").slice(1)}
              <select
                value={declarations[key]}
                onChange={(event) =>
                  setDeclarations((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }))
                }
                className="rounded border border-slate-300 bg-white px-2 py-1 text-sm font-normal text-slate-900"
              >
                {DECLARATION_OPTIONS[key].map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {!declarationsConfirmed && (
            <p className="text-xs text-amber-700 sm:col-span-3">
              Confirm all three declarations to enable Seal and Supersede.
            </p>
          )}
        </fieldset>
        {sealPreview && (
          <dl className="mt-4 grid gap-x-6 gap-y-2 rounded border border-slate-200 bg-slate-50 p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="font-medium text-slate-700">Snapshot</dt>
              <dd className="break-all text-slate-950">
                {sealPreview.snapshotId}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-slate-700">Input count</dt>
              <dd className="text-slate-950">{sealPreview.inputs.length}</dd>
            </div>
            <div>
              <dt className="font-medium text-slate-700">Files</dt>
              <dd className="break-all text-slate-950">
                {sealPreview.ledgerPath}, {sealPreview.sealPath}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-slate-700">Hashes</dt>
              <dd className="font-mono text-xs text-slate-950">
                config {shortHash(sealPreview.configurationHash)} · render{" "}
                {shortHash(sealPreview.renderHash)}
              </dd>
            </div>
          </dl>
        )}
        {sealResult && (
          <p
            role="status"
            className="mt-4 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"
          >
            Sealed snapshot {sealResult.snapshotId} at commit{" "}
            <code>{sealResult.commitSha}</code>.
          </p>
        )}
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
