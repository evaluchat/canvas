import { Client } from "@langchain/langgraph-sdk";
import { randomUUID } from "node:crypto";
import type {
  LedgerConfig,
  LedgerScopeFilter,
  LedgerSnapshotData,
} from "@opencanvas/shared";
import {
  RepositoryStatusSchema,
  ResearchRepositoryWorkspaceItemSchema,
  type RepositoryStatus,
  type ResearchRepositoryWorkspaceItem,
} from "@opencanvas/shared/research-repository";
import { LANGGRAPH_API_URL } from "@/constants";
import { githubErrorStatus } from "./research-repository/github-error-status";
import {
  FormValidationError,
  resolveFormMarkdown,
  submissionEquals,
  validateFormValues,
} from "./form-validation";
import type {
  FormValue,
  LedgerSnapshotWorkspaceItem,
  LedgerWorkspaceItem,
  MethodRunParticipant,
} from "./types";
import {
  DEFAULT_METHOD_PROFILE_ID,
  DEFAULT_WORKSPACE_TEMPLATE_ID,
  MarkdownTemplateSnapshot,
  MarkdownWorkspaceItem,
  MethodParticipantWorkspaceItem,
  MethodRun,
  MethodRunAssignment,
  MethodSource,
  MethodWorkspaceItem,
  PendingMethodInvite,
  UnusableResearchRepositoryWorkspaceItem,
  UsableWorkspaceItem,
  WorkspaceItem,
  WorkspaceManifest,
  isUsableResearchRepository,
} from "./types";
import {
  EvidenceLedgerResolutionError,
  resolveEvidenceLedgerFromSource,
  type EvidenceLedgerResolution,
} from "@/lib/apparatuses/evidence-ledger";
import {
  listResearchedMethods,
  loadLedgerSource,
  type LoadedLedgerSource,
} from "./ledger-source";
import { ledgerRenderHash } from "./ledger-publish";
import {
  catalogForTemplateId,
  getTemplateById,
  isSelectableTemplate,
} from "./template-catalog";
import { publicMethodPageUrl } from "./method-links";
import { withOwnedThreadMetadata } from "@/lib/thread-ownership";
import {
  buildEvidenceSnapshot,
  buildEvidenceSnapshotFromMarker,
  EvidenceRunNotConcludedError,
  type EvidenceSnapshot,
} from "./evidence";
import {
  BUILTIN_APPARATUS_IDS,
  getApparatusSpecification,
  getDefaultApparatusProfile,
  resolveApparatusConfiguration,
} from "@/lib/apparatuses/runtime";
import {
  INVITE_EMAIL_GAP_MS,
  findUserByEmail,
  inviteWorkspaceParticipant,
  sleep,
} from "@/lib/teaching/invitation-helpers";
import { readGithubResearchCredentials } from "./research-repository/credentials";
import {
  createGithubRepositoryBranch,
  getGithubInstallationRepository,
  getGithubRepositoryBranchHead,
} from "./research-repository/github-app";

const MANIFEST_KEY = "manifest";
const LOCK_KEY = "lock";
/** Store SDK TTL is in minutes (see @langchain/langgraph-sdk StoreClient.putItem). */
const WORKSPACE_LOCK_TTL_MINUTES = 1;
export const RESEARCH_REPOSITORY_BRANCH = "evaluchat/workspace" as const;
export const RESEARCH_REPOSITORY_LAYOUT_VERSION = "1.0" as const;

/** Test seam: mutate `.value` for lease TTL / renewal-interval math. */
export const workspaceLockTtlMs = { value: 60_000 };
/** Test seam: mutate `.value` to keep lock-timeout tests fast. */
export const workspaceLockRetryDelayMs = { value: 100 };
/** Test seam: mutate `.value` to bound acquisition wait; default ~10s. */
export const workspaceLockAcquireTimeoutMs = { value: 10_000 };

type WorkspaceLockValue = {
  token: string;
  expiresAt: number;
};

export class WorkspaceItemNotFoundError extends Error {
  constructor() {
    super("Workspace item not found");
    this.name = "WorkspaceItemNotFoundError";
  }
}

export class WorkspaceLockTimeoutError extends Error {
  constructor(userId: string) {
    super(`Timed out acquiring workspace lock for user ${userId}`);
    this.name = "WorkspaceLockTimeoutError";
  }
}

export class WorkspaceThreadOwnershipError extends Error {
  constructor() {
    super("Workspace thread does not belong to the workspace item");
    this.name = "WorkspaceThreadOwnershipError";
  }
}

export class WorkspaceItemThreadNotAllowedError extends Error {
  constructor() {
    super("This workspace item does not support an assistant thread");
    this.name = "WorkspaceItemThreadNotAllowedError";
  }
}

export class WorkspaceFormAlreadySubmittedError extends Error {
  constructor() {
    super("Form has already been submitted");
    this.name = "WorkspaceFormAlreadySubmittedError";
  }
}

export class WorkspaceEvidenceAlreadySubmittedError extends Error {
  constructor() {
    super("Evidence has already been submitted");
    this.name = "WorkspaceEvidenceAlreadySubmittedError";
  }
}

export class WorkspaceEvidenceThreadMissingError extends Error {
  constructor() {
    super(
      "Evidence thread no longer exists; create a new evidence contribution"
    );
    this.name = "WorkspaceEvidenceThreadMissingError";
  }
}

export {
  EvidenceRunNotConcludedError,
  EvidenceUnavailableError,
} from "./evidence";

export class UnsupportedMethodError extends Error {
  constructor() {
    super("Unsupported method");
    this.name = "UnsupportedMethodError";
  }
}

export class UnsupportedTemplateError extends Error {}

export class LedgerNotReadyError extends Error {
  constructor(message = "Method is not ready for Evidence Ledger") {
    super(message);
    this.name = "LedgerNotReadyError";
  }
}

export class LedgerConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerConfigValidationError";
  }
}

export type ResearchRepositoryBindingErrorCode =
  | "credentials_missing"
  | "installation_unavailable"
  | "repository_unavailable"
  | "repository_public"
  | "repository_already_bound";

export class ResearchRepositoryBindingError extends Error {
  constructor(
    public readonly code: ResearchRepositoryBindingErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ResearchRepositoryBindingError";
  }
}

export function parseCatalogTemplateRef(ref: string): {
  id: string;
  version?: string;
} {
  const at = ref.lastIndexOf("@");
  if (at <= 0) return { id: ref };
  return { id: ref.slice(0, at), version: ref.slice(at + 1) };
}

function client(): Client {
  return new Client({
    apiUrl: LANGGRAPH_API_URL,
    apiKey: process.env.LANGCHAIN_API_KEY,
  });
}

function namespace(userId: string): string[] {
  return ["workspace_items", userId];
}

function retainUnusableResearchRepository(
  value: unknown
): UnusableResearchRepositoryWorkspaceItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id : undefined;
  if (!id) return undefined;
  const binding =
    raw.binding &&
    typeof raw.binding === "object" &&
    !Array.isArray(raw.binding)
      ? (raw.binding as Record<string, unknown>)
      : undefined;
  const repositoryId =
    typeof binding?.repositoryId === "number"
      ? binding.repositoryId
      : undefined;
  console.error("[workspace] retained unusable research_repository item", id);
  return {
    id,
    kind: "research_repository",
    unusable: true,
    updatedAt:
      typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : "1970-01-01T00:00:00.000Z",
    createdAt:
      typeof raw.createdAt === "string"
        ? raw.createdAt
        : typeof raw.updatedAt === "string"
          ? raw.updatedAt
          : "1970-01-01T00:00:00.000Z",
    ...(typeof raw.ownerId === "string" ? { ownerId: raw.ownerId } : {}),
    ...(repositoryId !== undefined ? { binding: { repositoryId } } : {}),
  };
}

function normaliseWorkspaceItem(value: unknown): WorkspaceItem | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as WorkspaceItem & {
    templateSnapshot?: Record<string, unknown>;
  };
  if (item.kind === "research_repository") {
    const parsed = ResearchRepositoryWorkspaceItemSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    return retainUnusableResearchRepository(value);
  }
  if (
    item.kind === "markdown_template" &&
    item.templateSnapshot &&
    !item.templateSnapshot.kind
  ) {
    return {
      ...item,
      templateSnapshot: {
        ...item.templateSnapshot,
        kind: "markdown",
      } as MarkdownTemplateSnapshot,
    } as MarkdownWorkspaceItem;
  }
  return item;
}

async function readManifest(userId: string): Promise<WorkspaceManifest> {
  const item = await client().store.getItem(namespace(userId), MANIFEST_KEY);
  const value = item?.value as Partial<WorkspaceManifest> | undefined;
  if (!value || typeof value !== "object" || !value.items) {
    return { initialized: false, items: {} };
  }
  const items = Object.fromEntries(
    Object.entries(value.items as Record<string, unknown>)
      .map(([id, item]) => [id, normaliseWorkspaceItem(item)] as const)
      .filter((entry): entry is [string, WorkspaceItem] => Boolean(entry[1]))
  );
  return {
    initialized: value.initialized === true,
    defaultItemId:
      typeof value.defaultItemId === "string" ? value.defaultItemId : undefined,
    items,
  };
}

async function writeManifest(
  userId: string,
  manifest: WorkspaceManifest
): Promise<void> {
  await client().store.putItem(namespace(userId), MANIFEST_KEY, manifest);
}

function lockValue(value: unknown): WorkspaceLockValue | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<WorkspaceLockValue>;
  if (
    typeof candidate.token !== "string" ||
    typeof candidate.expiresAt !== "number"
  ) {
    return undefined;
  }
  return { token: candidate.token, expiresAt: candidate.expiresAt };
}

async function acquireUserLock(userId: string): Promise<string> {
  const ns = namespace(userId);
  const token = randomUUID();
  const deadline = Date.now() + workspaceLockAcquireTimeoutMs.value;

  while (Date.now() < deadline) {
    const existing = lockValue(
      (await client().store.getItem(ns, LOCK_KEY))?.value
    );
    const heldByOther =
      existing && existing.token !== token && existing.expiresAt > Date.now();

    if (heldByOther) {
      await sleep(workspaceLockRetryDelayMs.value);
      continue;
    }

    // Free, missing, or expired: claim (last-writer-wins among contenders).
    const expiresAt = Date.now() + workspaceLockTtlMs.value;
    await client().store.putItem(
      ns,
      LOCK_KEY,
      { token, expiresAt },
      { ttl: WORKSPACE_LOCK_TTL_MINUTES }
    );
    const stored = lockValue(
      (await client().store.getItem(ns, LOCK_KEY))?.value
    );
    if (stored?.token === token) {
      // Settle-verify: catch a late contender putItem that landed after read-back.
      await sleep(workspaceLockRetryDelayMs.value);
      const settled = lockValue(
        (await client().store.getItem(ns, LOCK_KEY))?.value
      );
      if (settled?.token === token) {
        return token;
      }
    }
    await sleep(workspaceLockRetryDelayMs.value);
  }

  throw new WorkspaceLockTimeoutError(userId);
}

async function releaseUserLock(userId: string, token: string): Promise<void> {
  const ns = namespace(userId);
  const stored = lockValue((await client().store.getItem(ns, LOCK_KEY))?.value);
  if (stored?.token !== token) return;
  await client().store.deleteItem(ns, LOCK_KEY);
  // An in-flight heartbeat renewal may have re-created our lock after the
  // delete; at most one can be in flight (interval cleared before release).
  const after = lockValue((await client().store.getItem(ns, LOCK_KEY))?.value);
  if (after?.token === token) {
    await client().store.deleteItem(ns, LOCK_KEY);
  }
}

async function renewUserLock(userId: string, token: string): Promise<void> {
  const ns = namespace(userId);
  await client().store.putItem(
    ns,
    LOCK_KEY,
    { token, expiresAt: Date.now() + workspaceLockTtlMs.value },
    { ttl: WORKSPACE_LOCK_TTL_MINUTES }
  );
}

async function withUserLock<T>(
  userId: string,
  operation: () => Promise<T>
): Promise<T> {
  const token = await acquireUserLock(userId);
  let released = false;
  let renewalPromise: Promise<void> | null = null;
  const renewalMs = Math.max(1, Math.floor(workspaceLockTtlMs.value / 3));
  const heartbeat = setInterval(() => {
    if (released) return;
    renewalPromise = renewUserLock(userId, token);
  }, renewalMs);
  try {
    return await operation();
  } finally {
    released = true;
    clearInterval(heartbeat);
    // Await any renewal already in flight so it cannot re-create the lock
    // after release deletes it. Renewals are best-effort; swallow errors.
    if (renewalPromise) {
      try {
        await renewalPromise;
      } catch {
        // best-effort renewal failure — the lock will expire via TTL
      }
    }
    await releaseUserLock(userId, token);
  }
}

function snapshotFromTemplate(templateId: string) {
  const template = getTemplateById(templateId);
  if (!template) throw new Error("Unsupported workspace template");
  const catalog = catalogForTemplateId(templateId);

  if (template.templateKind === "form") {
    return {
      kind: "form" as const,
      catalogRevision: catalog.catalogRevision,
      templateVersion: template.version,
      sourcePath: template.sourcePath,
      templateSnapshot: {
        kind: "form" as const,
        templateId: template.id,
        templateVersion: template.version,
        catalogRevision: catalog.catalogRevision,
        contentHash: template.contentHash,
        title: template.title,
        description: template.description,
        assistantGuidance: template.assistantGuidance,
        layoutMarkdown: template.layoutMarkdown,
        fields: structuredClone(template.fields),
      },
    };
  }

  return {
    kind: "markdown" as const,
    catalogRevision: catalog.catalogRevision,
    templateVersion: template.version,
    sourcePath: template.sourcePath,
    templateSnapshot: {
      kind: "markdown" as const,
      title: template.title,
      description: template.description,
      initialMarkdown: template.initialMarkdown,
      assistantGuidance: template.assistantGuidance,
      contentHash: template.contentHash,
    },
  };
}

function createItem(userId: string, templateId: string): WorkspaceItem {
  const now = new Date().toISOString();
  const snapshot = snapshotFromTemplate(templateId);
  const base = {
    id: `wi_${randomUUID()}`,
    ownerId: userId,
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
    source: {
      catalogRevision: snapshot.catalogRevision,
      templateId,
      templateVersion: snapshot.templateVersion,
      sourcePath: snapshot.sourcePath,
    },
  };

  if (snapshot.kind === "form") {
    return {
      ...base,
      kind: "form_template",
      templateSnapshot: snapshot.templateSnapshot,
    };
  }
  return {
    ...base,
    kind: "markdown_template",
    templateSnapshot: snapshot.templateSnapshot,
  };
}

function isSelectableDefaultItem(
  item: WorkspaceItem | undefined
): item is UsableWorkspaceItem {
  return item !== undefined && !("unusable" in item && item.unusable === true);
}

export async function ensureDefaultWorkspaceItem(
  userId: string
): Promise<WorkspaceItem | undefined> {
  return withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const pointed = manifest.defaultItemId
      ? manifest.items[manifest.defaultItemId]
      : undefined;
    if (pointed && !isSelectableDefaultItem(pointed)) {
      console.error(
        "[workspace] skipping unusable default workspace item",
        pointed.id
      );
    }
    const existing = isSelectableDefaultItem(pointed)
      ? pointed
      : Object.values(manifest.items)
          .filter(isSelectableDefaultItem)
          .sort((a, b) =>
            (a.createdAt ?? a.updatedAt).localeCompare(
              b.createdAt ?? b.updatedAt
            )
          )[0];
    if (existing) {
      if (manifest.defaultItemId !== existing.id || !manifest.initialized) {
        manifest.defaultItemId = existing.id;
        manifest.initialized = true;
        await writeManifest(userId, manifest);
      }
      return existing;
    }

    if (manifest.initialized) return undefined;

    const item = createItem(userId, DEFAULT_WORKSPACE_TEMPLATE_ID);
    manifest.initialized = true;
    manifest.defaultItemId = item.id;
    manifest.items[item.id] = item;
    await writeManifest(userId, manifest);
    return item;
  });
}

function enrichMethodSource(source: MethodSource): MethodSource {
  const url = publicMethodPageUrl(source.id);
  if (source.title && source.description && source.url === url) return source;
  const spec = getApparatusSpecification(source.id);
  return {
    ...source,
    title: source.title || spec?.name,
    description: source.description || spec?.description,
    url,
  };
}

function enrichWorkspaceItem<T extends WorkspaceItem>(item: T): T {
  if (item.kind !== "method" && item.kind !== "method_participant") {
    return item;
  }
  return { ...item, methodSource: enrichMethodSource(item.methodSource) };
}

export async function listWorkspaceItems(
  userId: string,
  options?: { email?: string }
): Promise<WorkspaceItem[]> {
  if (options?.email) {
    try {
      await claimPendingMethodInvites(userId, options.email);
    } catch (error) {
      console.error("[workspace] failed to claim pending invites", error);
    }
  }
  const manifest = await readManifest(userId);
  const items = await Promise.all(
    Object.values(manifest.items)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(async (item) => {
        if (item.kind === "method" && item.run) {
          return reconcileMethodRunSubmissions(userId, item);
        }
        return item;
      })
  );
  return items.map(enrichWorkspaceItem);
}

export async function createWorkspaceItem(
  userId: string,
  templateId: string
): Promise<WorkspaceItem> {
  return withUserLock(userId, async () => {
    if (!isSelectableTemplate(templateId)) {
      throw new UnsupportedTemplateError("Unsupported workspace template");
    }
    const manifest = await readManifest(userId);
    const item = createItem(userId, templateId);
    manifest.initialized = true;
    manifest.items[item.id] = item;
    await writeManifest(userId, manifest);
    return item;
  });
}

export async function createResearchRepositoryItem(
  userId: string,
  input: { repositoryId: number; installationId: number }
): Promise<ResearchRepositoryWorkspaceItem> {
  const credentials = await readGithubResearchCredentials(userId);
  if (!credentials) {
    throw new ResearchRepositoryBindingError(
      "credentials_missing",
      "Connect GitHub before binding a research repository"
    );
  }
  if (credentials.installationId !== input.installationId) {
    throw new ResearchRepositoryBindingError(
      "installation_unavailable",
      "The GitHub installation is not available to this user"
    );
  }
  if (!credentials.repositoryIds.includes(input.repositoryId)) {
    throw new ResearchRepositoryBindingError(
      "repository_unavailable",
      "The repository is not available to this GitHub installation"
    );
  }

  const repository = await getGithubInstallationRepository(
    input.installationId,
    input.repositoryId
  );
  if (!repository.private) {
    throw new ResearchRepositoryBindingError(
      "repository_public",
      "Research repositories must be private"
    );
  }
  return withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const duplicate = Object.values(manifest.items).some(
      (item) =>
        item.kind === "research_repository" &&
        item.binding?.repositoryId === input.repositoryId
    );
    if (duplicate) {
      throw new ResearchRepositoryBindingError(
        "repository_already_bound",
        "This repository is already bound to a workspace item"
      );
    }

    let headCommitSha: string;
    try {
      headCommitSha = await getGithubRepositoryBranchHead(
        input.installationId,
        repository,
        RESEARCH_REPOSITORY_BRANCH
      );
    } catch (error) {
      if (githubErrorStatus(error) !== 404) {
        throw error;
      }
      const defaultBranchHead = await getGithubRepositoryBranchHead(
        input.installationId,
        repository,
        repository.defaultBranch
      );
      let recoveredHeadCommitSha: string | undefined;
      try {
        await createGithubRepositoryBranch(
          input.installationId,
          repository,
          RESEARCH_REPOSITORY_BRANCH,
          defaultBranchHead
        );
      } catch (creationError) {
        const status = githubErrorStatus(creationError);
        if (status !== 409 && status !== 422) {
          throw creationError;
        }
        try {
          recoveredHeadCommitSha = await getGithubRepositoryBranchHead(
            input.installationId,
            repository,
            RESEARCH_REPOSITORY_BRANCH
          );
        } catch {
          throw creationError;
        }
      }
      headCommitSha =
        recoveredHeadCommitSha ??
        (await getGithubRepositoryBranchHead(
          input.installationId,
          repository,
          RESEARCH_REPOSITORY_BRANCH
        ));
    }

    const now = new Date().toISOString();
    const item = ResearchRepositoryWorkspaceItemSchema.parse({
      id: `wi_${randomUUID()}`,
      ownerId: userId,
      kind: "research_repository",
      status: "active",
      createdAt: now,
      updatedAt: now,
      binding: {
        provider: "github",
        repositoryId: input.repositoryId,
        installationId: input.installationId,
        branch: RESEARCH_REPOSITORY_BRANCH,
        layoutVersion: RESEARCH_REPOSITORY_LAYOUT_VERSION,
        headCommitSha,
        boundAt: now,
      },
    });
    manifest.initialized = true;
    manifest.items[item.id] = item;
    await writeManifest(userId, manifest);
    return item;
  });
}

function githubFailureStatus(
  item: ResearchRepositoryWorkspaceItem,
  error: unknown,
  missingReason: "repository_deleted" | "branch_deleted"
): RepositoryStatus {
  const status = githubErrorStatus(error);
  const message = error instanceof Error ? error.message : "";
  const transient =
    (typeof status === "number" && status >= 500) || status === undefined;
  const failure =
    status === 404
      ? { state: "blocked" as const, reason: missingReason }
      : status === 401
        ? {
            state: "read_only" as const,
            reason: "authorization_required" as const,
          }
        : /suspend/i.test(message)
          ? {
              state: "blocked" as const,
              reason: "installation_suspended" as const,
            }
          : transient
            ? {
                state: "blocked" as const,
                reason: "github_unavailable" as const,
              }
            : {
                state: "blocked" as const,
                reason: "permission_lost" as const,
              };
  return RepositoryStatusSchema.parse({
    workspaceId: item.id,
    repositoryId: item.binding.repositoryId,
    ...failure,
    checkedAt: new Date().toISOString(),
  });
}

export async function getResearchRepositoryStatus(
  userId: string,
  item: ResearchRepositoryWorkspaceItem
): Promise<RepositoryStatus> {
  let credentials;
  try {
    credentials = await readGithubResearchCredentials(userId);
  } catch {
    return RepositoryStatusSchema.parse({
      workspaceId: item.id,
      repositoryId: item.binding.repositoryId,
      state: "blocked",
      reason: "credential_corrupt",
      checkedAt: new Date().toISOString(),
    });
  }
  if (
    !credentials ||
    credentials.installationId !== item.binding.installationId
  ) {
    return RepositoryStatusSchema.parse({
      workspaceId: item.id,
      repositoryId: item.binding.repositoryId,
      state: "disconnected",
      reason: "disconnected",
      checkedAt: new Date().toISOString(),
    });
  }
  if (!credentials.repositoryIds.includes(item.binding.repositoryId)) {
    return RepositoryStatusSchema.parse({
      workspaceId: item.id,
      repositoryId: item.binding.repositoryId,
      state: "blocked",
      reason: "permission_lost",
      checkedAt: new Date().toISOString(),
    });
  }

  let repository;
  try {
    repository = await getGithubInstallationRepository(
      item.binding.installationId,
      item.binding.repositoryId
    );
  } catch (error) {
    return githubFailureStatus(item, error, "repository_deleted");
  }
  if (!repository.private) {
    return RepositoryStatusSchema.parse({
      workspaceId: item.id,
      repositoryId: item.binding.repositoryId,
      state: "read_only",
      reason: "repository_public",
      readonlyReason: "repository_public",
      checkedAt: new Date().toISOString(),
    });
  }

  let headCommitSha;
  try {
    headCommitSha = await getGithubRepositoryBranchHead(
      item.binding.installationId,
      repository,
      item.binding.branch
    );
  } catch (error) {
    return githubFailureStatus(item, error, "branch_deleted");
  }

  const [major, minor] = item.binding.layoutVersion
    .split(".")
    .map((part) => Number(part));
  const [supportedMajor, supportedMinor] =
    RESEARCH_REPOSITORY_LAYOUT_VERSION.split(".").map((part) => Number(part));
  if (major !== supportedMajor || minor !== supportedMinor) {
    return RepositoryStatusSchema.parse({
      workspaceId: item.id,
      repositoryId: item.binding.repositoryId,
      state: "read_only",
      reason:
        major === supportedMajor
          ? "unsupported_layout_minor"
          : "unsupported_layout_major",
      layoutVersion: item.binding.layoutVersion,
      headCommitSha,
      checkedAt: new Date().toISOString(),
    });
  }

  return RepositoryStatusSchema.parse({
    workspaceId: item.id,
    repositoryId: item.binding.repositoryId,
    state: "ready",
    layoutVersion: item.binding.layoutVersion,
    headCommitSha,
    checkedAt: new Date().toISOString(),
  });
}

export async function createMethodWorkspaceItem(
  userId: string,
  methodId: string
): Promise<MethodWorkspaceItem> {
  return withUserLock(userId, async () => {
    const spec = getApparatusSpecification(methodId);
    if (!spec || !BUILTIN_APPARATUS_IDS.has(methodId)) {
      throw new UnsupportedMethodError();
    }
    const brief = spec.run_brief_template;
    if (!brief) throw new UnsupportedMethodError();
    const { id: templateId, version } = parseCatalogTemplateRef(brief);
    const snapshot = snapshotFromTemplate(templateId);
    if (snapshot.kind !== "form") throw new UnsupportedMethodError();
    if (version && snapshot.templateVersion !== version) {
      throw new UnsupportedMethodError();
    }

    const profile = getDefaultApparatusProfile(methodId) ?? spec.profiles[0];
    const now = new Date().toISOString();
    const item: MethodWorkspaceItem = {
      id: `wi_${randomUUID()}`,
      ownerId: userId,
      status: "active",
      createdAt: now,
      updatedAt: now,
      source: {
        catalogRevision: snapshot.catalogRevision,
        templateId,
        templateVersion: snapshot.templateVersion,
        sourcePath: snapshot.sourcePath,
      },
      kind: "method",
      templateSnapshot: snapshot.templateSnapshot,
      methodSource: {
        id: spec.id,
        version: spec.version,
        title: spec.name,
        description: spec.description,
        url: publicMethodPageUrl(spec.id),
      },
      profileId: profile?.id ?? DEFAULT_METHOD_PROFILE_ID,
      profiles: spec.profiles.map((option) => ({
        id: option.id,
        label: option.label,
      })),
    };

    const manifest = await readManifest(userId);
    manifest.initialized = true;
    manifest.items[item.id] = item;
    await writeManifest(userId, manifest);
    return item;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLedgerFilters(value: unknown): LedgerScopeFilter[] {
  if (!Array.isArray(value)) {
    throw new LedgerConfigValidationError("Ledger filters must be an array");
  }
  return value.map((filter) => {
    if (
      !isRecord(filter) ||
      typeof filter.fieldId !== "string" ||
      !filter.fieldId
    ) {
      throw new LedgerConfigValidationError(
        "Ledger filters must declare a field id"
      );
    }
    if (filter.control === "multi-select") {
      if (
        !Array.isArray(filter.values) ||
        filter.values.some((value) => typeof value !== "string")
      ) {
        throw new LedgerConfigValidationError(
          `Ledger filter ${filter.fieldId} must use string option values`
        );
      }
      return {
        fieldId: filter.fieldId,
        control: "multi-select",
        values: filter.values,
      };
    }
    if (filter.control === "range") {
      for (const endpoint of [filter.min, filter.max]) {
        if (
          endpoint !== undefined &&
          typeof endpoint !== "string" &&
          typeof endpoint !== "number"
        ) {
          throw new LedgerConfigValidationError(
            `Ledger filter ${filter.fieldId} has an invalid range endpoint`
          );
        }
      }
      return {
        fieldId: filter.fieldId,
        control: "range",
        ...(typeof filter.min === "string" || typeof filter.min === "number"
          ? { min: filter.min }
          : {}),
        ...(typeof filter.max === "string" || typeof filter.max === "number"
          ? { max: filter.max }
          : {}),
      };
    }
    throw new LedgerConfigValidationError(
      `Ledger filter ${filter.fieldId} has an unsupported control`
    );
  });
}

function parseLedgerConfig(
  value: unknown,
  expected: LedgerWorkspaceItem["ledgerConfig"]
): LedgerConfig {
  if (!isRecord(value))
    throw new LedgerConfigValidationError("Ledger configuration is required");
  const strings = [
    "methodId",
    "methodVersion",
    "templateId",
    "templateVersion",
  ] as const;
  for (const key of strings) {
    if (value[key] !== expected[key]) {
      throw new LedgerConfigValidationError(
        `Ledger configuration ${key} does not match its selected method`
      );
    }
  }
  return {
    methodId: expected.methodId,
    methodVersion: expected.methodVersion,
    templateId: expected.templateId,
    templateVersion: expected.templateVersion,
    filters: parseLedgerFilters(value.filters),
  };
}

function predicateFor(
  config: LedgerConfig,
  source: LoadedLedgerSource
): string {
  const dimensions = new Map(
    source.template.dimensions.map((dimension) => [dimension.id, dimension])
  );
  if (!config.filters.length) return "all accepted evidence";
  return config.filters
    .map((filter) => {
      const dimension = dimensions.get(filter.fieldId);
      const prefix = `${dimension?.role || "context"}.${filter.fieldId}`;
      if (filter.control === "multi-select") {
        return `${prefix} in [${filter.values.join(", ")}]`;
      }
      return [
        filter.min !== undefined ? `${prefix} gte ${filter.min}` : undefined,
        filter.max !== undefined ? `${prefix} lte ${filter.max}` : undefined,
      ]
        .filter(Boolean)
        .join(" and ");
    })
    .join(" and ");
}

async function resolveLedgerConfig(
  item: LedgerWorkspaceItem,
  candidate?: unknown
): Promise<{
  config: LedgerConfig;
  source: LoadedLedgerSource;
  resolution: EvidenceLedgerResolution;
}> {
  const config =
    candidate === undefined
      ? item.ledgerConfig
      : parseLedgerConfig(candidate, item.ledgerConfig);
  const source = await loadLedgerSource(config.methodId, config.methodVersion);
  if (
    source.template.id !== config.templateId ||
    source.template.version !== config.templateVersion
  ) {
    throw new LedgerConfigValidationError(
      "Ledger template no longer matches its selected method"
    );
  }
  try {
    const resolution = resolveEvidenceLedgerFromSource({
      method: source.method,
      template: source.template,
      contributions: source.contributions,
      filters: config.filters,
    });
    return {
      config: { ...config, filters: resolution.scope.filters },
      source,
      resolution,
    };
  } catch (error) {
    if (error instanceof EvidenceLedgerResolutionError) {
      throw new LedgerConfigValidationError(error.message);
    }
    throw error;
  }
}

export async function createLedgerWorkspaceItem(
  userId: string,
  methodId: string
): Promise<LedgerWorkspaceItem> {
  // Network reads happen outside the user lock (slow GitHub calls must
  // not hold the per-user write lock for seconds at a time).
  const researched = await listResearchedMethods();
  const catalogueMethod = researched.find((method) => method.id === methodId);
  if (
    !catalogueMethod?.evidenceTemplate ||
    catalogueMethod.acceptedEvidenceCount <= 0
  ) {
    throw new LedgerNotReadyError();
  }
  const source = await loadLedgerSource(methodId, catalogueMethod.version);
  const baseline = resolveEvidenceLedgerFromSource({
    method: source.method,
    template: source.template,
    contributions: source.contributions,
    filters: [],
  });
  if (!baseline.scope.baselineCount)
    throw new LedgerNotReadyError("Method has no accepted evidence");

  return withUserLock(userId, async () => {
    const now = new Date().toISOString();
    const ledgerConfig: LedgerConfig = {
      methodId: source.method.id,
      methodVersion: source.method.version,
      templateId: source.template.id,
      templateVersion: source.template.version,
      filters: [],
    };
    const item: LedgerWorkspaceItem = {
      id: `wi_${randomUUID()}`,
      ownerId: userId,
      status: "active",
      createdAt: now,
      updatedAt: now,
      kind: "ledger",
      ledgerConfig,
      snapshotIds: [],
      source: {
        methodId: ledgerConfig.methodId,
        methodVersion: ledgerConfig.methodVersion,
        templateId: ledgerConfig.templateId,
        templateVersion: ledgerConfig.templateVersion,
        sourceCommit: source.sourceCommit,
        methodTitle: catalogueMethod.title,
        baselineAcceptedEvidenceCount: baseline.scope.baselineCount,
      },
    };
    const manifest = await readManifest(userId);
    manifest.initialized = true;
    manifest.items[item.id] = item;
    await writeManifest(userId, manifest);
    return item;
  });
}

export async function updateLedgerConfig(
  userId: string,
  itemId: string,
  candidate: unknown
): Promise<LedgerWorkspaceItem> {
  // Read + ownership check under a short lock; network + resolve outside the
  // lock; write under a fresh lock (re-validated against the freshest item).
  const item = await withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const item = manifest.items[itemId];
    if (!item || item.ownerId !== userId || item.kind !== "ledger") {
      throw new WorkspaceItemNotFoundError();
    }
    return item;
  });
  const { config } = await resolveLedgerConfig(item, candidate);
  return withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const fresh = manifest.items[itemId];
    if (!fresh || fresh.ownerId !== userId || fresh.kind !== "ledger") {
      throw new WorkspaceItemNotFoundError();
    }
    const updated: LedgerWorkspaceItem = {
      ...fresh,
      ledgerConfig: config,
      updatedAt: new Date().toISOString(),
    };
    manifest.items[itemId] = updated;
    await writeManifest(userId, manifest);
    return updated;
  });
}

export async function previewLedgerConfig(
  userId: string,
  itemId: string,
  candidate?: unknown
): Promise<{
  item: LedgerWorkspaceItem;
  resolution: EvidenceLedgerResolution;
  predicate: string;
}> {
  const item = await withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const item = manifest.items[itemId];
    if (!item || item.ownerId !== userId || item.kind !== "ledger") {
      throw new WorkspaceItemNotFoundError();
    }
    return item;
  });
  const { config, source, resolution } = await resolveLedgerConfig(
    item,
    candidate
  );
  return withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const fresh = manifest.items[itemId];
    if (!fresh || fresh.ownerId !== userId || fresh.kind !== "ledger") {
      throw new WorkspaceItemNotFoundError();
    }
    const updated: LedgerWorkspaceItem = {
      ...fresh,
      ledgerConfig: config,
      source: {
        ...fresh.source,
        sourceCommit: source.sourceCommit,
        baselineAcceptedEvidenceCount: resolution.scope.baselineCount,
      },
      updatedAt: new Date().toISOString(),
    };
    manifest.items[itemId] = updated;
    await writeManifest(userId, manifest);
    return {
      item: updated,
      resolution,
      predicate: predicateFor(config, source),
    };
  });
}

export async function createLedgerSnapshotItem(
  userId: string,
  itemId: string,
  candidate?: unknown
): Promise<{ item: LedgerSnapshotWorkspaceItem; idempotent: boolean }> {
  const ledger = await withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const ledger = manifest.items[itemId];
    if (!ledger || ledger.ownerId !== userId || ledger.kind !== "ledger") {
      throw new WorkspaceItemNotFoundError();
    }
    return ledger;
  });
  const { config, source, resolution } = await resolveLedgerConfig(
    ledger,
    candidate
  );
  return withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const current = manifest.items[itemId];
    if (!current || current.ownerId !== userId || current.kind !== "ledger") {
      throw new WorkspaceItemNotFoundError();
    }
    const fingerprint = resolution.manifestHash;
    const existing = current.snapshotIds
      .map((snapshotId) => manifest.items[snapshotId])
      .find(
        (snapshot): snapshot is LedgerSnapshotWorkspaceItem =>
          snapshot?.kind === "ledger_snapshot" &&
          snapshot.snapshot.inputFingerprint === fingerprint &&
          snapshot.snapshot.sourceCommit === source.sourceCommit
      );
    if (existing) return { item: existing, idempotent: true };

    const now = new Date().toISOString();
    const predicate = predicateFor(config, source);
    const snapshotHeader: LedgerSnapshotData = {
      ledgerId: `ledger_${randomUUID()}`,
      methodId: config.methodId,
      methodVersion: config.methodVersion,
      templateId: config.templateId,
      templateVersion: config.templateVersion,
      filters: config.filters,
      manifest: resolution.manifest,
      inputFingerprint: fingerprint,
      renderHash: "",
      buckets: resolution.scope.bucketCounts,
      predicate,
      generatedAt: now,
      resolverVersion: "1.0.0",
      sourceCommit: source.sourceCommit,
    };
    snapshotHeader.renderHash = ledgerRenderHash(snapshotHeader, config);
    const snapshot: LedgerSnapshotWorkspaceItem = {
      id: `wi_${randomUUID()}`,
      ownerId: userId,
      status: "active",
      createdAt: now,
      updatedAt: now,
      kind: "ledger_snapshot",
      parentLedgerItemId: current.id,
      snapshot: snapshotHeader,
      config,
      source: {
        ...current.source,
        sourceCommit: source.sourceCommit,
        baselineAcceptedEvidenceCount: resolution.scope.baselineCount,
      },
    };
    const updatedLedger: LedgerWorkspaceItem = {
      ...current,
      ledgerConfig: config,
      snapshotIds: [...current.snapshotIds, snapshot.id],
      source: snapshot.source,
      updatedAt: now,
    };
    manifest.items[snapshot.id] = snapshot;
    manifest.items[current.id] = updatedLedger;
    await writeManifest(userId, manifest);
    return { item: snapshot, idempotent: false };
  });
}

export async function listLedgerSnapshots(
  userId: string,
  itemId: string
): Promise<LedgerSnapshotWorkspaceItem[]> {
  const item = await getWorkspaceItem(userId, itemId);
  if (!item || item.kind !== "ledger") throw new WorkspaceItemNotFoundError();
  const manifest = await readManifest(userId);
  return item.snapshotIds
    .map((snapshotId) => manifest.items[snapshotId])
    .filter(
      (snapshot): snapshot is LedgerSnapshotWorkspaceItem =>
        snapshot?.kind === "ledger_snapshot"
    );
}

export async function submitWorkspaceForm(
  userId: string,
  itemId: string,
  rawValues: unknown,
  options?: {
    profileId?: string;
    threadId?: string;
  }
): Promise<{ item: WorkspaceItem; idempotent: boolean }> {
  const result = await withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const item = manifest.items[itemId];
    if (!item || item.ownerId !== userId || item.status !== "active") {
      throw new WorkspaceItemNotFoundError();
    }
    if (
      item.kind !== "form_template" &&
      item.kind !== "method" &&
      item.kind !== "method_participant"
    ) {
      throw new WorkspaceItemNotFoundError();
    }

    if (item.kind === "method_participant") {
      return submitMethodParticipant(userId, manifest, item, options?.threadId);
    }

    let values: Record<string, FormValue>;
    try {
      values = validateFormValues(item.templateSnapshot.fields, rawValues);
    } catch (error) {
      if (error instanceof FormValidationError) throw error;
      throw error;
    }
    const resolvedMarkdown = resolveFormMarkdown(
      item.templateSnapshot.layoutMarkdown,
      item.templateSnapshot.fields,
      values
    );

    if (item.kind === "form_template") {
      if (item.submission) {
        if (submissionEquals(item.submission, values, resolvedMarkdown)) {
          return { item, idempotent: true, deferred: [] };
        }
        throw new WorkspaceFormAlreadySubmittedError();
      }

      item.submission = {
        status: "submitted",
        values,
        resolvedMarkdown,
        submittedAt: new Date().toISOString(),
      };
      item.updatedAt = item.submission.submittedAt;
      manifest.items[item.id] = item;
      await writeManifest(userId, manifest);
      return { item, idempotent: false, deferred: [] };
    }

    if (item.run) {
      if (
        item.submission &&
        submissionEquals(item.submission, values, resolvedMarkdown)
      ) {
        return { item, idempotent: true, deferred: [] };
      }
      throw new WorkspaceFormAlreadySubmittedError();
    }

    const launched = await launchMethodRun(userId, manifest, item, values, {
      profileId: options?.profileId,
      resolvedMarkdown,
    });
    return {
      item: launched.item,
      idempotent: false,
      deferred: launched.deferred,
    };
  });
  await Promise.all(result.deferred.map((job) => job()));
  return { item: result.item, idempotent: result.idempotent };
}

async function attachOwnedThread(
  userId: string,
  itemId: string,
  threadId: string
): Promise<string> {
  const thread = await client().threads.get(threadId);
  const metadata = (thread?.metadata || {}) as Record<string, unknown>;
  if (metadata.user_id !== userId || metadata.workspace_item_id !== itemId) {
    throw new WorkspaceThreadOwnershipError();
  }
  return threadId;
}

function markOperatorParticipantSubmitted(
  manifest: WorkspaceManifest,
  operatorItemId: string,
  userId: string,
  participantItemId: string,
  submittedAt: string,
  threadId?: string
): boolean {
  const operatorItem = manifest.items[operatorItemId];
  if (operatorItem?.kind !== "method" || !operatorItem.run) return false;
  const row = operatorItem.run.participants.find(
    (participant) =>
      participant.itemId === participantItemId || participant.userId === userId
  );
  if (!row) return false;
  row.submissionStatus = "submitted";
  row.submittedAt = submittedAt;
  row.threadId = threadId ?? row.threadId;
  row.invitationStatus = "accepted";
  operatorItem.updatedAt = submittedAt;
  manifest.items[operatorItem.id] = operatorItem;
  return true;
}

async function syncOperatorParticipantSubmission(
  item: MethodParticipantWorkspaceItem,
  submittedAt: string,
  threadId?: string
): Promise<void> {
  await withUserLock(item.operatorId, async () => {
    const manifest = await readManifest(item.operatorId);
    if (
      markOperatorParticipantSubmitted(
        manifest,
        item.operatorItemId,
        item.ownerId,
        item.id,
        submittedAt,
        threadId
      )
    ) {
      await writeManifest(item.operatorId, manifest);
    }
  });
}

async function reconcileMethodRunSubmissions(
  operatorId: string,
  item: MethodWorkspaceItem
): Promise<MethodWorkspaceItem> {
  if (!item.run) return item;
  let changed = false;
  const submittedAtFallback = new Date().toISOString();

  for (const row of item.run.participants) {
    if (!row.userId || !row.itemId) continue;
    if (row.submissionStatus === "submitted") continue;
    try {
      const participantManifest = await readManifest(row.userId);
      const participant = participantManifest.items[row.itemId];
      if (
        participant?.kind !== "method_participant" ||
        participant.operatorId !== operatorId ||
        participant.operatorItemId !== item.id ||
        participant.submission?.status !== "submitted"
      ) {
        continue;
      }
      row.submissionStatus = "submitted";
      row.submittedAt =
        participant.submission.submittedAt ?? submittedAtFallback;
      row.threadId = participant.threadId ?? row.threadId;
      row.invitationStatus = "accepted";
      changed = true;
    } catch (error) {
      console.error(
        "[workspace] failed to reconcile participant submission",
        row.itemId,
        error
      );
    }
  }

  if (!changed) return item;

  await withUserLock(operatorId, async () => {
    const manifest = await readManifest(operatorId);
    const stored = manifest.items[item.id];
    if (stored?.kind !== "method" || !stored.run) return;
    for (const row of item.run!.participants) {
      const storedRow = stored.run.participants.find(
        (candidate) =>
          candidate.itemId === row.itemId ||
          (row.userId && candidate.userId === row.userId) ||
          candidate.email === row.email
      );
      if (!storedRow || storedRow.submissionStatus === "submitted") continue;
      if (row.submissionStatus === "submitted") {
        storedRow.submissionStatus = "submitted";
        storedRow.submittedAt = row.submittedAt;
        storedRow.threadId = row.threadId;
        storedRow.invitationStatus = "accepted";
      }
    }
    stored.updatedAt = new Date().toISOString();
    manifest.items[item.id] = stored;
    await writeManifest(operatorId, manifest);
  });

  return item;
}

async function submitMethodParticipant(
  userId: string,
  manifest: WorkspaceManifest,
  item: MethodParticipantWorkspaceItem,
  liveThreadId?: string
): Promise<{
  item: WorkspaceItem;
  idempotent: boolean;
  deferred: Array<() => Promise<void>>;
}> {
  const deferred: Array<() => Promise<void>> = [];
  let threadId = item.threadId;
  if (liveThreadId && liveThreadId !== threadId) {
    threadId = await attachOwnedThread(userId, item.id, liveThreadId);
    item.threadId = threadId;
  }

  if (item.submission?.status === "submitted") {
    if (item.operatorId === userId) {
      if (
        markOperatorParticipantSubmitted(
          manifest,
          item.operatorItemId,
          userId,
          item.id,
          item.submission.submittedAt,
          threadId
        )
      ) {
        await writeManifest(userId, manifest);
      }
    } else {
      deferred.push(() =>
        syncOperatorParticipantSubmission(
          item,
          item.submission!.submittedAt,
          threadId
        )
      );
    }
    return { item, idempotent: true, deferred };
  }

  const submittedAt = new Date().toISOString();
  item.submission = { status: "submitted", submittedAt };
  item.updatedAt = submittedAt;
  manifest.items[item.id] = item;
  await writeManifest(userId, manifest);

  if (threadId) {
    try {
      const thread = await client().threads.get(threadId);
      const metadata = (thread?.metadata || {}) as Record<string, unknown>;
      await client().threads.update(threadId, {
        metadata: {
          ...metadata,
          completionPercent: 100,
          phase_state: "submitted",
          phaseState: "submitted",
          submittedAt,
        },
      });
      const updater = (
        client().threads as Client["threads"] & {
          updateState?: (
            id: string,
            payload: { values: Record<string, unknown> }
          ) => Promise<unknown>;
        }
      ).updateState;
      if (updater) {
        await updater(threadId, {
          values: { phase_state: "submitted" },
        });
      }
    } catch (error) {
      if (!isMissingThreadError(error)) {
        console.error("[workspace] failed to mark thread submitted", error);
      }
    }
  }

  if (item.operatorId === userId) {
    markOperatorParticipantSubmitted(
      manifest,
      item.operatorItemId,
      userId,
      item.id,
      submittedAt,
      threadId
    );
    await writeManifest(userId, manifest);
  } else {
    deferred.push(() =>
      syncOperatorParticipantSubmission(item, submittedAt, threadId)
    );
  }

  return { item, idempotent: false, deferred };
}

function assignmentFromValues(
  values: Record<string, FormValue>
): MethodRunAssignment {
  const wordTarget = values.word_target;
  return {
    title: String(values.title || ""),
    course: String(values.course || ""),
    dueDate: String(values.due_date || ""),
    wordTarget:
      typeof wordTarget === "number" ? wordTarget : Number(wordTarget) || 0,
    prompt: String(values.essay_prompt || ""),
    agentInstructions: String(values.agent_instructions || ""),
    group: String(values.group || ""),
  };
}

export function pendingInviteNamespace(email: string): string[] {
  const label = email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128);
  return ["workspace_method_invites", label || "unknown"];
}

export function inviteLockId(email: string): string {
  const label = email
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128);
  return `invite_${label || "unknown"}`;
}

async function readPendingInvites(
  email: string
): Promise<PendingMethodInvite[]> {
  const item = await client().store.getItem(
    pendingInviteNamespace(email),
    "pending"
  );
  const value = item?.value as { invites?: PendingMethodInvite[] } | undefined;
  return Array.isArray(value?.invites) ? value.invites : [];
}

async function writePendingInvites(
  email: string,
  invites: PendingMethodInvite[]
): Promise<void> {
  await client().store.putItem(pendingInviteNamespace(email), "pending", {
    invites,
  });
}

function createParticipantRecord(
  userId: string,
  invite: {
    runId: string;
    operatorItemId: string;
    operatorId: string;
    methodSource: MethodSource;
    profileId: string;
    apparatusConfiguration: MethodParticipantWorkspaceItem["apparatusConfiguration"];
    assignment: MethodRunAssignment;
    source: MethodWorkspaceItem["source"];
  }
): MethodParticipantWorkspaceItem {
  const now = new Date().toISOString();
  return {
    id: `wi_${randomUUID()}`,
    ownerId: userId,
    status: "active",
    createdAt: now,
    updatedAt: now,
    source: invite.source,
    kind: "method_participant",
    runId: invite.runId,
    operatorItemId: invite.operatorItemId,
    operatorId: invite.operatorId,
    methodSource: invite.methodSource,
    profileId: invite.profileId,
    apparatusConfiguration: invite.apparatusConfiguration,
    assignment: invite.assignment,
  };
}

async function launchMethodRun(
  operatorId: string,
  manifest: WorkspaceManifest,
  item: MethodWorkspaceItem,
  values: Record<string, FormValue>,
  options: { profileId?: string; resolvedMarkdown: string }
): Promise<{
  item: MethodWorkspaceItem;
  deferred: Array<() => Promise<void>>;
}> {
  const emails = Array.isArray(values.participants)
    ? values.participants.map((email) => String(email).trim().toLowerCase())
    : [];
  if (emails.length === 0) {
    throw new FormValidationError([
      { fieldId: "participants", message: "Participants is required." },
    ]);
  }

  const resolved = resolveApparatusConfiguration({
    apparatusId: item.methodSource.id,
    profileId: options.profileId || item.profileId,
  });
  const assignment = assignmentFromValues(values);
  const launchedAt = new Date().toISOString();
  const runId = `run_${randomUUID()}`;
  const snapshot = {
    runId,
    operatorItemId: item.id,
    operatorId,
    methodSource: item.methodSource,
    profileId: resolved.apparatusProfileId,
    apparatusConfiguration: resolved.apparatusConfiguration,
    assignment,
    source: item.source,
  };

  const participants: MethodRunParticipant[] = [];
  const deferred: Array<() => Promise<void>> = [];

  let pendingInviteCount = 0;
  for (const [index, email] of emails.entries()) {
    const existing = await findUserByEmail(email);
    if (existing?.id) {
      const participantItem = createParticipantRecord(existing.id, snapshot);
      if (existing.id === operatorId) {
        manifest.items[participantItem.id] = participantItem;
      } else {
        deferred.push(() =>
          withUserLock(existing.id!, async () => {
            const participantManifest = await readManifest(existing.id!);
            participantManifest.initialized = true;
            participantManifest.items[participantItem.id] = participantItem;
            await writeManifest(existing.id!, participantManifest);
          })
        );
      }
      participants.push({
        email,
        userId: existing.id,
        itemId: participantItem.id,
        invitationStatus: "accepted",
        submissionStatus: "not_started",
      });
      await inviteWorkspaceParticipant(email, { correlationId: runId }).catch(
        (error) => {
          console.error(
            "[workspace] participant notify failed",
            runId,
            index,
            error
          );
        }
      );
      continue;
    }

    if (pendingInviteCount > 0 && INVITE_EMAIL_GAP_MS > 0) {
      await sleep(INVITE_EMAIL_GAP_MS);
    }
    await inviteWorkspaceParticipant(email, { correlationId: runId }).catch(
      (error) => {
        console.error("[workspace] invite email failed", runId, index, error);
      }
    );
    pendingInviteCount += 1;
    const pending: PendingMethodInvite = {
      email,
      runId,
      operatorId,
      operatorItemId: item.id,
      methodId: item.methodSource.id,
      methodVersion: item.methodSource.version,
      methodSource: item.methodSource,
      profileId: resolved.apparatusProfileId,
      apparatusConfiguration: resolved.apparatusConfiguration,
      assignment,
      createdAt: launchedAt,
    };
    await withUserLock(inviteLockId(email), async () => {
      const invites = await readPendingInvites(email);
      invites.push(pending);
      await writePendingInvites(email, invites);
    });
    participants.push({
      email,
      invitationStatus: "sent",
      submissionStatus: "not_started",
    });
  }

  item.submission = {
    status: "submitted",
    values,
    resolvedMarkdown: options.resolvedMarkdown,
    submittedAt: launchedAt,
  };
  item.profileId = resolved.apparatusProfileId;
  item.run = {
    id: runId,
    status: "in_progress",
    launchedAt,
    methodId: item.methodSource.id,
    methodVersion: item.methodSource.version,
    profileId: resolved.apparatusProfileId,
    apparatusConfiguration: resolved.apparatusConfiguration,
    assignment,
    participants,
  };
  item.updatedAt = launchedAt;
  manifest.items[item.id] = item;
  await writeManifest(operatorId, manifest);
  return { item, deferred };
}

export async function claimPendingMethodInvites(
  userId: string,
  email: string
): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return;

  const invites = await withUserLock(inviteLockId(normalized), async () =>
    readPendingInvites(normalized)
  );
  if (invites.length === 0) return;

  const claimed: PendingMethodInvite[] = [];
  for (const invite of invites) {
    let participantItemId: string | undefined;
    await withUserLock(userId, async () => {
      const manifest = await readManifest(userId);
      const already = Object.values(manifest.items).find(
        (item) =>
          item.kind === "method_participant" && item.runId === invite.runId
      );
      if (already) {
        participantItemId = already.id;
        return;
      }

      const participantItem = createParticipantRecord(userId, {
        runId: invite.runId,
        operatorItemId: invite.operatorItemId,
        operatorId: invite.operatorId,
        methodSource: enrichMethodSource(
          invite.methodSource || {
            id: invite.methodId,
            version: invite.methodVersion,
          }
        ),
        profileId: invite.profileId,
        apparatusConfiguration: invite.apparatusConfiguration,
        assignment: invite.assignment,
        source: {
          catalogRevision: "claimed",
          templateId: invite.methodId,
          templateVersion: invite.methodVersion,
          sourcePath: `methods/${invite.methodId}`,
        },
      });
      manifest.initialized = true;
      manifest.items[participantItem.id] = participantItem;
      await writeManifest(userId, manifest);
      participantItemId = participantItem.id;
    });

    if (participantItemId) {
      await withUserLock(invite.operatorId, async () => {
        const operatorManifest = await readManifest(invite.operatorId);
        const operatorItem = operatorManifest.items[invite.operatorItemId];
        if (operatorItem?.kind !== "method" || !operatorItem.run) return;
        const row = operatorItem.run.participants.find(
          (participant) => participant.email === normalized
        );
        if (row) {
          row.userId = userId;
          row.itemId = participantItemId;
          row.invitationStatus = "accepted";
        }
        operatorItem.updatedAt = new Date().toISOString();
        operatorManifest.items[operatorItem.id] = operatorItem;
        await writeManifest(invite.operatorId, operatorManifest);
      });
    }
    claimed.push(invite);
  }

  await withUserLock(inviteLockId(normalized), async () => {
    const remaining = (await readPendingInvites(normalized)).filter(
      (invite) =>
        !claimed.some(
          (done) =>
            done.runId === invite.runId &&
            done.operatorItemId === invite.operatorItemId
        )
    );
    await writePendingInvites(normalized, remaining);
  });
}

function isMissingThreadError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
    message?: unknown;
  };
  return (
    candidate.status === 404 ||
    candidate.statusCode === 404 ||
    candidate.response?.status === 404 ||
    (typeof candidate.message === "string" &&
      /(?:404|not found)/i.test(candidate.message))
  );
}

export async function deleteWorkspaceItem(
  userId: string,
  itemId: string
): Promise<void> {
  return withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const item = manifest.items[itemId];
    if (!item || item.ownerId !== userId || item.status !== "active") {
      throw new WorkspaceItemNotFoundError();
    }

    if (
      (item.kind === "markdown_template" ||
        item.kind === "form_template" ||
        item.kind === "method" ||
        item.kind === "method_participant") &&
      item.threadId
    ) {
      let thread: Awaited<ReturnType<Client["threads"]["get"]>> | undefined;
      try {
        thread = await client().threads.get(item.threadId);
      } catch (error) {
        if (!isMissingThreadError(error)) throw error;
      }

      if (thread) {
        const metadata = (thread.metadata || {}) as Record<string, unknown>;
        if (
          metadata.user_id !== userId ||
          metadata.workspace_item_id !== itemId
        ) {
          throw new WorkspaceThreadOwnershipError();
        }
        try {
          await client().threads.delete(item.threadId);
        } catch (error) {
          if (!isMissingThreadError(error)) throw error;
        }
      }
    }

    delete manifest.items[itemId];
    if (manifest.defaultItemId === itemId) delete manifest.defaultItemId;
    manifest.initialized = true;
    await writeManifest(userId, manifest);
  });
}

export async function getWorkspaceItem(
  userId: string,
  itemId: string
): Promise<UsableWorkspaceItem | undefined> {
  const manifest = await readManifest(userId);
  const item = manifest.items[itemId];
  if (!item || item.ownerId !== userId || item.status !== "active") {
    return undefined;
  }
  if (
    item.kind === "research_repository" &&
    !isUsableResearchRepository(item)
  ) {
    return undefined;
  }
  if (item.kind === "method" && item.run) {
    return enrichWorkspaceItem(
      await reconcileMethodRunSubmissions(userId, item)
    );
  }
  return enrichWorkspaceItem(item as UsableWorkspaceItem);
}

export async function updateResearchRepositoryBindingHead(
  userId: string,
  itemId: string,
  headCommitSha: string
): Promise<ResearchRepositoryWorkspaceItem> {
  return withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const item = manifest.items[itemId];
    if (
      !item ||
      !isUsableResearchRepository(item) ||
      item.ownerId !== userId ||
      item.status !== "active"
    ) {
      throw new WorkspaceItemNotFoundError();
    }
    const updated = ResearchRepositoryWorkspaceItemSchema.parse({
      ...item,
      updatedAt: new Date().toISOString(),
      binding: { ...item.binding, headCommitSha },
    });
    manifest.items[itemId] = updated;
    await writeManifest(userId, manifest);
    return updated;
  });
}

/** Read a sealed snapshot owned by the active workspace user. */
export async function getLedgerSnapshotItem(
  userId: string,
  itemId: string
): Promise<LedgerSnapshotWorkspaceItem> {
  const item = await getWorkspaceItem(userId, itemId);
  if (!item || item.kind !== "ledger_snapshot") {
    throw new WorkspaceItemNotFoundError();
  }
  return item;
}

/** Persist publication metadata without ever modifying snapshot inputs. */
export async function updateLedgerSnapshotPublication(
  userId: string,
  itemId: string,
  update: {
    publication?: LedgerSnapshotWorkspaceItem["publication"];
    renderHash?: string;
  }
): Promise<LedgerSnapshotWorkspaceItem> {
  return withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const item = manifest.items[itemId];
    if (
      !item ||
      item.ownerId !== userId ||
      item.status !== "active" ||
      item.kind !== "ledger_snapshot"
    ) {
      throw new WorkspaceItemNotFoundError();
    }
    const updated: LedgerSnapshotWorkspaceItem = {
      ...item,
      ...(update.publication === undefined
        ? {}
        : { publication: update.publication }),
      snapshot:
        update.renderHash === undefined
          ? item.snapshot
          : { ...item.snapshot, renderHash: update.renderHash },
      updatedAt: new Date().toISOString(),
    };
    manifest.items[itemId] = updated;
    await writeManifest(userId, manifest);
    return updated;
  });
}

export class WorkspaceReviewForbiddenError extends Error {
  constructor() {
    super("Forbidden");
    this.name = "WorkspaceReviewForbiddenError";
  }
}

export async function getMethodRun(
  userId: string,
  itemId: string
): Promise<MethodWorkspaceItem & { run: MethodRun }> {
  const item = await getWorkspaceItem(userId, itemId);
  if (!item || item.kind !== "method" || !item.run) {
    throw new WorkspaceItemNotFoundError();
  }
  return { ...item, run: item.run };
}

function evidenceReference(
  item: MethodWorkspaceItem,
  threadId: string
): MethodWorkspaceItem["evidenceThreads"] extends infer T
  ? T extends Array<infer R>
    ? R
    : never
  : never {
  const reference = item.evidenceThreads?.find(
    (candidate) => candidate.threadId === threadId
  );
  if (!reference) throw new WorkspaceThreadOwnershipError();
  return reference;
}

function evidenceThreadMetadata(
  userId: string,
  item: MethodWorkspaceItem,
  snapshot: EvidenceSnapshot
): Record<string, unknown> {
  return withOwnedThreadMetadata(
    {
      workspace_item_id: item.id,
      evidence: {
        method_id: snapshot.methodId,
        method_version: snapshot.methodVersion,
        template_version: snapshot.templateVersion,
        frozen_values: snapshot.frozenValues,
      },
    },
    userId
  );
}

async function createEvidenceLangGraphThread(
  userId: string,
  item: MethodWorkspaceItem,
  snapshot: EvidenceSnapshot
): Promise<string> {
  const metadata = evidenceThreadMetadata(userId, item, snapshot);
  const response = await fetch(`${LANGGRAPH_API_URL}/threads`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.LANGCHAIN_API_KEY || "",
    },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({
      metadata,
      config: {
        configurable: {
          workspace_item_id: item.id,
          systemPrompt: snapshot.guidance,
          evidence_layout: snapshot.layoutMarkdown,
          evidence_fields: snapshot.fields,
          evidence_frozen_values: snapshot.frozenValues,
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`Could not create evidence thread (${response.status})`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const threadId =
    typeof body.thread_id === "string"
      ? body.thread_id
      : typeof body.threadId === "string"
        ? body.threadId
        : undefined;
  if (!threadId) throw new Error("Evidence thread response had no thread id");
  return threadId;
}

export async function createEvidenceThread(
  userId: string,
  itemId: string
): Promise<{
  item: MethodWorkspaceItem;
  threadId: string;
  snapshot: EvidenceSnapshot;
}> {
  return withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const stored = manifest.items[itemId];
    if (
      !stored ||
      stored.ownerId !== userId ||
      stored.status !== "active" ||
      stored.kind !== "method"
    ) {
      throw new WorkspaceItemNotFoundError();
    }
    if (!stored.run || stored.submission?.status !== "submitted") {
      throw new EvidenceRunNotConcludedError();
    }

    const snapshot = buildEvidenceSnapshot(stored);
    const existing = [...(stored.evidenceThreads ?? [])]
      .reverse()
      .find((reference) => reference.status !== "filed");
    if (existing) {
      const thread = await client().threads.get(existing.threadId);
      const metadata = (thread?.metadata || {}) as Record<string, unknown>;
      if (
        metadata.user_id !== userId ||
        metadata.workspace_item_id !== itemId ||
        !metadata.evidence
      ) {
        throw new WorkspaceThreadOwnershipError();
      }
      return { item: stored, threadId: existing.threadId, snapshot };
    }

    const threadId = await createEvidenceLangGraphThread(
      userId,
      stored,
      snapshot
    );
    const submittedAt = new Date().toISOString();
    stored.evidenceThreads = [
      ...(stored.evidenceThreads ?? []),
      {
        threadId,
        status: "draft",
        templateVersion: snapshot.templateVersion,
      },
    ];
    stored.updatedAt = submittedAt;
    manifest.items[stored.id] = stored;
    await writeManifest(userId, manifest);
    return { item: stored, threadId, snapshot };
  });
}

export async function getEvidenceSnapshot(
  userId: string,
  itemId: string,
  threadId: string
): Promise<{
  item: MethodWorkspaceItem;
  snapshot: EvidenceSnapshot;
  reference: NonNullable<MethodWorkspaceItem["evidenceThreads"]>[number];
}> {
  const item = await getWorkspaceItem(userId, itemId);
  if (!item || item.kind !== "method") {
    throw new WorkspaceItemNotFoundError();
  }
  const reference = evidenceReference(item, threadId);
  let thread: Awaited<ReturnType<Client["threads"]["get"]>>;
  try {
    thread = await client().threads.get(threadId);
  } catch (error) {
    if (isMissingThreadError(error)) {
      throw new WorkspaceEvidenceThreadMissingError();
    }
    throw error;
  }
  const metadata = (thread?.metadata || {}) as Record<string, unknown>;
  if (
    metadata.user_id !== userId ||
    metadata.workspace_item_id !== itemId ||
    !metadata.evidence
  ) {
    throw new WorkspaceThreadOwnershipError();
  }
  return {
    item,
    snapshot: buildEvidenceSnapshotFromMarker(item, metadata.evidence),
    reference,
  };
}

export async function claimEvidenceSubmission(
  userId: string,
  itemId: string,
  threadId: string,
  submissionKey: string
): Promise<NonNullable<MethodWorkspaceItem["evidenceThreads"]>[number]> {
  return withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const item = manifest.items[itemId];
    if (
      !item ||
      item.ownerId !== userId ||
      item.status !== "active" ||
      item.kind !== "method"
    ) {
      throw new WorkspaceItemNotFoundError();
    }
    const reference = evidenceReference(item, threadId);
    if (reference.status === "submitted" || reference.status === "filed") {
      throw new WorkspaceEvidenceAlreadySubmittedError();
    }
    if (reference.status !== "submitting" || !reference.submissionKey) {
      reference.status = "submitting";
      reference.submissionKey = submissionKey;
      item.updatedAt = new Date().toISOString();
      manifest.items[item.id] = item;
      await writeManifest(userId, manifest);
    }
    return reference;
  });
}

export async function updateEvidenceThreadReference(
  userId: string,
  itemId: string,
  threadId: string,
  update: Partial<NonNullable<MethodWorkspaceItem["evidenceThreads"]>[number]>
): Promise<MethodWorkspaceItem> {
  return withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const item = manifest.items[itemId];
    if (
      !item ||
      item.ownerId !== userId ||
      item.status !== "active" ||
      item.kind !== "method"
    ) {
      throw new WorkspaceItemNotFoundError();
    }
    const reference = evidenceReference(item, threadId);
    let thread: Awaited<ReturnType<Client["threads"]["get"]>>;
    try {
      thread = await client().threads.get(threadId);
    } catch (error) {
      if (isMissingThreadError(error)) {
        throw new WorkspaceEvidenceThreadMissingError();
      }
      throw error;
    }
    const metadata = (thread?.metadata || {}) as Record<string, unknown>;
    if (
      metadata.user_id !== userId ||
      metadata.workspace_item_id !== itemId ||
      !metadata.evidence
    ) {
      throw new WorkspaceThreadOwnershipError();
    }
    if (update.values) {
      const snapshot = buildEvidenceSnapshotFromMarker(item, metadata.evidence);
      update = {
        ...update,
        values: Object.fromEntries(
          Object.entries(update.values).filter(
            ([fieldId, value]) =>
              snapshot.fields[fieldId]?.readOnly !== true &&
              typeof value === "string"
          )
        ),
      };
    }
    Object.assign(reference, update);
    item.updatedAt = new Date().toISOString();
    manifest.items[item.id] = item;
    await writeManifest(userId, manifest);
    return item;
  });
}

export async function getMethodParticipantReview(
  operatorId: string,
  operatorItemId: string,
  participantItemId: string
): Promise<{
  operatorItem: MethodWorkspaceItem;
  participant: MethodParticipantWorkspaceItem;
  thread: {
    id: string;
    messages: unknown[];
    artifact?: unknown;
    history: unknown[];
    metadata: Record<string, unknown>;
  } | null;
  trackingEnabled: boolean;
}> {
  const operatorItem = await getMethodRun(operatorId, operatorItemId);
  const row = operatorItem.run.participants.find(
    (participant) => participant.itemId === participantItemId
  );
  if (!row?.userId) {
    throw new WorkspaceItemNotFoundError();
  }

  const participantManifest = await readManifest(row.userId);
  const participant = participantManifest.items[participantItemId];
  if (
    !participant ||
    participant.kind !== "method_participant" ||
    participant.operatorId !== operatorId ||
    participant.operatorItemId !== operatorItemId
  ) {
    throw new WorkspaceItemNotFoundError();
  }

  const threadId = participant.threadId || row.threadId;
  let thread: {
    id: string;
    messages: unknown[];
    artifact?: unknown;
    history: unknown[];
    metadata: Record<string, unknown>;
  } | null = null;
  if (threadId) {
    try {
      const record = await client().threads.get(threadId);
      const state = await client().threads.getState(threadId);
      const values = (state?.values || {}) as Record<string, unknown>;
      let history: unknown[] = [];
      try {
        history = (await client().threads.getHistory(threadId)) as unknown[];
      } catch {
        history = [];
      }
      thread = {
        id: threadId,
        messages: Array.isArray(values.messages) ? values.messages : [],
        artifact: values.artifact,
        history,
        metadata: (record?.metadata || {}) as Record<string, unknown>,
      };
    } catch (error) {
      if (!isMissingThreadError(error)) throw error;
    }
  }

  return {
    operatorItem,
    participant,
    thread,
    trackingEnabled: participant.apparatusConfiguration.tracking !== false,
  };
}

/**
 * Resolve whether method tracking may be written/read for a thread.
 * Accepts either owner metadata key: authoritative `user_id` (server-stamped
 * via the proxy) preferred, with `supabase_user_id` (client ThreadProvider)
 * as fallback. This is tracking-policy only — thread ownership gates stay
 * strict on `user_id`.
 */
export async function resolveMethodTrackingAccess(
  threadId: string,
  userId: string
): Promise<{ allowed: boolean; canWrite: boolean; canRead: boolean }> {
  const denied = { allowed: false, canWrite: false, canRead: false };
  if (!threadId) return denied;
  try {
    const thread = await client().threads.get(threadId);
    const metadata = (thread?.metadata || {}) as Record<string, unknown>;
    const ownerId =
      typeof metadata.user_id === "string"
        ? metadata.user_id
        : typeof metadata.supabase_user_id === "string"
          ? metadata.supabase_user_id
          : undefined;
    const itemId = metadata.workspace_item_id;
    if (typeof ownerId !== "string" || typeof itemId !== "string")
      return denied;
    const manifest = await readManifest(ownerId);
    const item = manifest.items[itemId];
    if (item?.kind !== "method_participant") return denied;
    const allowed = item.apparatusConfiguration.tracking !== false;
    const isOwner = ownerId === userId;
    const isOperator = item.operatorId === userId;
    return {
      allowed,
      canWrite: allowed && isOwner,
      canRead: allowed && (isOwner || isOperator),
    };
  } catch {
    return denied;
  }
}

export async function reconcileWorkspaceItemThread(
  userId: string,
  itemId: string,
  threadId: string | null
): Promise<WorkspaceItem> {
  return withUserLock(userId, async () => {
    const manifest = await readManifest(userId);
    const item = manifest.items[itemId];
    if (!item || item.ownerId !== userId || item.status !== "active") {
      throw new WorkspaceItemNotFoundError();
    }
    if (
      item.kind !== "markdown_template" &&
      item.kind !== "form_template" &&
      item.kind !== "method" &&
      item.kind !== "method_participant"
    ) {
      throw new WorkspaceItemThreadNotAllowedError();
    }

    if (threadId) {
      const thread = await client().threads.get(threadId);
      const metadata = (thread?.metadata || {}) as Record<string, unknown>;
      if (
        metadata.user_id !== userId ||
        metadata.workspace_item_id !== itemId
      ) {
        throw new WorkspaceThreadOwnershipError();
      }
    }

    item.threadId = threadId || undefined;
    item.updatedAt = new Date().toISOString();
    manifest.items[item.id] = item;
    await writeManifest(userId, manifest);
    return item;
  });
}
