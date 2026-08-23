import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const invoke = vi.fn(async () => ({
    role: "assistant",
    content: "A private response",
  }));
  const bindTools = vi.fn();
  const model = { invoke, bindTools };
  return {
    bindTools,
    createModelForProvider: vi.fn(() => model),
    getPrimaryProviderName: vi.fn(() => "opencode-zen"),
    getProviderChain: vi.fn(() => ["opencode-zen", "opencode-go"]),
    invoke,
    isTracingDisabled: vi.fn(() => true),
    traceableConfig: undefined as Record<string, unknown> | undefined,
    wrapModelWithFallback: vi.fn(() => model),
  };
});

vi.mock("../provider-registry.js", () => ({
  createModelForProvider: harness.createModelForProvider,
  getPrimaryProviderName: harness.getPrimaryProviderName,
  getProviderChain: harness.getProviderChain,
  wrapModelWithFallback: harness.wrapModelWithFallback,
}));

vi.mock("./privacy.js", () => ({
  isResearchRepositoryTracingDisabled: harness.isTracingDisabled,
}));

vi.mock("langsmith/traceable", () => ({
  traceable: <T extends (...args: never[]) => unknown>(
    fn: T,
    config: Record<string, unknown>
  ) => {
    harness.traceableConfig = config;
    return fn;
  },
}));

import { graph, RESEARCH_REPOSITORY_TOOL_NAMES } from "./index.js";

describe("research repository graph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GITHUB_RESEARCH_REPOSITORY_AI_ENABLED", "true");
    harness.isTracingDisabled.mockReturnValue(true);
  });

  it("constructs a stateless guard-to-chat graph without tools", () => {
    expect(Object.keys(graph.nodes)).toEqual([
      "__start__",
      "privacyGuard",
      "chat",
    ]);
    expect(graph.checkpointer).toBeUndefined();
    expect(graph.store).toBeUndefined();
    expect(RESEARCH_REPOSITORY_TOOL_NAMES).toEqual([]);
    expect(Object.keys(graph.nodes).join(" ")).not.toMatch(
      /commit|write|tool/i
    );
    expect(harness.bindTools).not.toHaveBeenCalled();
  });

  it("resolves the provider and answers from explicitly supplied state", async () => {
    await graph.invoke({
      messages: [{ role: "user", content: "Summarize this file" }],
      currentArtifact: { path: "notes.md", text: "Private notes" },
    });

    expect(harness.createModelForProvider).toHaveBeenCalledWith(
      "opencode-zen",
      { temperature: 0 }
    );
    expect(harness.wrapModelWithFallback).toHaveBeenCalledWith(
      expect.anything(),
      ["opencode-zen", "opencode-go"],
      { temperature: 0 }
    );
    expect(harness.invoke).toHaveBeenCalledOnce();
    expect(harness.bindTools).not.toHaveBeenCalled();
  });

  it("uses a tracing-disabled scope for this graph's model runtime", () => {
    expect(harness.traceableConfig).toMatchObject({
      name: "research_repository_chat",
      tracingEnabled: false,
    });
  });

  it("refuses to reach the model when the mocked tracing check is on", async () => {
    harness.isTracingDisabled.mockReturnValue(false);

    await expect(
      graph.invoke({ messages: [{ role: "user", content: "Hello" }] })
    ).rejects.toThrow("requires tracing to be disabled");
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  it("defaults to disabled even when tracing is off", async () => {
    vi.stubEnv("GITHUB_RESEARCH_REPOSITORY_AI_ENABLED", "");

    await expect(
      graph.invoke({ messages: [{ role: "user", content: "Hello" }] })
    ).rejects.toThrow("assistant is disabled");
    expect(harness.invoke).not.toHaveBeenCalled();
  });
});
