import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const harness = vi.hoisted(() => {
  type Item = {
    namespace: string[];
    key: string;
    value: Record<string, unknown>;
  };
  const items = new Map<string, Item>();
  const fullKey = (namespace: string[], key: string) =>
    `${namespace.join("/")}:${key}`;
  const store = {
    putItem: vi.fn(
      async (
        namespace: string[],
        key: string,
        value: Record<string, unknown>
      ) => {
        items.set(fullKey(namespace, key), { namespace, key, value });
      }
    ),
    getItem: vi.fn(async (namespace: string[], key: string) => {
      return items.get(fullKey(namespace, key)) ?? null;
    }),
    deleteItem: vi.fn(async (namespace: string[], key: string) => {
      items.delete(fullKey(namespace, key));
    }),
    searchItems: vi.fn(
      async (
        prefix: string[],
        options?: {
          filter?: Record<string, unknown>;
          limit?: number;
          offset?: number;
        }
      ) => {
        const matches = [...items.values()].filter(
          (item) =>
            prefix.every((part, index) => item.namespace[index] === part) &&
            Object.entries(options?.filter ?? {}).every(
              ([key, value]) => item.value[key] === value
            )
        );
        const offset = options?.offset ?? 0;
        return {
          items: matches.slice(offset, offset + (options?.limit ?? 10)),
        };
      }
    ),
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
  claimGithubWebhookDelivery,
  consumeGithubOAuthState,
  deleteGithubResearchCredentials,
  CredentialOwnerSearchTruncatedError,
  findGithubCredentialOwnersByInstallationId,
  githubResearchCredentialsNamespace,
  MAX_CREDENTIAL_SEARCH_PAGES,
  hashGithubCredentialIdentifier,
  readGithubResearchCredentialRecord,
  readGithubResearchCredentials,
  recordGithubPush,
  releaseGithubWebhookDelivery,
  storeGithubOAuthState,
  storeGithubResearchCredentials,
  updateGithubInstallationRepositories,
} from "./credentials";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_KEY =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const OTHER_KEY_ID = createHash("sha256")
  .update(Buffer.from(OTHER_KEY, "hex"))
  .digest("hex")
  .slice(0, 8);

beforeEach(() => {
  vi.stubEnv("GITHUB_RESEARCH_TOKEN_ENCRYPTION_KEY", KEY);
  vi.stubEnv("GITHUB_RESEARCH_TOKEN_ENCRYPTION_PREVIOUS_KEYS", "");
  harness.items.clear();
  for (const method of Object.values(harness.store)) method.mockClear();
});

describe("GitHub research credential Store", () => {
  it("uses the per-user credential namespace", () => {
    expect(githubResearchCredentialsNamespace("user-1")).toEqual([
      "github_research_credentials",
      "user-1",
    ]);
  });

  it("stores an encrypted, one-time OAuth state tied to the user", async () => {
    await storeGithubOAuthState("user-1", "state-value", "v".repeat(43));
    expect(JSON.stringify([...harness.items.values()])).not.toContain(
      "v".repeat(43)
    );

    await expect(
      consumeGithubOAuthState("user-2", "state-value")
    ).resolves.toBeNull();
    await expect(
      consumeGithubOAuthState("user-1", "state-value")
    ).resolves.toBe("v".repeat(43));
    await expect(
      consumeGithubOAuthState("user-1", "state-value")
    ).resolves.toBeNull();
  });

  it("consumes OAuth state only once under concurrent calls", async () => {
    await storeGithubOAuthState("user-1", "state-value", "v".repeat(43));

    const results = await Promise.all([
      consumeGithubOAuthState("user-1", "state-value"),
      consumeGithubOAuthState("user-1", "state-value"),
    ]);

    expect(results.filter((value) => value === "v".repeat(43))).toHaveLength(1);
    expect(results.filter((value) => value === null)).toHaveLength(1);
  });

  it("consumes OAuth state encrypted before a key rotation", async () => {
    await storeGithubOAuthState("user-1", "state-value", "v".repeat(43));
    vi.stubEnv("GITHUB_RESEARCH_TOKEN_ENCRYPTION_KEY", OTHER_KEY);
    vi.stubEnv("GITHUB_RESEARCH_TOKEN_ENCRYPTION_PREVIOUS_KEYS", KEY);

    await expect(
      consumeGithubOAuthState("user-1", "state-value")
    ).resolves.toBe("v".repeat(43));
  });

  it("uses a keyed hash for stored credential identifiers", () => {
    const firstHash = hashGithubCredentialIdentifier("7");
    vi.stubEnv("GITHUB_RESEARCH_TOKEN_ENCRYPTION_KEY", OTHER_KEY);
    expect(hashGithubCredentialIdentifier("7")).not.toBe(firstHash);
  });

  it("encrypts tokens and display metadata, then decrypts them on read", async () => {
    await storeGithubResearchCredentials("user-1", {
      tokens: {
        accessToken: "ghu_access-secret",
        refreshToken: "ghr_refresh-secret",
      },
      installationId: 99,
      repositoryIds: [102, 101, 101],
      displayMetadata: { githubUserId: 7, login: "private-login" },
    });
    const stored = JSON.stringify([...harness.items.values()]);
    expect(stored).not.toContain("ghu_access-secret");
    expect(stored).not.toContain("ghr_refresh-secret");
    expect(stored).not.toContain("private-login");
    expect(stored).not.toContain("oauthCodeHash");

    await expect(readGithubResearchCredentials("user-1")).resolves.toEqual({
      tokens: {
        accessToken: "ghu_access-secret",
        refreshToken: "ghr_refresh-secret",
      },
      installationId: 99,
      repositoryIds: [101, 102],
      displayMetadata: { githubUserId: 7, login: "private-login" },
    });
    await expect(
      findGithubCredentialOwnersByInstallationId(99)
    ).resolves.toEqual(["user-1"]);
  });

  it("preserves connection history when credentials are re-authorized", async () => {
    await storeGithubResearchCredentials("user-1", {
      tokens: { accessToken: "ghu_old" },
      installationId: 99,
      repositoryIds: [101],
      displayMetadata: { githubUserId: 7 },
    });
    const stored = [...harness.items.values()].find(
      (item) => item.key === "credentials"
    );
    expect(stored).toBeDefined();
    stored!.value.connectedAt = "2020-01-01T00:00:00.000Z";
    stored!.value.lastPush = {
      repositoryId: 101,
      receivedAt: "2025-01-01T00:00:00.000Z",
    };

    await storeGithubResearchCredentials("user-1", {
      tokens: { accessToken: "ghu_new" },
      installationId: 99,
      repositoryIds: [101],
      displayMetadata: { githubUserId: 7 },
    });
    await updateGithubInstallationRepositories("user-1", [102], []);

    await expect(
      readGithubResearchCredentialRecord("user-1")
    ).resolves.toMatchObject({
      connectedAt: "2020-01-01T00:00:00.000Z",
      lastPush: {
        repositoryId: 101,
        receivedAt: "2025-01-01T00:00:00.000Z",
      },
      repositoryIds: [101, 102],
    });
  });

  it("re-encrypts credential envelopes after a key rotation", async () => {
    await storeGithubResearchCredentials("user-1", {
      tokens: {
        accessToken: "ghu_access",
        refreshToken: "ghr_refresh",
      },
      repositoryIds: [],
      displayMetadata: { githubUserId: 7 },
    });
    const previousHash = (await readGithubResearchCredentialRecord("user-1"))
      ?.githubUserIdHash;
    vi.stubEnv("GITHUB_RESEARCH_TOKEN_ENCRYPTION_KEY", OTHER_KEY);
    vi.stubEnv("GITHUB_RESEARCH_TOKEN_ENCRYPTION_PREVIOUS_KEYS", KEY);

    await expect(
      readGithubResearchCredentials("user-1")
    ).resolves.toMatchObject({
      tokens: {
        accessToken: "ghu_access",
        refreshToken: "ghr_refresh",
      },
    });
    const record = await readGithubResearchCredentialRecord("user-1");
    expect(record?.accessTokenEnc.kid).toBe(OTHER_KEY_ID);
    expect(record?.refreshTokenEnc?.kid).toBe(OTHER_KEY_ID);
    expect(record?.displayMetadataEnc.kid).toBe(OTHER_KEY_ID);
    expect(record?.githubUserIdHash).not.toBe(previousHash);
  });

  it("deletes credentials encrypted with an unknown key", async () => {
    await storeGithubResearchCredentials("user-1", {
      tokens: { accessToken: "ghu_access" },
      repositoryIds: [],
      displayMetadata: { githubUserId: 7 },
    });
    vi.stubEnv("GITHUB_RESEARCH_TOKEN_ENCRYPTION_KEY", OTHER_KEY);

    await expect(readGithubResearchCredentials("user-1")).resolves.toBeNull();
    await expect(
      readGithubResearchCredentialRecord("user-1")
    ).resolves.toBeNull();
  });

  it("deduplicates webhook deliveries by a stored hash", async () => {
    const claims = await Promise.all([
      claimGithubWebhookDelivery("user-1", "delivery-1"),
      claimGithubWebhookDelivery("user-1", "delivery-1"),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(JSON.stringify([...harness.items.values()])).not.toContain(
      "delivery-1"
    );

    await releaseGithubWebhookDelivery("user-1", "delivery-1");
    await expect(
      claimGithubWebhookDelivery("user-1", "delivery-1")
    ).resolves.toBe(true);
  });

  it("updates repository ids without storing repository names", async () => {
    await storeGithubResearchCredentials("user-1", {
      tokens: { accessToken: "ghu_access" },
      installationId: 99,
      repositoryIds: [101],
      displayMetadata: { githubUserId: 7 },
    });
    await updateGithubInstallationRepositories("user-1", [102], [101]);
    expect(
      (await readGithubResearchCredentials("user-1"))?.repositoryIds
    ).toEqual([102]);
  });

  it("serializes concurrent credential record updates", async () => {
    await storeGithubResearchCredentials("user-1", {
      tokens: { accessToken: "ghu_access" },
      installationId: 99,
      repositoryIds: [101],
      displayMetadata: { githubUserId: 7 },
    });

    await Promise.all([
      updateGithubInstallationRepositories("user-1", [102], []),
      updateGithubInstallationRepositories("user-1", [103], []),
      recordGithubPush("user-1", { repositoryId: 103 }),
    ]);

    await expect(
      readGithubResearchCredentialRecord("user-1")
    ).resolves.toMatchObject({
      repositoryIds: [101, 102, 103],
      lastPush: { repositoryId: 103 },
    });
  });

  it("searches every page for installation owners", async () => {
    for (let index = 0; index < 101; index += 1) {
      harness.items.set(`owner-${index}`, {
        namespace: ["github_research_credentials", `user-${index}`],
        key: "credentials",
        value: { installationId: 99 },
      });
    }

    const owners = await findGithubCredentialOwnersByInstallationId(99);
    expect(owners).toHaveLength(101);
    expect(harness.store.searchItems).toHaveBeenNthCalledWith(
      1,
      ["github_research_credentials"],
      expect.objectContaining({ limit: 100, offset: 0 })
    );
    expect(harness.store.searchItems).toHaveBeenNthCalledWith(
      2,
      ["github_research_credentials"],
      expect.objectContaining({ limit: 100, offset: 100 })
    );
  });

  it("errors instead of silently truncating a full last page", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(vi.fn());
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      namespace: ["github_research_credentials", `user-${index}`],
      key: "credentials",
      value: { installationId: 99 },
    }));
    harness.store.searchItems.mockResolvedValue({ items: fullPage });

    try {
      await expect(
        findGithubCredentialOwnersByInstallationId(99)
      ).rejects.toBeInstanceOf(CredentialOwnerSearchTruncatedError);
      expect(harness.store.searchItems).toHaveBeenCalledTimes(
        MAX_CREDENTIAL_SEARCH_PAGES
      );
      expect(consoleError).toHaveBeenCalledWith(
        "[github-research] credential owner search truncated",
        99,
        MAX_CREDENTIAL_SEARCH_PAGES
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("deletes the credentials item on disconnect", async () => {
    await storeGithubResearchCredentials("user-1", {
      tokens: { accessToken: "ghu_access", refreshToken: "ghr_refresh" },
      repositoryIds: [],
      displayMetadata: { githubUserId: 7 },
    });
    await deleteGithubResearchCredentials("user-1");
    await expect(readGithubResearchCredentials("user-1")).resolves.toBeNull();
    await expect(
      readGithubResearchCredentialRecord("user-1")
    ).resolves.toBeNull();
    await deleteGithubResearchCredentials("user-1");
    await expect(readGithubResearchCredentials("user-1")).resolves.toBeNull();
  });
});
