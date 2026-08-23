import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FindingValidationError,
  validateFindingSubmission,
  type ResearchArtifactFetcher,
} from "./finding-validation";

const STARTER_FINDING = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../../research-starter/findings/synthetic-finding.en.md"
  ),
  "utf8"
);

const LEDGER_PATH = "methods/demo-method/evidence/ledgers/ledger-k12-us.en.md";
const QUESTION_PATH = "theory/threshold-calibration.en.md";

const LEDGER_MD = `---
type: Evidence Ledger
id: ledger-k12-us
status: stable
method:
  id: demo-method
  version: 1.0.0
evidence_template:
  id: evidence-template
  version: 1.2.0
source_commit: abcdef0123456789
input_fingerprint: sha256:ledgerhash
---
# Ledger
`;

const QUESTION_MD = `---
type: Research Question
id: threshold-calibration
status: open
title: Threshold calibration
---
# Question
`;

function finding(overrides: Record<string, unknown> = {}): string {
  const frontmatter = {
    type: "Finding",
    id: "example-finding",
    lang: "en",
    origin: "native",
    status: "provisional",
    title: "Example",
    description: "Example summary",
    authors: [{ name: "Human author" }],
    claim: "A falsifiable claim",
    confidence: "low",
    research_questions: [
      {
        resource:
          "https://github.com/evaluchat/research/blob/main/theory/threshold-calibration.en.md",
      },
    ],
    evidence_ledgers: [
      {
        id: "ledger-k12-us",
        path: LEDGER_PATH,
        method: { id: "demo-method", version: "1.0.0" },
        evidence_template: { id: "evidence-template", version: "1.2.0" },
        source_commit: "abcdef0123456789",
        input_fingerprint: "sha256:ledgerhash",
      },
    ],
    ...overrides,
  };
  return `---
${Object.entries(frontmatter)
  .map(([key, value]) => {
    if (value === undefined) return "";
    return `${key}: ${JSON.stringify(value)}`;
  })
  .filter(Boolean)
  .join("\n")}
---

# Example
`;
}

function fetcher(
  files: Record<string, string> = {
    [LEDGER_PATH]: LEDGER_MD,
    [QUESTION_PATH]: QUESTION_MD,
  }
): ResearchArtifactFetcher {
  return async (path) => {
    const source = files[path];
    if (!source) return null;
    return { path, source };
  };
}

async function expectIssue(
  markdown: string,
  fieldId: string,
  message: RegExp,
  files?: Record<string, string>
) {
  try {
    await validateFindingSubmission(markdown, {
      fetchArtifact: fetcher(files),
    });
    throw new Error("expected validation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(FindingValidationError);
    const issues = (error as FindingValidationError).issues;
    expect(issues.some((issue) => issue.fieldId === fieldId)).toBe(true);
    expect(issues.find((issue) => issue.fieldId === fieldId)?.message).toMatch(
      message
    );
  }
}

describe("validateFindingSubmission", () => {
  it("accepts a finding with independently resolved questions and ledgers", async () => {
    const result = await validateFindingSubmission(finding(), {
      fetchArtifact: fetcher(),
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a non-Finding type even with valid reference lists", async () => {
    await expectIssue(
      finding({ type: "Notes" }),
      "type",
      /type must be "Finding"/
    );
    await expectIssue(
      finding({ type: undefined }),
      "type",
      /type must be "Finding"/
    );
  });

  it("rejects a missing research_questions list", async () => {
    await expectIssue(
      finding({ research_questions: [] }),
      "research_questions",
      /non-empty/i
    );
    await expectIssue(
      finding({ research_questions: undefined }),
      "research_questions",
      /non-empty/i
    );
  });

  it("rejects a missing evidence_ledgers list", async () => {
    await expectIssue(
      finding({ evidence_ledgers: [] }),
      "evidence_ledgers",
      /non-empty/i
    );
  });

  it("rejects an unresolvable ledger path", async () => {
    await expectIssue(
      finding(),
      "evidence_ledgers",
      /unresolvable|not found|404/i,
      { [QUESTION_PATH]: QUESTION_MD }
    );
  });

  it("rejects a ledger whose method or template identity does not match", async () => {
    await expectIssue(
      finding({
        evidence_ledgers: [
          {
            id: "ledger-k12-us",
            path: LEDGER_PATH,
            method: { id: "other-method", version: "1.0.0" },
            evidence_template: { id: "evidence-template", version: "1.2.0" },
            source_commit: "abcdef0123456789",
            input_fingerprint: "sha256:ledgerhash",
          },
        ],
      }),
      "evidence_ledgers",
      /method|template|identit/i
    );
  });

  it("rejects a ledger whose source_commit or input_fingerprint does not match", async () => {
    await expectIssue(
      finding({
        evidence_ledgers: [
          {
            id: "ledger-k12-us",
            path: LEDGER_PATH,
            method: { id: "demo-method", version: "1.0.0" },
            evidence_template: { id: "evidence-template", version: "1.2.0" },
            source_commit: "deadbeef",
            input_fingerprint: "sha256:ledgerhash",
          },
        ],
      }),
      "evidence_ledgers",
      /source_commit|fingerprint/i
    );
  });

  it("rejects an unresolvable research-question resource", async () => {
    await expectIssue(
      finding({
        research_questions: [
          {
            resource:
              "https://github.com/evaluchat/research/blob/main/theory/missing-question.en.md",
          },
        ],
      }),
      "research_questions",
      /unresolvable|not found|404|Research Question/i
    );
  });

  it("does not require a ledger to correspond to a research question", async () => {
    const result = await validateFindingSubmission(
      finding({
        research_questions: [
          {
            resource:
              "https://github.com/evaluchat/research/blob/main/theory/threshold-calibration.en.md",
          },
        ],
        evidence_ledgers: [
          {
            id: "ledger-k12-us",
            path: LEDGER_PATH,
            method: { id: "demo-method", version: "1.0.0" },
            evidence_template: { id: "evidence-template", version: "1.2.0" },
            source_commit: "abcdef0123456789",
            input_fingerprint: "sha256:ledgerhash",
          },
        ],
      }),
      { fetchArtifact: fetcher() }
    );
    expect(result.ok).toBe(true);
  });

  it("rejects the synthetic starter finding as non-submittable", async () => {
    await expectIssue(STARTER_FINDING, "research_questions", /non-empty/i);
    await expectIssue(STARTER_FINDING, "evidence_ledgers", /non-empty/i);
  });
});
