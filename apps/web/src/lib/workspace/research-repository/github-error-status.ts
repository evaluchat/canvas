export function githubErrorStatus(error: unknown): number | undefined {
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  const status =
    candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status;
  return typeof status === "number" ? status : undefined;
}
