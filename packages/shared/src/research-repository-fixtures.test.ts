import { readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { LedgerSealManifestV1Schema } from "./research-repository.js";

const fixturesRoot = join(__dirname, "fixtures/research-repository");

type FixtureMetadata = {
  canonicalContent: {
    repository: string;
    branch: string;
    methodRoot: string;
    theoryQuestion: string;
    note: string;
  };
  requiredManagedPaths: string[];
  supportedReaderVersion: string;
  compatibility: {
    supportedVersionAccess: string;
    unsupportedMajorAccess: string;
    laterMinorAccess: string;
    rule: string;
  };
  fixtures: Record<
    string,
    { root: string; layoutVersion: string; expectedAccess: string }
  >;
};

function readMetadata(): FixtureMetadata {
  return JSON.parse(
    readFileSync(join(fixturesRoot, "fixture-metadata.json"), "utf8")
  ) as FixtureMetadata;
}

describe("research repository layout fixtures", () => {
  it.each(["v1.0", "v1.1"])(
    "%s ships only layout scaffolding (no research markdown)",
    (version) => {
      const fixtureRoot = join(fixturesRoot, version);
      const entries = [
        ".evaluchat/workspace.yml",
        ".gitignore",
        "CITATION.cff",
      ];

      for (const entry of entries) {
        expect(() =>
          readFileSync(join(fixtureRoot, entry), "utf8")
        ).not.toThrow();
      }

      const workspaceManifest = readFileSync(
        join(fixtureRoot, ".evaluchat/workspace.yml"),
        "utf8"
      );
      expect(workspaceManifest).toContain(
        `layout_version: "${version.slice(1)}"`
      );
      expect(workspaceManifest).toContain(
        "managed_branch: evaluchat/workspace"
      );
    }
  );

  it("documents managed paths and canonical research catalog location", () => {
    const metadata = readMetadata();

    expect(metadata.canonicalContent.repository).toBe("evaluchat/research");
    expect(metadata.canonicalContent.methodRoot).toBe(
      "methods/synthetic-method"
    );
    expect(metadata.requiredManagedPaths).toEqual(
      expect.arrayContaining([
        "methods/synthetic-method/evidence/ledgers/synthetic-snapshot.en.md",
        "methods/synthetic-method/evidence/ledgers/synthetic-snapshot.seal.yml",
        "theory/synthetic-question.en.md",
      ])
    );
    expect(metadata.supportedReaderVersion).toBe("1.0");
    expect(metadata.compatibility.supportedVersionAccess).toBe("read-write");
    expect(metadata.compatibility.unsupportedMajorAccess).toBe("read-only");
    expect(metadata.compatibility.laterMinorAccess).toBe("read-only");
    expect(metadata.compatibility.rule).toMatch(
      /unsupported major.*later unsupported minor.*read-only/i
    );
    expect(metadata.fixtures["v1.0"]).toMatchObject({
      layoutVersion: "1.0",
      expectedAccess: "read-write",
    });
    expect(metadata.fixtures["v1.1"]).toMatchObject({
      layoutVersion: "1.1",
      expectedAccess: "read-only",
    });
  });

  it("round-trips unknown v1.1 seal fields and rejects invalid core fields", () => {
    const fixture = yaml.load(
      `
schema_version: "1"
snapshot_id: synthetic-snapshot
sealed_from_commit: 1111111111111111111111111111111111111111
reviewer_login: synthetic-reviewer
reviewed_at: 2026-08-22T11:00:00Z
method:
  id: synthetic-method
  version: 1.1.0
inputs:
  - path: methods/synthetic-method/evidence/synthetic-evidence.en.md
    blob_sha: 2222222222222222222222222222222222222222
    sha256: 3333333333333333333333333333333333333333333333333333333333333333
configuration_hash: 4444444444444444444444444444444444444444444444444444444444444444
render_hash: 5555555555555555555555555555555555555555555555555555555555555555
future_minor_note: preserved by compatible readers
`.trim(),
      { schema: yaml.FAILSAFE_SCHEMA }
    );
    const parsed = LedgerSealManifestV1Schema.parse(fixture);

    expect((parsed as Record<string, unknown>).future_minor_note).toBe(
      "preserved by compatible readers"
    );
    expect(
      LedgerSealManifestV1Schema.safeParse({
        ...(fixture as Record<string, unknown>),
        sealed_from_commit: "not-a-commit",
      }).success
    ).toBe(false);
  });
});
