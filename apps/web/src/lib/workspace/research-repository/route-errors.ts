import { RepositoryAccessError } from "./access";
import { RepositoryLayoutError } from "./layout";

export function repositoryRouteErrorDetails(
  workspaceId: string,
  error: unknown
): { workspaceId: string; code: string; name?: string } {
  if (error instanceof RepositoryLayoutError) {
    return { workspaceId, code: error.code };
  }
  if (error instanceof RepositoryAccessError) {
    return { workspaceId, code: error.code };
  }
  return {
    workspaceId,
    code: "unknown",
    name: error instanceof Error ? error.name : "UnknownError",
  };
}
