import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Client } from "@langchain/langgraph-sdk";
import {
  decryptGithubResearchSecret,
  encryptGithubResearchSecret,
  UnknownGithubResearchEncryptionKeyError,
  type GithubResearchEncryptedEnvelope,
} from "@opencanvas/shared/github-research/crypto";
import { LANGGRAPH_API_URL } from "@/constants";
import type { GithubResearchOAuthTokens } from "./github-app";

export const GITHUB_RESEARCH_CREDENTIALS_ROOT = "github_research_credentials";
export const GITHUB_RESEARCH_CREDENTIALS_KEY = "credentials";

const OAUTH_STATE_TTL_MINUTES = 10;
const WEBHOOK_DELIVERY_TTL_MINUTES = 7 * 24 * 60;
const IDENTIFIER_HMAC_DOMAIN = "github-research-identifier-hmac";
const SEARCH_PAGE_SIZE = 100;
export const MAX_CREDENTIAL_SEARCH_PAGES = 100;

export class CredentialOwnerSearchTruncatedError extends Error {
  constructor(public readonly installationId: number) {
    super(
      `GitHub credential owner search truncated after ${MAX_CREDENTIAL_SEARCH_PAGES} pages for installation ${installationId}`
    );
    this.name = "CredentialOwnerSearchTruncatedError";
  }
}

export type GithubResearchCredentialRecord = {
  accessTokenEnc: GithubResearchEncryptedEnvelope;
  refreshTokenEnc?: GithubResearchEncryptedEnvelope;
  accessTokenExpiresAt?: string;
  refreshTokenExpiresAt?: string;
  installationId?: number;
  repositoryIds: number[];
  displayMetadataEnc: GithubResearchEncryptedEnvelope;
  githubUserIdHash: string;
  connectedAt: string;
  updatedAt: string;
  lastPush?: {
    repositoryId?: number;
    refHash?: string;
    beforeHash?: string;
    afterHash?: string;
    receivedAt: string;
  };
};

export type DecryptedGithubResearchCredentials = {
  tokens: GithubResearchOAuthTokens;
  installationId?: number;
  repositoryIds: number[];
  displayMetadata: Record<string, unknown>;
};

type StoredOAuthState = {
  stateHash: string;
  verifierEnc: GithubResearchEncryptedEnvelope;
  expiresAt: string;
};

function client(): Client {
  return new Client({
    apiUrl: LANGGRAPH_API_URL,
    apiKey: process.env.LANGCHAIN_API_KEY,
  });
}

function encryptionKey(): string {
  const value = process.env.GITHUB_RESEARCH_TOKEN_ENCRYPTION_KEY?.trim();
  if (!value) {
    throw new Error("GITHUB_RESEARCH_TOKEN_ENCRYPTION_KEY is required");
  }
  return value;
}

/**
 * Rotate by moving the current key into the comma-separated previous-key list
 * before activating its replacement. Keep previous keys configured until reads
 * have rewritten all envelopes; records with an unconfigured kid are deleted so
 * the user can reconnect instead of receiving persistent server errors.
 */
function encryptionKeyRing(): [string, ...string[]] {
  const activeKey = encryptionKey();
  const previousKeys = (
    process.env.GITHUB_RESEARCH_TOKEN_ENCRYPTION_PREVIOUS_KEYS ?? ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && value !== activeKey);
  return [activeKey, ...new Set(previousKeys)];
}

// LangGraph Store has no compare-and-swap. This serializes mutations only
// within one running application instance; deployments still need sticky or
// single-instance handling for strict cross-instance exclusion.
const userOperationTails = new Map<string, Promise<void>>();

export async function withUserLock<T>(
  userId: string,
  operation: () => Promise<T>
): Promise<T> {
  const predecessor = userOperationTails.get(userId) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = predecessor.then(() => gate);
  userOperationTails.set(userId, tail);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
    if (userOperationTails.get(userId) === tail) {
      userOperationTails.delete(userId);
    }
  }
}

export function githubResearchCredentialsNamespace(userId: string): string[] {
  if (!userId || userId.includes(".")) throw new Error("Invalid user id");
  return [GITHUB_RESEARCH_CREDENTIALS_ROOT, userId];
}

function hashGithubCredentialIdentifierWithKey(
  value: string,
  keyHex: string
): string {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      "GITHUB_RESEARCH_TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)"
    );
  }
  const hmacKey = createHash("sha256")
    .update(Buffer.from(keyHex, "hex"))
    .update(`\0${IDENTIFIER_HMAC_DOMAIN}`, "utf8")
    .digest();
  return createHmac("sha256", hmacKey).update(value, "utf8").digest("hex");
}

export function hashGithubCredentialIdentifier(value: string): string {
  return hashGithubCredentialIdentifierWithKey(value, encryptionKey());
}

function equalHashes(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function stateKey(stateHash: string): string {
  return `oauth_state:${stateHash}`;
}

function webhookDeliveryKey(deliveryHash: string): string {
  return `webhook_delivery:${deliveryHash}`;
}

function normaliseRecord(
  value: unknown
): GithubResearchCredentialRecord | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<GithubResearchCredentialRecord>;
  if (
    !candidate.accessTokenEnc ||
    !candidate.displayMetadataEnc ||
    !Array.isArray(candidate.repositoryIds) ||
    typeof candidate.githubUserIdHash !== "string" ||
    typeof candidate.connectedAt !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }
  return candidate as GithubResearchCredentialRecord;
}

export async function storeGithubOAuthState(
  userId: string,
  state: string,
  verifier: string
): Promise<void> {
  const stateHash = hashGithubCredentialIdentifier(state);
  const expiresAt = new Date(
    Date.now() + OAUTH_STATE_TTL_MINUTES * 60_000
  ).toISOString();
  await client().store.putItem(
    githubResearchCredentialsNamespace(userId),
    stateKey(stateHash),
    {
      stateHash,
      verifierEnc: encryptGithubResearchSecret(verifier, encryptionKey()),
      expiresAt,
    },
    { index: false, ttl: OAUTH_STATE_TTL_MINUTES }
  );
}

/** Read and delete an OAuth state before returning its PKCE verifier. */
export async function consumeGithubOAuthState(
  userId: string,
  state: string
): Promise<string | null> {
  return withUserLock(userId, async () => {
    const namespace = githubResearchCredentialsNamespace(userId);
    const keyRing = encryptionKeyRing();
    let stateHash: string | undefined;
    let key: string | undefined;
    let item: { value?: unknown } | null | undefined;
    for (const encryptionKey of keyRing) {
      const candidateHash = hashGithubCredentialIdentifierWithKey(
        state,
        encryptionKey
      );
      const candidateKey = stateKey(candidateHash);
      const candidateItem = await client().store.getItem(
        namespace,
        candidateKey
      );
      if (candidateItem) {
        stateHash = candidateHash;
        key = candidateKey;
        item = candidateItem;
        break;
      }
    }
    if (!item || !stateHash || !key) return null;
    await client().store.deleteItem(namespace, key);

    const value = item.value as Partial<StoredOAuthState> | undefined;
    if (
      !value ||
      typeof value.stateHash !== "string" ||
      !equalHashes(value.stateHash, stateHash) ||
      typeof value.expiresAt !== "string" ||
      new Date(value.expiresAt).getTime() <= Date.now() ||
      !value.verifierEnc
    ) {
      return null;
    }
    return decryptGithubResearchSecret(value.verifierEnc, ...keyRing).plaintext;
  });
}

export async function storeGithubResearchCredentials(
  userId: string,
  input: {
    tokens: GithubResearchOAuthTokens;
    installationId?: number;
    repositoryIds: number[];
    displayMetadata: Record<string, unknown> & { githubUserId: number };
  }
): Promise<void> {
  await withUserLock(userId, async () => {
    const key = encryptionKey();
    const now = new Date().toISOString();
    const existing = await readGithubResearchCredentialRecord(userId);
    const record: GithubResearchCredentialRecord = {
      accessTokenEnc: encryptGithubResearchSecret(
        input.tokens.accessToken,
        key
      ),
      refreshTokenEnc: input.tokens.refreshToken
        ? encryptGithubResearchSecret(input.tokens.refreshToken, key)
        : undefined,
      accessTokenExpiresAt: input.tokens.expiresAt,
      refreshTokenExpiresAt: input.tokens.refreshTokenExpiresAt,
      installationId: input.installationId,
      repositoryIds: [...new Set(input.repositoryIds)].sort(
        (left, right) => left - right
      ),
      displayMetadataEnc: encryptGithubResearchSecret(
        JSON.stringify(input.displayMetadata),
        key
      ),
      githubUserIdHash: hashGithubCredentialIdentifier(
        String(input.displayMetadata.githubUserId)
      ),
      connectedAt: existing?.connectedAt ?? now,
      updatedAt: now,
      lastPush: existing?.lastPush,
    };
    await client().store.putItem(
      githubResearchCredentialsNamespace(userId),
      GITHUB_RESEARCH_CREDENTIALS_KEY,
      record,
      { index: ["installationId", "githubUserIdHash"] }
    );
  });
}

export async function readGithubResearchCredentialRecord(
  userId: string
): Promise<GithubResearchCredentialRecord | null> {
  const item = await client().store.getItem(
    githubResearchCredentialsNamespace(userId),
    GITHUB_RESEARCH_CREDENTIALS_KEY
  );
  return normaliseRecord(item?.value);
}

export async function readGithubResearchCredentials(
  userId: string
): Promise<DecryptedGithubResearchCredentials | null> {
  return withUserLock(userId, async () => {
    const record = await readGithubResearchCredentialRecord(userId);
    if (!record) return null;
    const keyRing = encryptionKeyRing();
    try {
      const metadataResult = decryptGithubResearchSecret(
        record.displayMetadataEnc,
        ...keyRing
      );
      const accessTokenResult = decryptGithubResearchSecret(
        record.accessTokenEnc,
        ...keyRing
      );
      const refreshTokenResult = record.refreshTokenEnc
        ? decryptGithubResearchSecret(record.refreshTokenEnc, ...keyRing)
        : undefined;
      const metadata = JSON.parse(metadataResult.plaintext) as unknown;
      if (
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata)
      ) {
        throw new Error("Invalid encrypted GitHub display metadata");
      }
      const metadataRecord = metadata as Record<string, unknown>;
      if (
        metadataResult.reencrypted ||
        accessTokenResult.reencrypted ||
        refreshTokenResult?.reencrypted
      ) {
        await client().store.putItem(
          githubResearchCredentialsNamespace(userId),
          GITHUB_RESEARCH_CREDENTIALS_KEY,
          {
            ...record,
            displayMetadataEnc: metadataResult.envelope,
            accessTokenEnc: accessTokenResult.envelope,
            refreshTokenEnc: refreshTokenResult?.envelope,
            githubUserIdHash:
              typeof metadataRecord.githubUserId === "number"
                ? hashGithubCredentialIdentifierWithKey(
                    String(metadataRecord.githubUserId),
                    keyRing[0]
                  )
                : record.githubUserIdHash,
            updatedAt: new Date().toISOString(),
          },
          { index: ["installationId", "githubUserIdHash"] }
        );
      }
      return {
        tokens: {
          accessToken: accessTokenResult.plaintext,
          refreshToken: refreshTokenResult?.plaintext,
          expiresAt: record.accessTokenExpiresAt,
          refreshTokenExpiresAt: record.refreshTokenExpiresAt,
        },
        installationId: record.installationId,
        repositoryIds: record.repositoryIds,
        displayMetadata: metadataRecord,
      };
    } catch (error) {
      if (error instanceof UnknownGithubResearchEncryptionKeyError) {
        await client().store.deleteItem(
          githubResearchCredentialsNamespace(userId),
          GITHUB_RESEARCH_CREDENTIALS_KEY
        );
        return null;
      }
      throw error;
    }
  });
}

export async function deleteGithubResearchCredentials(
  userId: string
): Promise<void> {
  await withUserLock(userId, async () => {
    await client().store.deleteItem(
      githubResearchCredentialsNamespace(userId),
      GITHUB_RESEARCH_CREDENTIALS_KEY
    );
  });
}

export async function findGithubCredentialOwnersByInstallationId(
  installationId: number
): Promise<string[]> {
  const items = [];
  let offset = 0;
  for (let page = 0; page < MAX_CREDENTIAL_SEARCH_PAGES; page += 1) {
    const response = await client().store.searchItems(
      [GITHUB_RESEARCH_CREDENTIALS_ROOT],
      {
        filter: { installationId },
        limit: SEARCH_PAGE_SIZE,
        offset,
      }
    );
    items.push(...response.items);
    if (response.items.length < SEARCH_PAGE_SIZE) {
      return items
        .filter(
          (item) =>
            item.key === GITHUB_RESEARCH_CREDENTIALS_KEY &&
            item.value?.installationId === installationId &&
            item.namespace[0] === GITHUB_RESEARCH_CREDENTIALS_ROOT &&
            typeof item.namespace[1] === "string"
        )
        .map((item) => item.namespace[1] as string);
    }
    offset += response.items.length;
  }
  console.error(
    "[github-research] credential owner search truncated",
    installationId,
    MAX_CREDENTIAL_SEARCH_PAGES
  );
  throw new CredentialOwnerSearchTruncatedError(installationId);
}

export async function claimGithubWebhookDelivery(
  userId: string,
  deliveryId: string
): Promise<boolean> {
  return withUserLock(userId, async () => {
    const namespace = githubResearchCredentialsNamespace(userId);
    const keyRing = encryptionKeyRing();
    for (const key of keyRing) {
      const knownHash = hashGithubCredentialIdentifierWithKey(deliveryId, key);
      if (
        await client().store.getItem(namespace, webhookDeliveryKey(knownHash))
      ) {
        return false;
      }
    }
    const deliveryHash = hashGithubCredentialIdentifierWithKey(
      deliveryId,
      keyRing[0]
    );
    await client().store.putItem(
      namespace,
      webhookDeliveryKey(deliveryHash),
      { deliveryHash, receivedAt: new Date().toISOString() },
      { index: false, ttl: WEBHOOK_DELIVERY_TTL_MINUTES }
    );
    return true;
  });
}

export async function releaseGithubWebhookDelivery(
  userId: string,
  deliveryId: string
): Promise<void> {
  await withUserLock(userId, async () => {
    const namespace = githubResearchCredentialsNamespace(userId);
    for (const key of encryptionKeyRing()) {
      const deliveryHash = hashGithubCredentialIdentifierWithKey(
        deliveryId,
        key
      );
      await client().store.deleteItem(
        namespace,
        webhookDeliveryKey(deliveryHash)
      );
    }
  });
}

async function updateCredentialRecord(
  userId: string,
  update: (
    record: GithubResearchCredentialRecord
  ) => GithubResearchCredentialRecord
): Promise<void> {
  await withUserLock(userId, async () => {
    const record = await readGithubResearchCredentialRecord(userId);
    if (!record) return;
    await client().store.putItem(
      githubResearchCredentialsNamespace(userId),
      GITHUB_RESEARCH_CREDENTIALS_KEY,
      { ...update(record), updatedAt: new Date().toISOString() },
      { index: ["installationId", "githubUserIdHash"] }
    );
  });
}

export async function updateGithubInstallation(
  userId: string,
  installationId: number,
  repositoryIds: number[]
): Promise<void> {
  await updateCredentialRecord(userId, (record) => ({
    ...record,
    installationId,
    repositoryIds: [...new Set(repositoryIds)].sort(
      (left, right) => left - right
    ),
  }));
}

export async function updateGithubInstallationRepositories(
  userId: string,
  addedRepositoryIds: number[],
  removedRepositoryIds: number[]
): Promise<void> {
  await updateCredentialRecord(userId, (record) => {
    const repositoryIds = new Set(record.repositoryIds);
    for (const id of addedRepositoryIds) repositoryIds.add(id);
    for (const id of removedRepositoryIds) repositoryIds.delete(id);
    return {
      ...record,
      repositoryIds: [...repositoryIds].sort((left, right) => left - right),
    };
  });
}

export async function recordGithubPush(
  userId: string,
  input: {
    repositoryId?: number;
    ref?: string;
    before?: string;
    after?: string;
  }
): Promise<void> {
  await updateCredentialRecord(userId, (record) => ({
    ...record,
    lastPush: {
      repositoryId: input.repositoryId,
      refHash: input.ref
        ? hashGithubCredentialIdentifier(input.ref)
        : undefined,
      beforeHash: input.before
        ? hashGithubCredentialIdentifier(input.before)
        : undefined,
      afterHash: input.after
        ? hashGithubCredentialIdentifier(input.after)
        : undefined,
      receivedAt: new Date().toISOString(),
    },
  }));
}
