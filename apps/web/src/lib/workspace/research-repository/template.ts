export const DEFAULT_GITHUB_RESEARCH_STARTER_TEMPLATE =
  "evaluchat/private-research-starter";

export function githubResearchStarterTemplate(): string {
  return (
    process.env.GITHUB_RESEARCH_STARTER_TEMPLATE?.trim() ||
    DEFAULT_GITHUB_RESEARCH_STARTER_TEMPLATE
  );
}

export function buildGithubResearchTemplateUrl(
  owner: string,
  template = githubResearchStarterTemplate()
): string {
  const [templateOwner, templateName, ...extra] = template.split("/");
  if (!templateOwner || !templateName || extra.length > 0) {
    throw new Error(
      "GITHUB_RESEARCH_STARTER_TEMPLATE must use the owner/repository format"
    );
  }
  const url = new URL("https://github.com/new");
  url.searchParams.set("template_owner", templateOwner);
  url.searchParams.set("template_name", templateName);
  url.searchParams.set("owner", owner);
  url.searchParams.set("visibility", "private");
  return url.toString();
}
