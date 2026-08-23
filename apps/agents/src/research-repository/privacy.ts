/**
 * LangChain/LangSmith tracing is process-wide in the current agents runtime.
 * The repository assistant therefore fails closed whenever ambient tracing is
 * enabled. Other graphs keep their existing tracing configuration unchanged.
 */
export const RESEARCH_REPOSITORY_TRACING_ENV_KEYS = [
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING",
  "LANGCHAIN_TRACING_V2",
] as const;

export function isResearchRepositoryTracingDisabled(
  environment: NodeJS.ProcessEnv = process.env
): boolean {
  return RESEARCH_REPOSITORY_TRACING_ENV_KEYS.every(
    (key) => environment[key] !== "true"
  );
}
