import { createHash, randomUUID } from "node:crypto";
import type { LedgerConfig, LedgerSnapshotData } from "@opencanvas/shared";
import {
  LedgerSealManifestV1Schema,
  type LedgerSealManifestV1,
  type RepositoryArtifactRef,
  type ResearchRepositoryBinding,
} from "@opencanvas/shared/research-repository";
import yaml from "js-yaml";
import { ledgerRenderHash, renderLedgerBody } from "../ledger-publish";
import { parseArtifactFrontMatter } from "./authoring";
import type { DecryptedGithubResearchCredentials } from "./credentials";
import {
  commitArtifactBlobs,
  listRepositoryArtifactRefs,
  readArtifactBlob,
  StaleRepositoryError,
  type GithubCommitAuthor,
  type GithubRepositoryCoordinates,
} from "./git-adapter";

const SNAPSHOT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEAL_MANIFEST_PATH = /^ledger\/seals\/([^/]+)\.seal\.yml$/;
const METHOD_SEAL_MANIFEST_PATH =
  /^methods\/[^/]+\/evidence\/ledgers\/([^/]+)\.seal\.yml$/;
const METHOD_SEAL_RENDER_PATH =
  /^methods\/([^/]+)\/evidence\/ledgers\/([^/]+)\.en\.md$/;
const SEAL_INPUT_KINDS = new Set(["method", "evidence", "finding", "ledger"]);

/**
 * Seal outputs live under ledger/seals/ (rendered `<id>.en.md` and
 * `<id>.seal.yml`) and, for method-scoped seals, next to the method ledger.
 * The renders carry kind "ledger" and must never feed back into the input
 * set: after the first seal, its own render would otherwise become an input
 * of the next seal and drift configurationHash/renderHash on every seal even
 * when nothing changed.
 */
const SEAL_OUTPUT_PREFIX = "ledger/seals/";

function isSealManifestPath(path: string): boolean {
  return SEAL_MANIFEST_PATH.test(path) || METHOD_SEAL_MANIFEST_PATH.test(path);
}

function isSealRenderPath(
  path: string,
  artifacts: readonly RepositoryArtifactRef[]
): boolean {
  if (path.startsWith(SEAL_OUTPUT_PREFIX)) return true;
  const match = METHOD_SEAL_RENDER_PATH.exec(path);
  if (!match) return false;
  const manifestPath = `methods/${match[1]}/evidence/ledgers/${match[2]}.seal.yml`;
  return artifacts.some((artifact) => artifact.path === manifestPath);
}

export type SealSnapshotErrorCode =
  | "DECLARATIONS_REQUIRED"
  | "INVALID_METHOD"
  | "INVALID_PREVIEW"
  | "MISSING_METHOD"
  | "NO_SEAL_INPUTS"
  | "PREVIEW_MISMATCH"
  | "SNAPSHOT_ALREADY_SEALED"
  | "UNKNOWN_SNAPSHOT";

export class SealSnapshotError extends Error {
  constructor(
    public readonly code: SealSnapshotErrorCode,
    message: string
  ) {
    super(message);
    this.name = "SealSnapshotError";
  }
}

export type RepositorySealAccess = {
  binding: ResearchRepositoryBinding;
  credentials: DecryptedGithubResearchCredentials;
  repository: GithubRepositoryCoordinates;
};

export type SealSnapshotPreview = LedgerSealManifestV1 & {
  ledgerPath: string;
  sealPath: string;
  ledgerMarkdown: string;
  manifestYaml: string;
  inputArtifactIds: string[];
  latestSnapshotId?: string;
  /**
   * The deterministic v0.7 ledger snapshot this preview renders. Carried so
   * the declaration gate can validate researcher confirmations against the
   * exact repository state under review. Never serialized or stored.
   */
  snapshotData: LedgerSnapshotData;
};

type PreviewOptions = {
  expectedHeadCommitSha?: string;
  reviewedAt?: string;
  snapshotId?: string;
  supersedes?: string;
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function githubLogin(credentials: DecryptedGithubResearchCredentials): string {
  const login = credentials.displayMetadata.login;
  if (typeof login !== "string" || !login.trim()) {
    throw new SealSnapshotError(
      "INVALID_PREVIEW",
      "The bound GitHub credential has no reviewer login"
    );
  }
  return login;
}

function assertSnapshotId(snapshotId: string): void {
  if (!SNAPSHOT_ID.test(snapshotId)) {
    throw new SealSnapshotError(
      "INVALID_PREVIEW",
      "A seal snapshot id must be a UUID v4"
    );
  }
}

export function sealLedgerPath(snapshotId: string): string {
  assertSnapshotId(snapshotId);
  return `ledger/seals/${snapshotId}.en.md`;
}

export function sealManifestPath(snapshotId: string): string {
  assertSnapshotId(snapshotId);
  return `ledger/seals/${snapshotId}.seal.yml`;
}

/**
 * Canonical configuration bytes are the UTF-8 JSON encoding, in this exact
 * key order, of method {id,version}, layout_version, and the lexically sorted
 * input_artifact_ids array. No whitespace or other repository metadata is
 * included.
 */
export function canonicalSealConfigurationJson(input: {
  method: { id: string; version: string };
  layoutVersion: string;
  inputArtifactIds: string[];
}): string {
  return JSON.stringify({
    method: { id: input.method.id, version: input.method.version },
    layout_version: input.layoutVersion,
    input_artifact_ids: [...input.inputArtifactIds].sort(compare),
  });
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sealManifestFile(
  manifest: LedgerSealManifestV1
): Record<string, unknown> {
  return {
    schema_version: manifest.schemaVersion,
    snapshot_id: manifest.snapshotId,
    sealed_from_commit: manifest.sealedFromCommit,
    reviewer_login: manifest.reviewerLogin,
    reviewed_at: manifest.reviewedAt,
    method: manifest.method,
    inputs: manifest.inputs.map((input) => ({
      path: input.path,
      blob_sha: input.blobSha,
      sha256: input.sha256,
    })),
    configuration_hash: manifest.configurationHash,
    render_hash: manifest.renderHash,
    ...(manifest.supersedes ? { supersedes: manifest.supersedes } : {}),
  };
}

export function serializeSealManifest(manifest: LedgerSealManifestV1): string {
  const source = yaml.dump(sealManifestFile(manifest), {
    lineWidth: -1,
    noRefs: true,
    sortKeys: false,
  });
  const parsed = yaml.load(source, { schema: yaml.JSON_SCHEMA });
  LedgerSealManifestV1Schema.parse(parsed);
  return source;
}

export function parseSealManifest(source: string): LedgerSealManifestV1 {
  return LedgerSealManifestV1Schema.parse(
    yaml.load(source, { schema: yaml.JSON_SCHEMA })
  );
}

function methodIdentity(
  artifacts: RepositoryArtifactRef[],
  contents: Map<string, string>
): { id: string; version: string } {
  const methodArtifact = artifacts.find(
    (artifact) => artifact.kind === "method"
  );
  if (!methodArtifact) {
    throw new SealSnapshotError(
      "MISSING_METHOD",
      "A repository seal requires a Method artifact"
    );
  }
  const parsed = parseArtifactFrontMatter(
    contents.get(methodArtifact.path) ?? ""
  );
  if (!parsed.ok) {
    throw new SealSnapshotError(
      "INVALID_METHOD",
      "The Method artifact has invalid front-matter"
    );
  }
  const id = parsed.data.id;
  const version = parsed.data.version;
  if (typeof id !== "string" || typeof version !== "string") {
    throw new SealSnapshotError(
      "INVALID_METHOD",
      "The Method artifact requires id and version fields"
    );
  }
  return { id, version };
}

function ledgerSnapshot(
  manifest: LedgerSealManifestV1,
  artifacts: RepositoryArtifactRef[],
  layoutVersion: string
): { snapshot: LedgerSnapshotData; config: LedgerConfig } {
  const config: LedgerConfig = {
    methodId: manifest.method.id,
    methodVersion: manifest.method.version,
    templateId: "repository-artifacts",
    templateVersion: layoutVersion,
    filters: [],
  };
  const contributions = artifacts.map((artifact) => {
    const input = manifest.inputs.find(
      (candidate) => candidate.path === artifact.path
    );
    if (!input) {
      throw new SealSnapshotError(
        "INVALID_PREVIEW",
        "A seal input is missing its rendered contribution"
      );
    }
    return {
      id: artifact.artifactId,
      path: artifact.path,
      sourceHash: input.sha256,
      methodId: manifest.method.id,
      methodVersion: manifest.method.version,
      templateVersion: layoutVersion,
      dimensionValues: {},
      scopeValues: {},
      bucket: "Included" as const,
    };
  });
  const snapshot: LedgerSnapshotData = {
    ledgerId: manifest.snapshotId,
    methodId: manifest.method.id,
    methodVersion: manifest.method.version,
    templateId: config.templateId,
    templateVersion: config.templateVersion,
    filters: [],
    manifest: {
      methods: [],
      filters: [],
      contributions,
    },
    inputFingerprint: manifest.configurationHash,
    renderHash: "",
    buckets: {
      Included: contributions.length,
      "Outside declared scope": 0,
      Unknown: 0,
      Unavailable: 0,
      "Resolver exclusion": 0,
    },
    predicate:
      "all managed method, evidence, finding, and ledger artifacts at the sealed commit",
    generatedAt: manifest.reviewedAt,
    resolverVersion: "repository-seal/1",
    sourceCommit: manifest.sealedFromCommit,
  };
  return { snapshot, config };
}

function sealRefs(artifacts: RepositoryArtifactRef[]): RepositoryArtifactRef[] {
  return artifacts.filter(
    (artifact) =>
      artifact.kind === "ledger_seal" && isSealManifestPath(artifact.path)
  );
}

async function sealManifestsFromArtifacts(
  access: RepositorySealAccess,
  artifacts: RepositoryArtifactRef[],
  expectedCommitSha: string
): Promise<LedgerSealManifestV1[]> {
  return Promise.all(
    sealRefs(artifacts).map(async (artifact) => {
      const blob = await readArtifactBlob(
        access.binding.installationId,
        access.repository,
        access.binding.branch,
        artifact.path
      );
      if (blob.commitSha !== expectedCommitSha) {
        throw new StaleRepositoryError(blob.commitSha);
      }
      return parseSealManifest(blob.content);
    })
  );
}

async function newestSealFromArtifacts(
  access: RepositorySealAccess,
  artifacts: RepositoryArtifactRef[],
  expectedCommitSha: string
): Promise<string | undefined> {
  const manifests = await sealManifestsFromArtifacts(
    access,
    artifacts,
    expectedCommitSha
  );
  return manifests.sort(
    (left, right) =>
      Date.parse(right.reviewedAt) - Date.parse(left.reviewedAt) ||
      compare(right.snapshotId, left.snapshotId)
  )[0]?.snapshotId;
}

/**
 * Resolves a complete preview from one repository head. The caller supplies
 * reviewedAt once and it is then stable preview data; snapshotId is the only
 * value generated non-deterministically here (UUID v4). All render and hash
 * fields are deterministic functions of the resolved head and supplied time.
 */
export async function previewSealSnapshot(
  access: RepositorySealAccess,
  options: PreviewOptions = {}
): Promise<SealSnapshotPreview> {
  const listed = await listRepositoryArtifactRefs(
    access.binding.installationId,
    access.repository,
    access.binding.branch,
    access.binding.layoutVersion
  );
  if (
    options.expectedHeadCommitSha &&
    listed.commitSha !== options.expectedHeadCommitSha
  ) {
    throw new StaleRepositoryError(listed.commitSha);
  }

  const snapshotId = options.snapshotId ?? randomUUID();
  assertSnapshotId(snapshotId);
  const sealed = await sealManifestsFromArtifacts(
    access,
    listed.artifacts,
    listed.commitSha
  );
  if (sealed.some((manifest) => manifest.snapshotId === snapshotId)) {
    throw new SealSnapshotError(
      "SNAPSHOT_ALREADY_SEALED",
      "A sealed snapshot with this id already exists"
    );
  }
  if (
    sealRefs(listed.artifacts).some(
      (artifact) => artifact.path === sealManifestPath(snapshotId)
    ) ||
    listed.artifacts.some(
      (artifact) => artifact.path === sealLedgerPath(snapshotId)
    )
  ) {
    throw new SealSnapshotError(
      "SNAPSHOT_ALREADY_SEALED",
      "A sealed snapshot with this id already exists"
    );
  }
  if (options.supersedes) {
    if (
      !sealed.some((manifest) => manifest.snapshotId === options.supersedes)
    ) {
      throw new SealSnapshotError(
        "UNKNOWN_SNAPSHOT",
        "The superseded snapshot does not exist at repository head"
      );
    }
  }

  const artifacts = listed.artifacts
    .filter(
      (artifact) =>
        SEAL_INPUT_KINDS.has(artifact.kind) &&
        !isSealRenderPath(artifact.path, listed.artifacts)
    )
    .sort((left, right) => compare(left.path, right.path));
  if (!artifacts.length) {
    throw new SealSnapshotError(
      "NO_SEAL_INPUTS",
      "A repository seal requires at least one managed input"
    );
  }

  const contents = new Map<string, string>();
  const inputs = await Promise.all(
    artifacts.map(async (artifact) => {
      const blob = await readArtifactBlob(
        access.binding.installationId,
        access.repository,
        access.binding.branch,
        artifact.path
      );
      if (blob.commitSha !== listed.commitSha) {
        throw new StaleRepositoryError(blob.commitSha);
      }
      if (blob.blobSha !== artifact.blobSha) {
        throw new SealSnapshotError(
          "PREVIEW_MISMATCH",
          "A repository input changed while the seal preview was resolving"
        );
      }
      contents.set(artifact.path, blob.content);
      return {
        path: artifact.path,
        blobSha: blob.blobSha,
        sha256: sha256(Buffer.from(blob.content, "utf8")),
      };
    })
  );
  const method = methodIdentity(artifacts, contents);
  const reviewedAt = options.reviewedAt ?? new Date().toISOString();
  const configurationHash = sha256(
    canonicalSealConfigurationJson({
      method,
      layoutVersion: access.binding.layoutVersion,
      inputArtifactIds: artifacts.map((artifact) => artifact.artifactId),
    })
  );
  const partialManifest: LedgerSealManifestV1 = {
    schemaVersion: "1",
    snapshotId,
    sealedFromCommit: listed.commitSha,
    reviewerLogin: githubLogin(access.credentials),
    reviewedAt,
    method,
    inputs,
    configurationHash,
    renderHash: "0".repeat(64),
    supersedes: options.supersedes,
  };
  const renderable = ledgerSnapshot(
    partialManifest,
    artifacts,
    access.binding.layoutVersion
  );
  const ledgerMarkdown = renderLedgerBody(
    renderable.snapshot,
    renderable.config
  );
  const renderHash = ledgerRenderHash(
    renderable.snapshot,
    renderable.config
  ).replace(/^sha256:/, "");
  const manifest = LedgerSealManifestV1Schema.parse(
    sealManifestFile({ ...partialManifest, renderHash })
  );
  const manifestYaml = serializeSealManifest(manifest);
  const latestSnapshotId = await newestSealFromArtifacts(
    access,
    listed.artifacts,
    listed.commitSha
  );

  return {
    ...manifest,
    ledgerPath: sealLedgerPath(snapshotId),
    sealPath: sealManifestPath(snapshotId),
    ledgerMarkdown,
    manifestYaml,
    inputArtifactIds: artifacts.map((artifact) => artifact.artifactId),
    latestSnapshotId,
    snapshotData: renderable.snapshot,
  };
}

export async function commitSealSnapshot(
  access: RepositorySealAccess,
  preview: SealSnapshotPreview,
  authorUser?: GithubCommitAuthor
): Promise<{ commitSha: string; snapshotId: string }> {
  const parsed = LedgerSealManifestV1Schema.parse(sealManifestFile(preview));
  if (
    preview.ledgerPath !== sealLedgerPath(parsed.snapshotId) ||
    preview.sealPath !== sealManifestPath(parsed.snapshotId) ||
    preview.manifestYaml !== serializeSealManifest(parsed) ||
    sha256(preview.ledgerMarkdown) !== parsed.renderHash
  ) {
    throw new SealSnapshotError(
      "INVALID_PREVIEW",
      "Seal preview paths or manifest bytes do not match the manifest"
    );
  }
  const listed = await listRepositoryArtifactRefs(
    access.binding.installationId,
    access.repository,
    access.binding.branch,
    access.binding.layoutVersion
  );
  if (listed.commitSha !== parsed.sealedFromCommit) {
    throw new StaleRepositoryError(listed.commitSha);
  }
  if (
    listed.artifacts.some(
      (artifact) =>
        artifact.path === preview.ledgerPath ||
        artifact.path === preview.sealPath
    )
  ) {
    throw new SealSnapshotError(
      "SNAPSHOT_ALREADY_SEALED",
      "Sealed snapshot files are never rewritten in place"
    );
  }
  const commitSha = await commitArtifactBlobs(
    access.binding.installationId,
    access.repository,
    access.binding.branch,
    {
      authorUser,
      message: `Seal ledger snapshot ${parsed.snapshotId}`,
      baseSha: parsed.sealedFromCommit,
      files: [
        { path: preview.ledgerPath, content: preview.ledgerMarkdown },
        { path: preview.sealPath, content: preview.manifestYaml },
      ],
    }
  );
  return { commitSha, snapshotId: parsed.snapshotId };
}

export async function supersedeSeal(
  access: RepositorySealAccess,
  supersedes: string,
  options: Omit<PreviewOptions, "supersedes"> = {},
  authorUser?: GithubCommitAuthor
): Promise<{
  commitSha: string;
  snapshotId: string;
  preview: SealSnapshotPreview;
}> {
  const preview = await previewSealSnapshot(access, { ...options, supersedes });
  const result = await commitSealSnapshot(access, preview, authorUser);
  return { ...result, preview };
}

export async function latestSealSnapshotId(
  access: RepositorySealAccess
): Promise<string | undefined> {
  const listed = await listRepositoryArtifactRefs(
    access.binding.installationId,
    access.repository,
    access.binding.branch,
    access.binding.layoutVersion
  );
  return newestSealFromArtifacts(access, listed.artifacts, listed.commitSha);
}
