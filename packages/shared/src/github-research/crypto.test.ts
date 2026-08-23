import { describe, expect, it } from "vitest";
import {
  decryptGithubResearchSecret,
  encryptGithubResearchSecret,
  githubResearchEncryptionKeyId,
  UnknownGithubResearchEncryptionKeyError,
} from "./crypto.js";

const TEST_KEY =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const OTHER_KEY =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

describe("GitHub research credential crypto", () => {
  it("round-trips a secret in a versioned envelope", () => {
    const plaintext = "ghu_sensitive-user-token";
    const encrypted = encryptGithubResearchSecret(plaintext, TEST_KEY);

    expect(encrypted).toEqual({
      v: 1,
      kid: githubResearchEncryptionKeyId(TEST_KEY),
      ct: expect.any(String),
    });
    expect(encrypted.ct).not.toContain(plaintext);
    expect(decryptGithubResearchSecret(encrypted, TEST_KEY)).toEqual({
      plaintext,
      reencrypted: false,
      envelope: encrypted,
    });
  });

  it("round-trips an empty plaintext", () => {
    const encrypted = encryptGithubResearchSecret("", TEST_KEY);
    expect(decryptGithubResearchSecret(encrypted, TEST_KEY).plaintext).toBe("");
  });

  it("decrypts with a previous key and re-encrypts with the active key", () => {
    const encrypted = encryptGithubResearchSecret("secret", OTHER_KEY);
    const result = decryptGithubResearchSecret(encrypted, TEST_KEY, OTHER_KEY);

    expect(result.plaintext).toBe("secret");
    expect(result.reencrypted).toBe(true);
    expect(result.envelope.kid).toBe(githubResearchEncryptionKeyId(TEST_KEY));
    expect(
      decryptGithubResearchSecret(result.envelope, TEST_KEY).plaintext
    ).toBe("secret");
  });

  it("derives a deterministic key id", () => {
    expect(githubResearchEncryptionKeyId(TEST_KEY)).toBe("4884fdaa");
    expect(githubResearchEncryptionKeyId(TEST_KEY)).toHaveLength(8);
  });

  it("rejects a tampered ciphertext", () => {
    const encrypted = encryptGithubResearchSecret("secret", TEST_KEY);
    const bytes = Buffer.from(encrypted.ct, "base64");
    bytes[bytes.length - 1] ^= 0xff;

    expect(() =>
      decryptGithubResearchSecret(
        { ...encrypted, ct: bytes.toString("base64") },
        TEST_KEY
      )
    ).toThrow();
  });

  it("rejects the wrong key", () => {
    const encrypted = encryptGithubResearchSecret("secret", TEST_KEY);
    expect(() => decryptGithubResearchSecret(encrypted, OTHER_KEY)).toThrow(
      UnknownGithubResearchEncryptionKeyError
    );
  });

  it.each([
    null,
    "ciphertext",
    {},
    { v: 2, kid: "4884fda8", ct: "YWJj" },
    { v: 1, kid: "not-a-kid", ct: "YWJj" },
    { v: 1, kid: "4884fda8", ct: "not-base64!!!" },
    { v: 1, kid: "4884fda8", ct: "YWJj" },
  ])("rejects malformed payload %#", (payload) => {
    expect(() => decryptGithubResearchSecret(payload, TEST_KEY)).toThrow(
      /Invalid|Unknown/
    );
  });
});
