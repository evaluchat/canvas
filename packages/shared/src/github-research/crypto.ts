import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

const ENVELOPE_VERSION = 1;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_HEX_LENGTH = 64;
const KEY_ID_HEX_LENGTH = 8;

export type GithubResearchEncryptedEnvelope = {
  v: number;
  kid: string;
  ct: string;
};

export class UnknownGithubResearchEncryptionKeyError extends Error {
  constructor() {
    super("Unknown GitHub research encryption key id");
    this.name = "UnknownGithubResearchEncryptionKeyError";
  }
}

function parseEncryptionKey(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex) || keyHex.length !== KEY_HEX_LENGTH) {
    throw new Error(
      "GITHUB_RESEARCH_TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes)"
    );
  }
  return Buffer.from(keyHex, "hex");
}

function decodeCiphertext(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("Invalid GitHub research encrypted payload");
  }
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length < IV_LENGTH + AUTH_TAG_LENGTH ||
    decoded.toString("base64") !== value
  ) {
    throw new Error("Invalid GitHub research encrypted payload");
  }
  return decoded;
}

function parseEnvelope(value: unknown): GithubResearchEncryptedEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid GitHub research encrypted payload");
  }
  const envelope = value as Partial<GithubResearchEncryptedEnvelope>;
  if (
    envelope.v !== ENVELOPE_VERSION ||
    typeof envelope.kid !== "string" ||
    !new RegExp(`^[0-9a-f]{${KEY_ID_HEX_LENGTH}}$`).test(envelope.kid) ||
    typeof envelope.ct !== "string"
  ) {
    throw new Error("Invalid GitHub research encrypted payload");
  }
  return envelope as GithubResearchEncryptedEnvelope;
}

/** A stable, non-secret fingerprint used to select a key during rotation. */
export function githubResearchEncryptionKeyId(keyHex: string): string {
  const key = parseEncryptionKey(keyHex);
  return createHash("sha256")
    .update(key)
    .digest("hex")
    .slice(0, KEY_ID_HEX_LENGTH);
}

/** Encrypt a GitHub user token or display-metadata value with AES-256-GCM. */
export function encryptGithubResearchSecret(
  plaintext: string,
  keyHex: string
): GithubResearchEncryptedEnvelope {
  const key = parseEncryptionKey(keyHex);
  const kid = githubResearchEncryptionKeyId(keyHex);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    v: ENVELOPE_VERSION,
    kid,
    ct: Buffer.concat([iv, authTag, ciphertext]).toString("base64"),
  };
}

export type GithubResearchDecryptionResult = {
  plaintext: string;
  reencrypted: boolean;
  envelope: GithubResearchEncryptedEnvelope;
};

/**
 * Decrypt an envelope with the active key or a previous rotation key. Values
 * read with a previous key are returned re-encrypted under the active key.
 */
export function decryptGithubResearchSecret(
  value: unknown,
  activeKeyHex: string,
  ...previousKeyHexes: string[]
): GithubResearchDecryptionResult {
  const envelope = parseEnvelope(value);
  const keyHex = [activeKeyHex, ...previousKeyHexes].find(
    (candidate) => envelope.kid === githubResearchEncryptionKeyId(candidate)
  );
  if (!keyHex) {
    throw new UnknownGithubResearchEncryptionKeyError();
  }

  const key = parseEncryptionKey(keyHex);
  const payload = decodeCiphertext(envelope.ct);
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
  const reencrypted = keyHex !== activeKeyHex;
  return {
    plaintext,
    reencrypted,
    envelope: reencrypted
      ? encryptGithubResearchSecret(plaintext, activeKeyHex)
      : envelope,
  };
}
