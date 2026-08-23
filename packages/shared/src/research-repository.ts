import { z } from "zod";

const IdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

const OpaqueIdSchema = z.string().min(1).max(256);
const GithubNumericIdSchema = z.number().int().positive();
const CommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const LayoutVersionSchema = z.string().regex(/^\d+\.\d+$/);
const TimestampSchema = z.string().datetime({ offset: true });
const GithubLoginSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[a-z\d](?:[a-z\d]|-(?=[a-z\d]))*$/i);

const RepositoryPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.endsWith("/") &&
      !path.includes("//") &&
      path.split("/").every((segment) => segment !== "." && segment !== ".."),
    "Expected a normalized repository-relative path"
  );

const BranchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((branch) => {
    const components = branch.split("/");
    const hasForbiddenCharacter = Array.from(branch).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (
        codePoint <= 0x20 ||
        codePoint === 0x7f ||
        "~^:?*[\\".includes(character)
      );
    });

    return (
      branch !== "@" &&
      !branch.startsWith("-") &&
      !branch.includes("..") &&
      !branch.includes("@{") &&
      !branch.endsWith(".") &&
      !hasForbiddenCharacter &&
      components.every(
        (component) =>
          component.length > 0 &&
          !component.startsWith(".") &&
          !component.endsWith(".lock")
      )
    );
  }, "Expected a valid Git branch name");

const ArtifactKindSchema = z.enum([
  "workspace_manifest",
  "index",
  "theory",
  "method",
  "evidence_template",
  "evidence",
  "ledger",
  "ledger_seal",
  "finding",
  "citation",
  "readme",
  "gitignore",
]);

/**
 * Server-owned locator for a managed repository artifact. Browser mutation
 * requests use `artifactId`; they never supply `path`.
 */
export const RepositoryArtifactRefSchema = z
  .object({
    artifactId: IdentifierSchema,
    kind: ArtifactKindSchema,
    path: RepositoryPathSchema,
    commitSha: CommitShaSchema,
    blobSha: CommitShaSchema,
    contentSha256: Sha256Schema,
  })
  .strict();

export type RepositoryArtifactRef = z.infer<typeof RepositoryArtifactRefSchema>;

/** One private GitHub repository and its fixed managed branch. */
export const ResearchRepositoryBindingSchema = z
  .object({
    provider: z.literal("github"),
    repositoryId: GithubNumericIdSchema,
    installationId: GithubNumericIdSchema,
    branch: z.literal("evaluchat/workspace"),
    layoutVersion: LayoutVersionSchema,
    headCommitSha: CommitShaSchema,
    boundAt: TimestampSchema,
  })
  .strict();

export type ResearchRepositoryBinding = z.infer<
  typeof ResearchRepositoryBindingSchema
>;

/** A repository-backed member of the existing workspace item family. */
export const ResearchRepositoryWorkspaceItemSchema = z
  .object({
    id: OpaqueIdSchema,
    ownerId: OpaqueIdSchema,
    kind: z.literal("research_repository"),
    status: z.literal("active"),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    binding: ResearchRepositoryBindingSchema,
  })
  .strict();

export type ResearchRepositoryWorkspaceItem = z.infer<
  typeof ResearchRepositoryWorkspaceItemSchema
>;

const RepositoryStatusReasonSchema = z.enum([
  "unsupported_layout_major",
  "unsupported_layout_minor",
  "repository_public",
  "repository_deleted",
  "permission_lost",
  "installation_suspended",
  "branch_deleted",
  "protection_failure",
  "force_push",
  "authorization_required",
  "credential_corrupt",
  "disconnected",
]);

type RepositoryStatusReason = z.infer<typeof RepositoryStatusReasonSchema>;

/** The fixed state for every non-ready repository reason. */
const RepositoryStatusStateByReason: Record<
  RepositoryStatusReason,
  "read_only" | "blocked" | "disconnected"
> = {
  unsupported_layout_major: "read_only",
  unsupported_layout_minor: "read_only",
  repository_public: "read_only",
  repository_deleted: "blocked",
  permission_lost: "blocked",
  installation_suspended: "blocked",
  branch_deleted: "blocked",
  protection_failure: "blocked",
  force_push: "blocked",
  authorization_required: "read_only",
  credential_corrupt: "blocked",
  disconnected: "disconnected",
};

export const RepositoryStatusSchema = z
  .object({
    workspaceId: OpaqueIdSchema,
    repositoryId: GithubNumericIdSchema,
    state: z.enum(["ready", "read_only", "blocked", "disconnected"]),
    reason: RepositoryStatusReasonSchema.optional(),
    readonlyReason: z.enum(["repository_public"]).optional(),
    layoutVersion: LayoutVersionSchema.optional(),
    headCommitSha: CommitShaSchema.optional(),
    checkedAt: TimestampSchema,
  })
  .strict()
  .superRefine((status, context) => {
    if (status.state === "ready") {
      if (status.reason !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reason"],
          message: "A ready repository cannot have a failure reason",
        });
      }
      if (status.layoutVersion === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["layoutVersion"],
          message: "A ready repository requires its layout version",
        });
      }
      if (status.headCommitSha === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["headCommitSha"],
          message: "A ready repository requires its head commit",
        });
      }
    } else {
      if (status.reason === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reason"],
          message: "A non-ready repository requires a reason",
        });
      } else if (
        RepositoryStatusStateByReason[status.reason] !== status.state
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["state"],
          message: `Reason ${status.reason} requires state ${RepositoryStatusStateByReason[status.reason]}`,
        });
      }
    }
    if (status.readonlyReason !== undefined && status.state !== "read_only") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["readonlyReason"],
        message: "readonlyReason is only valid for a read-only repository",
      });
    }
  });

export type RepositoryStatus = z.infer<typeof RepositoryStatusSchema>;

/**
 * Retained operation metadata. The strict schema deliberately has no artifact
 * body, repository path, commit message, token, or raw webhook field.
 */
export const RepositoryOperationSchema = z
  .object({
    operationId: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    kind: z.enum(["commit", "seal", "publish", "reconcile"]),
    idempotencyKey: z.string().min(16).max(200),
    status: z.enum(["pending", "running", "succeeded", "failed"]),
    artifactIds: z.array(IdentifierSchema).max(1000),
    baseCommitSha: CommitShaSchema.optional(),
    resultCommitSha: CommitShaSchema.optional(),
    publicationId: OpaqueIdSchema.optional(),
    errorCode: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Z0-9_]+$/)
      .optional(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((operation, context) => {
    if (
      operation.kind !== "reconcile" &&
      operation.baseCommitSha === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseCommitSha"],
        message: "Mutating operations require a base commit",
      });
    }
    if (operation.status === "failed" && operation.errorCode === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["errorCode"],
        message: "A failed operation requires a non-content error code",
      });
    }
  });

export type RepositoryOperation = z.infer<typeof RepositoryOperationSchema>;

const LedgerSealInputFileSchema = z
  .object({
    path: RepositoryPathSchema,
    blob_sha: CommitShaSchema,
    sha256: Sha256Schema,
  })
  .strict();

const LedgerSealManifestV1FileSchema = z
  .object({
    schema_version: z.literal("1"),
    snapshot_id: IdentifierSchema,
    sealed_from_commit: CommitShaSchema,
    reviewer_login: GithubLoginSchema,
    reviewed_at: TimestampSchema,
    method: z
      .object({
        id: IdentifierSchema,
        version: z.string().min(1).max(80),
      })
      .strict(),
    inputs: z.array(LedgerSealInputFileSchema).min(1).max(1000),
    configuration_hash: Sha256Schema,
    render_hash: Sha256Schema,
    supersedes: IdentifierSchema.optional(),
  })
  .passthrough();

/**
 * Parser for the snake-case `<snapshot-id>.seal.yml` contract. Its validated
 * TypeScript output follows the package's camel-case naming convention.
 */
export const LedgerSealManifestV1Schema =
  LedgerSealManifestV1FileSchema.transform((manifest) => {
    const {
      schema_version: schemaVersion,
      snapshot_id: snapshotId,
      sealed_from_commit: sealedFromCommit,
      reviewer_login: reviewerLogin,
      reviewed_at: reviewedAt,
      method,
      inputs,
      configuration_hash: configurationHash,
      render_hash: renderHash,
      supersedes,
      ...unknownFields
    } = manifest;

    return {
      ...unknownFields,
      schemaVersion,
      snapshotId,
      sealedFromCommit,
      reviewerLogin,
      reviewedAt,
      method,
      inputs: inputs.map((input) => ({
        path: input.path,
        blobSha: input.blob_sha,
        sha256: input.sha256,
      })),
      configurationHash,
      renderHash,
      supersedes,
    };
  });

export type LedgerSealManifestV1 = z.infer<typeof LedgerSealManifestV1Schema>;

const PublicationFileSchema = z
  .object({
    artifact: RepositoryArtifactRefSchema,
    destinationPath: RepositoryPathSchema,
    dependencyArtifactIds: z.array(IdentifierSchema).max(1000),
  })
  .strict();

/**
 * Hash-and-pointer publication projection. Exact bytes are fetched from the
 * seal commit for preview and publish and are never retained in this record.
 */
export const PublicationBundleV1Schema = z
  .object({
    schemaVersion: z.literal("1"),
    bundleId: OpaqueIdSchema,
    snapshotId: IdentifierSchema,
    sourceSealCommitSha: CommitShaSchema,
    destinationRepositoryId: GithubNumericIdSchema,
    destinationBaseBranch: BranchNameSchema,
    files: z.array(PublicationFileSchema).min(1).max(1000),
    bundleHash: Sha256Schema,
    provenance: z
      .object({
        privateSealCommitSha: CommitShaSchema,
        publiclyResolvable: z.literal(false),
      })
      .strict(),
    license: z
      .object({
        spdxId: z.string().min(1).max(80),
        notice: z.string().min(1).max(500).optional(),
      })
      .strict(),
    createdAt: TimestampSchema,
  })
  .strict()
  .superRefine((bundle, context) => {
    const artifactIds = new Set(
      bundle.files.map(({ artifact }) => artifact.artifactId)
    );
    const destinationPaths = new Set<string>();

    bundle.files.forEach((file, fileIndex) => {
      if (file.artifact.commitSha !== bundle.sourceSealCommitSha) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", fileIndex, "artifact", "commitSha"],
          message: "Published artifacts must be pinned to the seal commit",
        });
      }

      if (destinationPaths.has(file.destinationPath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["files", fileIndex, "destinationPath"],
          message: "Publication destination paths must be unique",
        });
      }
      destinationPaths.add(file.destinationPath);

      file.dependencyArtifactIds.forEach((dependencyId, dependencyIndex) => {
        if (!artifactIds.has(dependencyId)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [
              "files",
              fileIndex,
              "dependencyArtifactIds",
              dependencyIndex,
            ],
            message: "Publication dependencies must be included in the bundle",
          });
        }
      });
    });

    if (bundle.provenance.privateSealCommitSha !== bundle.sourceSealCommitSha) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provenance", "privateSealCommitSha"],
        message:
          "Public provenance must identify the exact private seal commit",
      });
    }
  });

export type PublicationBundleV1 = z.infer<typeof PublicationBundleV1Schema>;

/** Durable pointer to the public draft PR; contains no private display data. */
export const RepositoryPublicationRefSchema = z
  .object({
    publicationId: OpaqueIdSchema,
    operationId: OpaqueIdSchema,
    workspaceId: OpaqueIdSchema,
    sourceSealCommitSha: CommitShaSchema,
    bundleHash: Sha256Schema,
    destinationRepositoryId: GithubNumericIdSchema,
    branch: BranchNameSchema,
    pullRequestNumber: z.number().int().positive(),
    pullRequestUrl: z.string().url(),
    status: z.enum(["draft", "ready", "merged", "closed"]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .strict()
  .superRefine((publication, context) => {
    const pullRequestUrl = new URL(publication.pullRequestUrl);
    const pathnameMatch =
      /^\/[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+\/pull\/([1-9]\d*)$/.exec(
        pullRequestUrl.pathname
      );

    if (
      pullRequestUrl.origin !== "https://github.com" ||
      pullRequestUrl.username !== "" ||
      pullRequestUrl.password !== "" ||
      pullRequestUrl.search !== "" ||
      pullRequestUrl.hash !== "" ||
      pathnameMatch === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pullRequestUrl"],
        message: "Expected an exact canonical GitHub pull-request URL",
      });
      return;
    }

    if (pathnameMatch[1] !== String(publication.pullRequestNumber)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pullRequestUrl"],
        message: "Pull-request URL number must match pullRequestNumber",
      });
    }
  });

export type RepositoryPublicationRef = z.infer<
  typeof RepositoryPublicationRefSchema
>;
