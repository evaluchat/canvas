import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isGithubResearchRepositoryAiEnabled,
  isGithubResearchWorkspacesEnabled,
} from "./research-workspaces-enabled.server";

describe("GITHUB_RESEARCH_WORKSPACES_ENABLED", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults off when the server flag is unset", () => {
    const previous = process.env.GITHUB_RESEARCH_WORKSPACES_ENABLED;
    delete process.env.GITHUB_RESEARCH_WORKSPACES_ENABLED;

    try {
      expect(isGithubResearchWorkspacesEnabled()).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.GITHUB_RESEARCH_WORKSPACES_ENABLED;
      } else {
        process.env.GITHUB_RESEARCH_WORKSPACES_ENABLED = previous;
      }
    }
  });

  it("enables only for the exact value true", () => {
    vi.stubEnv("GITHUB_RESEARCH_WORKSPACES_ENABLED", "true");
    expect(isGithubResearchWorkspacesEnabled()).toBe(true);

    for (const disabledValue of ["false", "TRUE", "1", " yes ", ""]) {
      vi.stubEnv("GITHUB_RESEARCH_WORKSPACES_ENABLED", disabledValue);
      expect(isGithubResearchWorkspacesEnabled()).toBe(false);
    }
  });
});

describe("GITHUB_RESEARCH_REPOSITORY_AI_ENABLED", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults off when the server flag is unset", () => {
    const previous = process.env.GITHUB_RESEARCH_REPOSITORY_AI_ENABLED;
    delete process.env.GITHUB_RESEARCH_REPOSITORY_AI_ENABLED;

    try {
      expect(isGithubResearchRepositoryAiEnabled()).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.GITHUB_RESEARCH_REPOSITORY_AI_ENABLED;
      } else {
        process.env.GITHUB_RESEARCH_REPOSITORY_AI_ENABLED = previous;
      }
    }
  });

  it("enables only for the exact value true", () => {
    vi.stubEnv("GITHUB_RESEARCH_REPOSITORY_AI_ENABLED", "true");
    expect(isGithubResearchRepositoryAiEnabled()).toBe(true);

    for (const disabledValue of ["false", "TRUE", "1", " yes ", ""]) {
      vi.stubEnv("GITHUB_RESEARCH_REPOSITORY_AI_ENABLED", disabledValue);
      expect(isGithubResearchRepositoryAiEnabled()).toBe(false);
    }
  });
});
