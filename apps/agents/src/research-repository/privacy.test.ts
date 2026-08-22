import { describe, expect, it } from "vitest";
import {
  isResearchRepositoryTracingDisabled,
  RESEARCH_REPOSITORY_TRACING_ENV_KEYS,
} from "./privacy.js";

describe("research repository tracing guard", () => {
  it("treats an environment without tracing flags as private", () => {
    expect(isResearchRepositoryTracingDisabled({})).toBe(true);
  });

  it.each(RESEARCH_REPOSITORY_TRACING_ENV_KEYS)(
    "rejects the runtime when %s enables tracing",
    (key) => {
      expect(
        isResearchRepositoryTracingDisabled({
          [key]: "true",
        })
      ).toBe(false);
    }
  );

  it("matches LangChain's exact, case-sensitive tracing switch", () => {
    expect(
      isResearchRepositoryTracingDisabled({
        LANGSMITH_TRACING: "false",
        LANGCHAIN_TRACING_V2: "TRUE",
      })
    ).toBe(true);
  });
});
