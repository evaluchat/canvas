import yaml from "js-yaml";

export type AuthorableArtifactKind = "method" | "evidence" | "finding";

export type ArtifactFrontMatterResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; reason: string };

/** Top-level keys present in the canonical Research repository artifacts. */
export const authoringKeyMap: Record<
  AuthorableArtifactKind,
  readonly string[]
> = {
  method: [
    "type",
    "id",
    "lang",
    "origin",
    "status",
    "version",
    "min_canvas_version",
    "title",
    "name",
    "description",
    "tags",
    "timestamp",
    "research_questions",
    "question",
    "roles",
    "required_capabilities",
    "levers",
    "telemetry",
    "provenance",
    "profiles",
    "run_brief_template",
    "evidence_template",
    "platform",
    "catalog_urls",
    "implementation_status",
    "blockers",
    "generated",
    "verified",
    "sources",
  ],
  evidence: [
    "type",
    "id",
    "lang",
    "origin",
    "status",
    "version",
    "title",
    "name",
    "description",
    "tags",
    "stage",
    "contributor",
    "method",
    "provenance",
    "field_values",
    "source_path",
    "authors",
    "generated",
    "verified",
    "sources",
  ],
  finding: [
    "type",
    "id",
    "lang",
    "origin",
    "status",
    "version",
    "title",
    "name",
    "description",
    "tags",
    "authors",
    "claim",
    "confidence",
    "research_questions",
    "evidence_ledgers",
    "review",
    "generated",
    "verified",
    "sources",
  ],
};

const typeToKind: Record<string, AuthorableArtifactKind> = {
  Method: "method",
  "Evidence Contribution": "evidence",
  Finding: "finding",
};

const stringFields: Record<AuthorableArtifactKind, readonly string[]> = {
  method: [
    "type",
    "id",
    "lang",
    "origin",
    "status",
    "version",
    "min_canvas_version",
    "title",
    "name",
    "description",
    "timestamp",
    "question",
    "run_brief_template",
    "evidence_template",
    "implementation_status",
  ],
  evidence: [
    "type",
    "id",
    "lang",
    "origin",
    "status",
    "version",
    "title",
    "name",
    "description",
    "stage",
    "contributor",
    "source_path",
  ],
  finding: [
    "type",
    "id",
    "lang",
    "origin",
    "status",
    "version",
    "title",
    "name",
    "description",
    "claim",
    "confidence",
  ],
};

const arrayFields: Record<AuthorableArtifactKind, readonly string[]> = {
  method: [
    "tags",
    "research_questions",
    "roles",
    "required_capabilities",
    "levers",
    "telemetry",
    "profiles",
    "blockers",
    "sources",
  ],
  evidence: ["tags", "authors", "sources"],
  finding: [
    "tags",
    "authors",
    "research_questions",
    "evidence_ledgers",
    "sources",
  ],
};

const objectFields: Record<AuthorableArtifactKind, readonly string[]> = {
  method: ["provenance", "platform", "catalog_urls", "generated", "verified"],
  evidence: ["method", "provenance", "field_values", "generated", "verified"],
  finding: ["review", "generated", "verified"],
};

function failure(reason: string): ArtifactFrontMatterResult {
  return { ok: false, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function frontMatterSource(text: string): ArtifactFrontMatterResult | string {
  const lines = text.split(/\r?\n/);
  if (!/^---[\t ]*$/.test(lines[0] ?? "")) {
    return failure("A leading YAML front-matter block is required");
  }

  const end = lines.findIndex(
    (line, index) => index > 0 && /^---[\t ]*$/.test(line)
  );
  if (end < 0) return failure("The YAML front-matter block is not closed");

  const nextContentLine = lines
    .slice(end + 1)
    .find((line) => line.trim().length > 0);
  if (nextContentLine && /^---[\t ]*$/.test(nextContentLine)) {
    return failure("Multiple YAML documents are not allowed");
  }
  return lines.slice(1, end).join("\n");
}

function kindFromType(value: unknown): AuthorableArtifactKind | undefined {
  return typeof value === "string" ? typeToKind[value] : undefined;
}

const anchorOrAliasAtLineStart = /^(?:[&*])[A-Za-z_][A-Za-z0-9_-]*/;
const anchorOrAliasAfterStructuralToken =
  /(?::\s+|-\s+|[,\[{]\s*)[&*][A-Za-z_][A-Za-z0-9_-]*/;
const blockScalarAtLineEnd = /[|>](?:[+-][1-9]?|[1-9][+-]?)?[ \t]*$/;

function isUnescapedDoubleQuote(line: string, index: number): boolean {
  let backslashCount = 0;
  for (
    let preceding = index - 1;
    preceding >= 0 && line[preceding] === "\\";
    preceding -= 1
  ) {
    backslashCount += 1;
  }
  return backslashCount % 2 === 0;
}

function containsAnchorOrAliasToken(text: string): boolean {
  let inDoubleQuotedScalar = false;
  let inSingleQuotedScalar = false;
  let blockScalarIndent: number | undefined;

  for (const line of text.split(/\r?\n/)) {
    const indentation = line.match(/^[ \t]*/)?.[0].length ?? 0;

    if (blockScalarIndent !== undefined) {
      if (line.trim().length === 0 || indentation > blockScalarIndent) {
        continue;
      }
      blockScalarIndent = undefined;
    }

    const bareSegments: Array<{ start: number; text: string }> = [];
    let bareSegmentStart =
      inDoubleQuotedScalar || inSingleQuotedScalar ? undefined : 0;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];

      if (inDoubleQuotedScalar) {
        if (character === '"' && isUnescapedDoubleQuote(line, index)) {
          inDoubleQuotedScalar = false;
          bareSegmentStart = index + 1;
        }
        continue;
      }

      if (inSingleQuotedScalar) {
        if (character === "'") {
          if (line[index + 1] === "'") {
            index += 1;
          } else {
            inSingleQuotedScalar = false;
            bareSegmentStart = index + 1;
          }
        }
        continue;
      }

      if (
        (character === '"' && isUnescapedDoubleQuote(line, index)) ||
        character === "'"
      ) {
        if (bareSegmentStart !== undefined) {
          bareSegments.push({
            start: bareSegmentStart,
            text: line.slice(bareSegmentStart, index),
          });
        }
        bareSegmentStart = undefined;
        inDoubleQuotedScalar = character === '"';
        inSingleQuotedScalar = character === "'";
      }
    }

    if (bareSegmentStart !== undefined) {
      bareSegments.push({
        start: bareSegmentStart,
        text: line.slice(bareSegmentStart),
      });
    }

    for (const segment of bareSegments) {
      const lineStartText =
        segment.start === 0 ? segment.text.replace(/^[ \t]*/, "") : "";
      if (
        (lineStartText && anchorOrAliasAtLineStart.test(lineStartText)) ||
        anchorOrAliasAfterStructuralToken.test(segment.text)
      ) {
        return true;
      }
    }

    const finalSegment = bareSegments[bareSegments.length - 1];
    if (
      finalSegment &&
      finalSegment.start + finalSegment.text.length === line.length &&
      blockScalarAtLineEnd.test(finalSegment.text)
    ) {
      blockScalarIndent = indentation;
    }
  }

  return false;
}

/**
 * Parse an artifact's leading YAML block without js-yaml's default schema.
 * JSON_SCHEMA keeps scalar resolution predictable and excludes language-specific
 * tags; `json: false` also preserves duplicate-key rejection.
 */
export function parseArtifactFrontMatter(
  text: string
): ArtifactFrontMatterResult {
  const source = frontMatterSource(text);
  if (typeof source !== "string") return source;

  // JSON_SCHEMA still implements YAML graph aliases, which authoring forbids.
  if (containsAnchorOrAliasToken(source)) {
    return failure("YAML aliases and anchors are not allowed");
  }

  let data: unknown;
  try {
    data = yaml.load(source, { json: false, schema: yaml.JSON_SCHEMA });
  } catch (error) {
    const reason =
      error instanceof yaml.YAMLException && error.reason
        ? error.reason
        : "The YAML could not be parsed";
    return failure(reason);
  }

  if (!isRecord(data)) return failure("Front-matter must be a YAML object");
  const kind = kindFromType(data.type);
  if (!kind) {
    return failure(
      "Front-matter type must be Method, Evidence Contribution, or Finding"
    );
  }

  const allowedKeys = new Set(authoringKeyMap[kind]);
  const unexpectedKey = Object.keys(data).find((key) => !allowedKeys.has(key));
  if (unexpectedKey) {
    return failure(
      `Front-matter key "${unexpectedKey}" is not allowed for ${kind} artifacts`
    );
  }

  return { ok: true, data };
}

function validateStringFields(
  data: Record<string, unknown>,
  kind: AuthorableArtifactKind
): ArtifactFrontMatterResult | undefined {
  for (const field of stringFields[kind]) {
    if (field in data && typeof data[field] !== "string") {
      return failure(`Front-matter field "${field}" must be a string`);
    }
  }
  for (const field of arrayFields[kind]) {
    if (field in data && !Array.isArray(data[field])) {
      return failure(`Front-matter field "${field}" must be an array`);
    }
  }
  for (const field of objectFields[kind]) {
    if (field in data && !isRecord(data[field])) {
      return failure(`Front-matter field "${field}" must be an object`);
    }
  }
}

function requiredString(
  data: Record<string, unknown>,
  field: string
): ArtifactFrontMatterResult | undefined {
  if (typeof data[field] !== "string" || !data[field].trim()) {
    return failure(`Front-matter field "${field}" is required`);
  }
}

function validateKind(
  text: string,
  kind: AuthorableArtifactKind
): ArtifactFrontMatterResult {
  const parsed = parseArtifactFrontMatter(text);
  if (!parsed.ok) return parsed;
  if (kindFromType(parsed.data.type) !== kind) {
    return failure(`Expected ${kind} front-matter`);
  }

  const typedFields = validateStringFields(parsed.data, kind);
  if (typedFields) return typedFields;
  for (const field of ["id", "description", "status"]) {
    const required = requiredString(parsed.data, field);
    if (required) return required;
  }
  const ledgerEvidence =
    kind === "evidence" &&
    isRecord(parsed.data.method) &&
    isRecord(parsed.data.field_values);
  if (
    !ledgerEvidence &&
    !(
      (typeof parsed.data.title === "string" && parsed.data.title.trim()) ||
      (typeof parsed.data.name === "string" && parsed.data.name.trim())
    )
  ) {
    return failure('Front-matter field "title" or "name" is required');
  }
  if (kind === "method") {
    const version = requiredString(parsed.data, "version");
    if (version) return version;
  }
  if (kind === "finding") {
    const authors = parsed.data.authors;
    if (
      !Array.isArray(authors) ||
      authors.length === 0 ||
      authors.some(
        (author) =>
          !isRecord(author) ||
          typeof author.name !== "string" ||
          !author.name.trim()
      )
    ) {
      return failure(
        'Front-matter field "authors" must contain objects with a name'
      );
    }
  }
  return parsed;
}

export function validateMethodFrontMatter(
  text: string
): ArtifactFrontMatterResult {
  return validateKind(text, "method");
}

export function validateEvidenceFrontMatter(
  text: string
): ArtifactFrontMatterResult {
  return validateKind(text, "evidence");
}

export function validateFindingFrontMatter(
  text: string
): ArtifactFrontMatterResult {
  return validateKind(text, "finding");
}

export function artifactKindFromId(
  artifactId: string
): AuthorableArtifactKind | undefined {
  if (artifactId.startsWith("method.")) return "method";
  if (artifactId.startsWith("evidence.")) return "evidence";
  if (artifactId.startsWith("finding.")) return "finding";
}

export function validateArtifactFrontMatter(
  artifactId: string,
  text: string
): ArtifactFrontMatterResult {
  const kind = artifactKindFromId(artifactId);
  if (kind === "method") return validateMethodFrontMatter(text);
  if (kind === "evidence") return validateEvidenceFrontMatter(text);
  if (kind === "finding") return validateFindingFrontMatter(text);
  return failure("Artifact kind does not use authorable front-matter");
}
