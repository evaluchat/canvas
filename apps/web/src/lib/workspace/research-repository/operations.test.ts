import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const items = new Map<string, unknown>();
  const key = (namespace: string[], itemKey: string) =>
    `${namespace.join("/")}:${itemKey}`;
  const store = {
    getItem: vi.fn(async (namespace: string[], itemKey: string) => {
      const value = items.get(key(namespace, itemKey));
      return value === undefined ? undefined : { value };
    }),
    putItem: vi.fn(
      async (namespace: string[], itemKey: string, value: unknown) => {
        items.set(key(namespace, itemKey), structuredClone(value));
      }
    ),
    deleteItem: vi.fn(async (namespace: string[], itemKey: string) => {
      items.delete(key(namespace, itemKey));
    }),
  };
  return {
    items,
    store,
    Client: vi.fn(function ClientMock() {
      return { store };
    }),
  };
});

vi.mock("@langchain/langgraph-sdk", () => ({ Client: harness.Client }));
vi.mock("@/constants", () => ({ LANGGRAPH_API_URL: "http://langgraph" }));

import {
  claimRepositoryOperation,
  completeRepositoryOperation,
  failRepositoryOperation,
  recordRepositoryOperationResult,
  RepositoryOperationInProgressError,
  repositoryOperationsNamespace,
  startRepositoryOperation,
} from "./operations";
import { StaleRepositoryError } from "./git-adapter";
import type { RepositoryOperation } from "@opencanvas/shared/research-repository";

const baseCommitSha = "a".repeat(40);
const resultCommitSha = "b".repeat(40);
const claim = {
  workspaceId: "workspace-one",
  kind: "commit" as const,
  idempotencyKey: "idempotency-key-0001",
  artifactIds: ["index"],
  baseCommitSha,
};

function storedOperation(): RepositoryOperation {
  return structuredClone([...harness.items.values()][0]) as RepositoryOperation;
}

function replaceStoredOperation(operation: RepositoryOperation): void {
  const key = [...harness.items.keys()][0];
  harness.items.set(key, structuredClone(operation));
}

function expire(operation: RepositoryOperation): RepositoryOperation {
  return {
    ...operation,
    updatedAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
  };
}

describe("repository operation Store", () => {
  beforeEach(() => {
    harness.items.clear();
    for (const method of Object.values(harness.store)) method.mockClear();
  });

  it("stores operations in the per-user namespace without file text", async () => {
    await claimRepositoryOperation("user-1", {
      ...claim,
      content: "must never be retained",
      path: "index.md",
      commitMessage: "must never be retained",
    } as typeof claim);

    expect(repositoryOperationsNamespace("user-1")).toEqual([
      "github_research_operations",
      "user-1",
    ]);
    const stored = JSON.stringify([...harness.items.values()]);
    expect(stored).not.toContain("must never be retained");
    expect(stored).not.toContain("index.md");
  });

  it("replays a succeeded idempotency key with the original result", async () => {
    const pending = await claimRepositoryOperation("user-1", claim);
    const running = await startRepositoryOperation("user-1", pending);
    const landed = await recordRepositoryOperationResult(
      "user-1",
      running,
      resultCommitSha
    );
    const completed = await completeRepositoryOperation(
      "user-1",
      landed,
      resultCommitSha
    );

    await expect(claimRepositoryOperation("user-1", claim)).resolves.toEqual(
      completed
    );
    expect(harness.items.size).toBe(1);
  });

  it("serializes concurrent same-key claims to one operation record", async () => {
    const results = await Promise.allSettled([
      claimRepositoryOperation("user-1", claim),
      claimRepositoryOperation("user-1", claim),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    );
    expect(rejected?.reason).toBeInstanceOf(RepositoryOperationInProgressError);
    const fulfilled = results.find(
      (result): result is PromiseFulfilledResult<RepositoryOperation> =>
        result.status === "fulfilled"
    );
    expect(rejected?.reason.operation.operationId).toBe(
      fulfilled?.value.operationId
    );
    expect(fulfilled?.value.operationId).toMatch(/^op_[0-9a-f]{16}$/);
    expect(harness.items.size).toBe(1);
    expect(harness.store.putItem).toHaveBeenCalledTimes(1);
  });

  it("completes a stale landed operation when the branch is at its result", async () => {
    const pending = await claimRepositoryOperation("user-1", claim);
    replaceStoredOperation(
      expire({ ...pending, resultCommitSha } as RepositoryOperation)
    );

    const reclaimed = await claimRepositoryOperation("user-1", {
      ...claim,
      getCurrentHeadCommitSha: vi.fn().mockResolvedValue(resultCommitSha),
    });

    expect(reclaimed).toMatchObject({
      operationId: pending.operationId,
      status: "succeeded",
      resultCommitSha,
    });
    expect(storedOperation().status).toBe("succeeded");
  });

  it("replays a failed operation with its landed commit result", async () => {
    const pending = await claimRepositoryOperation("user-1", claim);
    const running = await startRepositoryOperation("user-1", pending);
    const landed = await recordRepositoryOperationResult(
      "user-1",
      running,
      resultCommitSha
    );
    const failed = await failRepositoryOperation(
      "user-1",
      landed,
      "COMMIT_LANDED_HEAD_UPDATE_FAILED",
      resultCommitSha
    );

    await expect(claimRepositoryOperation("user-1", claim)).resolves.toEqual(
      failed
    );
    expect(failed).toMatchObject({ status: "failed", resultCommitSha });
    expect(harness.items.size).toBe(1);
  });

  it("reclaims a stale operation when the branch is still at its base", async () => {
    const pending = await claimRepositoryOperation("user-1", claim);
    replaceStoredOperation(expire(pending));

    const reclaimed = await claimRepositoryOperation("user-1", {
      ...claim,
      getCurrentHeadCommitSha: vi.fn().mockResolvedValue(baseCommitSha),
    });
    const running = await startRepositoryOperation("user-1", reclaimed);

    expect(reclaimed).toMatchObject({
      operationId: pending.operationId,
      status: "pending",
    });
    expect(running.status).toBe("running");
  });

  it("does not persist a stale reclaim so the next claim is fresh", async () => {
    const pending = await claimRepositoryOperation("user-1", claim);
    replaceStoredOperation(expire(pending));

    await expect(
      claimRepositoryOperation("user-1", {
        ...claim,
        getCurrentHeadCommitSha: vi.fn().mockResolvedValue("c".repeat(40)),
      })
    ).rejects.toBeInstanceOf(StaleRepositoryError);
    expect(harness.items.size).toBe(0);

    const retry = await claimRepositoryOperation("user-1", claim);
    expect(retry.status).toBe("pending");
  });

  it("retries a previously failed stale operation under the same key", async () => {
    const pending = await claimRepositoryOperation("user-1", claim);
    replaceStoredOperation({
      ...pending,
      status: "failed",
      errorCode: "STALE_REPOSITORY",
    });

    const retry = await claimRepositoryOperation("user-1", claim);
    expect(retry.status).toBe("pending");
    expect(retry.errorCode).toBeUndefined();
  });
});
