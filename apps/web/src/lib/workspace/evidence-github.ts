import { isAutoMergeEligibleStage, shouldAutoMergeEvidence } from "./evidence";

const GITHUB_API = "https://api.github.com";
export const RESEARCH_REPOSITORY = "evaluchat/research";

type GithubJson = Record<string, any>;

export function githubHeaders(): HeadersInit {
  // Catalogue publisher app (GITHUB_CATALOGUE_APP_ID / GITHUB_CATALOGUE_PRIVATE_KEY)
  // is a maintainer step: createGithubInstallationOctokit needs an installation
  // id we do not resolve here. Runtime credential remains VALERY_GITHUB_TOKEN.
  const token = process.env.VALERY_GITHUB_TOKEN;
  if (!token) throw new Error("VALERY_GITHUB_TOKEN is not configured");
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "canvas-evidence-runtime",
  };
}

export async function githubRequest(
  path: string,
  init: RequestInit = {}
): Promise<GithubJson> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { ...githubHeaders(), ...(init.headers || {}) },
    signal:
      init.signal ??
      AbortSignal.timeout(
        Number.parseInt(
          process.env.EVIDENCE_GITHUB_TIMEOUT_MS || "15000",
          10
        ) || 15_000
      ),
  });
  const text = await response.text();
  let body: GithubJson = {};
  if (text) {
    try {
      body = JSON.parse(text) as GithubJson;
    } catch {
      body = { message: text };
    }
  }
  if (!response.ok) {
    throw new Error(
      `GitHub API ${response.status}: ${String(body.message || "request failed")}`
    );
  }
  return body;
}

function safeBranchPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForOkfLint(
  sha: string
): Promise<{ passed: boolean; conclusion?: string }> {
  const attempts = Math.max(
    1,
    Number.parseInt(process.env.EVIDENCE_GITHUB_CHECK_ATTEMPTS || "10", 10) ||
      10
  );
  const intervalMs = Math.max(
    0,
    Number.parseInt(
      process.env.EVIDENCE_GITHUB_CHECK_INTERVAL_MS || "1000",
      10
    ) || 1000
  );
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const body = await githubRequest(
      `/repos/${RESEARCH_REPOSITORY}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
      { method: "GET" }
    );
    const checkRuns = Array.isArray(body.check_runs) ? body.check_runs : [];
    const check = checkRuns.find(
      (candidate: GithubJson) => candidate.name === "okf-lint"
    );
    if (check?.conclusion === "success") {
      return { passed: true, conclusion: "success" };
    }
    if (
      check?.conclusion &&
      ["failure", "cancelled", "timed_out", "action_required"].includes(
        check.conclusion
      )
    ) {
      return { passed: false, conclusion: check.conclusion };
    }
    if (attempt + 1 < attempts && intervalMs > 0) await sleep(intervalMs);
  }
  return { passed: false };
}

export type GithubResearchWriteAccess = {
  allowed: boolean;
  login?: string;
  reason?: "missing_identity" | "missing_write_access";
};

/**
 * The token-backed GitHub identity is the identity used for the subsequent
 * branch, commit, and PR calls. Check its collaborator permission before a
 * public write so a failed publish cannot leave a branch behind.
 */
export async function getGithubResearchWriteAccess(): Promise<GithubResearchWriteAccess> {
  let identity: GithubJson;
  try {
    identity = await githubRequest("/user", { method: "GET" });
  } catch {
    return { allowed: false, reason: "missing_identity" };
  }
  const login = identity.login;
  if (typeof login !== "string" || !login) {
    return { allowed: false, reason: "missing_identity" };
  }
  try {
    const permission = await githubRequest(
      `/repos/${RESEARCH_REPOSITORY}/collaborators/${encodeURIComponent(login)}/permission`,
      { method: "GET" }
    );
    const level = permission.permission;
    if (["admin", "maintain", "write"].includes(level)) {
      return { allowed: true, login };
    }
  } catch {
    // GitHub returns 404 for a non-collaborator; it remains an access denial.
  }
  return { allowed: false, login, reason: "missing_write_access" };
}

export type LedgerPullRequestStatus = {
  state: "open" | "closed";
  merged: boolean;
  mergedAt?: string;
};

export async function getLedgerPullRequestStatus(
  pullRequestNumber: number
): Promise<LedgerPullRequestStatus> {
  const pullRequest = await githubRequest(
    `/repos/${RESEARCH_REPOSITORY}/pulls/${pullRequestNumber}`,
    { method: "GET" }
  );
  const state = pullRequest.state === "closed" ? "closed" : "open";
  const merged =
    pullRequest.merged === true || typeof pullRequest.merged_at === "string";
  return {
    state,
    merged,
    ...(typeof pullRequest.merged_at === "string"
      ? { mergedAt: pullRequest.merged_at }
      : {}),
  };
}

export type OpenLedgerPullRequestInput = {
  ledgerId: string;
  inputFingerprint: string;
  filePath: string;
  markdown: string;
  body: string;
  /** Verified by the publish route against the sealed snapshot's rendered body. */
  renderHashMatches: boolean;
  /** Set only after server-side publication declarations have been validated. */
  consentConfirmed: boolean;
  /** Immutable source revision named by the sealed snapshot. */
  sourceCommit: string;
  /** A closed prior publication needs a distinct branch, never a force-push. */
  retry?: number;
};

export type OpenLedgerPullRequestResult = {
  number: number;
  url: string;
  branch: string;
  status: "draft";
  lintConclusion?: string;
};

export function ledgerBranch(input: OpenLedgerPullRequestInput): string {
  const fingerprint = input.inputFingerprint.replace(/^sha256:/, "");
  const suffix = input.retry && input.retry > 1 ? `-retry-${input.retry}` : "";
  return `ledger/${safeBranchPart(input.ledgerId)}-${safeBranchPart(fingerprint.slice(0, 12))}${suffix}`;
}

function isPinnedCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

/**
 * Require the pinned source revision to resolve in the main lineage, not just
 * to look like a commit id. A comparison result of `behind` or `identical`
 * means the source commit is an ancestor of the main revision used for this PR.
 */
async function sourceCommitIsOnMainLineage(
  sourceCommit: string,
  mainSha: string
): Promise<boolean> {
  if (!isPinnedCommitSha(sourceCommit)) return false;
  try {
    const comparison = await githubRequest(
      `/repos/${RESEARCH_REPOSITORY}/compare/${encodeURIComponent(sourceCommit)}...${encodeURIComponent(mainSha)}`,
      { method: "GET" }
    );
    return ["behind", "identical"].includes(comparison.status);
  } catch {
    // An absent commit, a non-comparable revision, or a GitHub read failure is
    // not sufficient evidence for automatic publication. Leave the draft open.
    return false;
  }
}

/**
 * Create exactly one immutable ledger file in a draft PR. Integrity gates
 * still run (lint, render hash, consent, source lineage) but never ready,
 * approve, or merge — human review completes publication.
 */
export async function openLedgerPullRequest(
  input: OpenLedgerPullRequestInput
): Promise<OpenLedgerPullRequestResult> {
  const branch = ledgerBranch(input);
  const baseRef = await githubRequest(
    `/repos/${RESEARCH_REPOSITORY}/git/ref/heads/main`,
    { method: "GET" }
  );
  const baseSha = baseRef.object?.sha;
  if (typeof baseSha !== "string" || !baseSha) {
    throw new Error("Research main branch did not return a commit SHA");
  }
  await githubRequest(
    `/repos/${RESEARCH_REPOSITORY}/git/refs`,
    jsonBody({ ref: `refs/heads/${branch}`, sha: baseSha })
  );
  await githubRequest(
    `/repos/${RESEARCH_REPOSITORY}/contents/${input.filePath}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `docs(evidence-ledger): ${input.ledgerId} snapshot ${input.inputFingerprint.replace(/^sha256:/, "").slice(0, 12)}`,
        content: Buffer.from(input.markdown, "utf8").toString("base64"),
        branch,
      }),
    }
  );
  const pullRequest = await githubRequest(
    `/repos/${RESEARCH_REPOSITORY}/pulls`,
    jsonBody({
      title: `docs(evidence-ledger): ${input.ledgerId}`,
      head: branch,
      base: "main",
      draft: true,
      body: input.body,
    })
  );
  const number = pullRequest.number;
  const url = pullRequest.html_url;
  const headSha = pullRequest.head?.sha;
  if (
    typeof number !== "number" ||
    typeof url !== "string" ||
    typeof headSha !== "string" ||
    !headSha
  ) {
    throw new Error("GitHub pull request response was incomplete");
  }
  const lint = await waitForOkfLint(headSha);
  const baseResult = {
    number,
    url,
    branch,
    status: "draft" as const,
    lintConclusion: lint.conclusion,
  };

  if (!lint.passed || !input.renderHashMatches || !input.consentConfirmed) {
    return baseResult;
  }

  const sourceCommitValid = await sourceCommitIsOnMainLineage(
    input.sourceCommit,
    baseSha
  );
  if (!sourceCommitValid) return baseResult;

  return baseResult;
}

export type OpenEvidencePullRequestInput = {
  methodId: string;
  methodTitle?: string;
  stage: string;
  timestampSlug: string;
  filePath: string;
  markdown: string;
  existingPullRequest?: ExistingEvidencePullRequest;
};

export type ExistingEvidencePullRequest = {
  branch: string;
  number: number;
  url: string;
  headSha: string;
};

export type OpenEvidencePullRequestResult = {
  number: number;
  url: string;
  branch: string;
  status: "submitted" | "filed";
  lintConclusion?: string;
};

export async function findExistingEvidencePullRequest(
  methodId: string,
  timestampSlug: string
): Promise<ExistingEvidencePullRequest | undefined> {
  const branch = `evidence/${safeBranchPart(methodId)}/${safeBranchPart(timestampSlug)}`;
  let ref: GithubJson;
  try {
    ref = await githubRequest(
      `/repos/${RESEARCH_REPOSITORY}/git/ref/heads/${branch}`,
      { method: "GET" }
    );
  } catch (error) {
    if (error instanceof Error && /^GitHub API 404:/.test(error.message)) {
      return undefined;
    }
    throw error;
  }
  const headSha = ref.object?.sha;
  if (typeof headSha !== "string" || !headSha) {
    throw new Error("Existing evidence branch did not return a commit SHA");
  }
  const pulls = await githubRequest(
    `/repos/${RESEARCH_REPOSITORY}/pulls?head=evaluchat:${encodeURIComponent(branch)}&state=open`,
    { method: "GET" }
  );
  const matches = Array.isArray(pulls)
    ? pulls.filter((candidate: GithubJson) => candidate.head?.ref === branch)
    : [];
  if (matches.length !== 1) {
    throw new Error("Existing evidence branch has no unique open pull request");
  }
  const pullRequest = matches[0];
  if (
    typeof pullRequest.number !== "number" ||
    typeof pullRequest.html_url !== "string" ||
    pullRequest.head?.sha !== headSha
  ) {
    throw new Error("Existing evidence pull request head changed");
  }
  return {
    branch,
    number: pullRequest.number,
    url: pullRequest.html_url,
    headSha,
  };
}

/** Open a draft bot-authored research PR. Never ready, approve, or merge. */
export async function openEvidencePullRequest(
  input: OpenEvidencePullRequestInput
): Promise<OpenEvidencePullRequestResult> {
  const branch = `evidence/${safeBranchPart(input.methodId)}/${safeBranchPart(input.timestampSlug)}`;
  let number: number;
  let url: string;
  let headSha: string;
  if (input.existingPullRequest) {
    ({ number, url, headSha } = input.existingPullRequest);
  } else {
    const baseRef = await githubRequest(
      `/repos/${RESEARCH_REPOSITORY}/git/ref/heads/main`,
      { method: "GET" }
    );
    const baseSha = baseRef.object?.sha;
    if (typeof baseSha !== "string" || !baseSha) {
      throw new Error("Research main branch did not return a commit SHA");
    }
    await githubRequest(
      `/repos/${RESEARCH_REPOSITORY}/git/refs`,
      jsonBody({ ref: `refs/heads/${branch}`, sha: baseSha })
    );
    await githubRequest(
      `/repos/${RESEARCH_REPOSITORY}/contents/${input.filePath}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `docs(evidence): ${input.methodId} evidence ${input.timestampSlug}`,
          content: Buffer.from(input.markdown, "utf8").toString("base64"),
          branch,
        }),
      }
    );

    const pullRequest = await githubRequest(
      `/repos/${RESEARCH_REPOSITORY}/pulls`,
      jsonBody({
        title: `docs(evidence): ${input.methodId} evidence ${input.timestampSlug}`,
        head: branch,
        base: "main",
        draft: true,
        body: [
          "This bot-authored evidence contribution was assembled from one concluded method run.",
          "",
          `- Method: ${input.methodId}`,
          `- Stage: ${input.stage}`,
          "- Student identifiers, raw student material, and transcripts are excluded.",
          "- Generated by: canvas-evidence-runtime/0.1",
        ].join("\n"),
      })
    );
    number = pullRequest.number;
    url = pullRequest.html_url;
    const pullRequestHeadSha = pullRequest.head?.sha;
    if (typeof pullRequestHeadSha !== "string" || !pullRequestHeadSha) {
      throw new Error("GitHub pull request response had no head SHA");
    }
    headSha = pullRequestHeadSha;
    if (pullRequest.head?.sha !== headSha) {
      throw new Error("GitHub pull request head changed");
    }
  }
  if (typeof number !== "number" || typeof url !== "string") {
    throw new Error("GitHub pull request response was incomplete");
  }

  if (!isAutoMergeEligibleStage(input.stage)) {
    await githubRequest(
      `/repos/${RESEARCH_REPOSITORY}/issues/${number}/comments`,
      jsonBody({
        body: "This evidence contribution is routed to human review per the evidence-publishing design because its declared stage is above `documented-experience`.",
      })
    );
    return { number, url, branch, status: "submitted" };
  }

  if (typeof headSha !== "string" || !headSha) {
    throw new Error("GitHub pull request response had no head SHA");
  }
  const lint = await waitForOkfLint(headSha);
  if (
    shouldAutoMergeEvidence({
      stage: input.stage,
      provenancePresent: true,
      consentPresent: true,
      okfLintPassed: lint.passed,
    })
  ) {
    return {
      number,
      url,
      branch,
      status: "filed",
      lintConclusion: lint.conclusion,
    };
  }

  return {
    number,
    url,
    branch,
    status: "submitted",
    lintConclusion: lint.conclusion,
  };
}
