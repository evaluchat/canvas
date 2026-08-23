"use client";

import { useEffect, useRef, useState } from "react";
import type { RepositoryArtifactRef } from "@opencanvas/shared/research-repository";

type RepositoryBrowserProps = {
  workspaceItemId: string;
  selectedArtifactId?: string;
  refreshKey?: number;
  onSelectArtifact: (artifact: RepositoryArtifactRef | undefined) => void;
  onArtifactsLoaded?: (headCommitSha: string) => void;
};

type ArtifactListResponse = {
  artifacts?: RepositoryArtifactRef[];
  headCommitSha?: string;
  error?: string;
};

type ArtifactTreeDirectory = {
  name: string;
  directories: Map<string, ArtifactTreeDirectory>;
  files: { name: string; artifact: RepositoryArtifactRef }[];
};

function buildArtifactTree(
  artifacts: RepositoryArtifactRef[]
): ArtifactTreeDirectory {
  const root: ArtifactTreeDirectory = {
    name: "",
    directories: new Map(),
    files: [],
  };

  for (const artifact of artifacts) {
    const parts = artifact.path.split("/");
    const fileName = parts.pop();
    if (!fileName) continue;

    let directory = root;
    for (const part of parts) {
      let child = directory.directories.get(part);
      if (!child) {
        child = { name: part, directories: new Map(), files: [] };
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push({ name: fileName, artifact });
  }

  return root;
}

function ArtifactTree({
  directory,
  selectedArtifactId,
  onSelectArtifact,
  nested = false,
}: {
  directory: ArtifactTreeDirectory;
  selectedArtifactId?: string;
  onSelectArtifact: (artifact: RepositoryArtifactRef) => void;
  nested?: boolean;
}) {
  const directories = Array.from(directory.directories.values()).sort(
    (left, right) => left.name.localeCompare(right.name)
  );
  const files = [...directory.files].sort((left, right) =>
    left.name.localeCompare(right.name)
  );

  return (
    <ul
      role={nested ? "group" : "tree"}
      className={nested ? "ml-4 border-l border-slate-200 pl-3" : "space-y-1"}
    >
      {directories.map((child) => (
        <li
          key={child.name}
          role="treeitem"
          aria-expanded="true"
          aria-selected="false"
        >
          <div className="py-1 text-xs font-semibold text-slate-600">
            {child.name}/
          </div>
          <ArtifactTree
            directory={child}
            selectedArtifactId={selectedArtifactId}
            onSelectArtifact={onSelectArtifact}
            nested
          />
        </li>
      ))}
      {files.map(({ name, artifact }) => {
        const selected = artifact.artifactId === selectedArtifactId;
        return (
          <li
            key={artifact.artifactId}
            role="treeitem"
            aria-selected={selected}
          >
            <button
              type="button"
              aria-pressed={selected}
              title={artifact.path}
              onClick={() => onSelectArtifact(artifact)}
              className={`w-full rounded px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${
                selected
                  ? "bg-slate-200 font-medium text-slate-950"
                  : "text-slate-700 hover:bg-slate-100"
              }`}
            >
              {name}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function RepositoryBrowser({
  workspaceItemId,
  selectedArtifactId,
  refreshKey = 0,
  onSelectArtifact,
  onArtifactsLoaded,
}: RepositoryBrowserProps) {
  const [artifacts, setArtifacts] = useState<RepositoryArtifactRef[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const selectionRef = useRef({
    selectedArtifactId,
    onSelectArtifact,
    onArtifactsLoaded,
  });
  selectionRef.current = {
    selectedArtifactId,
    onSelectArtifact,
    onArtifactsLoaded,
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    fetch(
      `/api/workspace/items/${encodeURIComponent(workspaceItemId)}/repository/artifacts`,
      { credentials: "include", cache: "no-store" }
    )
      .then(async (response) => {
        const body = (await response.json()) as ArtifactListResponse;
        if (!response.ok) {
          throw new Error(body.error || "Could not load repository artifacts");
        }
        if (!body.artifacts || !body.headCommitSha) {
          throw new Error("Repository artifacts response was incomplete");
        }
        return {
          artifacts: body.artifacts,
          headCommitSha: body.headCommitSha,
        };
      })
      .then((body) => {
        if (cancelled) return;
        setArtifacts(body.artifacts);
        const selection = selectionRef.current;
        selection.onArtifactsLoaded?.(body.headCommitSha);
        if (selection.selectedArtifactId) {
          selection.onSelectArtifact(
            body.artifacts.find(
              (artifact) => artifact.artifactId === selection.selectedArtifactId
            )
          );
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setArtifacts([]);
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load repository artifacts"
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshKey, workspaceItemId]);

  return (
    <section aria-labelledby="repository-artifacts-heading">
      <h2
        id="repository-artifacts-heading"
        className="mb-3 text-sm font-semibold text-slate-900"
      >
        Artifacts
      </h2>
      {loading ? (
        <p className="text-sm text-slate-500">Loading artifacts…</p>
      ) : error ? (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      ) : artifacts.length === 0 ? (
        <p className="text-sm text-slate-500">No managed artifacts found.</p>
      ) : (
        <ArtifactTree
          directory={buildArtifactTree(artifacts)}
          selectedArtifactId={selectedArtifactId}
          onSelectArtifact={(artifact) => onSelectArtifact(artifact)}
        />
      )}
    </section>
  );
}
