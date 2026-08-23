import { describe, expect, it } from "vitest";
import {
  artifactKindFromId,
  parseArtifactFrontMatter,
  validateArtifactFrontMatter,
  validateEvidenceFrontMatter,
  validateFindingFrontMatter,
  validateMethodFrontMatter,
} from "./authoring";

const method = `---
type: Method
id: synthetic-method
lang: en
origin: native
status: draft
version: 1.0.0
title: Synthetic method
description: A safe synthetic method.
tags: [method, synthetic]
generated: { by: test/1.0, at: 2026-08-23T00:00:00Z }
---`;

const evidence = `---
type: Evidence Contribution
id: synthetic-evidence
lang: en
origin: native
status: draft
title: Synthetic evidence
description: A safe synthetic evidence packet.
stage: documented-experience
---`;

const finding = `---
type: Finding
id: synthetic-finding
lang: en
origin: native
status: provisional
title: Synthetic finding
description: A safe synthetic finding.
authors:
  - name: Fixture Author
claim: A falsifiable synthetic claim.
confidence: low
research_questions: []
evidence_ledgers: []
---`;

describe("artifact front-matter authoring", () => {
  it("parses a front-matter object with JSON schema scalar behavior", () => {
    const parsed = parseArtifactFrontMatter(method);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.data.generated).toEqual({
        by: "test/1.0",
        at: "2026-08-23T00:00:00Z",
      });
    }
  });

  it("validates canonical Method, Evidence, and Finding fields", () => {
    expect(validateMethodFrontMatter(method).ok).toBe(true);
    expect(validateEvidenceFrontMatter(evidence).ok).toBe(true);
    expect(validateFindingFrontMatter(finding).ok).toBe(true);
  });

  it.each([
    ['description: "Use *emphasis*"'],
    ["description: 'Use & more'"],
    ["description: |\n  some *text* & more"],
    ["description: use *emphasis* here"],
  ])("accepts non-token asterisks and ampersands in %s", (description) => {
    const source = method.replace(
      "description: A safe synthetic method.",
      description
    );

    expect(parseArtifactFrontMatter(source).ok).toBe(true);
  });

  it.each([
    ["an alias", "description: *anchorName"],
    ["an anchor", "description: &anchorName value"],
    ["a sequence of aliases", "tags:\n  - *a\n  - *b"],
  ])("rejects %s tokens", (_label, replacement) => {
    const target = replacement.startsWith("tags:")
      ? "tags: [method, synthetic]"
      : "description: A safe synthetic method.";
    const parsed = parseArtifactFrontMatter(
      method.replace(target, replacement)
    );

    expect(parsed).toEqual({
      ok: false,
      reason: "YAML aliases and anchors are not allowed",
    });
  });

  it("accepts canonical ledger evidence that uses method fields as its identity", () => {
    const ledgerEvidence = `---
type: Evidence Contribution
id: packet-one
status: accepted
description: A canonical ledger packet.
method: { id: synthetic-method, version: 1.0.0 }
field_values: { sample_size: 10 }
---`;

    expect(validateEvidenceFrontMatter(ledgerEvidence).ok).toBe(true);
  });

  it.each([
    ["a scalar", "---\nunsafe\n---", "YAML object"],
    ["an array", "---\n- unsafe\n---", "YAML object"],
    [
      "invalid YAML",
      `${method.replace("tags: [method, synthetic]", "tags: [method")}`,
      "flow collection",
    ],
    [
      "an anchor",
      method.replace(
        "title: Synthetic method",
        "title: &title Synthetic method"
      ),
      "aliases and anchors",
    ],
    [
      "an alias",
      method.replace(
        "description: A safe synthetic method.",
        "description: *title"
      ),
      "aliases and anchors",
    ],
    [
      "a custom tag",
      method.replace(
        "title: Synthetic method",
        "title: !!js/function function() {}"
      ),
      "unknown tag",
    ],
    [
      "an unknown key",
      method.replace("status: draft", "status: draft\nunsafe_key: true"),
      "is not allowed",
    ],
    [
      "duplicate keys",
      method.replace("status: draft", "status: draft\nstatus: stable"),
      "duplicated mapping key",
    ],
  ])("rejects %s", (_label, source, reason) => {
    const parsed = parseArtifactFrontMatter(source);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toContain(reason);
  });

  it("rejects empty and multi-document streams", () => {
    expect(parseArtifactFrontMatter("---\n---").ok).toBe(false);
    const parsed = parseArtifactFrontMatter(`${method}\n---\n${evidence}`);
    expect(parsed).toEqual({
      ok: false,
      reason: "Multiple YAML documents are not allowed",
    });
  });

  it("checks required fields and their types", () => {
    const missingTitle = method.replace("title: Synthetic method\n", "");
    const numericVersion = method.replace("version: 1.0.0", "version: 1");
    const missingAuthors = finding.replace(
      "authors:\n  - name: Fixture Author\n",
      ""
    );

    expect(validateMethodFrontMatter(missingTitle)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('"title" or "name"'),
    });
    expect(validateMethodFrontMatter(numericVersion)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('"version" must be a string'),
    });
    expect(validateFindingFrontMatter(missingAuthors)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('"authors"'),
    });
  });

  it("derives only authorable kinds from artifact ids", () => {
    expect(artifactKindFromId("method.synthetic-method")).toBe("method");
    expect(artifactKindFromId("evidence.synthetic-method.packet-one")).toBe(
      "evidence"
    );
    expect(artifactKindFromId("finding.synthetic-finding")).toBe("finding");
    expect(artifactKindFromId("evidence-template.synthetic-method")).toBe(
      undefined
    );
    expect(artifactKindFromId("method")).toBe(undefined);
    expect(artifactKindFromId("theory.synthetic-question")).toBe(undefined);
  });

  it("requires the front-matter type to match the artifact id kind", () => {
    expect(validateArtifactFrontMatter("finding.synthetic", method)).toEqual({
      ok: false,
      reason: "Expected finding front-matter",
    });
  });
});
