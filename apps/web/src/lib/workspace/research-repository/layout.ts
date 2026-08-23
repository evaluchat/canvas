import type { RepositoryArtifactRef } from "@opencanvas/shared/research-repository";

export const REPOSITORY_ARTIFACT_MAX_BYTES = 1024 * 1024;
export const REPOSITORY_ARTIFACT_MAX_COUNT = 1000;

export type RepositoryArtifactIdentity = Pick<
  RepositoryArtifactRef,
  "artifactId" | "kind" | "path"
>;

export class RepositoryLayoutError extends Error {
  constructor(
    public readonly code:
      | "UNSUPPORTED_LAYOUT"
      | "INVALID_ARTIFACT_ID"
      | "INVALID_ARTIFACT_PATH"
      | "INVALID_ARTIFACT_TYPE"
      | "ARTIFACT_TOO_LARGE"
      | "TOO_MANY_ARTIFACTS"
      | "EXECUTABLE_ARTIFACT"
      | "SYMLINK_ARTIFACT",
    message: string
  ) {
    super(message);
    this.name = "RepositoryLayoutError";
  }
}

const COMPONENT = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;
const ARTIFACT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function isRepositoryLayoutVersionSupported(
  layoutVersion: string
): boolean {
  return layoutVersion === "1.0";
}

const FIXED_ARTIFACTS = new Map<string, RepositoryArtifactIdentity>([
  [
    "workspace-manifest",
    {
      artifactId: "workspace-manifest",
      kind: "workspace_manifest",
      path: ".evaluchat/workspace.yml",
    },
  ],
  ["index", { artifactId: "index", kind: "index", path: "index.md" }],
  ["readme", { artifactId: "readme", kind: "readme", path: "README.md" }],
  [
    "citation",
    { artifactId: "citation", kind: "citation", path: "CITATION.cff" },
  ],
  [
    "gitignore",
    { artifactId: "gitignore", kind: "gitignore", path: ".gitignore" },
  ],
]);

function assertLayoutVersion(layoutVersion: string): void {
  if (!isRepositoryLayoutVersionSupported(layoutVersion)) {
    throw new RepositoryLayoutError(
      "UNSUPPORTED_LAYOUT",
      `Unsupported research repository layout ${layoutVersion}`
    );
  }
}

function assertComponent(value: string): string {
  if (!COMPONENT.test(value)) {
    throw new RepositoryLayoutError(
      "INVALID_ARTIFACT_ID",
      "Artifact identifiers must contain normalized lower-case components"
    );
  }
  return value;
}

/** Reject paths before normalization so traversal can never be hidden. */
export function assertSafeRepositoryArtifactPath(path: string): void {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.length > 512 ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    path.includes("//") ||
    segments.some((segment) => segment === "." || segment === "..")
  ) {
    throw new RepositoryLayoutError(
      "INVALID_ARTIFACT_PATH",
      "Expected a normalized repository-relative artifact path"
    );
  }
  if (
    segments.some(
      (segment) =>
        /(?:\.lnk|\.symlink)$/i.test(segment) || segment.includes("->")
    )
  ) {
    throw new RepositoryLayoutError(
      "SYMLINK_ARTIFACT",
      "Symbolic-link-looking artifact names are not allowed"
    );
  }
}

/**
 * Convert a v1.0 managed path into its stable, server-owned artifact id.
 * Dynamic ids include their parent method so they remain unambiguous.
 */
export function identifyRepositoryArtifactPath(
  path: string,
  layoutVersion = "1.0"
): RepositoryArtifactIdentity | undefined {
  assertLayoutVersion(layoutVersion);

  for (const artifact of FIXED_ARTIFACTS.values()) {
    if (artifact.path === path) return artifact;
  }

  let match = /^theory\/([^/]+)\.en\.md$/.exec(path);
  if (match && COMPONENT.test(match[1])) {
    return {
      artifactId: `theory.${match[1]}`,
      kind: "theory",
      path,
    };
  }

  match = /^methods\/([^/]+)\/\1\.en\.md$/.exec(path);
  if (match && COMPONENT.test(match[1])) {
    return {
      artifactId: `method.${match[1]}`,
      kind: "method",
      path,
    };
  }

  match = /^methods\/([^/]+)\/evidence-template\.en\.md$/.exec(path);
  if (match && COMPONENT.test(match[1])) {
    return {
      artifactId: `evidence-template.${match[1]}`,
      kind: "evidence_template",
      path,
    };
  }

  match = /^methods\/([^/]+)\/evidence\/([^/]+)\.en\.md$/.exec(path);
  if (match && COMPONENT.test(match[1]) && COMPONENT.test(match[2])) {
    return {
      artifactId: `evidence.${match[1]}.${match[2]}`,
      kind: "evidence",
      path,
    };
  }

  match = /^methods\/([^/]+)\/evidence\/ledgers\/([^/]+)\.en\.md$/.exec(path);
  if (match && COMPONENT.test(match[1]) && COMPONENT.test(match[2])) {
    return {
      artifactId: `ledger.${match[1]}.${match[2]}`,
      kind: "ledger",
      path,
    };
  }

  match = /^methods\/([^/]+)\/evidence\/ledgers\/([^/]+)\.seal\.yml$/.exec(
    path
  );
  if (match && COMPONENT.test(match[1]) && COMPONENT.test(match[2])) {
    return {
      artifactId: `ledger-seal.${match[1]}.${match[2]}`,
      kind: "ledger_seal",
      path,
    };
  }

  match = /^ledger\/seals\/([^/]+)\.en\.md$/.exec(path);
  if (match && COMPONENT.test(match[1])) {
    return {
      artifactId: `ledger.${match[1]}`,
      kind: "ledger",
      path,
    };
  }

  match = /^ledger\/seals\/([^/]+)\.seal\.yml$/.exec(path);
  if (match && COMPONENT.test(match[1])) {
    return {
      artifactId: `ledger-seal.${match[1]}`,
      kind: "ledger_seal",
      path,
    };
  }

  match = /^findings\/([^/]+)\.en\.md$/.exec(path);
  if (match && COMPONENT.test(match[1])) {
    return {
      artifactId: `finding.${match[1]}`,
      kind: "finding",
      path,
    };
  }

  return undefined;
}

/** Resolve an artifact id without accepting a browser-supplied path. */
export function resolveRepositoryArtifactPath(
  artifactId: string,
  layoutVersion = "1.0"
): RepositoryArtifactIdentity {
  assertLayoutVersion(layoutVersion);
  if (!ARTIFACT_ID.test(artifactId) || artifactId.length > 128) {
    throw new RepositoryLayoutError(
      "INVALID_ARTIFACT_ID",
      "Invalid repository artifact id"
    );
  }

  const fixed = FIXED_ARTIFACTS.get(artifactId);
  if (fixed) return fixed;

  const parts = artifactId.split(".");
  const kind = parts.shift();
  let path: string | undefined;
  if (kind === "theory" && parts.length === 1) {
    path = `theory/${assertComponent(parts[0])}.en.md`;
  } else if (kind === "method" && parts.length === 1) {
    const methodId = assertComponent(parts[0]);
    path = `methods/${methodId}/${methodId}.en.md`;
  } else if (kind === "evidence-template" && parts.length === 1) {
    path = `methods/${assertComponent(parts[0])}/evidence-template.en.md`;
  } else if (kind === "evidence" && parts.length === 2) {
    path = `methods/${assertComponent(parts[0])}/evidence/${assertComponent(
      parts[1]
    )}.en.md`;
  } else if (kind === "ledger" && parts.length === 2) {
    path = `methods/${assertComponent(
      parts[0]
    )}/evidence/ledgers/${assertComponent(parts[1])}.en.md`;
  } else if (kind === "ledger" && parts.length === 1) {
    // Sealed snapshot render (ledger/seals/<snapshot-id>.en.md).
    path = `ledger/seals/${assertComponent(parts[0])}.en.md`;
  } else if (kind === "ledger-seal" && parts.length === 2) {
    path = `methods/${assertComponent(
      parts[0]
    )}/evidence/ledgers/${assertComponent(parts[1])}.seal.yml`;
  } else if (kind === "ledger-seal" && parts.length === 1) {
    // Sealed snapshot manifest (ledger/seals/<snapshot-id>.seal.yml).
    path = `ledger/seals/${assertComponent(parts[0])}.seal.yml`;
  } else if (kind === "finding" && parts.length === 1) {
    path = `findings/${assertComponent(parts[0])}.en.md`;
  }

  if (!path) {
    throw new RepositoryLayoutError(
      "INVALID_ARTIFACT_ID",
      "Artifact id is not part of research repository layout 1.0"
    );
  }
  const artifact = identifyRepositoryArtifactPath(path, layoutVersion);
  if (!artifact || artifact.artifactId !== artifactId) {
    throw new RepositoryLayoutError(
      "INVALID_ARTIFACT_ID",
      "Artifact id does not resolve to a managed repository path"
    );
  }
  return artifact;
}

export function validateRepositoryArtifactContent(
  path: string,
  content: string
): void {
  assertSafeRepositoryArtifactPath(path);
  if (!identifyRepositoryArtifactPath(path)) {
    throw new RepositoryLayoutError(
      "INVALID_ARTIFACT_TYPE",
      "Only managed Markdown, YAML, CFF, and gitignore artifacts are allowed"
    );
  }
  if (Buffer.byteLength(content, "utf8") > REPOSITORY_ARTIFACT_MAX_BYTES) {
    throw new RepositoryLayoutError(
      "ARTIFACT_TOO_LARGE",
      "Repository artifacts may not exceed 1 MB"
    );
  }
}

export function validateRepositoryArtifactMode(
  path: string,
  mode: string
): void {
  if (mode === "120000") {
    throw new RepositoryLayoutError(
      "SYMLINK_ARTIFACT",
      `${path} may not be a symbolic link`
    );
  }
  if (mode !== "100644") {
    throw new RepositoryLayoutError(
      "EXECUTABLE_ARTIFACT",
      `${path} must be a non-executable regular file`
    );
  }
}

export function validateRepositoryArtifactCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new RepositoryLayoutError(
      "TOO_MANY_ARTIFACTS",
      "Invalid managed artifact count"
    );
  }
  if (count > REPOSITORY_ARTIFACT_MAX_COUNT) {
    throw new RepositoryLayoutError(
      "TOO_MANY_ARTIFACTS",
      "Research repositories may not contain more than 1000 managed artifacts"
    );
  }
}
