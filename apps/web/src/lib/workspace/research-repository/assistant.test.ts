import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const streamResult = { kind: "stream" };
  const stream = vi.fn(() => streamResult);
  return {
    Client: vi.fn(function MockClient() {
      return { runs: { stream } };
    }),
    stream,
    streamResult,
  };
});

vi.mock("@langchain/langgraph-sdk", () => ({ Client: harness.Client }));
vi.mock("@/constants", () => ({ LANGGRAPH_API_URL: "http://langgraph" }));

import {
  MAX_CURRENT_ARTIFACT_BYTES,
  MAX_CURRENT_ARTIFACT_PATH_BYTES,
  ResearchRepositoryAssistantDisabledError,
  ResearchRepositoryAssistantPayloadError,
  streamResearchRepositoryAssistant,
} from "./assistant";

describe("research repository assistant client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GITHUB_RESEARCH_WORKSPACES_ENABLED", "true");
    vi.stubEnv("GITHUB_RESEARCH_REPOSITORY_AI_ENABLED", "true");
  });

  it("streams a memory-only run with an explicit bounded conversation", () => {
    const result = streamResearchRepositoryAssistant({
      conversation: [
        {
          role: "user",
          content: "What does this note mean?",
          ignoredRepositoryBody: "must not be forwarded",
        } as never,
      ],
      currentArtifact: { path: "notes/current.md", text: "Current text" },
    });

    expect(result).toBe(harness.streamResult);
    expect(harness.stream).toHaveBeenCalledWith(null, "research_repository", {
      input: {
        messages: [{ role: "user", content: "What does this note mean?" }],
        currentArtifact: {
          path: "notes/current.md",
          text: "Current text",
        },
      },
      streamMode: "messages-tuple",
    });
  });

  it("refuses to run when the repository AI flag is off", () => {
    vi.stubEnv("GITHUB_RESEARCH_REPOSITORY_AI_ENABLED", "false");

    expect(() =>
      streamResearchRepositoryAssistant({ conversation: [] })
    ).toThrow(ResearchRepositoryAssistantDisabledError);
    expect(harness.stream).not.toHaveBeenCalled();
  });

  it("refuses to run when the workspace flag is off", () => {
    vi.stubEnv("GITHUB_RESEARCH_WORKSPACES_ENABLED", "false");

    expect(() =>
      streamResearchRepositoryAssistant({ conversation: [] })
    ).toThrow(ResearchRepositoryAssistantDisabledError);
    expect(harness.stream).not.toHaveBeenCalled();
  });

  it("rejects an oversized current artifact before creating a run", () => {
    expect(() =>
      streamResearchRepositoryAssistant({
        conversation: [{ role: "user", content: "Review this" }],
        currentArtifact: {
          path: "large.md",
          text: "x".repeat(MAX_CURRENT_ARTIFACT_BYTES + 1),
        },
      })
    ).toThrow(ResearchRepositoryAssistantPayloadError);
    expect(harness.stream).not.toHaveBeenCalled();
  });

  it("permits the maximum path size and rejects an oversized path", () => {
    streamResearchRepositoryAssistant({
      conversation: [{ role: "user", content: "Review this" }],
      currentArtifact: {
        path: "x".repeat(MAX_CURRENT_ARTIFACT_PATH_BYTES),
        text: "Current text",
      },
    });
    expect(harness.stream).toHaveBeenCalledOnce();

    harness.stream.mockClear();

    expect(() =>
      streamResearchRepositoryAssistant({
        conversation: [{ role: "user", content: "Review this" }],
        currentArtifact: {
          path: "x".repeat(MAX_CURRENT_ARTIFACT_PATH_BYTES + 1),
          text: "Current text",
        },
      })
    ).toThrow(ResearchRepositoryAssistantPayloadError);
    expect(harness.stream).not.toHaveBeenCalled();
  });
});
