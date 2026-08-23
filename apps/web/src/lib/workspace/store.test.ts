import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const items = new Map<string, any>();
  const threads = new Map<string, any>();
  const storeKey = (namespace: string[], key: string) =>
    `${namespace.join("/")}:${key}`;

  const state = {
    items,
    threads,
    get manifest() {
      return items.get("workspace_items/user-1:manifest");
    },
    set manifest(value: any) {
      if (value === undefined) items.delete("workspace_items/user-1:manifest");
      else items.set("workspace_items/user-1:manifest", value);
    },
  };
  const hooks = {
    onParticipantManifestWrite: undefined as (() => void) | undefined,
    onLockPut: undefined as (() => void | Promise<void>) | undefined,
  };

  const client = {
    store: {
      getItem: vi.fn(async (namespace: string[], key: string) => {
        const value = items.get(storeKey(namespace, key));
        return value !== undefined
          ? { value: structuredClone(value) }
          : undefined;
      }),
      putItem: vi.fn(
        async (
          namespace: string[],
          key: string,
          value: any,
          _options?: { ttl?: number | null }
        ) => {
          if (key === "lock") {
            await hooks.onLockPut?.();
          }
          items.set(storeKey(namespace, key), structuredClone(value));
          if (
            namespace.join("/") === "workspace_items/user-2" &&
            key === "manifest"
          ) {
            hooks.onParticipantManifestWrite?.();
          }
        }
      ),
      deleteItem: vi.fn(async (namespace: string[], key: string) => {
        items.delete(storeKey(namespace, key));
      }),
    },
    threads: {
      get: vi.fn(async (id: string) => {
        const thread = threads.get(id);
        if (thread) return thread;
        throw Object.assign(new Error("Not found"), { status: 404 });
      }),
      delete: vi.fn(async (id: string) => {
        if (!threads.has(id)) {
          throw Object.assign(new Error("Not found"), { status: 404 });
        }
        threads.delete(id);
      }),
      update: vi.fn(async (id: string, payload: { metadata?: any }) => {
        const thread = threads.get(id) || { metadata: {} };
        threads.set(id, {
          ...thread,
          metadata: { ...thread.metadata, ...payload.metadata },
        });
      }),
      updateState: vi.fn(async () => undefined),
      getState: vi.fn(async (id: string) => {
        const thread = threads.get(id);
        return { values: thread?.values || {} };
      }),
      getHistory: vi.fn(async () => []),
    },
  };

  return {
    state,
    hooks,
    client,
    Client: vi.fn(function ClientMock() {
      return client;
    }),
    findUserByEmail: vi.fn(
      async (_email?: string): Promise<{ id: string; email: string } | null> =>
        null
    ),
    inviteWorkspaceParticipant: vi.fn(async () => undefined),
    readGithubResearchCredentials: vi.fn(),
    createGithubRepositoryBranch: vi.fn(),
    getGithubInstallationRepository: vi.fn(),
    getGithubRepositoryBranchHead: vi.fn(),
  };
});

vi.mock("@langchain/langgraph-sdk", () => ({ Client: harness.Client }));
vi.mock("@/constants", () => ({ LANGGRAPH_API_URL: "http://langgraph" }));
vi.mock("@/lib/teaching/invitation-helpers", () => ({
  findUserByEmail: harness.findUserByEmail,
  inviteWorkspaceParticipant: harness.inviteWorkspaceParticipant,
  INVITE_EMAIL_GAP_MS: 0,
  // Yield so lock-retry loops do not starve deferred work / timers.
  sleep: async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  },
}));
vi.mock("./research-repository/credentials", () => ({
  readGithubResearchCredentials: harness.readGithubResearchCredentials,
}));
vi.mock("./research-repository/github-app", () => ({
  createGithubRepositoryBranch: harness.createGithubRepositoryBranch,
  getGithubInstallationRepository: harness.getGithubInstallationRepository,
  getGithubRepositoryBranchHead: harness.getGithubRepositoryBranchHead,
}));

import {
  createResearchRepositoryItem,
  createWorkspaceItem,
  createMethodWorkspaceItem,
  deleteWorkspaceItem,
  ensureDefaultWorkspaceItem,
  getMethodParticipantReview,
  getResearchRepositoryStatus,
  getMethodRun,
  getWorkspaceItem,
  listWorkspaceItems,
  pendingInviteNamespace,
  inviteLockId,
  resolveMethodTrackingAccess,
  submitWorkspaceForm,
  WorkspaceItemNotFoundError,
  WorkspaceLockTimeoutError,
  WorkspaceThreadOwnershipError,
  reconcileWorkspaceItemThread,
  ResearchRepositoryBindingError,
  updateResearchRepositoryBindingHead,
  workspaceLockAcquireTimeoutMs,
  workspaceLockRetryDelayMs,
  workspaceLockTtlMs,
} from "./store";

const defaultLockRetryDelayMs = workspaceLockRetryDelayMs.value;
const defaultLockAcquireTimeoutMs = workspaceLockAcquireTimeoutMs.value;
const defaultLockTtlMs = workspaceLockTtlMs.value;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await delay(5);
  }
}

describe("workspace item lifecycle", () => {
  beforeEach(() => {
    harness.state.items.clear();
    harness.state.threads.clear();
    harness.hooks.onParticipantManifestWrite = undefined;
    harness.hooks.onLockPut = undefined;
    harness.findUserByEmail.mockReset();
    harness.inviteWorkspaceParticipant.mockReset();
    harness.findUserByEmail.mockResolvedValue(null);
    harness.inviteWorkspaceParticipant.mockResolvedValue(undefined);
    workspaceLockRetryDelayMs.value = defaultLockRetryDelayMs;
    workspaceLockAcquireTimeoutMs.value = defaultLockAcquireTimeoutMs;
    workspaceLockTtlMs.value = defaultLockTtlMs;
    vi.clearAllMocks();
  });

  it("cascades thread deletion, removes the manifest item, and clears default", async () => {
    const item = await ensureDefaultWorkspaceItem("user-1");
    expect(item).toBeDefined();
    harness.state.threads.set("thread-1", {
      metadata: { user_id: "user-1", workspace_item_id: item!.id },
    });
    await reconcileWorkspaceItemThread("user-1", item!.id, "thread-1");

    await deleteWorkspaceItem("user-1", item!.id);

    expect(harness.client.threads.delete).toHaveBeenCalledWith("thread-1");
    expect(harness.state.manifest.items[item!.id]).toBeUndefined();
    expect(harness.state.manifest.defaultItemId).toBeUndefined();
    expect(harness.state.manifest.initialized).toBe(true);
  });

  it("skips retained unusable research repositories when selecting a default item", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const created = await ensureDefaultWorkspaceItem("user-1");
    expect(created).toBeDefined();

    harness.state.manifest = {
      ...harness.state.manifest,
      defaultItemId: undefined,
      items: {
        "broken-repo": {
          id: "broken-repo",
          kind: "research_repository",
          binding: { repositoryId: 101 },
        },
        ...harness.state.manifest.items,
      },
    };

    const item = await ensureDefaultWorkspaceItem("user-1");
    expect(item?.id).toBe(created!.id);
    expect(harness.state.manifest.defaultItemId).toBe(created!.id);
    expect(spy.mock.calls.flat().join(" ")).toContain("broken-repo");
    spy.mockRestore();
  });

  it("does not recreate the original item after explicit deletion", async () => {
    const item = await ensureDefaultWorkspaceItem("user-1");
    await deleteWorkspaceItem("user-1", item!.id);

    await expect(ensureDefaultWorkspaceItem("user-1")).resolves.toBeUndefined();
  });

  it("treats a missing thread as an idempotent cascade", async () => {
    const item = await ensureDefaultWorkspaceItem("user-1");
    harness.state.manifest.items[item!.id].threadId = "missing-thread";

    await expect(
      deleteWorkspaceItem("user-1", item!.id)
    ).resolves.toBeUndefined();
    expect(harness.state.manifest.items[item!.id]).toBeUndefined();
  });

  it("rejects a different user before changing the manifest", async () => {
    const item = await ensureDefaultWorkspaceItem("user-1");

    await expect(
      deleteWorkspaceItem("user-2", item!.id)
    ).rejects.toBeInstanceOf(WorkspaceItemNotFoundError);
    expect(harness.state.manifest.items[item!.id]).toBeDefined();
  });

  it("rejects a thread whose ownership markers do not match", async () => {
    const item = await ensureDefaultWorkspaceItem("user-1");
    harness.state.manifest.items[item!.id].threadId = "foreign-thread";
    harness.state.threads.set("foreign-thread", {
      metadata: { user_id: "user-2", workspace_item_id: item!.id },
    });

    await expect(
      deleteWorkspaceItem("user-1", item!.id)
    ).rejects.toBeInstanceOf(WorkspaceThreadOwnershipError);
    expect(harness.state.manifest.items[item!.id]).toBeDefined();
  });

  it("rejects the assignment brief as a selectable workspace starter", async () => {
    await expect(
      createWorkspaceItem("user-1", "evaluchat-assignment-brief")
    ).rejects.toThrow(/unsupported workspace template/i);
  });

  it("does not partially write invalid method-brief values or allow another owner", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    const manifestWrites = () =>
      harness.client.store.putItem.mock.calls.filter(
        (call) => call[1] === "manifest"
      ).length;
    const writesBefore = manifestWrites();
    await expect(
      submitWorkspaceForm("user-1", item.id, {
        title: "",
        participants: "not-an-email",
      })
    ).rejects.toThrow("invalid");
    expect(manifestWrites()).toBe(writesBefore);
    await expect(
      submitWorkspaceForm("user-2", item.id, {})
    ).rejects.toBeInstanceOf(WorkspaceItemNotFoundError);
  });

  it("attaches a thread to method drafts for the workspace chat", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.state.threads.set("thread-1", {
      metadata: { user_id: "user-1", workspace_item_id: item.id },
    });
    const attached = await reconcileWorkspaceItemThread(
      "user-1",
      item.id,
      "thread-1"
    );
    expect(attached.kind).toBe("method");
    expect(attached.kind === "method" && attached.threadId).toBe("thread-1");
  });

  it("creates a Form-backed method draft from a built-in method id", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    expect(item.kind).toBe("method");
    if (item.kind !== "method") return;
    expect(item.templateSnapshot.kind).toBe("form");
    expect(item.templateSnapshot.templateId).toBe("evaluchat-assignment-brief");
    expect(item.methodSource).toEqual({
      id: "ai-assisted-essay",
      version: expect.any(String),
      title: expect.stringMatching(/AI-assisted essay/i),
      description: expect.any(String),
      url: "https://research.evaluchat.org/methods/ai-assisted-essay.html",
    });
    expect(item.profileId).toBe("canonical-constrained-dialogue");
    expect(item.run).toBeUndefined();
    expect(item.threadId).toBeUndefined();
  });

  it("fills method title and public URL when listing an older draft", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    const stored = harness.state.manifest;
    stored.items[item.id].methodSource = {
      id: "ai-assisted-essay",
      version: item.methodSource.version,
      url: "https://research.evaluchat.org/ai-assisted-essay.html",
    };
    harness.state.manifest = stored;

    const listed = await listWorkspaceItems("user-1");
    const draft = listed.find((candidate) => candidate.id === item.id);
    expect(draft?.kind).toBe("method");
    if (draft?.kind !== "method") return;
    expect(draft.methodSource.title).toMatch(/AI-assisted essay/i);
    expect(draft.methodSource.url).toBe(
      "https://research.evaluchat.org/methods/ai-assisted-essay.html"
    );
  });

  it("rejects unknown method ids", async () => {
    await expect(
      createMethodWorkspaceItem("user-1", "not-a-builtin-method")
    ).rejects.toThrow(/unsupported method/i);
  });

  it("stores pending invites under a LangGraph-safe namespace", () => {
    const namespace = pendingInviteNamespace("cronjev@outlook.com");
    expect(namespace[0]).toBe("workspace_method_invites");
    expect(namespace.every((label) => !label.includes("."))).toBe(true);
    expect(pendingInviteNamespace("cronjev@outlook.com")).toEqual(
      pendingInviteNamespace("Cronjev@Outlook.Com")
    );

    const lockId = inviteLockId("cronjevh+test1708@gmail.com");
    expect(lockId).not.toMatch(/[.@+]/);
    expect(lockId).toBe("invite_cronjevh_test1708_gmail_com");
  });
});

const repositorySha = "a".repeat(40);
const workspaceBranchSha = "b".repeat(40);

function connectedGithubCredentials(repositoryIds = [101]) {
  return {
    tokens: { accessToken: "ghu_access" },
    installationId: 99,
    repositoryIds,
    displayMetadata: {
      githubUserId: 7,
      login: "octocat",
      repositories: [{ id: 101, nameWithOwner: "octocat/private" }],
    },
  };
}

function repositoryWorkspaceItem(layoutVersion = "1.0") {
  const now = "2026-08-22T10:00:00.000Z";
  return {
    id: "wi_repository",
    ownerId: "user-1",
    kind: "research_repository" as const,
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
    binding: {
      provider: "github" as const,
      repositoryId: 101,
      installationId: 99,
      branch: "evaluchat/workspace" as const,
      layoutVersion,
      headCommitSha: repositorySha,
      boundAt: now,
    },
  };
}

describe("research repository workspace items", () => {
  beforeEach(() => {
    harness.state.items.clear();
    harness.state.threads.clear();
    harness.readGithubResearchCredentials.mockReset();
    harness.createGithubRepositoryBranch.mockReset();
    harness.getGithubInstallationRepository.mockReset();
    harness.getGithubRepositoryBranchHead.mockReset();
    harness.readGithubResearchCredentials.mockResolvedValue(
      connectedGithubCredentials()
    );
    harness.getGithubInstallationRepository.mockResolvedValue({
      id: 101,
      name: "private",
      nameWithOwner: "octocat/private",
      owner: "octocat",
      private: true,
      defaultBranch: "main",
    });
    harness.getGithubRepositoryBranchHead.mockResolvedValue(workspaceBranchSha);
    workspaceLockRetryDelayMs.value = defaultLockRetryDelayMs;
    workspaceLockAcquireTimeoutMs.value = defaultLockAcquireTimeoutMs;
    workspaceLockTtlMs.value = defaultLockTtlMs;
  });

  it("binds a private repository from the user's installation", async () => {
    const item = await createResearchRepositoryItem("user-1", {
      repositoryId: 101,
      installationId: 99,
    });

    expect(item).toMatchObject({
      ownerId: "user-1",
      kind: "research_repository",
      status: "active",
      binding: {
        provider: "github",
        repositoryId: 101,
        installationId: 99,
        branch: "evaluchat/workspace",
        layoutVersion: "1.0",
        headCommitSha: workspaceBranchSha,
      },
    });
    expect(item.binding.boundAt).toBe(item.createdAt);
    expect(harness.getGithubRepositoryBranchHead).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ defaultBranch: "main" }),
      "evaluchat/workspace"
    );
    expect(harness.createGithubRepositoryBranch).not.toHaveBeenCalled();
    expect(harness.state.manifest.items[item.id]).toEqual(item);
  });

  it("creates a missing managed branch from the default head before binding", async () => {
    harness.getGithubRepositoryBranchHead
      .mockRejectedValueOnce(
        Object.assign(new Error("Not found"), { status: 404 })
      )
      .mockResolvedValueOnce(repositorySha)
      .mockResolvedValueOnce(workspaceBranchSha);

    const item = await createResearchRepositoryItem("user-1", {
      repositoryId: 101,
      installationId: 99,
    });

    expect(harness.getGithubRepositoryBranchHead).toHaveBeenNthCalledWith(
      1,
      99,
      expect.objectContaining({ defaultBranch: "main" }),
      "evaluchat/workspace"
    );
    expect(harness.getGithubRepositoryBranchHead).toHaveBeenNthCalledWith(
      2,
      99,
      expect.objectContaining({ defaultBranch: "main" }),
      "main"
    );
    expect(harness.createGithubRepositoryBranch).toHaveBeenCalledWith(
      99,
      expect.objectContaining({ owner: "octocat", name: "private" }),
      "evaluchat/workspace",
      repositorySha
    );
    expect(harness.getGithubRepositoryBranchHead).toHaveBeenNthCalledWith(
      3,
      99,
      expect.objectContaining({ defaultBranch: "main" }),
      "evaluchat/workspace"
    );
    expect(item.binding.headCommitSha).toBe(workspaceBranchSha);
    expect(harness.state.manifest.items[item.id]).toEqual(item);
  });

  it.each([409, 422])(
    "binds after a %i managed branch creation race",
    async (status) => {
      const rereadSha = "c".repeat(40);
      harness.getGithubRepositoryBranchHead
        .mockRejectedValueOnce(
          Object.assign(new Error("Not found"), { status: 404 })
        )
        .mockResolvedValueOnce(repositorySha)
        .mockResolvedValueOnce(rereadSha);
      harness.createGithubRepositoryBranch.mockRejectedValue(
        Object.assign(new Error("Branch already exists"), { status })
      );

      const item = await createResearchRepositoryItem("user-1", {
        repositoryId: 101,
        installationId: 99,
      });

      expect(item.binding.headCommitSha).toBe(rereadSha);
      expect(harness.getGithubRepositoryBranchHead).toHaveBeenCalledTimes(3);
      expect(harness.state.manifest.items[item.id]).toEqual(item);
    }
  );

  it.each([409, 422])(
    "rethrows the original %i creation error when the branch reread fails",
    async (status) => {
      const creationError = Object.assign(new Error("Branch creation failed"), {
        status,
      });
      const rereadError = Object.assign(new Error("GitHub unavailable"), {
        status: 503,
      });
      harness.getGithubRepositoryBranchHead
        .mockRejectedValueOnce(
          Object.assign(new Error("Not found"), { status: 404 })
        )
        .mockResolvedValueOnce(repositorySha)
        .mockRejectedValueOnce(rereadError);
      harness.createGithubRepositoryBranch.mockRejectedValue(creationError);

      await expect(
        createResearchRepositoryItem("user-1", {
          repositoryId: 101,
          installationId: 99,
        })
      ).rejects.toBe(creationError);
      expect(harness.getGithubRepositoryBranchHead).toHaveBeenCalledTimes(3);
      expect(harness.state.manifest).toBeUndefined();
    }
  );

  it("does not bind when managed branch resolution fails unexpectedly", async () => {
    const failure = Object.assign(new Error("GitHub unavailable"), {
      status: 503,
    });
    harness.getGithubRepositoryBranchHead.mockRejectedValue(failure);

    await expect(
      createResearchRepositoryItem("user-1", {
        repositoryId: 101,
        installationId: 99,
      })
    ).rejects.toBe(failure);
    expect(harness.createGithubRepositoryBranch).not.toHaveBeenCalled();
    expect(harness.state.manifest).toBeUndefined();
  });

  it("rejects a public repository", async () => {
    harness.getGithubInstallationRepository.mockResolvedValue({
      id: 101,
      name: "public",
      nameWithOwner: "octocat/public",
      owner: "octocat",
      private: false,
      defaultBranch: "main",
    });

    await expect(
      createResearchRepositoryItem("user-1", {
        repositoryId: 101,
        installationId: 99,
      })
    ).rejects.toMatchObject({ code: "repository_public" });
    expect(harness.getGithubRepositoryBranchHead).not.toHaveBeenCalled();
    expect(harness.state.manifest).toBeUndefined();
  });

  it("rejects a repository outside the user's installation", async () => {
    harness.readGithubResearchCredentials.mockResolvedValue(
      connectedGithubCredentials([])
    );

    await expect(
      createResearchRepositoryItem("user-1", {
        repositoryId: 101,
        installationId: 99,
      })
    ).rejects.toMatchObject({ code: "repository_unavailable" });
    expect(harness.getGithubInstallationRepository).not.toHaveBeenCalled();
  });

  it("rejects an installation the user does not own", async () => {
    await expect(
      createResearchRepositoryItem("user-1", {
        repositoryId: 101,
        installationId: 100,
      })
    ).rejects.toMatchObject({ code: "installation_unavailable" });
    expect(harness.getGithubInstallationRepository).not.toHaveBeenCalled();
  });

  it("allows only one item to bind a repository", async () => {
    await createResearchRepositoryItem("user-1", {
      repositoryId: 101,
      installationId: 99,
    });

    await expect(
      createResearchRepositoryItem("user-1", {
        repositoryId: 101,
        installationId: 99,
      })
    ).rejects.toBeInstanceOf(ResearchRepositoryBindingError);
    expect(harness.getGithubRepositoryBranchHead).toHaveBeenCalledTimes(1);
    expect(Object.keys(harness.state.manifest.items)).toHaveLength(1);
  });

  it("normalises stored repository items even while the flag is off", async () => {
    const item = await createResearchRepositoryItem("user-1", {
      repositoryId: 101,
      installationId: 99,
    });
    vi.stubEnv("GITHUB_RESEARCH_WORKSPACES_ENABLED", "false");

    await expect(listWorkspaceItems("user-1")).resolves.toEqual([item]);
    vi.unstubAllEnvs();
  });

  it("reports a ready repository from the managed branch head", async () => {
    harness.getGithubRepositoryBranchHead.mockResolvedValue(workspaceBranchSha);

    await expect(
      getResearchRepositoryStatus("user-1", repositoryWorkspaceItem())
    ).resolves.toMatchObject({
      workspaceId: "wi_repository",
      repositoryId: 101,
      state: "ready",
      layoutVersion: "1.0",
      headCommitSha: workspaceBranchSha,
    });
  });

  it("updates only the repository binding head during reconciliation", async () => {
    const item = repositoryWorkspaceItem();
    harness.state.manifest = {
      initialized: true,
      items: { [item.id]: item },
    };
    const reconciledHead = "c".repeat(40);

    const updated = await updateResearchRepositoryBindingHead(
      "user-1",
      item.id,
      reconciledHead
    );

    expect(updated.binding.headCommitSha).toBe(reconciledHead);
    expect(harness.state.manifest.items[item.id]).toEqual(updated);
    expect(JSON.stringify(harness.state.manifest)).not.toContain("content");
  });

  it("projects a deleted repository as unavailable", async () => {
    harness.getGithubInstallationRepository.mockRejectedValue(
      Object.assign(new Error("Not Found"), { status: 404 })
    );

    await expect(
      getResearchRepositoryStatus("user-1", repositoryWorkspaceItem())
    ).resolves.toMatchObject({
      state: "blocked",
      reason: "repository_deleted",
    });
  });

  it("blocks a repository that became public", async () => {
    harness.getGithubInstallationRepository.mockResolvedValue({
      id: 101,
      name: "private",
      nameWithOwner: "octocat/private",
      owner: "octocat",
      private: false,
      defaultBranch: "main",
    });

    await expect(
      getResearchRepositoryStatus("user-1", repositoryWorkspaceItem())
    ).resolves.toMatchObject({
      state: "read_only",
      reason: "repository_public",
      readonlyReason: "repository_public",
    });
  });

  it("blocks a repository when the managed branch was deleted", async () => {
    harness.getGithubRepositoryBranchHead.mockRejectedValue(
      Object.assign(new Error("Not found"), { status: 404 })
    );

    await expect(
      getResearchRepositoryStatus("user-1", repositoryWorkspaceItem())
    ).resolves.toMatchObject({
      state: "blocked",
      reason: "branch_deleted",
    });
  });

  it("retains an unusable research repository record across writes", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const item = await createResearchRepositoryItem("user-1", {
      repositoryId: 101,
      installationId: 99,
    });
    harness.state.manifest = {
      ...harness.state.manifest,
      items: {
        ...harness.state.manifest.items,
        [item.id]: {
          id: item.id,
          kind: "research_repository",
          binding: { repositoryId: 101 },
        },
      },
    };

    harness.readGithubResearchCredentials.mockResolvedValue(
      connectedGithubCredentials([101, 102])
    );
    harness.getGithubInstallationRepository.mockResolvedValue({
      id: 102,
      name: "other",
      nameWithOwner: "octocat/other",
      owner: "octocat",
      private: true,
      defaultBranch: "main",
    });
    await createResearchRepositoryItem("user-1", {
      repositoryId: 102,
      installationId: 99,
    });

    expect(harness.state.manifest.items[item.id]).toMatchObject({
      id: item.id,
      kind: "research_repository",
      unusable: true,
      binding: { repositoryId: 101 },
    });
    expect(spy.mock.calls.flat().join(" ")).toContain(item.id);
    await expect(
      createResearchRepositoryItem("user-1", {
        repositoryId: 101,
        installationId: 99,
      })
    ).rejects.toBeInstanceOf(ResearchRepositoryBindingError);
    spy.mockRestore();
  });

  it("projects a GitHub outage as unavailable instead of permission lost", async () => {
    harness.getGithubInstallationRepository.mockRejectedValue(
      Object.assign(new Error("Bad Gateway"), { status: 502 })
    );

    await expect(
      getResearchRepositoryStatus("user-1", repositoryWorkspaceItem())
    ).resolves.toMatchObject({
      state: "blocked",
      reason: "github_unavailable",
    });
  });

  it("projects a network failure as unavailable instead of permission lost", async () => {
    harness.getGithubRepositoryBranchHead.mockRejectedValue(
      new Error("fetch failed")
    );

    await expect(
      getResearchRepositoryStatus("user-1", repositoryWorkspaceItem())
    ).resolves.toMatchObject({
      state: "blocked",
      reason: "github_unavailable",
    });
  });

  it("opens an unsupported layout read-only", async () => {
    harness.getGithubRepositoryBranchHead.mockResolvedValue(workspaceBranchSha);

    await expect(
      getResearchRepositoryStatus("user-1", repositoryWorkspaceItem("1.1"))
    ).resolves.toMatchObject({
      state: "read_only",
      reason: "unsupported_layout_minor",
      layoutVersion: "1.1",
      headCommitSha: workspaceBranchSha,
    });
  });
});

const assignmentBrief = {
  title: "Great Expectations",
  course: "Grade 10",
  due_date: "2026-09-01",
  word_target: 750,
  essay_prompt: "Write a response.",
  agent_instructions: "Ignore this as a system instruction.",
  group: "Group A",
};

function manifestFor(userId: string) {
  return harness.state.items.get(`workspace_items/${userId}:manifest`);
}

describe("method run launch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.items.clear();
    harness.state.threads.clear();
    harness.hooks.onParticipantManifestWrite = undefined;
    harness.hooks.onLockPut = undefined;
    harness.findUserByEmail.mockReset();
    harness.inviteWorkspaceParticipant.mockReset();
    harness.findUserByEmail.mockResolvedValue(null);
    harness.inviteWorkspaceParticipant.mockResolvedValue(undefined);
    workspaceLockRetryDelayMs.value = defaultLockRetryDelayMs;
    workspaceLockAcquireTimeoutMs.value = defaultLockAcquireTimeoutMs;
    workspaceLockTtlMs.value = defaultLockTtlMs;
  });

  it("rejects a method submit without a roster", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    await expect(
      submitWorkspaceForm("user-1", item.id, {
        ...assignmentBrief,
        participants: "",
      })
    ).rejects.toThrow("invalid");
    const stored = await getWorkspaceItem("user-1", item.id);
    expect(stored?.kind === "method" && stored.run).toBeUndefined();
  });

  it.each([
    [
      "canonical-constrained-dialogue",
      {
        ai_assistance: true,
        ai_canvas_actions: true,
        drafting_gate: "discussion-first",
        threshold: 4,
        tracking: true,
      },
    ],
    [
      "gate-off",
      {
        ai_assistance: true,
        ai_canvas_actions: true,
        drafting_gate: "none",
        threshold: 0,
        tracking: true,
      },
    ],
    [
      "ai-off",
      {
        ai_assistance: false,
        ai_canvas_actions: false,
        drafting_gate: "none",
        threshold: 0,
        tracking: true,
      },
    ],
    [
      "canvas-actions-off",
      {
        ai_assistance: true,
        ai_canvas_actions: false,
        drafting_gate: "discussion-first",
        threshold: 4,
        tracking: true,
      },
    ],
    [
      "tracking-off",
      {
        ai_assistance: true,
        ai_canvas_actions: true,
        drafting_gate: "discussion-first",
        threshold: 4,
        tracking: false,
      },
    ],
  ])(
    "snapshots %s on the run and every participant item",
    async (profileId, apparatusConfiguration) => {
      const item = await createMethodWorkspaceItem(
        "user-1",
        "ai-assisted-essay"
      );
      harness.findUserByEmail.mockResolvedValue({
        id: "user-2",
        email: "a@example.com",
      });

      const result = await submitWorkspaceForm(
        "user-1",
        item.id,
        { ...assignmentBrief, participants: "a@example.com" },
        { profileId }
      );

      expect(result.item.kind).toBe("method");
      if (result.item.kind !== "method" || !result.item.run) {
        throw new Error("expected method run item from submitWorkspaceForm");
      }
      expect(result.item.run.profileId).toBe(profileId);
      expect(result.item.run.apparatusConfiguration).toEqual(
        apparatusConfiguration
      );

      const participantId = result.item.run.participants[0].itemId!;
      const participantManifest = manifestFor("user-2");
      expect(
        participantManifest.items[participantId].apparatusConfiguration
      ).toEqual(apparatusConfiguration);
    }
  );

  it("falls back to the canonical profile for an unknown profile id", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue({
      id: "user-2",
      email: "a@example.com",
    });

    const result = await submitWorkspaceForm(
      "user-1",
      item.id,
      { ...assignmentBrief, participants: "a@example.com" },
      { profileId: "not-a-profile" }
    );

    expect(result.item.kind).toBe("method");
    if (result.item.kind !== "method" || !result.item.run) {
      throw new Error("expected method run item from submitWorkspaceForm");
    }
    expect(result.item.run.profileId).toBe("canonical-constrained-dialogue");
    expect(result.item.run.apparatusConfiguration).toEqual({
      ai_assistance: true,
      ai_canvas_actions: true,
      drafting_gate: "discussion-first",
      threshold: 4,
      tracking: true,
    });
  });

  it("writes a participant item for an existing account and a pending invite otherwise", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockImplementation(async (email?: string) =>
      email === "a@example.com"
        ? { id: "user-2", email: "a@example.com" }
        : null
    );

    const result = await submitWorkspaceForm("user-1", item.id, {
      ...assignmentBrief,
      participants: "a@example.com, unknown@example.com",
    });
    expect(result.item.kind).toBe("method");
    if (result.item.kind !== "method" || !result.item.run) return;

    const existing = result.item.run.participants.find(
      (participant) => participant.email === "a@example.com"
    );
    const unknown = result.item.run.participants.find(
      (participant) => participant.email === "unknown@example.com"
    );
    expect(existing).toMatchObject({
      userId: "user-2",
      invitationStatus: "accepted",
      submissionStatus: "not_started",
    });
    expect(existing?.itemId).toMatch(/^wi_/);
    expect(unknown).toMatchObject({
      invitationStatus: "sent",
      submissionStatus: "not_started",
    });
    expect(unknown?.userId).toBeUndefined();
    expect(harness.inviteWorkspaceParticipant).toHaveBeenCalledWith(
      "unknown@example.com",
      { correlationId: expect.any(String) }
    );
    expect(harness.inviteWorkspaceParticipant).toHaveBeenCalledWith(
      "a@example.com",
      { correlationId: expect.any(String) }
    );

    const participantManifest = manifestFor("user-2");
    const participantItem = Object.values(participantManifest.items).find(
      (candidate: any) => candidate.kind === "method_participant"
    ) as any;
    expect(participantItem.assignment.title).toBe("Great Expectations");
    expect(participantItem.methodSource.url).toBe(
      "https://research.evaluchat.org/methods/ai-assisted-essay.html"
    );
    expect(participantItem.runId).toBe(result.item.run.id);
    expect(participantItem.operatorItemId).toBe(item.id);
    // The live shared-provider resolver uses these immutable relationship
    // fields; provider settings are deliberately not copied into the item.
    expect(participantItem).toMatchObject({
      ownerId: "user-2",
      operatorId: "user-1",
      operatorItemId: item.id,
    });
    expect(participantItem).not.toHaveProperty("apiKey");
    expect(participantItem).not.toHaveProperty("baseUrl");
  });

  it("does not deadlock a participant submit against a concurrent operator launch", async () => {
    const first = await createMethodWorkspaceItem(
      "user-1",
      "ai-assisted-essay"
    );
    const second = await createMethodWorkspaceItem(
      "user-1",
      "ai-assisted-essay"
    );
    harness.findUserByEmail.mockResolvedValue({
      id: "user-2",
      email: "a@example.com",
    });

    const launched = await submitWorkspaceForm("user-1", first.id, {
      ...assignmentBrief,
      participants: "a@example.com",
    });
    if (launched.item.kind !== "method" || !launched.item.run) return;
    const participantId = launched.item.run.participants[0].itemId!;
    const participantManifest = manifestFor("user-2");
    participantManifest.items[participantId].threadId = "thread-p";
    harness.state.threads.set("thread-p", {
      metadata: { user_id: "user-2", workspace_item_id: participantId },
    });

    let releaseThreadRead!: () => void;
    const threadRead = new Promise<void>((resolve) => {
      releaseThreadRead = resolve;
    });
    harness.client.threads.get.mockImplementationOnce(async (id: string) => {
      await threadRead;
      return harness.state.threads.get(id);
    });

    let resolveParticipantWrite!: () => void;
    const participantWritten = new Promise<void>((resolve) => {
      resolveParticipantWrite = resolve;
    });
    harness.hooks.onParticipantManifestWrite = resolveParticipantWrite;
    const participantSubmit = submitWorkspaceForm("user-2", participantId, {});
    await participantWritten;

    let resolveOperatorLookup!: () => void;
    const operatorLookup = new Promise<void>((resolve) => {
      resolveOperatorLookup = resolve;
    });
    harness.findUserByEmail.mockImplementation(async () => {
      resolveOperatorLookup();
      return { id: "user-2", email: "a@example.com" };
    });
    const operatorLaunch = submitWorkspaceForm("user-1", second.id, {
      ...assignmentBrief,
      participants: "a@example.com",
    });
    await operatorLookup;
    releaseThreadRead();

    await Promise.race([
      Promise.all([participantSubmit, operatorLaunch]),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("workspace user locks deadlocked")),
          1000
        )
      ),
    ]);
  });

  it("puts the assignment in the operator workspace when they invite themselves", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue({
      id: "user-1",
      email: "cronjev@outlook.com",
    });
    await submitWorkspaceForm("user-1", item.id, {
      ...assignmentBrief,
      participants: "cronjev@outlook.com",
    });

    const listed = await listWorkspaceItems("user-1");
    const assignment = listed.find(
      (candidate) => candidate.kind === "method_participant"
    );
    const run = listed.find((candidate) => candidate.kind === "method");
    expect(run?.id).toBe(item.id);
    expect(assignment?.kind).toBe("method_participant");
    if (assignment?.kind !== "method_participant") return;
    expect(assignment.assignment.title).toBe("Great Expectations");
    expect(harness.inviteWorkspaceParticipant).toHaveBeenCalledWith(
      "cronjev@outlook.com",
      { correlationId: expect.any(String) }
    );
  });

  it("still launches when the invite email cannot be sent", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue(null);
    harness.inviteWorkspaceParticipant.mockRejectedValue(
      new Error("535 authentication failed")
    );
    const result = await submitWorkspaceForm("user-1", item.id, {
      ...assignmentBrief,
      participants: "new@example.com",
    });
    expect(result.item.kind).toBe("method");
    if (result.item.kind !== "method") return;
    expect(result.item.run?.participants[0]).toMatchObject({
      email: "new@example.com",
      invitationStatus: "sent",
    });
  });

  it("claims a pending invite when the recipient lists workspace items", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue(null);
    await submitWorkspaceForm("user-1", item.id, {
      ...assignmentBrief,
      participants: "new@example.com",
    });

    const claimed = await listWorkspaceItems("user-3", {
      email: "new@example.com",
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].kind).toBe("method_participant");
    if (claimed[0].kind !== "method_participant") return;
    expect(claimed[0].assignment.title).toBe("Great Expectations");
    expect(claimed[0].methodSource).toMatchObject({
      id: "ai-assisted-essay",
      title: expect.stringMatching(/AI-assisted essay/i),
      url: "https://research.evaluchat.org/methods/ai-assisted-essay.html",
    });

    const operator = await getWorkspaceItem("user-1", item.id);
    expect(operator?.kind).toBe("method");
    if (operator?.kind !== "method") return;
    expect(operator.run?.participants[0]).toMatchObject({
      email: "new@example.com",
      userId: "user-3",
      invitationStatus: "accepted",
      itemId: claimed[0].id,
    });
  });

  it("updates operator counts when a participant submits", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue({
      id: "user-2",
      email: "a@example.com",
    });
    const launched = await submitWorkspaceForm("user-1", item.id, {
      ...assignmentBrief,
      participants: "a@example.com",
    });
    expect(launched.item.kind).toBe("method");
    if (launched.item.kind !== "method" || !launched.item.run) return;
    const participantId = launched.item.run.participants[0].itemId!;
    harness.state.threads.set("thread-p", {
      metadata: { user_id: "user-2", workspace_item_id: participantId },
    });
    const participantManifest = manifestFor("user-2");
    participantManifest.items[participantId].threadId = "thread-p";

    const result = await submitWorkspaceForm("user-2", participantId, {});
    expect(result.item.kind).toBe("method_participant");
    if (result.item.kind !== "method_participant") return;
    expect(result.item.submission?.status).toBe("submitted");

    const operator = await getWorkspaceItem("user-1", item.id);
    expect(operator?.kind).toBe("method");
    if (operator?.kind !== "method") return;
    expect(operator.run?.participants[0].submissionStatus).toBe("submitted");
    expect(operator.run?.participants[0].threadId).toBe("thread-p");
    expect(harness.client.threads.update).toHaveBeenCalled();
  });

  it("leaves a failed participant submit unsubmitted and retryable", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue({
      id: "user-2",
      email: "a@example.com",
    });
    const launched = await submitWorkspaceForm("user-1", item.id, {
      ...assignmentBrief,
      participants: "a@example.com",
    });
    if (launched.item.kind !== "method" || !launched.item.run) return;
    const participantId = launched.item.run.participants[0].itemId!;
    harness.state.threads.set("foreign-thread", {
      metadata: { user_id: "user-1", workspace_item_id: item.id },
    });

    await expect(
      submitWorkspaceForm(
        "user-2",
        participantId,
        {},
        {
          threadId: "foreign-thread",
        }
      )
    ).rejects.toBeInstanceOf(WorkspaceThreadOwnershipError);

    expect(
      manifestFor("user-2").items[participantId].submission
    ).toBeUndefined();
    expect(
      harness.state.threads.get("foreign-thread").metadata.phase_state
    ).not.toBe("submitted");
  });

  it("updates the operator run when the operator submits their own assignment", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue({
      id: "user-1",
      email: "operator@example.com",
    });
    const launched = await submitWorkspaceForm("user-1", item.id, {
      ...assignmentBrief,
      participants: "operator@example.com",
    });
    expect(launched.item.kind).toBe("method");
    if (launched.item.kind !== "method" || !launched.item.run) return;
    const participantId = launched.item.run.participants[0].itemId!;
    harness.state.threads.set("thread-self", {
      metadata: { user_id: "user-1", workspace_item_id: participantId },
    });
    const operatorManifest = manifestFor("user-1");
    operatorManifest.items[participantId].threadId = "thread-self";

    await submitWorkspaceForm("user-1", participantId, {});
    const operator = await getWorkspaceItem("user-1", item.id);
    expect(operator?.kind).toBe("method");
    if (operator?.kind !== "method") return;
    expect(operator.run?.participants[0].submissionStatus).toBe("submitted");
    expect(operator.run?.participants[0].threadId).toBe("thread-self");
  });

  it("records a live thread id on submit when the participant item had none", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue({
      id: "user-2",
      email: "a@example.com",
    });
    const launched = await submitWorkspaceForm("user-1", item.id, {
      ...assignmentBrief,
      participants: "a@example.com",
    });
    if (launched.item.kind !== "method" || !launched.item.run) return;
    const participantId = launched.item.run.participants[0].itemId!;
    harness.state.threads.set("thread-live", {
      metadata: { user_id: "user-2", workspace_item_id: participantId },
    });

    await submitWorkspaceForm(
      "user-2",
      participantId,
      {},
      {
        threadId: "thread-live",
      }
    );
    const operator = await getWorkspaceItem("user-1", item.id);
    expect(
      operator?.kind === "method" &&
        operator.run?.participants[0].submissionStatus
    ).toBe("submitted");
    expect(
      operator?.kind === "method" && operator.run?.participants[0].threadId
    ).toBe("thread-live");
    expect(manifestFor("user-2").items[participantId].threadId).toBe(
      "thread-live"
    );
  });

  it("reconciles operator submitted counts when the participant manifest is ahead", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue({
      id: "user-2",
      email: "a@example.com",
    });
    const launched = await submitWorkspaceForm("user-1", item.id, {
      ...assignmentBrief,
      participants: "a@example.com",
    });
    if (launched.item.kind !== "method" || !launched.item.run) return;
    const participantId = launched.item.run.participants[0].itemId!;
    const participantManifest = manifestFor("user-2");
    participantManifest.items[participantId].submission = {
      status: "submitted",
      submittedAt: "2026-08-13T12:00:00.000Z",
    };
    participantManifest.items[participantId].threadId = "thread-stale";

    const operator = await getWorkspaceItem("user-1", item.id);
    expect(operator?.kind).toBe("method");
    if (operator?.kind !== "method") return;
    expect(operator.run?.participants[0].submissionStatus).toBe("submitted");
    expect(operator.run?.participants[0].threadId).toBe("thread-stale");

    const listed = await listWorkspaceItems("user-1");
    const run = listed.find((candidate) => candidate.id === item.id);
    expect(run?.kind).toBe("method");
    if (run?.kind !== "method") return;
    expect(run.run?.participants[0].submissionStatus).toBe("submitted");
  });

  it("syncs the operator row on idempotent participant submit", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue({
      id: "user-2",
      email: "a@example.com",
    });
    const launched = await submitWorkspaceForm("user-1", item.id, {
      ...assignmentBrief,
      participants: "a@example.com",
    });
    if (launched.item.kind !== "method" || !launched.item.run) return;
    const participantId = launched.item.run.participants[0].itemId!;
    const participantManifest = manifestFor("user-2");
    participantManifest.items[participantId].submission = {
      status: "submitted",
      submittedAt: "2026-08-13T12:00:00.000Z",
    };

    await submitWorkspaceForm("user-2", participantId, {});
    const operator = await getWorkspaceItem("user-1", item.id);
    expect(
      operator?.kind === "method" &&
        operator.run?.participants[0].submissionStatus
    ).toBe("submitted");
  });

  it("forbids a non-operator from loading the run review", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue({
      id: "user-2",
      email: "a@example.com",
    });
    const launched = await submitWorkspaceForm("user-1", item.id, {
      ...assignmentBrief,
      participants: "a@example.com",
    });
    if (launched.item.kind !== "method" || !launched.item.run) return;
    const participantId = launched.item.run.participants[0].itemId!;

    await expect(getMethodRun("user-2", item.id)).rejects.toBeInstanceOf(
      WorkspaceItemNotFoundError
    );
    await expect(
      getMethodParticipantReview("user-2", item.id, participantId)
    ).rejects.toBeInstanceOf(WorkspaceItemNotFoundError);

    const review = await getMethodParticipantReview(
      "user-1",
      item.id,
      participantId
    );
    expect(review.participant.id).toBe(participantId);
    expect(review.thread).toBeNull();
  });

  it("omits tracking when the frozen tracking lever is off", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue({
      id: "user-2",
      email: "a@example.com",
    });
    const launched = await submitWorkspaceForm(
      "user-1",
      item.id,
      { ...assignmentBrief, participants: "a@example.com" },
      { profileId: "tracking-off" }
    );
    if (launched.item.kind !== "method" || !launched.item.run) return;
    expect(launched.item.run.apparatusConfiguration.tracking).toBe(false);
    const participantId = launched.item.run.participants[0].itemId!;
    harness.state.threads.set("thread-track", {
      metadata: {
        user_id: "user-2",
        workspace_item_id: participantId,
      },
    });

    const access = await resolveMethodTrackingAccess("thread-track", "user-2");
    expect(access).toEqual({
      allowed: false,
      canWrite: false,
      canRead: false,
    });
  });

  it("allows tracking when thread owner is stamped only as supabase_user_id", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue({
      id: "user-2",
      email: "a@example.com",
    });
    const launched = await submitWorkspaceForm("user-1", item.id, {
      ...assignmentBrief,
      participants: "a@example.com",
    });
    if (launched.item.kind !== "method" || !launched.item.run) {
      throw new Error("expected method run item from submitWorkspaceForm");
    }
    const participantId = launched.item.run.participants[0].itemId!;
    harness.state.threads.set("thread-supabase-owner", {
      metadata: {
        supabase_user_id: "user-2",
        workspace_item_id: participantId,
      },
    });

    const access = await resolveMethodTrackingAccess(
      "thread-supabase-owner",
      "user-2"
    );
    expect(access).toEqual({
      allowed: true,
      canWrite: true,
      canRead: true,
    });
  });

  it("allows tracking when thread owner is stamped only as user_id", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue({
      id: "user-2",
      email: "a@example.com",
    });
    const launched = await submitWorkspaceForm("user-1", item.id, {
      ...assignmentBrief,
      participants: "a@example.com",
    });
    if (launched.item.kind !== "method" || !launched.item.run) {
      throw new Error("expected method run item from submitWorkspaceForm");
    }
    const participantId = launched.item.run.participants[0].itemId!;
    harness.state.threads.set("thread-user-owner", {
      metadata: {
        user_id: "user-2",
        workspace_item_id: participantId,
      },
    });

    const access = await resolveMethodTrackingAccess(
      "thread-user-owner",
      "user-2"
    );
    expect(access).toEqual({
      allowed: true,
      canWrite: true,
      canRead: true,
    });
  });

  it("serializes concurrent same-user default ensures to one item", async () => {
    const [first, second] = await Promise.all([
      ensureDefaultWorkspaceItem("user-1"),
      ensureDefaultWorkspaceItem("user-1"),
    ]);
    expect(first?.id).toBeDefined();
    expect(second?.id).toBe(first?.id);
    expect(Object.keys(harness.state.manifest.items)).toHaveLength(1);
  });

  it("holds competing acquisition until the first lock holder releases", async () => {
    let releaseFirstManifestWrite!: () => void;
    const firstManifestWriteGate = new Promise<void>((resolve) => {
      releaseFirstManifestWrite = resolve;
    });
    let firstManifestWriteStarted = false;

    const putItem = harness.client.store.putItem;
    const previousPut = putItem.getMockImplementation()!;
    putItem.mockImplementation(
      async (
        namespace: string[],
        key: string,
        value: any,
        options?: { ttl?: number | null }
      ) => {
        if (
          namespace.join("/") === "workspace_items/user-1" &&
          key === "manifest" &&
          !firstManifestWriteStarted
        ) {
          firstManifestWriteStarted = true;
          await firstManifestWriteGate;
        }
        return previousPut(namespace, key, value, options);
      }
    );

    try {
      const firstPromise = ensureDefaultWorkspaceItem("user-1");
      await waitFor(() => firstManifestWriteStarted);

      const secondPromise = ensureDefaultWorkspaceItem("user-1");
      let secondSettled = false;
      void secondPromise.then(() => {
        secondSettled = true;
      });

      await delay(50);
      expect(secondSettled).toBe(false);
      expect(harness.state.items.has("workspace_items/user-1:lock")).toBe(true);

      releaseFirstManifestWrite();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(first?.id).toBeDefined();
      expect(second?.id).toBe(first?.id);
      expect(Object.keys(harness.state.manifest.items)).toHaveLength(1);
      expect(harness.state.items.has("workspace_items/user-1:lock")).toBe(
        false
      );
    } finally {
      putItem.mockImplementation(previousPut);
    }
  });

  it("release waits for an in-flight renewal so it cannot re-create the lock", async () => {
    workspaceLockTtlMs.value = 200;
    workspaceLockRetryDelayMs.value = 1;
    workspaceLockAcquireTimeoutMs.value = 1000;

    let resolveManifestWrite!: () => void;
    let manifestWriteStarted = false;
    let resolveLockPut!: () => void;
    let lockPutStarted = false;
    let lockPutsSeen = 0;

    harness.hooks.onLockPut = async () => {
      lockPutsSeen += 1;
      // First put is acquire; gate subsequent renewals.
      if (lockPutsSeen === 1) return;
      lockPutStarted = true;
      await new Promise<void>((resolve) => {
        resolveLockPut = resolve;
      });
    };

    const putItem = harness.client.store.putItem;
    const previousPut = putItem.getMockImplementation()!;
    putItem.mockImplementation(
      async (
        namespace: string[],
        key: string,
        value: any,
        options?: { ttl?: number | null }
      ) => {
        if (
          namespace.join("/") === "workspace_items/user-1" &&
          key === "manifest" &&
          !manifestWriteStarted
        ) {
          manifestWriteStarted = true;
          await new Promise<void>((resolve) => {
            resolveManifestWrite = resolve;
          });
        }
        return previousPut(namespace, key, value, options);
      }
    );

    try {
      const lockKey = "workspace_items/user-1:lock";
      const op = ensureDefaultWorkspaceItem("user-1");
      await waitFor(() => manifestWriteStarted);
      await waitFor(() => lockPutStarted);

      let opSettled = false;
      void op.then(
        () => {
          opSettled = true;
        },
        () => {
          opSettled = true;
        }
      );

      resolveManifestWrite();
      await delay(50);
      expect(opSettled).toBe(false);
      expect(harness.state.items.has(lockKey)).toBe(true);

      resolveLockPut();
      await op;
      expect(opSettled).toBe(true);
      expect(harness.state.items.has(lockKey)).toBe(false);
    } finally {
      harness.hooks.onLockPut = undefined;
      putItem.mockImplementation(previousPut);
    }
  });

  it("renews the store lock lease while a long op holds it", async () => {
    workspaceLockTtlMs.value = 200;
    workspaceLockRetryDelayMs.value = 1;
    // renewal period = max(1000, floor(200/3)) = 1000
    const renewalMs = Math.max(1000, Math.floor(workspaceLockTtlMs.value / 3));

    let releaseManifestWrite!: () => void;
    const manifestWriteGate = new Promise<void>((resolve) => {
      releaseManifestWrite = resolve;
    });
    let manifestWriteStarted = false;

    const putItem = harness.client.store.putItem;
    const previousPut = putItem.getMockImplementation()!;
    putItem.mockImplementation(
      async (
        namespace: string[],
        key: string,
        value: any,
        options?: { ttl?: number | null }
      ) => {
        if (
          namespace.join("/") === "workspace_items/user-1" &&
          key === "manifest" &&
          !manifestWriteStarted
        ) {
          manifestWriteStarted = true;
          await manifestWriteGate;
        }
        return previousPut(namespace, key, value, options);
      }
    );

    try {
      const op = ensureDefaultWorkspaceItem("user-1");
      await waitFor(() => manifestWriteStarted);

      const lockKey = "workspace_items/user-1:lock";
      const initial = harness.state.items.get(lockKey) as {
        token: string;
        expiresAt: number;
      };
      expect(initial?.token).toBeDefined();
      const initialExpiresAt = initial.expiresAt;

      await delay(renewalMs + 200);

      const mid = harness.state.items.get(lockKey) as {
        token: string;
        expiresAt: number;
      };
      expect(mid.token).toBe(initial.token);
      expect(mid.expiresAt).toBeGreaterThan(initialExpiresAt);

      releaseManifestWrite();
      await op;
      expect(harness.state.items.has(lockKey)).toBe(false);
    } finally {
      putItem.mockImplementation(previousPut);
    }
  });

  it("keeps the lease alive across TTL so a competitor waits for release", async () => {
    workspaceLockTtlMs.value = 200;
    workspaceLockRetryDelayMs.value = 1;

    let releaseFirstManifestWrite!: () => void;
    const firstManifestWriteGate = new Promise<void>((resolve) => {
      releaseFirstManifestWrite = resolve;
    });
    let firstManifestWriteStarted = false;

    const putItem = harness.client.store.putItem;
    const previousPut = putItem.getMockImplementation()!;
    putItem.mockImplementation(
      async (
        namespace: string[],
        key: string,
        value: any,
        options?: { ttl?: number | null }
      ) => {
        if (
          namespace.join("/") === "workspace_items/user-1" &&
          key === "manifest" &&
          !firstManifestWriteStarted
        ) {
          firstManifestWriteStarted = true;
          await firstManifestWriteGate;
        }
        return previousPut(namespace, key, value, options);
      }
    );

    try {
      const firstPromise = ensureDefaultWorkspaceItem("user-1");
      await waitFor(() => firstManifestWriteStarted);

      const secondPromise = ensureDefaultWorkspaceItem("user-1");
      let secondSettled = false;
      void secondPromise.then(() => {
        secondSettled = true;
      });

      // Hold past the 200ms TTL; renewal must keep the lease so the competitor waits.
      await delay(300);
      expect(secondSettled).toBe(false);
      expect(harness.state.items.has("workspace_items/user-1:lock")).toBe(true);

      releaseFirstManifestWrite();
      const [first, second] = await Promise.all([firstPromise, secondPromise]);
      expect(first?.id).toBeDefined();
      expect(second?.id).toBe(first?.id);
      expect(Object.keys(harness.state.manifest.items)).toHaveLength(1);
      expect(harness.state.items.has("workspace_items/user-1:lock")).toBe(
        false
      );
    } finally {
      putItem.mockImplementation(previousPut);
    }
  });

  it("releases the store lock after a manifest op", async () => {
    await ensureDefaultWorkspaceItem("user-1");
    expect(harness.state.items.has("workspace_items/user-1:lock")).toBe(false);
  });

  it("takes over a stale store lock and completes the op", async () => {
    harness.state.items.set("workspace_items/user-1:lock", {
      token: "stale-foreign-token",
      expiresAt: Date.now() - 1_000,
    });
    const item = await ensureDefaultWorkspaceItem("user-1");
    expect(item?.id).toBeDefined();
    expect(harness.state.items.has("workspace_items/user-1:lock")).toBe(false);
  });

  it("times out when a fresh foreign store lock is held", async () => {
    harness.state.items.set("workspace_items/user-1:lock", {
      token: "fresh-foreign-token",
      expiresAt: Date.now() + 60_000,
    });
    workspaceLockAcquireTimeoutMs.value = 0;
    workspaceLockRetryDelayMs.value = 0;

    await expect(ensureDefaultWorkspaceItem("user-1")).rejects.toBeInstanceOf(
      WorkspaceLockTimeoutError
    );
  });

  it("covers the method lifecycle from create through review payload", async () => {
    const item = await createMethodWorkspaceItem("user-1", "ai-assisted-essay");
    harness.findUserByEmail.mockResolvedValue({
      id: "user-2",
      email: "a@example.com",
    });
    const launched = await submitWorkspaceForm("user-1", item.id, {
      ...assignmentBrief,
      participants: "a@example.com",
    });
    if (launched.item.kind !== "method" || !launched.item.run) return;
    const participantId = launched.item.run.participants[0].itemId!;
    harness.state.threads.set("thread-life", {
      metadata: { user_id: "user-2", workspace_item_id: participantId },
      values: { messages: [{ type: "human", content: "hello" }] },
    });
    const participantManifest = manifestFor("user-2");
    participantManifest.items[participantId].threadId = "thread-life";
    await submitWorkspaceForm("user-2", participantId, {});
    const operator = await getWorkspaceItem("user-1", item.id);
    expect(
      operator?.kind === "method" &&
        operator.run?.participants[0].submissionStatus
    ).toBe("submitted");
    const review = await getMethodParticipantReview(
      "user-1",
      item.id,
      participantId
    );
    expect(review.thread?.messages).toEqual([
      { type: "human", content: "hello" },
    ]);
    expect(review.trackingEnabled).toBe(true);
  });
});
