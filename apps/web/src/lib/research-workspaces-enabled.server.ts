/**
 * Server-only gate for GitHub-backed private research workspaces. The absence
 * of a NEXT_PUBLIC_ prefix is intentional: this value must not enter the
 * browser bundle.
 */
export function isGithubResearchWorkspacesEnabled(): boolean {
  return process.env.GITHUB_RESEARCH_WORKSPACES_ENABLED === "true";
}

export function isGithubResearchRepositoryAiEnabled(): boolean {
  return process.env.GITHUB_RESEARCH_REPOSITORY_AI_ENABLED === "true";
}
