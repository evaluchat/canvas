import { describe, expect, it } from "vitest";
import { REPOSITORY_UNAVAILABLE, RepositoryAccessError } from "./access";
import { RepositoryLayoutError } from "./layout";
import { repositoryRouteErrorDetails } from "./route-errors";

describe("repository route error details", () => {
  it("redacts messages from unknown errors", () => {
    const details = repositoryRouteErrorDetails(
      "workspace-one",
      new Error("failed at research/private-notes.md")
    );

    expect(details).toEqual({
      workspaceId: "workspace-one",
      code: "unknown",
      name: "Error",
    });
    expect(details).not.toHaveProperty("message");
  });

  it("maps GitHub access and layout errors to the stable route contract", () => {
    expect(
      repositoryRouteErrorDetails(
        "workspace-one",
        new RepositoryAccessError(
          REPOSITORY_UNAVAILABLE,
          "Repository unavailable (deleted or access removed)."
        )
      )
    ).toEqual({
      workspaceId: "workspace-one",
      code: REPOSITORY_UNAVAILABLE,
    });
    expect(
      repositoryRouteErrorDetails(
        "workspace-one",
        new RepositoryLayoutError("SYMLINK_ARTIFACT", "private/path")
      )
    ).toEqual({
      workspaceId: "workspace-one",
      code: "SYMLINK_ARTIFACT",
    });
  });

  it("uses a stable name for non-Error values", () => {
    expect(
      repositoryRouteErrorDetails("workspace-one", "private/path")
    ).toEqual({
      workspaceId: "workspace-one",
      code: "unknown",
      name: "UnknownError",
    });
  });
});
