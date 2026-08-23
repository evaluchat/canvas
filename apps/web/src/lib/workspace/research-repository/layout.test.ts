import { describe, expect, it } from "vitest";
import {
  assertSafeRepositoryArtifactPath,
  identifyRepositoryArtifactPath,
  RepositoryLayoutError,
  resolveRepositoryArtifactPath,
  validateRepositoryArtifactContent,
  validateRepositoryArtifactCount,
  validateRepositoryArtifactMode,
} from "./layout";

describe("research repository layout 1.0", () => {
  it.each([
    ["index", "index.md", "index"],
    ["theory.question-one", "theory/question-one.en.md", "theory"],
    [
      "method.synthetic-method",
      "methods/synthetic-method/synthetic-method.en.md",
      "method",
    ],
    [
      "evidence-template.synthetic-method",
      "methods/synthetic-method/evidence-template.en.md",
      "evidence_template",
    ],
    [
      "evidence.synthetic-method.source-one",
      "methods/synthetic-method/evidence/source-one.en.md",
      "evidence",
    ],
    [
      "ledger.synthetic-method.snapshot-one",
      "methods/synthetic-method/evidence/ledgers/snapshot-one.en.md",
      "ledger",
    ],
    [
      "ledger-seal.synthetic-method.snapshot-one",
      "methods/synthetic-method/evidence/ledgers/snapshot-one.seal.yml",
      "ledger_seal",
    ],
    [
      "ledger.11111111-1111-4111-8111-111111111111",
      "ledger/seals/11111111-1111-4111-8111-111111111111.en.md",
      "ledger",
    ],
    [
      "ledger-seal.11111111-1111-4111-8111-111111111111",
      "ledger/seals/11111111-1111-4111-8111-111111111111.seal.yml",
      "ledger_seal",
    ],
    ["finding.result-one", "findings/result-one.en.md", "finding"],
    ["workspace-manifest", ".evaluchat/workspace.yml", "workspace_manifest"],
    ["readme", "README.md", "readme"],
    ["citation", "CITATION.cff", "citation"],
    ["gitignore", ".gitignore", "gitignore"],
  ])("resolves %s to its server-owned path", (artifactId, path, kind) => {
    expect(resolveRepositoryArtifactPath(artifactId)).toEqual({
      artifactId,
      path,
      kind,
    });
    expect(identifyRepositoryArtifactPath(path)).toEqual({
      artifactId,
      path,
      kind,
    });
  });

  it.each([
    "../private.md",
    "methods/../private.md",
    "/index.md",
    "methods/link.symlink/file.md",
    "methods/link.lnk/file.md",
  ])("rejects unsafe or symlink-looking path %s", (path) => {
    expect(() => assertSafeRepositoryArtifactPath(path)).toThrow(
      RepositoryLayoutError
    );
  });

  it.each(["notes.lnk", "foo->bar.md", "methods/../private.md"])(
    "ignores unmanaged discovery path %s",
    (path) => {
      expect(identifyRepositoryArtifactPath(path)).toBeUndefined();
    }
  );

  it("recognises repository seal output paths as managed artifacts", () => {
    const snapshotId = "11111111-1111-4111-8111-111111111111";
    expect(
      identifyRepositoryArtifactPath(`ledger/seals/${snapshotId}.en.md`)
    ).toEqual({
      artifactId: `ledger.${snapshotId}`,
      kind: "ledger",
      path: `ledger/seals/${snapshotId}.en.md`,
    });
    expect(
      identifyRepositoryArtifactPath(`ledger/seals/${snapshotId}.seal.yml`)
    ).toEqual({
      artifactId: `ledger-seal.${snapshotId}`,
      kind: "ledger_seal",
      path: `ledger/seals/${snapshotId}.seal.yml`,
    });
  });

  it("rejects executable names, executable modes, and symlink modes", () => {
    expect(() => resolveRepositoryArtifactPath("payload.exe")).toThrow(
      RepositoryLayoutError
    );
    expect(() =>
      validateRepositoryArtifactContent("payload.exe", "content")
    ).toThrow(RepositoryLayoutError);
    expect(() => validateRepositoryArtifactMode("index.md", "100755")).toThrow(
      /non-executable/
    );
    expect(() => validateRepositoryArtifactMode("index.md", "120000")).toThrow(
      /symbolic link/
    );
  });

  it("enforces the 1 MB content and 1000 managed artifact limits", () => {
    expect(() =>
      validateRepositoryArtifactContent("index.md", "x".repeat(1024 * 1024))
    ).not.toThrow();
    expect(() =>
      validateRepositoryArtifactContent("index.md", "x".repeat(1024 * 1024 + 1))
    ).toThrow(/1 MB/);
    expect(() => validateRepositoryArtifactCount(1000)).not.toThrow();
    expect(() => validateRepositoryArtifactCount(1001)).toThrow(/1000/);
  });

  it("rejects mixed-case snapshot ids and unsupported layout versions", () => {
    const mixed = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
    expect(() => resolveRepositoryArtifactPath(`ledger.${mixed}`)).toThrow(
      RepositoryLayoutError
    );
    expect(
      identifyRepositoryArtifactPath(`ledger/seals/${mixed}.seal.yml`)
    ).toBeUndefined();
    expect(() => resolveRepositoryArtifactPath("index", "1.1")).toThrow(
      RepositoryLayoutError
    );
    expect(() => resolveRepositoryArtifactPath("index", "2.0")).toThrow(
      RepositoryLayoutError
    );
  });

  it("refuses gitlink/submodule modes", () => {
    expect(() => validateRepositoryArtifactMode("index.md", "160000")).toThrow(
      /non-executable/
    );
  });
});
