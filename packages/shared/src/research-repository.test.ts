import { describe, expect, it } from "vitest";
import {
  LedgerSealManifestV1Schema,
  PublicationBundleV1Schema,
  RepositoryArtifactRefSchema,
  RepositoryOperationSchema,
  RepositoryPublicationRefSchema,
  RepositoryStatusSchema,
  ResearchRepositoryBindingSchema,
  ResearchRepositoryWorkspaceItemSchema,
} from "./research-repository.js";

const commitSha = "a".repeat(40);
const blobSha = "b".repeat(40);
const contentSha256 = "c".repeat(64);
const bundleHash = "d".repeat(64);
const timestamp = "2026-08-22T10:00:00Z";

const binding = {
  provider: "github",
  repositoryId: 12001,
  installationId: 22001,
  branch: "evaluchat/workspace",
  layoutVersion: "1.0",
  headCommitSha: commitSha,
  boundAt: timestamp,
};

const artifact = {
  artifactId: "synthetic-evidence",
  kind: "evidence",
  path: "methods/synthetic-method/evidence/synthetic-evidence.en.md",
  commitSha,
  blobSha,
  contentSha256,
};

const bundle = {
  schemaVersion: "1",
  bundleId: "bundle-synthetic",
  snapshotId: "synthetic-snapshot",
  sourceSealCommitSha: commitSha,
  destinationRepositoryId: 58001,
  destinationBaseBranch: "main",
  files: [
    {
      artifact,
      destinationPath: artifact.path,
      dependencyArtifactIds: [],
    },
  ],
  bundleHash,
  provenance: {
    privateSealCommitSha: commitSha,
    publiclyResolvable: false,
  },
  license: { spdxId: "CC-BY-4.0" },
  createdAt: timestamp,
};

describe("research repository contracts", () => {
  it("parses a repository binding and workspace item", () => {
    expect(ResearchRepositoryBindingSchema.parse(binding)).toEqual(binding);

    const item = {
      id: "workspace-synthetic",
      ownerId: "owner-synthetic",
      kind: "research_repository",
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      binding,
    };

    expect(ResearchRepositoryWorkspaceItemSchema.parse(item)).toEqual(item);
  });

  it("rejects an arbitrary or traversing artifact path", () => {
    expect(
      RepositoryArtifactRefSchema.safeParse({
        ...artifact,
        path: "../private/synthetic-evidence.en.md",
      }).success
    ).toBe(false);
  });

  it("parses ready and compatibility read-only repository states", () => {
    expect(
      RepositoryStatusSchema.safeParse({
        workspaceId: "workspace-synthetic",
        repositoryId: 12001,
        state: "ready",
        layoutVersion: "1.0",
        headCommitSha: commitSha,
        checkedAt: timestamp,
      }).success
    ).toBe(true);

    expect(
      RepositoryStatusSchema.safeParse({
        workspaceId: "workspace-synthetic",
        repositoryId: 12001,
        state: "read_only",
        reason: "unsupported_layout_minor",
        layoutVersion: "1.1",
        headCommitSha: commitSha,
        checkedAt: timestamp,
      }).success
    ).toBe(true);

    expect(
      RepositoryStatusSchema.safeParse({
        workspaceId: "workspace-synthetic",
        repositoryId: 12001,
        state: "read_only",
        checkedAt: timestamp,
      }).success
    ).toBe(false);
  });

  it("accepts only the documented repository status state/reason pairs", () => {
    const allowedPairs = [
      ["read_only", "unsupported_layout_major"],
      ["read_only", "unsupported_layout_minor"],
      ["read_only", "authorization_required"],
      ["read_only", "repository_public"],
      ["blocked", "repository_deleted"],
      ["blocked", "permission_lost"],
      ["blocked", "installation_suspended"],
      ["blocked", "branch_deleted"],
      ["blocked", "protection_failure"],
      ["blocked", "force_push"],
      ["blocked", "credential_corrupt"],
      ["disconnected", "disconnected"],
    ] as const;

    for (const [state, reason] of allowedPairs) {
      expect(
        RepositoryStatusSchema.safeParse({
          workspaceId: "workspace-synthetic",
          repositoryId: 12001,
          state,
          reason,
          checkedAt: timestamp,
        }).success
      ).toBe(true);
    }

    expect(
      RepositoryStatusSchema.safeParse({
        workspaceId: "workspace-synthetic",
        repositoryId: 12001,
        state: "blocked",
        reason: "unsupported_layout_minor",
        checkedAt: timestamp,
      }).success
    ).toBe(false);
    expect(
      RepositoryStatusSchema.safeParse({
        workspaceId: "workspace-synthetic",
        repositoryId: 12001,
        state: "blocked",
        reason: "repository_public",
        checkedAt: timestamp,
      }).success
    ).toBe(false);
  });

  it("accepts pointer-only operation state and rejects retained commit messages", () => {
    const operation = {
      operationId: "operation-synthetic",
      workspaceId: "workspace-synthetic",
      kind: "commit",
      idempotencyKey: "synthetic-key-0001",
      status: "succeeded",
      artifactIds: ["synthetic-evidence"],
      baseCommitSha: commitSha,
      resultCommitSha: "e".repeat(40),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(RepositoryOperationSchema.safeParse(operation).success).toBe(true);
    expect(
      RepositoryOperationSchema.safeParse({
        ...operation,
        commitMessage: "This must not be retained",
      }).success
    ).toBe(false);
    expect(
      RepositoryOperationSchema.safeParse({
        ...operation,
        baseCommitSha: undefined,
      }).success
    ).toBe(false);
  });

  it("validates a complete v1 ledger seal manifest", () => {
    const manifestFile = {
      schema_version: "1",
      snapshot_id: "synthetic-snapshot",
      sealed_from_commit: commitSha,
      reviewer_login: "synthetic-reviewer",
      reviewed_at: timestamp,
      method: { id: "synthetic-method", version: "1.0.0" },
      inputs: [
        {
          path: artifact.path,
          blob_sha: blobSha,
          sha256: contentSha256,
        },
      ],
      configuration_hash: "f".repeat(64),
      render_hash: "1".repeat(64),
    };

    expect(LedgerSealManifestV1Schema.parse(manifestFile)).toEqual({
      schemaVersion: "1",
      snapshotId: "synthetic-snapshot",
      sealedFromCommit: commitSha,
      reviewerLogin: "synthetic-reviewer",
      reviewedAt: timestamp,
      method: manifestFile.method,
      inputs: [
        {
          path: artifact.path,
          blobSha,
          sha256: contentSha256,
        },
      ],
      configurationHash: manifestFile.configuration_hash,
      renderHash: manifestFile.render_hash,
      supersedes: undefined,
    });
    expect(
      LedgerSealManifestV1Schema.safeParse({
        ...manifestFile,
        sealed_from_commit: "not-a-commit",
      }).success
    ).toBe(false);
  });

  it("validates a dependency-closed publication bundle pinned to its seal", () => {
    expect(PublicationBundleV1Schema.safeParse(bundle).success).toBe(true);
    expect(
      PublicationBundleV1Schema.safeParse({
        ...bundle,
        privateRepositoryUrl: "https://github.com/private/synthetic",
      }).success
    ).toBe(false);
    expect(
      PublicationBundleV1Schema.safeParse({
        ...bundle,
        files: [
          {
            ...bundle.files[0],
            dependencyArtifactIds: ["missing-artifact"],
          },
        ],
      }).success
    ).toBe(false);
  });

  it("rejects Git-invalid publication branch names", () => {
    const invalidBranchNames = [
      "branch name",
      "branch\u0001name",
      "branch\u007fname",
      "branch~name",
      "branch^name",
      "branch:name",
      "branch?name",
      "branch*name",
      "branch[name",
      "branch\\name",
      ".hidden/name",
      "feature/.hidden",
      "feature..name",
      "@",
      "feature@{one",
      "/feature",
      "feature/",
      "feature//name",
      "feature.lock/name",
      "feature/name.lock",
      "feature.",
    ];

    for (const destinationBaseBranch of invalidBranchNames) {
      expect(
        PublicationBundleV1Schema.safeParse({
          ...bundle,
          destinationBaseBranch,
        }).success
      ).toBe(false);
    }
  });

  it("rejects leading hyphens but accepts them in nested components", () => {
    expect(
      PublicationBundleV1Schema.safeParse({
        ...bundle,
        destinationBaseBranch: "-danger",
      }).success
    ).toBe(false);

    for (const destinationBaseBranch of [
      "danger",
      "feature/danger-name",
      "feature/-danger",
    ]) {
      expect(
        PublicationBundleV1Schema.safeParse({
          ...bundle,
          destinationBaseBranch,
        }).success
      ).toBe(true);
    }
  });

  it("requires an exact matching GitHub pull-request URL", () => {
    const publication = {
      publicationId: "publication-synthetic",
      operationId: "operation-synthetic",
      workspaceId: "workspace-synthetic",
      sourceSealCommitSha: commitSha,
      bundleHash,
      destinationRepositoryId: 58001,
      branch: "evaluchat/publication-synthetic",
      pullRequestNumber: 120,
      pullRequestUrl: "https://github.com/evaluchat/research/pull/120",
      status: "draft",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(RepositoryPublicationRefSchema.parse(publication)).toEqual(
      publication
    );
    const invalidUrls = [
      "https://example.test/evaluchat/research/pull/120",
      "https://github.com/evaluchat/research/pull/121",
      "https://github.com/evaluchat/research?x/pull/120",
      "https://github.com/evaluchat/research/extra/pull/120",
      "https://github.com/evaluchat/research/pull/120/extra",
      "https://github.com/evaluchat/research/pull/120?view=files",
      "https://github.com/evaluchat/research/pull/120#discussion",
    ];

    for (const pullRequestUrl of invalidUrls) {
      expect(
        RepositoryPublicationRefSchema.safeParse({
          ...publication,
          pullRequestUrl,
        }).success
      ).toBe(false);
    }
  });
});
