import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGithubResearchTemplateUrl,
  githubResearchStarterTemplate,
} from "./template";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GitHub research starter template", () => {
  it("builds the exact private repository handoff URL", () => {
    expect(buildGithubResearchTemplateUrl("octocat")).toBe(
      "https://github.com/new?template_owner=evaluchat&template_name=private-research-starter&owner=octocat&visibility=private"
    );
  });

  it("uses the configured template override", () => {
    vi.stubEnv("GITHUB_RESEARCH_STARTER_TEMPLATE", "school/custom-starter");

    expect(githubResearchStarterTemplate()).toBe("school/custom-starter");
    expect(buildGithubResearchTemplateUrl("researcher")).toBe(
      "https://github.com/new?template_owner=school&template_name=custom-starter&owner=researcher&visibility=private"
    );
  });
});
