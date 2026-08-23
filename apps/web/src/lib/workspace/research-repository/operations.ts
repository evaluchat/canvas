import { createHash } from "node:crypto";
import { Client } from "@langchain/langgraph-sdk";
import {
  RepositoryOperationSchema,
  type RepositoryOperation,
} from "@opencanvas/shared/research-repository";
import { LANGGRAPH_API_URL } from "@/constants";
import { withUserLock } from "./credentials";
import { StaleRepositoryError } from "./git-adapter";

export const GITHUB_RESEARCH_OPERATIONS_ROOT = "github_research_operations";
export const REPOSITORY_OPERATION_LEASE_MS = 5 * 60 * 1000;

export class RepositoryOperationInProgressError extends Error {
  constructor(public readonly operation: RepositoryOperation) {
    super("A repository operation with this idempotency key is in progress");
    this.name = "RepositoryOperationInProgressError";
  }
}

function client(): Client {
  return new Client({
    apiUrl: LANGGRAPH_API_URL,
    apiKey: process.env.LANGCHAIN_API_KEY,
  });
}

export function repositoryOperationsNamespace(userId: string): string[] {
  if (!userId || userId.includes(".")) throw new Error("Invalid user id");
  return [GITHUB_RESEARCH_OPERATIONS_ROOT, userId];
}

function operationKey(idempotencyKey: string): string {
  return `idempotency-${createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")}`;
}

function operationId(idempotencyKey: string): string {
  return `op_${createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 16)}`;
}

async function writeOperation(
  userId: string,
  operation: RepositoryOperation
): Promise<void> {
  await client().store.putItem(
    repositoryOperationsNamespace(userId),
    operationKey(operation.idempotencyKey),
    operation
  );
}

async function readOperation(
  userId: string,
  idempotencyKey: string
): Promise<RepositoryOperation | undefined> {
  const item = await client().store.getItem(
    repositoryOperationsNamespace(userId),
    operationKey(idempotencyKey)
  );
  const parsed = RepositoryOperationSchema.safeParse(item?.value);
  return parsed.success ? parsed.data : undefined;
}

async function deleteOperation(
  userId: string,
  idempotencyKey: string
): Promise<void> {
  await client().store.deleteItem(
    repositoryOperationsNamespace(userId),
    operationKey(idempotencyKey)
  );
}

export async function claimRepositoryOperation(
  userId: string,
  input: {
    workspaceId: string;
    kind: RepositoryOperation["kind"];
    idempotencyKey: string;
    artifactIds: string[];
    baseCommitSha?: string;
    getCurrentHeadCommitSha?: () => Promise<string>;
  }
): Promise<RepositoryOperation> {
  return withUserLock(userId, async () => {
    const existing = await readOperation(userId, input.idempotencyKey);
    if (
      existing?.status === "failed" &&
      existing.errorCode === "STALE_REPOSITORY"
    ) {
      await deleteOperation(userId, input.idempotencyKey);
    } else if (
      existing?.status === "succeeded" ||
      existing?.status === "failed"
    ) {
      return existing;
    }
    if (existing?.status === "pending" || existing?.status === "running") {
      const updatedAt = Date.parse(existing.updatedAt);
      if (
        Number.isFinite(updatedAt) &&
        Date.now() - updatedAt < REPOSITORY_OPERATION_LEASE_MS
      ) {
        throw new RepositoryOperationInProgressError(existing);
      }
      if (!input.getCurrentHeadCommitSha) {
        throw new RepositoryOperationInProgressError(existing);
      }

      const currentHeadCommitSha = await input.getCurrentHeadCommitSha();
      const now = new Date().toISOString();
      if (
        existing.resultCommitSha &&
        currentHeadCommitSha === existing.resultCommitSha
      ) {
        const completed = RepositoryOperationSchema.parse({
          ...existing,
          status: "succeeded",
          errorCode: undefined,
          updatedAt: now,
        });
        await writeOperation(userId, completed);
        return completed;
      }
      if (
        existing.baseCommitSha &&
        currentHeadCommitSha === existing.baseCommitSha
      ) {
        const reclaimed = RepositoryOperationSchema.parse({
          ...existing,
          status: "pending",
          resultCommitSha: undefined,
          errorCode: undefined,
          updatedAt: now,
        });
        await writeOperation(userId, reclaimed);
        return reclaimed;
      }

      await deleteOperation(userId, input.idempotencyKey);
      throw new StaleRepositoryError(currentHeadCommitSha);
    }

    const now = new Date().toISOString();
    const operation = RepositoryOperationSchema.parse({
      operationId: operationId(input.idempotencyKey),
      workspaceId: input.workspaceId,
      kind: input.kind,
      idempotencyKey: input.idempotencyKey,
      status: "pending",
      artifactIds: input.artifactIds,
      baseCommitSha: input.baseCommitSha,
      createdAt: now,
      updatedAt: now,
    });
    // withUserLock only serializes bookkeeping in this process. Store lifecycle
    // writes are advisory bookkeeping with deterministic keys; the Git ref update
    // (force:false) is the CAS of record for commits. Residual cross-instance
    // status drift is bounded and corrected by reconcile-on-reclaim (GitHub-head
    // reconciliation).
    await writeOperation(userId, operation);
    return operation;
  });
}

export async function startRepositoryOperation(
  userId: string,
  operation: RepositoryOperation
): Promise<RepositoryOperation> {
  return withUserLock(userId, async () => {
    const current = await readOperation(userId, operation.idempotencyKey);
    if (!current || current.operationId !== operation.operationId) {
      throw new Error("Repository operation is no longer current");
    }
    if (current.status !== "pending") return current;
    const running = RepositoryOperationSchema.parse({
      ...current,
      status: "running",
      updatedAt: new Date().toISOString(),
    });
    await writeOperation(userId, running);
    return running;
  });
}

export async function recordRepositoryOperationResult(
  userId: string,
  operation: RepositoryOperation,
  resultCommitSha: string
): Promise<RepositoryOperation> {
  return withUserLock(userId, async () => {
    const current = await readOperation(userId, operation.idempotencyKey);
    if (!current || current.operationId !== operation.operationId) {
      throw new Error("Repository operation is no longer current");
    }
    if (current.status !== "running") {
      throw new Error("Repository operation is not running");
    }
    const landed = RepositoryOperationSchema.parse({
      ...current,
      resultCommitSha,
      updatedAt: new Date().toISOString(),
    });
    await writeOperation(userId, landed);
    return landed;
  });
}

export async function completeRepositoryOperation(
  userId: string,
  operation: RepositoryOperation,
  resultCommitSha: string
): Promise<RepositoryOperation> {
  return withUserLock(userId, async () => {
    const current = await readOperation(userId, operation.idempotencyKey);
    if (!current || current.operationId !== operation.operationId) {
      throw new Error("Repository operation is no longer current");
    }
    if (current.status === "succeeded") return current;
    if (current.status === "failed") {
      throw new Error("Repository operation has already failed");
    }
    if (current.status !== "running") {
      throw new Error("Repository operation is not running");
    }
    const completed = RepositoryOperationSchema.parse({
      ...current,
      status: "succeeded",
      resultCommitSha,
      errorCode: undefined,
      updatedAt: new Date().toISOString(),
    });
    await writeOperation(userId, completed);
    return completed;
  });
}

export async function failRepositoryOperation(
  userId: string,
  operation: RepositoryOperation,
  errorCode: string,
  resultCommitSha?: string
): Promise<RepositoryOperation> {
  return withUserLock(userId, async () => {
    const current = await readOperation(userId, operation.idempotencyKey);
    if (!current || current.operationId !== operation.operationId) {
      throw new Error("Repository operation is no longer current");
    }
    if (current.status === "succeeded" || current.status === "failed") {
      return current;
    }
    const failed = RepositoryOperationSchema.parse({
      ...current,
      status: "failed",
      resultCommitSha: resultCommitSha ?? current.resultCommitSha,
      errorCode,
      updatedAt: new Date().toISOString(),
    });
    await writeOperation(userId, failed);
    return failed;
  });
}
