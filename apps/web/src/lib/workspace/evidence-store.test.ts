import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const items = new Map<string, any>();
  const key = (namespace: string[], name: string) =>
    `${namespace.join("/")}:${name}`;
  const client = {
    store: {
      getItem: vi.fn(async (namespace: string[], name: string) => {
        const value = items.get(key(namespace, name));
        return value === undefined
          ? undefined
          : { value: structuredClone(value) };
      }),
      putItem: vi.fn(
        async (namespace: string[], name: string, value: unknown) => {
          items.set(key(namespace, name), structuredClone(value));
        }
      ),
      deleteItem: vi.fn(async (namespace: string[], name: string) => {
        items.delete(key(namespace, name));
      }),
    },
    threads: {
      get: vi.fn(async () => {
        throw new Error("No existing thread expected");
      }),
    },
  };
  return {
    items,
    client,
    Client: vi.fn(function ClientMock() {
      return client;
    }),
  };
});

vi.mock("@langchain/langgraph-sdk", () => ({ Client: harness.Client }));
vi.mock("@/constants", () => ({ LANGGRAPH_API_URL: "http://langgraph" }));
vi.mock("@/lib/teaching/invitation-helpers", () => ({
  INVITE_EMAIL_GAP_MS: 0,
  findUserByEmail: vi.fn(async () => null),
  inviteWorkspaceParticipant: vi.fn(async () => undefined),
  sleep: async () => undefined,
}));

import {
  claimEvidenceSubmission,
  createEvidenceThread,
  createMethodWorkspaceItem,
  createWorkspaceItem,
  WorkspaceItemNotFoundError,
  WorkspaceEvidenceAlreadySubmittedError,
} from "./store";

function manifestFor(userId: string): any {
  return harness.items.get(`workspace_items/${userId}:manifest`);
}

function conclude(itemId: string): void {
  const manifest = manifestFor("user-1");
  manifest.items[itemId].run = {
    id: "run-1",
    status: "in_progress",
    launchedAt: "2026-08-18T10:30:00.000Z",
    methodId: "ai-assisted-essay",
    methodVersion: "0.1.0",
    profileId: "canonical-constrained-dialogue",
    apparatusConfiguration: {
      ai_assistance: true,
      ai_canvas_actions: true,
      drafting_gate: "discussion-first",
      threshold: 4,
      tracking: true,
    },
    assignment: {
      title: "Essay",
      course: "Course",
      dueDate: "2026-09-01",
      wordTarget: 500,
      prompt: "Write.",
      agentInstructions: "",
      group: "Group",
    },
    participants: [],
  };
  manifest.items[itemId].submission = {
    status: "submitted",
    values: {},
    resolvedMarkdown: "",
    submittedAt: "2026-08-18T11:00:00.000Z",
  };
  harness.items.set(`workspace_items/user-1:manifest`, manifest);
}

describe("Evidence workspace threads", () => {
  beforeEach(() => {
    harness.items.clear();
    vi.restoreAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ thread_id: "evidence-thread-1" }), {
            status: 201,
            headers: { "content-type": "application/json" },
          })
      )
    );
  });

  it("creates a LangGraph evidence thread and stores only its reference on the item", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    conclude(item.id);

    const result = await createEvidenceThread("user-1", item.id);
    const manifest = manifestFor("user-1");

    expect(result.threadId).toBe("evidence-thread-1");
    expect(result.item.evidenceThreads).toEqual([
      {
        threadId: "evidence-thread-1",
        status: "draft",
        templateVersion: "1.0.0",
      },
    ]);
    expect(manifest.items[item.id].evidenceThreads).toHaveLength(1);
    expect(manifest.items["evidence-thread-1"]).toBeUndefined();
    expect(Object.keys(manifest.items)).not.toContain("evidence-thread-1");

    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledWith(
      "http://langgraph/threads",
      expect.objectContaining({ method: "POST" })
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.metadata).toMatchObject({
      user_id: "user-1",
      workspace_item_id: item.id,
      evidence: { method_id: "ai-assisted-essay" },
    });
  });

  it("rejects another owner and drafts without a concluded method run", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    await expect(
      createEvidenceThread("user-2", item.id)
    ).rejects.toBeInstanceOf(WorkspaceItemNotFoundError);
    await expect(createEvidenceThread("user-1", item.id)).rejects.toThrow(
      "Evidence requires a concluded method run"
    );

    const nonMethod = await createWorkspaceItem(
      "user-1",
      "evaluchat-getting-started"
    );
    await expect(
      createEvidenceThread("user-1", nonMethod.id)
    ).rejects.toBeInstanceOf(WorkspaceItemNotFoundError);
  });

  it("claims an evidence submission under the user lock and rejects duplicates", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    conclude(item.id);
    const result = await createEvidenceThread("user-1", item.id);
    const claimed = await claimEvidenceSubmission(
      "user-1",
      item.id,
      result.threadId,
      "submission-key"
    );
    expect(claimed).toMatchObject({
      status: "submitting",
      submissionKey: "submission-key",
    });
    expect(
      manifestFor("user-1").items[item.id].evidenceThreads[0]
    ).toMatchObject({
      status: "submitting",
      submissionKey: "submission-key",
    });
    manifestFor("user-1").items[item.id].evidenceThreads[0].status =
      "submitted";
    await expect(
      claimEvidenceSubmission("user-1", item.id, result.threadId, "other-key")
    ).rejects.toBeInstanceOf(WorkspaceEvidenceAlreadySubmittedError);
  });
});
