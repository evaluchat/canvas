import { beforeEach, describe, expect, it, vi } from "vitest";
import yaml from "js-yaml";

const harness = vi.hoisted(() => ({
  listArtifacts: vi.fn(),
  readBlob: vi.fn(),
  commitArtifacts: vi.fn(),
}));

vi.mock("./git-adapter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./git-adapter")>();
  return {
    ...actual,
    listRepositoryArtifactRefs: harness.listArtifacts,
    readArtifactBlob: harness.readBlob,
    commitArtifactBlobs: harness.commitArtifacts,
  };
});

import {
  canonicalSealConfigurationJson,
  commitSealSnapshot,
  latestSealSnapshotId,
  parseSealManifest,
  previewSealSnapshot,
  sealLedgerPath,
  sealManifestPath,
  SealSnapshotError,
  serializeSealManifest,
  supersedeSeal,
} from "./seals";
import { LedgerSealManifestV1Schema } from "@opencanvas/shared/research-repository";

const headCommitSha = "a".repeat(40);
const resultCommitSha = "f".repeat(40);
const snapshotOne = "11111111-1111-4111-8111-111111111111";
const snapshotTwo = "22222222-2222-4222-8222-222222222222";
const reviewedAt = "2026-08-23T10:00:00.000Z";

const methodContent = `---
type: Method
id: synthetic-method
lang: en
origin: native
status: stable
version: 1.2.3
title: Synthetic method
description: A deterministic test method.
---

# Synthetic method`;

const BASELINE_FILES: Array<[string, { content: string; blobSha: string }]> = [
  [
    "methods/synthetic-method/synthetic-method.en.md",
    { content: methodContent, blobSha: "b".repeat(40) },
  ],
  [
    "methods/synthetic-method/evidence/evidence-one.en.md",
    { content: "evidence bytes", blobSha: "c".repeat(40) },
  ],
  [
    "findings/finding-one.en.md",
    { content: "finding bytes", blobSha: "d".repeat(40) },
  ],
  [
    "methods/synthetic-method/evidence/ledgers/draft-ledger.en.md",
    { content: "draft ledger bytes", blobSha: "e".repeat(40) },
  ],
];
const files = new Map<string, { content: string; blobSha: string }>();

const artifacts = [
  {
    artifactId: "method.synthetic-method",
    kind: "method",
    path: "methods/synthetic-method/synthetic-method.en.md",
    commitSha: headCommitSha,
    blobSha: "b".repeat(40),
    contentSha256: "1".repeat(64),
  },
  {
    artifactId: "evidence.synthetic-method.evidence-one",
    kind: "evidence",
    path: "methods/synthetic-method/evidence/evidence-one.en.md",
    commitSha: headCommitSha,
    blobSha: "c".repeat(40),
    contentSha256: "2".repeat(64),
  },
  {
    artifactId: "finding.finding-one",
    kind: "finding",
    path: "findings/finding-one.en.md",
    commitSha: headCommitSha,
    blobSha: "d".repeat(40),
    contentSha256: "3".repeat(64),
  },
  {
    artifactId: "ledger.synthetic-method.draft-ledger",
    kind: "ledger",
    path: "methods/synthetic-method/evidence/ledgers/draft-ledger.en.md",
    commitSha: headCommitSha,
    blobSha: "e".repeat(40),
    contentSha256: "4".repeat(64),
  },
] as const;

const access = {
  binding: {
    provider: "github" as const,
    repositoryId: 101,
    installationId: 99,
    branch: "evaluchat/workspace" as const,
    layoutVersion: "1.0",
    headCommitSha,
    boundAt: "2026-08-23T00:00:00.000Z",
  },
  credentials: {
    tokens: { accessToken: "not-retained" },
    installationId: 99,
    repositoryIds: [101],
    displayMetadata: { githubUserId: 7, login: "researcher" },
  },
  repository: { owner: "octocat", name: "private" },
};

function oldManifest(snapshotId = snapshotOne, at = reviewedAt) {
  return {
    schemaVersion: "1" as const,
    snapshotId,
    sealedFromCommit: "9".repeat(40),
    reviewerLogin: "researcher",
    reviewedAt: at,
    method: { id: "synthetic-method", version: "1.2.3" },
    inputs: [
      {
        path: "methods/synthetic-method/synthetic-method.en.md",
        blobSha: "8".repeat(40),
        sha256: "7".repeat(64),
      },
    ],
    configurationHash: "6".repeat(64),
    renderHash: "5".repeat(64),
  };
}

describe("repository ledger seals", () => {
  beforeEach(() => {
    files.clear();
    for (const [path, file] of BASELINE_FILES) {
      files.set(path, { ...file });
    }
    harness.listArtifacts.mockReset();
    harness.readBlob.mockReset();
    harness.commitArtifacts.mockReset();
    harness.listArtifacts.mockResolvedValue({
      artifacts: [...artifacts],
      commitSha: headCommitSha,
    });
    harness.readBlob.mockImplementation(
      async (
        _installationId: number,
        _repository: unknown,
        _branch: string,
        path: string
      ) => {
        const file = files.get(path);
        if (!file) throw Object.assign(new Error("not found"), { status: 404 });
        return { ...file, commitSha: headCommitSha };
      }
    );
    harness.commitArtifacts.mockResolvedValue(resultCommitSha);
  });

  it("renders deterministic preview bytes and hashes apart from snapshot id", async () => {
    const first = await previewSealSnapshot(access, {
      snapshotId: snapshotOne,
      reviewedAt,
    });
    const second = await previewSealSnapshot(access, {
      snapshotId: snapshotTwo,
      reviewedAt,
    });

    expect(first.snapshotId).not.toBe(second.snapshotId);
    expect(first.ledgerMarkdown).toBe(second.ledgerMarkdown);
    expect(first.configurationHash).toBe(second.configurationHash);
    expect(first.renderHash).toBe(second.renderHash);
    expect(first.inputs).toEqual(second.inputs);
    expect(first.renderHash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.inputArtifactIds).toEqual(
      [...artifacts]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((artifact) => artifact.artifactId)
    );
    expect(
      canonicalSealConfigurationJson({
        method: first.method,
        layoutVersion: "1.0",
        inputArtifactIds: ["finding.finding-one", "method.synthetic-method"],
      })
    ).toBe(
      '{"method":{"id":"synthetic-method","version":"1.2.3"},"layout_version":"1.0","input_artifact_ids":["finding.finding-one","method.synthetic-method"]}'
    );
  });

  it("commits the ledger and adjacent manifest atomically and round-trips the schema", async () => {
    const preview = await previewSealSnapshot(access, {
      snapshotId: snapshotOne,
      reviewedAt,
    });
    const result = await commitSealSnapshot(access, preview, {
      name: "researcher",
      email: "7+researcher@users.noreply.github.com",
    });

    expect(result).toEqual({
      commitSha: resultCommitSha,
      snapshotId: snapshotOne,
    });
    expect(harness.commitArtifacts).toHaveBeenCalledOnce();
    expect(harness.commitArtifacts).toHaveBeenCalledWith(
      99,
      access.repository,
      "evaluchat/workspace",
      expect.objectContaining({
        baseSha: headCommitSha,
        files: [
          {
            path: sealLedgerPath(snapshotOne),
            content: preview.ledgerMarkdown,
          },
          {
            path: sealManifestPath(snapshotOne),
            content: preview.manifestYaml,
          },
        ],
      })
    );
    const parsed = parseSealManifest(preview.manifestYaml);
    expect(parsed).toEqual(
      LedgerSealManifestV1Schema.parse(
        // Exercise the snake-case file contract rather than only the transformed value.
        yamlObject(preview.manifestYaml)
      )
    );
    expect(parsed.snapshotId).toBe(snapshotOne);
  });

  it("supersedes with a new id without changing the previous seal bytes", async () => {
    const oldPath = sealManifestPath(snapshotOne);
    const oldBytes = serializeSealManifest(oldManifest());
    files.set(oldPath, { content: oldBytes, blobSha: "1".repeat(40) });
    harness.listArtifacts.mockResolvedValue({
      commitSha: headCommitSha,
      artifacts: [
        ...artifacts,
        {
          artifactId: `ledger-seal.${snapshotOne}`,
          kind: "ledger_seal",
          path: oldPath,
          commitSha: headCommitSha,
          blobSha: "1".repeat(40),
          contentSha256: "2".repeat(64),
        },
      ],
    });
    harness.commitArtifacts.mockImplementation(async (_i, _r, _b, input) => {
      for (const file of input.files) {
        files.set(file.path, {
          content: file.content,
          blobSha: "3".repeat(40),
        });
      }
      return resultCommitSha;
    });

    const result = await supersedeSeal(
      access,
      snapshotOne,
      { snapshotId: snapshotTwo, reviewedAt },
      undefined
    );

    expect(result.snapshotId).toBe(snapshotTwo);
    expect(result.preview.supersedes).toBe(snapshotOne);
    expect(parseSealManifest(result.preview.manifestYaml).supersedes).toBe(
      snapshotOne
    );
    expect(files.get(oldPath)?.content).toBe(oldBytes);
    expect(
      harness.commitArtifacts.mock.calls[0]?.[3].files.map(
        (file: { path: string }) => file.path
      )
    ).not.toContain(oldPath);
  });

  it("refuses to rewrite an existing sealed snapshot path", async () => {
    const preview = await previewSealSnapshot(access, {
      snapshotId: snapshotOne,
      reviewedAt,
    });
    harness.listArtifacts.mockResolvedValue({
      commitSha: headCommitSha,
      artifacts: [
        ...artifacts,
        {
          artifactId: `ledger-seal.${snapshotOne}`,
          kind: "ledger_seal",
          path: sealManifestPath(snapshotOne),
          commitSha: headCommitSha,
          blobSha: "1".repeat(40),
          contentSha256: "2".repeat(64),
        },
      ],
    });

    await expect(commitSealSnapshot(access, preview)).rejects.toMatchObject({
      code: "SNAPSHOT_ALREADY_SEALED",
    } satisfies Partial<SealSnapshotError>);
    expect(harness.commitArtifacts).not.toHaveBeenCalled();
  });

  it("excludes sealed renders from later seal inputs", async () => {
    const sealedRenderPath = sealLedgerPath(snapshotOne);
    files.set(sealManifestPath(snapshotOne), {
      content: serializeSealManifest(oldManifest()),
      blobSha: "c2".repeat(20),
    });
    harness.listArtifacts.mockResolvedValue({
      artifacts: [
        ...artifacts,
        {
          artifactId: `ledger.${snapshotOne}`,
          kind: "ledger",
          path: sealedRenderPath,
          commitSha: headCommitSha,
          blobSha: "c1".repeat(20),
          contentSha256: "9".repeat(64),
        },
        {
          artifactId: `ledger-seal.${snapshotOne}`,
          kind: "ledger_seal",
          path: sealManifestPath(snapshotOne),
          commitSha: headCommitSha,
          blobSha: "c2".repeat(20),
          contentSha256: "8".repeat(64),
        },
      ],
      commitSha: headCommitSha,
    });
    const clean = await previewSealSnapshot(access, {
      snapshotId: snapshotTwo,
      reviewedAt,
    });

    expect(clean.inputArtifactIds).not.toContain(`ledger.${snapshotOne}`);
    expect(clean.inputs.map((input) => input.path)).not.toContain(
      sealedRenderPath
    );
    // A prior seal changes nothing: same inputs and configuration hash as the
    // fresh-repository preview in the determinism test below.
    expect(clean.inputArtifactIds).toEqual(
      [...artifacts]
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((artifact) => artifact.artifactId)
    );
  });

  it("rejects upper-case snapshot ids", async () => {
    await expect(
      previewSealSnapshot(access, {
        snapshotId: "ABCD1111-1111-4111-8111-111111111111",
        reviewedAt,
      })
    ).rejects.toMatchObject({
      code: "INVALID_PREVIEW",
    });
  });

  it("carries the deterministic snapshot data for the declaration gate", async () => {
    const preview = await previewSealSnapshot(access, {
      snapshotId: snapshotOne,
      reviewedAt,
    });

    expect(preview.snapshotData).toBeDefined();
    expect(preview.snapshotData.ledgerId).toBe(snapshotOne);
    expect(preview.snapshotData.methodId).toBe("synthetic-method");
    expect(preview.snapshotData.manifest.contributions).toHaveLength(
      preview.inputs.length
    );
  });

  it("resolves the latest parsed seal by review time", async () => {
    const latestPath = sealManifestPath(snapshotTwo);
    files.set(sealManifestPath(snapshotOne), {
      content: serializeSealManifest(oldManifest()),
      blobSha: "1".repeat(40),
    });
    files.set(latestPath, {
      content: serializeSealManifest(
        oldManifest(snapshotTwo, "2026-08-23T11:00:00.000Z")
      ),
      blobSha: "2".repeat(40),
    });
    harness.listArtifacts.mockResolvedValue({
      commitSha: headCommitSha,
      artifacts: [
        ...artifacts,
        ...[snapshotOne, snapshotTwo].map((snapshotId, index) => ({
          artifactId: `ledger-seal.${snapshotId}`,
          kind: "ledger_seal",
          path: sealManifestPath(snapshotId),
          commitSha: headCommitSha,
          blobSha: String(index + 1).repeat(40),
          contentSha256: String(index + 3).repeat(64),
        })),
      ],
    });

    await expect(latestSealSnapshotId(access)).resolves.toBe(snapshotTwo);
  });

  it("excludes method-scoped seal renders and includes their manifests", async () => {
    const methodManifest =
      "methods/synthetic-method/evidence/ledgers/synthetic-snapshot.seal.yml";
    const methodRender =
      "methods/synthetic-method/evidence/ledgers/synthetic-snapshot.en.md";
    files.set(methodManifest, {
      content: serializeSealManifest(oldManifest()),
      blobSha: "3".repeat(40),
    });
    files.set(methodRender, {
      content: "sealed ledger render",
      blobSha: "4".repeat(40),
    });
    harness.listArtifacts.mockResolvedValue({
      commitSha: headCommitSha,
      artifacts: [
        ...artifacts,
        {
          artifactId: "ledger.synthetic-method.synthetic-snapshot",
          kind: "ledger",
          path: methodRender,
          commitSha: headCommitSha,
          blobSha: "4".repeat(40),
          contentSha256: "a".repeat(64),
        },
        {
          artifactId: "ledger-seal.synthetic-method.synthetic-snapshot",
          kind: "ledger_seal",
          path: methodManifest,
          commitSha: headCommitSha,
          blobSha: "3".repeat(40),
          contentSha256: "b".repeat(64),
        },
      ],
    });

    const preview = await previewSealSnapshot(access, {
      snapshotId: snapshotTwo,
      reviewedAt,
    });
    expect(preview.inputArtifactIds).not.toContain(
      "ledger.synthetic-method.synthetic-snapshot"
    );
    expect(preview.inputArtifactIds).toContain(
      "ledger.synthetic-method.draft-ledger"
    );
    await expect(latestSealSnapshotId(access)).resolves.toBe(snapshotOne);
  });

  it("validates a superseded seal from manifest content when the filename differs", async () => {
    const methodManifest =
      "methods/synthetic-method/evidence/ledgers/synthetic-snapshot.seal.yml";
    files.set(methodManifest, {
      content: serializeSealManifest(oldManifest(snapshotOne)),
      blobSha: "3".repeat(40),
    });
    harness.listArtifacts.mockResolvedValue({
      commitSha: headCommitSha,
      artifacts: [
        ...artifacts,
        {
          artifactId: "ledger-seal.synthetic-method.synthetic-snapshot",
          kind: "ledger_seal",
          path: methodManifest,
          commitSha: headCommitSha,
          blobSha: "3".repeat(40),
          contentSha256: "b".repeat(64),
        },
      ],
    });

    const preview = await previewSealSnapshot(access, {
      snapshotId: snapshotTwo,
      reviewedAt,
      supersedes: snapshotOne,
    });
    expect(preview.supersedes).toBe(snapshotOne);
  });

  it("rejects a duplicate snapshot id from method-scoped manifest content", async () => {
    const methodManifest =
      "methods/synthetic-method/evidence/ledgers/synthetic-snapshot.seal.yml";
    files.set(methodManifest, {
      content: serializeSealManifest(oldManifest(snapshotOne)),
      blobSha: "3".repeat(40),
    });
    harness.listArtifacts.mockResolvedValue({
      commitSha: headCommitSha,
      artifacts: [
        ...artifacts,
        {
          artifactId: "ledger-seal.synthetic-method.synthetic-snapshot",
          kind: "ledger_seal",
          path: methodManifest,
          commitSha: headCommitSha,
          blobSha: "3".repeat(40),
          contentSha256: "b".repeat(64),
        },
      ],
    });

    await expect(
      previewSealSnapshot(access, {
        snapshotId: snapshotOne,
        reviewedAt,
      })
    ).rejects.toMatchObject({
      code: "SNAPSHOT_ALREADY_SEALED",
    } satisfies Partial<SealSnapshotError>);

    await expect(
      previewSealSnapshot(access, {
        snapshotId: snapshotTwo,
        reviewedAt,
      })
    ).resolves.toMatchObject({ snapshotId: snapshotTwo });
  });
});

function yamlObject(source: string): unknown {
  return yaml.load(source, { schema: yaml.JSON_SCHEMA });
}
